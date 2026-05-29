import { randomUUID } from "node:crypto";
import { connectAsync, type IClientOptions, type IClientPublishOptions, type IPublishPacket, type MqttClient } from "mqtt";
import { DbConnectionWithSecret, QueryResult, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";
import { sliceRows } from "../core/utils";

const MQTT_SUBSCRIPTION_SPACE = "subscriptions";
const DEFAULT_SUBSCRIBE_LIMIT = 50;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 10000;
export const MQTT_MESSAGE_COLUMNS = ["topic", "qos", "retain", "dup", "timestamp", "payload", "json", "size", "messageId"];

export type MqttCommand =
  | { kind: "showSubscriptions" }
  | { kind: "ping" }
  | { kind: "subscribe"; topic: string; qos: 0 | 1 | 2; limit: number; timeoutMs: number }
  | { kind: "unsubscribe"; topic: string }
  | { kind: "publish"; topic: string; qos: 0 | 1 | 2; retain: boolean; payload: string };

export type MqttLiveSubscription = {
  topic: string;
  dispose(): Promise<void>;
};

export class MqttWorkbenchClient implements DbClient {
  private readonly options: IClientOptions;
  private readonly topicFilters: string[];

  private constructor(config: DbConnectionWithSecret, database?: string) {
    this.topicFilters = parseMqttTopicFilters(database && database !== MQTT_SUBSCRIPTION_SPACE ? database : config.database);
    this.options = createMqttClientOptions(config, "client");
  }

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<MqttWorkbenchClient> {
    return new MqttWorkbenchClient(config, database);
  }

  async ping(): Promise<void> {
    await this.withClient(async () => undefined);
  }

  async listDatabases(): Promise<string[]> {
    return [MQTT_SUBSCRIPTION_SPACE];
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    return this.topicFilters.map((topic) => ({
      name: topic,
      comment: "MQTT 订阅 Topic",
    }));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const summaries = await this.listTableSummaries();
    return summaries.map((summary) => ({
      name: summary.name,
      comment: summary.comment,
      columns: buildMqttColumns(),
    }));
  }

  async getCreateTableSql(topic: string): Promise<string> {
    return `SUBSCRIBE ${quoteMqttTopic(topic)} LIMIT 30 TIMEOUT ${DEFAULT_SUBSCRIBE_TIMEOUT_MS};`;
  }

  async query(commandText: string, maxRows: number): Promise<QueryResult> {
    const startedAt = Date.now();
    const command = parseMqttCommand(commandText, maxRows);
    const result = await this.executeCommand(command, maxRows);
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  quoteIdentifier(identifier: string): string {
    return quoteMqttTopic(identifier);
  }

  async dispose(): Promise<void> {
    // MQTT.js 客户端按单次操作创建并关闭，这里无需额外释放。
  }

  private async executeCommand(command: MqttCommand, maxRows: number): Promise<QueryResult> {
    if (command.kind === "showSubscriptions") {
      return buildRowsResult(this.topicFilters.map((topic) => ({ topic })), "SHOW SUBSCRIPTIONS");
    }
    if (command.kind === "ping") {
      await this.ping();
      return buildRowsResult([{ connected: true }], "PING", 1);
    }
    if (command.kind === "subscribe") {
      return this.subscribeMessages(command, maxRows);
    }
    if (command.kind === "unsubscribe") {
      return this.withClient(async (client) => {
        await client.unsubscribeAsync(command.topic);
        return buildRowsResult([{ topic: command.topic, unsubscribed: true }], "UNSUBSCRIBE", 1);
      });
    }
    if (command.kind === "publish") {
      return this.withClient(async (client) => {
        const options: IClientPublishOptions = { qos: command.qos, retain: command.retain };
        const packet = await client.publishAsync(command.topic, command.payload, options);
        return {
          columns: MQTT_MESSAGE_COLUMNS,
          rows: [normalizePublishedMqttMessage(command.topic, command.payload, command.qos, command.retain, packet)],
          rowCount: 1,
          affectedRows: 1,
          command: "PUBLISH",
          elapsedMs: 0,
        };
      });
    }
    return buildRowsResult([], "MQTT");
  }

  private async subscribeMessages(command: Extract<MqttCommand, { kind: "subscribe" }>, maxRows: number): Promise<QueryResult> {
    const limit = Math.max(1, Math.min(maxRows < 0 ? DEFAULT_SUBSCRIBE_LIMIT : maxRows, command.limit));
    return this.withClient(async (client) => new Promise<QueryResult>((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      let finished = false;
      let grantedQos: number | string = command.qos;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        client.off("message", onMessage);
        void client.unsubscribeAsync(command.topic)
          .catch(() => undefined)
          .then(() => {
            if (error) {
              reject(error);
              return;
            }
            resolve({
              columns: MQTT_MESSAGE_COLUMNS,
              rows: sliceRows(rows, limit),
              rowCount: rows.length,
              command: "SUBSCRIBE",
              elapsedMs: 0,
              metadata: { topic: command.topic, qos: grantedQos, timeoutMs: command.timeoutMs },
            });
          });
      };
      const onMessage = (topic: string, payload: Buffer, packet: IPublishPacket) => {
        rows.push(normalizeMqttMessage(topic, payload, packet));
        if (rows.length >= limit) {
          finish();
        }
      };
      const timer = setTimeout(() => finish(), Math.max(1000, command.timeoutMs));
      client.on("message", onMessage);
      client.subscribeAsync(command.topic, { qos: command.qos })
        .then((granted) => {
          grantedQos = granted[0]?.qos ?? command.qos;
        })
        .catch((error) => finish(error));
    }));
  }

  private async withClient<T>(callback: (client: MqttClient) => Promise<T>): Promise<T> {
    const client = await connectAsync(this.options);
    try {
      return await callback(client);
    } finally {
      await client.endAsync(false).catch(() => undefined);
    }
  }
}

export async function createMqttLiveSubscription(
  config: DbConnectionWithSecret,
  topic: string,
  onMessage: (row: Record<string, unknown>) => void,
  onError: (error: unknown) => void,
  onStatus?: (message: string) => void,
  qos: 0 | 1 | 2 = 0
): Promise<MqttLiveSubscription> {
  assertMqttTopicFilter(topic);
  const client = await connectAsync(createMqttClientOptions(config, "live", true));
  let disposed = false;
  let subscribed = false;
  const handleMessage = (receivedTopic: string, payload: Buffer, packet: IPublishPacket) => {
    if (!disposed) {
      onMessage(normalizeMqttMessage(receivedTopic, payload, packet));
    }
  };
  const handleError = (error: unknown) => {
    if (!disposed) {
      onError(error);
    }
  };
  const handleClose = () => {
    if (!disposed) {
      onStatus?.("MQTT 持续订阅连接已断开，正在等待重连。");
    }
  };
  const handleReconnect = () => {
    if (!disposed) {
      onStatus?.("MQTT 持续订阅正在重连。");
    }
  };
  const handleConnect = () => {
    if (!disposed && subscribed) {
      onStatus?.(`MQTT 已连接，正在持续订阅 ${topic}。`);
    }
  };

  client.on("message", handleMessage);
  client.on("error", handleError);
  client.on("close", handleClose);
  client.on("reconnect", handleReconnect);
  client.on("connect", handleConnect);
  try {
    await client.subscribeAsync(topic, { qos });
    subscribed = true;
    onStatus?.(`MQTT 已持续订阅 ${topic}，新消息会实时展示。`);
  } catch (error) {
    disposed = true;
    client.off("message", handleMessage);
    client.off("error", handleError);
    client.off("close", handleClose);
    client.off("reconnect", handleReconnect);
    client.off("connect", handleConnect);
    await client.endAsync(true).catch(() => undefined);
    throw error;
  }

  return {
    topic,
    async dispose() {
      if (disposed) return;
      disposed = true;
      client.off("message", handleMessage);
      client.off("error", handleError);
      client.off("close", handleClose);
      client.off("reconnect", handleReconnect);
      client.off("connect", handleConnect);
      if (subscribed) {
        await client.unsubscribeAsync(topic).catch(() => undefined);
      }
      await client.endAsync(false).catch(() => undefined);
    },
  };
}

function createMqttClientOptions(config: DbConnectionWithSecret, label: string, live = false): IClientOptions {
  return {
    protocol: config.ssl ? "mqtts" : "mqtt",
    host: config.host,
    port: config.port,
    username: config.username || undefined,
    password: config.password || undefined,
    clientId: sanitizeMqttClientId(`database-workbench-${label}-${config.name || "client"}-${randomUUID().slice(0, 8)}`),
    clean: true,
    reconnectPeriod: live ? 2000 : 0,
    connectTimeout: 10000,
    resubscribe: live,
    rejectUnauthorized: config.ssl ? !config.allowInsecureTls : undefined,
  };
}

export function parseMqttCommand(commandText: string, maxRows = DEFAULT_SUBSCRIBE_LIMIT): MqttCommand {
  const text = stripTrailingSemicolon(commandText).trim();
  if (!text) {
    throw new Error("请输入 MQTT 命令，例如 SUBSCRIBE sensors/# LIMIT 20 或 PUBLISH sensors/1 PAYLOAD hello。");
  }
  if (/^(SHOW|LIST)\s+SUBSCRIPTIONS$/i.test(text)) {
    return { kind: "showSubscriptions" };
  }
  if (/^PING$/i.test(text)) {
    return { kind: "ping" };
  }
  const subscribe = parseNamedCommand(text, /^(SUBSCRIBE|SUB)\s+/i);
  if (subscribe) {
    assertMqttTopicFilter(subscribe.name);
    const qos = parseMqttQosOption(subscribe.rest, 0);
    const limit = parsePositiveOption(subscribe.rest, "LIMIT", maxRows < 0 ? DEFAULT_SUBSCRIBE_LIMIT : Math.max(1, maxRows));
    const timeoutMs = parsePositiveOption(subscribe.rest, "TIMEOUT", DEFAULT_SUBSCRIBE_TIMEOUT_MS);
    return { kind: "subscribe", topic: subscribe.name, qos, limit, timeoutMs };
  }
  const unsubscribe = parseNamedCommand(text, /^(UNSUBSCRIBE|UNSUB)\s+/i);
  if (unsubscribe) {
    assertMqttTopicFilter(unsubscribe.name);
    return { kind: "unsubscribe", topic: unsubscribe.name };
  }
  const publish = parseNamedCommand(text, /^(PUBLISH|PUB)\s+/i);
  if (publish) {
    return parseMqttPublishCommand(publish.name, publish.rest);
  }
  throw new Error("暂不支持该 MQTT 命令。支持 SHOW SUBSCRIPTIONS、PING、SUBSCRIBE、UNSUBSCRIBE、PUBLISH。");
}

export function parseMqttTopicFilters(value: string | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((topic) => {
      if (seen.has(topic)) return;
      assertMqttTopicFilter(topic);
      seen.add(topic);
      result.push(topic);
    });
  return result;
}

function parseMqttPublishCommand(topic: string, rest: string): MqttCommand {
  assertMqttPublishTopic(topic);
  const qos = parseMqttQosOption(rest, 0);
  const retain = /\bRETAIN\b/i.test(rest);
  const payloadMatch = rest.match(/\b(?:PAYLOAD|MESSAGE|VALUE)\s+([\s\S]+)$/i);
  let payload = payloadMatch?.[1]?.trim();
  if (!payload) {
    payload = rest
      .replace(/\bQOS\s+[012]\b/ig, "")
      .replace(/\bRETAIN\b/ig, "")
      .trim();
  }
  if (!payload) {
    throw new Error("PUBLISH 命令需要消息内容，例如 PUBLISH sensors/1 PAYLOAD {\"temperature\":26}。");
  }
  return { kind: "publish", topic, qos, retain, payload: parseMqttPayloadToken(payload) };
}

function parseNamedCommand(text: string, prefix: RegExp): { name: string; rest: string } | undefined {
  const match = text.match(prefix);
  if (!match) return undefined;
  return readMqttName(text.slice(match[0].length));
}

function readMqttName(source: string): { name: string; rest: string } {
  const text = source.trimStart();
  if (!text) {
    throw new Error("缺少 Topic。");
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
    throw new Error("Topic 引号未闭合。");
  }
  const match = text.match(/^(\S+)([\s\S]*)$/);
  if (!match) {
    throw new Error("缺少 Topic。");
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

function parseMqttQosOption(source: string, fallback: 0 | 1 | 2): 0 | 1 | 2 {
  const match = source.match(/\bQOS\s+(\d+)\b/i);
  if (!match) return fallback;
  const value = Number(match[1]);
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new Error("QoS 只能是 0、1 或 2。");
  }
  return value;
}

function parseMqttPayloadToken(value: string): string {
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
  return text;
}

function buildMqttColumns() {
  return [
    { name: "topic", type: "string", nullable: false, comment: "实际收到消息的 Topic" },
    { name: "qos", type: "int", nullable: false, comment: "消息 QoS" },
    { name: "retain", type: "boolean", nullable: false, comment: "是否保留消息" },
    { name: "dup", type: "boolean", nullable: false, comment: "是否重复投递" },
    { name: "timestamp", type: "timestamp", nullable: false, comment: "插件收到消息的时间" },
    { name: "payload", type: "string", nullable: true, comment: "消息内容" },
    { name: "json", type: "json", nullable: true, comment: "消息内容可解析为 JSON 时展示" },
    { name: "size", type: "int", nullable: true, comment: "消息字节数" },
    { name: "messageId", type: "int", nullable: true, comment: "MQTT 消息 ID" },
  ];
}

function normalizeMqttMessage(topic: string, payload: Buffer, packet: IPublishPacket): Record<string, unknown> {
  const text = payload.toString("utf8");
  return {
    topic,
    qos: packet.qos ?? "",
    retain: Boolean(packet.retain),
    dup: Boolean(packet.dup),
    timestamp: new Date().toISOString(),
    payload: text,
    json: parseJsonPayload(text),
    size: payload.length,
    messageId: packet.messageId ?? "",
  };
}

function normalizePublishedMqttMessage(
  topic: string,
  payload: string,
  qos: 0 | 1 | 2,
  retain: boolean,
  packet: { messageId?: number } | undefined
): Record<string, unknown> {
  const bytes = Buffer.from(payload, "utf8");
  return {
    topic,
    qos,
    retain,
    dup: false,
    timestamp: new Date().toISOString(),
    payload,
    json: parseJsonPayload(payload),
    size: bytes.length,
    messageId: packet?.messageId ?? "",
  };
}

function parseJsonPayload(value: string): unknown {
  const text = value.trim();
  if (!text || !/^[\[{]/.test(text)) return "";
  try {
    return JSON.parse(text);
  } catch {
    return "";
  }
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

function assertMqttTopicFilter(topic: string): void {
  const text = topic.trim();
  if (!text) {
    throw new Error("MQTT Topic 不能为空。");
  }
  if (text.includes("\0")) {
    throw new Error("MQTT Topic 不能包含空字符。");
  }
  const levels = text.split("/");
  levels.forEach((level, index) => {
    if (level.includes("#") && (level !== "#" || index !== levels.length - 1)) {
      throw new Error("MQTT 多层通配符 # 只能单独作为最后一级。");
    }
    if (level.includes("+") && level !== "+") {
      throw new Error("MQTT 单层通配符 + 必须单独占一级。");
    }
  });
}

function assertMqttPublishTopic(topic: string): void {
  assertMqttTopicFilter(topic);
  if (topic.includes("#") || topic.includes("+")) {
    throw new Error("发布消息的 Topic 不能包含 + 或 # 通配符。");
  }
}

function quoteMqttTopic(value: string): string {
  return /^[^\s"'`]+$/.test(value) ? value : JSON.stringify(value);
}

function sanitizeMqttClientId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 90) || "database-workbench";
}

function stripTrailingSemicolon(value: string): string {
  return String(value || "").replace(/;\s*$/, "");
}
