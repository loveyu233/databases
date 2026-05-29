import { randomUUID } from "node:crypto";
import { Kafka, logLevel, type Admin, type EachMessagePayload, type IHeaders, type IResourceConfigEntry } from "kafkajs";
import { DbConnectionWithSecret, QueryResult, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";
import { sliceRows } from "../core/utils";

const KAFKA_TOPIC_SPACE = "topics";
const DEFAULT_CONSUME_LIMIT = 50;
const DEFAULT_CONSUME_TIMEOUT_MS = 5000;
const KAFKA_MESSAGE_COLUMNS = ["topic", "partition", "offset", "timestamp", "key", "value", "headers", "size"];

type KafkaCommand =
  | { kind: "showTopics"; includeInternal: boolean }
  | { kind: "listGroups" }
  | { kind: "describeTopic"; topic: string }
  | { kind: "describeGroup"; groupId: string }
  | { kind: "createTopic"; topic: string; partitions: number; replicationFactor: number; configEntries?: IResourceConfigEntry[] }
  | { kind: "deleteTopic"; topic: string }
  | { kind: "produce"; topic: string; key?: string; value: string }
  | { kind: "consume"; topic: string; limit: number; fromBeginning: boolean; timeoutMs: number };

export class KafkaWorkbenchClient implements DbClient {
  private readonly kafka: Kafka;
  private readonly topicFilter: string | undefined;

  private constructor(config: DbConnectionWithSecret, database?: string) {
    this.topicFilter = (database && database !== KAFKA_TOPIC_SPACE ? database : config.database)?.trim() || undefined;
    this.kafka = new Kafka({
      clientId: sanitizeKafkaClientId(`database-workbench-${config.name || "client"}`),
      brokers: [`${config.host}:${config.port}`],
      ssl: config.ssl ? { rejectUnauthorized: !config.allowInsecureTls } : undefined,
      sasl: config.username
        ? { mechanism: "plain", username: config.username, password: config.password || "" }
        : undefined,
      connectionTimeout: 10000,
      authenticationTimeout: 10000,
      requestTimeout: 30000,
      logLevel: logLevel.ERROR,
    });
  }

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<KafkaWorkbenchClient> {
    return new KafkaWorkbenchClient(config, database);
  }

  async ping(): Promise<void> {
    await this.withAdmin(async (admin) => {
      await admin.describeCluster();
    });
  }

  async listDatabases(): Promise<string[]> {
    return [KAFKA_TOPIC_SPACE];
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    return this.withAdmin(async (admin) => {
      const topics = await this.listVisibleTopics(admin, false);
      if (!topics.length) {
        return [];
      }
      const metadata = await admin.fetchTopicMetadata({ topics });
      const offsetMap = await this.fetchTopicMessageCounts(admin, topics);
      return metadata.topics
        .map((topic) => ({
          name: topic.name,
          comment: `${topic.partitions.length} partitions · ${offsetMap.get(topic.name) ?? 0} messages`,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  async loadSchema(): Promise<TableInfo[]> {
    const summaries = await this.listTableSummaries();
    return summaries.map((summary) => ({
      name: summary.name,
      comment: summary.comment,
      columns: [
        { name: "topic", type: "string", nullable: false, comment: "Topic 名称" },
        { name: "partition", type: "int", nullable: false, comment: "分区编号" },
        { name: "offset", type: "bigint", nullable: false, key: "PRI", comment: "消息 Offset" },
        { name: "timestamp", type: "timestamp", nullable: true, comment: "消息时间戳" },
        { name: "key", type: "string", nullable: true, comment: "消息 Key" },
        { name: "value", type: "string", nullable: true, comment: "消息内容" },
        { name: "headers", type: "json", nullable: true, comment: "消息 Headers" },
        { name: "size", type: "int", nullable: true, comment: "消息大小" },
      ],
    }));
  }

  async getCreateTableSql(topic: string): Promise<string> {
    return this.withAdmin(async (admin) => {
      const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
      const topicMetadata = metadata.topics.find((item) => item.name === topic);
      if (!topicMetadata) {
        throw new Error(`Topic ${topic} 不存在。`);
      }
      const replicationFactor = topicMetadata.partitions[0]?.replicas.length || 1;
      return `CREATE TOPIC ${quoteKafkaName(topic)} PARTITIONS ${topicMetadata.partitions.length} REPLICATION_FACTOR ${replicationFactor};`;
    });
  }

  async query(commandText: string, maxRows: number): Promise<QueryResult> {
    const startedAt = Date.now();
    const command = parseKafkaCommand(commandText, maxRows);
    const result = await this.executeCommand(command, maxRows);
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  quoteIdentifier(identifier: string): string {
    return quoteKafkaName(identifier);
  }

  async dispose(): Promise<void> {
    // KafkaJS 连接按 admin / producer / consumer 单次操作创建并释放，这里无需额外处理。
  }

  private async executeCommand(command: KafkaCommand, maxRows: number): Promise<QueryResult> {
    if (command.kind === "showTopics") {
      return this.withAdmin(async (admin) => {
        const topics = await this.listVisibleTopics(admin, command.includeInternal);
        return buildRowsResult(topics.map((topic) => ({ topic })), "SHOW TOPICS");
      });
    }
    if (command.kind === "listGroups") {
      return this.withAdmin(async (admin) => {
        const groups = (await admin.listGroups()).groups;
        return buildRowsResult(groups.map((group) => ({ groupId: group.groupId, protocolType: group.protocolType })), "LIST GROUPS");
      });
    }
    if (command.kind === "describeTopic") {
      return this.describeTopic(command.topic);
    }
    if (command.kind === "describeGroup") {
      return this.withAdmin(async (admin) => {
        const group = (await admin.describeGroups([command.groupId])).groups[0];
        if (!group) {
          return buildRowsResult([], "DESCRIBE GROUP");
        }
        const rows = group.members.length
          ? group.members.map((member) => ({
            groupId: group.groupId,
            state: group.state,
            protocol: group.protocol,
            protocolType: group.protocolType,
            memberId: member.memberId,
            clientId: member.clientId,
            clientHost: member.clientHost,
          }))
          : [{ groupId: group.groupId, state: group.state, protocol: group.protocol, protocolType: group.protocolType, memberId: "", clientId: "", clientHost: "" }];
        return buildRowsResult(rows, "DESCRIBE GROUP");
      });
    }
    if (command.kind === "createTopic") {
      return this.withAdmin(async (admin) => {
        const created = await admin.createTopics({
          waitForLeaders: true,
          topics: [{
            topic: command.topic,
            numPartitions: command.partitions,
            replicationFactor: command.replicationFactor,
            configEntries: command.configEntries,
          }],
        });
        return buildRowsResult([{
          topic: command.topic,
          partitions: command.partitions,
          replicationFactor: command.replicationFactor,
          configs: Object.fromEntries((command.configEntries || []).map((item) => [item.name, item.value])),
          created,
        }], "CREATE TOPIC", created ? 1 : 0);
      });
    }
    if (command.kind === "deleteTopic") {
      return this.withAdmin(async (admin) => {
        await admin.deleteTopics({ topics: [command.topic] });
        return buildRowsResult([{ topic: command.topic, deleted: true }], "DELETE TOPIC", 1);
      });
    }
    if (command.kind === "produce") {
      const producer = this.kafka.producer({ allowAutoTopicCreation: false });
      try {
        await producer.connect();
        const metadata = await producer.send({
          topic: command.topic,
          messages: [{ key: command.key, value: command.value }],
        });
        return buildRowsResult(metadata.map((item) => ({
          topicName: item.topicName,
          partition: item.partition,
          errorCode: item.errorCode,
          baseOffset: item.baseOffset,
        })), "PRODUCE", metadata.length);
      } finally {
        await producer.disconnect().catch(() => undefined);
      }
    }
    if (command.kind === "consume") {
      return this.consumeMessages(command, maxRows);
    }
    return buildRowsResult([], "KAFKA");
  }

  private async describeTopic(topic: string): Promise<QueryResult> {
    return this.withAdmin(async (admin) => {
      const [metadata, offsets] = await Promise.all([
        admin.fetchTopicMetadata({ topics: [topic] }),
        admin.fetchTopicOffsets(topic).catch(() => []),
      ]);
      const topicMetadata = metadata.topics.find((item) => item.name === topic);
      if (!topicMetadata) {
        return buildRowsResult([], "DESCRIBE TOPIC");
      }
      const offsetMap = new Map(offsets.map((offset) => [offset.partition, offset]));
      const rows = topicMetadata.partitions.map((partition) => {
        const offset = offsetMap.get(partition.partitionId);
        const low = Number(offset?.low ?? 0);
        const high = Number(offset?.high ?? 0);
        return {
          topic,
          partition: partition.partitionId,
          leader: partition.leader,
          replicas: partition.replicas.join(","),
          isr: partition.isr.join(","),
          lowOffset: Number.isFinite(low) ? low : offset?.low ?? "",
          highOffset: Number.isFinite(high) ? high : offset?.high ?? "",
          messages: Number.isFinite(low) && Number.isFinite(high) ? Math.max(0, high - low) : "",
        };
      });
      return buildRowsResult(rows, "DESCRIBE TOPIC");
    });
  }

  private async consumeMessages(command: Extract<KafkaCommand, { kind: "consume" }>, maxRows: number): Promise<QueryResult> {
    const limit = Math.max(1, Math.min(maxRows < 0 ? DEFAULT_CONSUME_LIMIT : maxRows, command.limit));
    const consumer = this.kafka.consumer({
      groupId: `database-workbench-preview-${Date.now()}-${randomUUID().slice(0, 8)}`,
      allowAutoTopicCreation: false,
      maxWaitTimeInMs: Math.min(command.timeoutMs, DEFAULT_CONSUME_TIMEOUT_MS),
    });
    const rows: Record<string, unknown>[] = [];
    let finished = false;

    return await new Promise<QueryResult>(async (resolve, reject) => {
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void consumer.stop()
          .catch(() => undefined)
          .then(() => consumer.disconnect().catch(() => undefined))
          .then(() => {
            if (error) {
              reject(error);
              return;
            }
            resolve({
              columns: KAFKA_MESSAGE_COLUMNS,
              rows: sliceRows(rows, limit),
              rowCount: rows.length,
              command: "CONSUME",
              elapsedMs: 0,
            });
          });
      };
      const timer = setTimeout(() => finish(), Math.max(1000, command.timeoutMs));
      try {
        await consumer.connect();
        await consumer.subscribe({ topic: command.topic, fromBeginning: command.fromBeginning });
        await consumer.run({
          autoCommit: false,
          eachMessage: async (payload) => {
            rows.push(normalizeKafkaMessage(payload));
            if (rows.length >= limit) {
              finish();
            }
          },
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  private async listVisibleTopics(admin: Admin, includeInternal: boolean): Promise<string[]> {
    const topics = await admin.listTopics();
    return topics
      .filter((topic) => includeInternal || !topic.startsWith("__"))
      .filter((topic) => matchesTopicFilter(topic, this.topicFilter))
      .sort((left, right) => left.localeCompare(right));
  }

  private async fetchTopicMessageCounts(admin: Admin, topics: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    await Promise.all(topics.map(async (topic) => {
      try {
        const offsets = await admin.fetchTopicOffsets(topic);
        counts.set(topic, offsets.reduce((sum, offset) => {
          const low = Number(offset.low);
          const high = Number(offset.high);
          return Number.isFinite(low) && Number.isFinite(high) ? sum + Math.max(0, high - low) : sum;
        }, 0));
      } catch {
        counts.set(topic, 0);
      }
    }));
    return counts;
  }

  private async withAdmin<T>(callback: (admin: Admin) => Promise<T>): Promise<T> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      return await callback(admin);
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }
}

export function parseKafkaCommand(commandText: string, maxRows = DEFAULT_CONSUME_LIMIT): KafkaCommand {
  const text = stripTrailingSemicolon(commandText).trim();
  if (!text) {
    throw new Error("请输入 Kafka 命令，例如 SHOW TOPICS、DESCRIBE TOPIC orders 或 CONSUME orders LIMIT 20。");
  }
  if (/^SHOW\s+TOPICS(?:\s+ALL)?$/i.test(text)) {
    return { kind: "showTopics", includeInternal: /\bALL$/i.test(text) };
  }
  if (/^(SHOW|LIST)\s+GROUPS$/i.test(text)) {
    return { kind: "listGroups" };
  }

  const describeTopic = parseNamedCommand(text, /^DESCRIBE\s+TOPIC\s+/i);
  if (describeTopic) {
    return { kind: "describeTopic", topic: describeTopic.name };
  }
  const describeGroup = parseNamedCommand(text, /^DESCRIBE\s+GROUP\s+/i);
  if (describeGroup) {
    return { kind: "describeGroup", groupId: describeGroup.name };
  }
  const deleteTopic = parseNamedCommand(text, /^DELETE\s+TOPIC\s+/i);
  if (deleteTopic) {
    return { kind: "deleteTopic", topic: deleteTopic.name };
  }
  const createTopic = parseNamedCommand(text, /^CREATE\s+TOPIC\s+/i);
  if (createTopic) {
    const partitions = parsePositiveOption(createTopic.rest, "PARTITIONS", 1);
    const replicationFactor = parsePositiveOption(createTopic.rest, "REPLICATION_FACTOR", 1);
    const configEntries = parseKafkaConfigEntries(createTopic.rest);
    return {
      kind: "createTopic",
      topic: createTopic.name,
      partitions,
      replicationFactor,
      ...(configEntries.length ? { configEntries } : {}),
    };
  }
  const consume = parseNamedCommand(text, /^CONSUME\s+/i);
  if (consume) {
    const limit = parsePositiveOption(consume.rest, "LIMIT", maxRows < 0 ? DEFAULT_CONSUME_LIMIT : Math.max(1, maxRows));
    const timeoutMs = parsePositiveOption(consume.rest, "TIMEOUT", DEFAULT_CONSUME_TIMEOUT_MS);
    const fromBeginning = !/\bFROM\s+LATEST\b/i.test(consume.rest);
    return { kind: "consume", topic: consume.name, limit, timeoutMs, fromBeginning };
  }
  const produce = parseNamedCommand(text, /^PRODUCE\s+/i);
  if (produce) {
    return parseProduceCommand(produce.name, produce.rest);
  }

  throw new Error("暂不支持该 Kafka 命令。支持 SHOW TOPICS、LIST GROUPS、DESCRIBE TOPIC、CONSUME、PRODUCE、CREATE TOPIC、DELETE TOPIC。");
}

function parseProduceCommand(topic: string, rest: string): KafkaCommand {
  const keyMatch = rest.match(/^\s+KEY\s+((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\S+))([\s\S]*)$/i);
  let key: string | undefined;
  let source = rest;
  if (keyMatch) {
    key = parseKafkaValueToken(keyMatch[1]);
    source = keyMatch[2] || "";
  }
  const valueMatch = source.match(/^\s+VALUE\s+([\s\S]+)$/i);
  if (!valueMatch) {
    throw new Error("PRODUCE 命令需要 VALUE，例如 PRODUCE orders KEY user-1 VALUE {\"id\":1}。");
  }
  return { kind: "produce", topic, key, value: parseKafkaValueToken(valueMatch[1].trim(), true) };
}

function parseNamedCommand(text: string, prefix: RegExp): { name: string; rest: string } | undefined {
  const match = text.match(prefix);
  if (!match) return undefined;
  return readKafkaName(text.slice(match[0].length));
}

function readKafkaName(source: string): { name: string; rest: string } {
  const text = source.trimStart();
  if (!text) {
    throw new Error("缺少名称。");
  }
  const quote = text[0];
  if (quote === "\"" || quote === "'" || quote === "`") {
    let value = "";
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (char === "\\" && next !== undefined) {
        value += next;
        index += 1;
        continue;
      }
      if (char === quote) {
        return { name: value, rest: text.slice(index + 1) };
      }
      value += char;
    }
    throw new Error("名称引号未闭合。");
  }
  const match = text.match(/^(\S+)([\s\S]*)$/);
  if (!match) {
    throw new Error("缺少名称。");
  }
  return { name: match[1], rest: match[2] || "" };
}

function parsePositiveOption(source: string, name: string, fallback: number): number {
  const match = source.match(new RegExp("\\b" + name + "\\s+(\\d+)\\b", "i"));
  if (!match) return fallback;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是大于 0 的整数。`);
  }
  return value;
}

function parseKafkaConfigEntries(source: string): IResourceConfigEntry[] {
  const entries: IResourceConfigEntry[] = [];
  const regex = /\bCONFIG\s+([A-Za-z0-9._-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s;]+)/ig;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    entries.push({ name: match[1], value: parseKafkaValueToken(match[2]) });
  }
  return dedupeKafkaConfigEntries(entries);
}

function dedupeKafkaConfigEntries(entries: IResourceConfigEntry[]): IResourceConfigEntry[] {
  const map = new Map<string, string>();
  entries.forEach((entry) => map.set(entry.name, entry.value));
  return [...map.entries()].map(([name, value]) => ({ name, value }));
}

function parseKafkaValueToken(value: string, keepRaw = false): string {
  const text = value.trim();
  const quote = text[0];
  if ((quote === "\"" || quote === "'" || quote === "`") && text[text.length - 1] === quote) {
    if (quote === "\"") {
      try {
        return JSON.parse(text);
      } catch {
        return text.slice(1, -1);
      }
    }
    return text.slice(1, -1).replace(/\\([\\'`])/g, "$1");
  }
  return keepRaw ? text : text.split(/\s+/, 1)[0] || "";
}

function buildRowsResult(rows: Record<string, unknown>[], command: string, affectedRows?: number): QueryResult {
  return {
    columns: collectColumns(rows),
    rows,
    rowCount: rows.length,
    affectedRows,
    command,
    elapsedMs: 0,
  };
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }
  return columns.length ? columns : ["result"];
}

function normalizeKafkaMessage(payload: EachMessagePayload): Record<string, unknown> {
  const message = payload.message;
  return {
    topic: payload.topic,
    partition: payload.partition,
    offset: message.offset,
    timestamp: formatKafkaTimestamp(message.timestamp),
    key: bufferToText(message.key),
    value: bufferToText(message.value),
    headers: normalizeKafkaHeaders(message.headers),
    size: message.size ?? estimateMessageSize(message.key, message.value, message.headers),
  };
}

function normalizeKafkaHeaders(headers: IHeaders | undefined): Record<string, unknown> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    if (Array.isArray(value)) {
      return [key, value.map((item) => bufferToText(item))];
    }
    return [key, bufferToText(value)];
  }));
}

function bufferToText(value: Buffer | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function formatKafkaTimestamp(value: string | undefined): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return value || "";
  }
  return new Date(timestamp).toISOString();
}

function estimateMessageSize(key: Buffer | null, value: Buffer | null, headers: IHeaders | undefined): number {
  const headerSize = headers
    ? Object.entries(headers).reduce((sum, [name, item]) => {
      const values = Array.isArray(item) ? item : [item];
      return sum + Buffer.byteLength(name) + values.reduce((inner, value) => inner + (Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value ?? ""))), 0);
    }, 0)
    : 0;
  return (key?.length ?? 0) + (value?.length ?? 0) + headerSize;
}

function matchesTopicFilter(topic: string, filter: string | undefined): boolean {
  if (!filter) return true;
  const parts = filter.split(",").map((item) => item.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.some((part) => globToRegExp(part).test(topic));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function quoteKafkaName(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value);
}

function sanitizeKafkaClientId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "database-workbench";
}

function stripTrailingSemicolon(value: string): string {
  return String(value || "").replace(/;\s*$/, "");
}
