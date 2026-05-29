import { Etcd3, type IDeleteRangeResponse, type IKeyValue, type IOptions, type IRangeResponse } from "etcd3";
import { DbConnectionWithSecret, QueryResult, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";

const ETCD_KEY_SPACE = "keys";
const ETCD_DEFAULT_LIMIT = 100;
const ETCD_TREE_KEY_LIMIT = 500;
const ETCD_VALUE_PREVIEW_LENGTH = 4096;

type EtcdCommand =
  | { kind: "showKeys"; prefix: string; limit: number }
  | { kind: "get"; key: string }
  | { kind: "prefix"; prefix: string; limit: number }
  | { kind: "put"; key: string; value: string }
  | { kind: "delete"; key: string }
  | { kind: "deletePrefix"; prefix: string };

export class EtcdWorkbenchClient implements DbClient {
  private constructor(
    private readonly client: Etcd3,
    private readonly prefixFilter: string
  ) {}

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<EtcdWorkbenchClient> {
    const protocol = config.ssl ? "https" : "http";
    const options: IOptions = {
      hosts: `${protocol}://${config.host}:${config.port}`,
      dialTimeout: 10000,
      defaultCallOptions: (context) => context.isStream ? {} : { deadline: Date.now() + 30000 },
      auth: config.username ? { username: config.username, password: config.password || "" } : undefined,
    };
    const client = new Etcd3(options);
    const prefixFilter = database && database !== ETCD_KEY_SPACE ? database : config.database || "";
    return new EtcdWorkbenchClient(client, prefixFilter);
  }

  async ping(): Promise<void> {
    await this.client.maintenance.status();
  }

  async listDatabases(): Promise<string[]> {
    return [ETCD_KEY_SPACE];
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const response = await this.readPrefix(this.prefixFilter, ETCD_TREE_KEY_LIMIT);
    return (response.kvs || [])
      .map((kv) => {
        const row = normalizeEtcdKeyValue(kv, true);
        return {
          name: String(row.key),
          comment: `v${row.version} · rev ${row.modRevision} · ${row.size} bytes`,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const summaries = await this.listTableSummaries();
    return summaries.map((summary) => ({
      name: summary.name,
      comment: summary.comment,
      columns: buildEtcdColumns(),
    }));
  }

  async getCreateTableSql(key: string): Promise<string> {
    const response = await this.readKey(key);
    const row = response.kvs?.[0];
    if (!row) {
      throw new Error(`Key ${key} 不存在。`);
    }
    return `PUT ${quoteEtcdToken(key)} VALUE ${quoteEtcdValue(bufferToText(row.value))};`;
  }

  async query(commandText: string, maxRows: number): Promise<QueryResult> {
    const startedAt = Date.now();
    const command = parseEtcdCommand(commandText, maxRows || ETCD_DEFAULT_LIMIT);
    const result = await this.executeCommand(command, maxRows);
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  quoteIdentifier(identifier: string): string {
    return quoteEtcdToken(identifier);
  }

  async dispose(): Promise<void> {
    this.client.close();
  }

  private async executeCommand(command: EtcdCommand, maxRows: number): Promise<QueryResult> {
    if (command.kind === "showKeys" || command.kind === "prefix") {
      const limit = clampEtcdLimit(command.limit, maxRows);
      const response = await this.readPrefix(command.prefix, limit);
      return buildEtcdRowsResult(response, command.kind === "showKeys" ? "SHOW KEYS" : "PREFIX", true);
    }
    if (command.kind === "get") {
      const response = await this.readKey(command.key);
      return buildEtcdRowsResult(response, "GET", false);
    }
    if (command.kind === "put") {
      await this.client.put(command.key).value(command.value).exec();
      return buildRowsResult([{ key: command.key, value: command.value, saved: true }], "PUT", 1);
    }
    if (command.kind === "delete") {
      const response = await this.client.delete().key(command.key).exec();
      const deleted = readEtcdDeletedCount(response);
      return buildRowsResult([{ key: command.key, deleted }], "DELETE", deleted);
    }
    if (command.kind === "deletePrefix") {
      if (!command.prefix) {
        throw new Error("DELETE_PREFIX 需要填写非空前缀，避免误删全部 Key。");
      }
      const response = await this.client.delete().prefix(command.prefix).exec();
      const deleted = readEtcdDeletedCount(response);
      return buildRowsResult([{ prefix: command.prefix, deleted }], "DELETE_PREFIX", deleted);
    }
    return buildRowsResult([], "ETCD");
  }

  private readKey(key: string): Promise<IRangeResponse> {
    return this.client.get(key).exec();
  }

  private readPrefix(prefix: string, limit: number): Promise<IRangeResponse> {
    const builder = this.client.getAll();
    const scoped = prefix ? builder.prefix(prefix) : builder.all();
    return scoped.limit(Math.max(1, limit)).exec();
  }
}

export function parseEtcdCommand(commandText: string, maxRows = ETCD_DEFAULT_LIMIT): EtcdCommand {
  const text = stripTrailingSemicolon(commandText).trim();
  if (!text) {
    throw new Error("请输入 ETCD 命令，例如 SHOW KEYS、GET /config/app 或 PUT /config/app VALUE {...}。");
  }

  const showKeys = text.match(/^SHOW\s+KEYS(?:\s+([\s\S]+))?$/i);
  if (showKeys) {
    const rest = showKeys[1] || "";
    const prefix = readNamedEtcdOption(rest, "PREFIX") ?? "";
    const limit = parseEtcdLimit(rest, maxRows);
    return { kind: "showKeys", prefix, limit };
  }

  const prefix = readEtcdNamedCommand(text, /^(?:PREFIX|SCAN)\s+/i);
  if (prefix) {
    return { kind: "prefix", prefix: prefix.name, limit: parseEtcdLimit(prefix.rest, maxRows) };
  }

  const get = readEtcdNamedCommand(text, /^GET\s+/i);
  if (get) {
    return { kind: "get", key: get.name };
  }

  const put = readEtcdNamedCommand(text, /^(?:PUT|SET)\s+/i);
  if (put) {
    const valueMatch = put.rest.match(/^\s+(?:VALUE|=)\s+([\s\S]+)$/i);
    if (!valueMatch) {
      throw new Error("PUT 命令需要 VALUE，例如 PUT /config/app VALUE {\"enabled\":true}。");
    }
    return { kind: "put", key: put.name, value: parseEtcdValueToken(valueMatch[1].trim(), true) };
  }

  const deletePrefix = readEtcdNamedCommand(text, /^(?:DELETE_PREFIX|DEL_PREFIX|DELETE\s+PREFIX)\s+/i);
  if (deletePrefix) {
    return { kind: "deletePrefix", prefix: deletePrefix.name };
  }

  const del = readEtcdNamedCommand(text, /^(?:DELETE|DEL)\s+/i);
  if (del) {
    return { kind: "delete", key: del.name };
  }

  throw new Error("暂不支持该 ETCD 命令。支持 SHOW KEYS、GET、PREFIX、PUT、DELETE、DELETE_PREFIX。");
}

function buildEtcdRowsResult(response: IRangeResponse, command: string, preview: boolean): QueryResult {
  const rows = (response.kvs || []).map((kv) => normalizeEtcdKeyValue(kv, preview));
  return {
    columns: buildEtcdResultColumns(rows),
    rows,
    rowCount: rows.length,
    command,
    elapsedMs: 0,
    metadata: {
      count: Number(response.count || rows.length),
      more: Boolean(response.more),
      revision: response.header?.revision,
    },
  };
}

function normalizeEtcdKeyValue(kv: IKeyValue, preview: boolean): Record<string, unknown> {
  const value = bufferToText(kv.value);
  return {
    key: bufferToText(kv.key),
    value: preview ? truncateEtcdValue(value) : value,
    version: Number(kv.version || 0),
    createRevision: Number(kv.create_revision || 0),
    modRevision: Number(kv.mod_revision || 0),
    lease: kv.lease && kv.lease !== "0" ? kv.lease : "",
    size: Buffer.byteLength(value),
  };
}

function buildEtcdColumns() {
  return [
    { name: "key", type: "etcd-key", nullable: false, key: "PRI", comment: "ETCD Key" },
    { name: "value", type: "string", nullable: true, comment: "Key 当前值" },
    { name: "version", type: "int", nullable: false, comment: "Key 版本" },
    { name: "createRevision", type: "revision", nullable: false, comment: "创建 Revision" },
    { name: "modRevision", type: "revision", nullable: false, comment: "最后修改 Revision" },
    { name: "lease", type: "lease", nullable: true, comment: "关联 Lease ID" },
    { name: "size", type: "bytes", nullable: false, comment: "值大小" },
  ];
}

function buildEtcdResultColumns(rows: Record<string, unknown>[]): string[] {
  return rows.length ? ["key", "value", "version", "createRevision", "modRevision", "lease", "size"] : ["key", "value", "version", "createRevision", "modRevision", "lease", "size"];
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

function readEtcdDeletedCount(response: IDeleteRangeResponse): number {
  return Number(response.deleted || 0);
}

function clampEtcdLimit(limit: number, maxRows: number): number {
  const safe = Number.isInteger(limit) && limit > 0 ? limit : ETCD_DEFAULT_LIMIT;
  return maxRows < 0 ? safe : Math.max(1, Math.min(safe, Math.max(1, maxRows)));
}

function parseEtcdLimit(source: string, fallback: number): number {
  const match = source.match(/\bLIMIT\s+(\d+)\b/i);
  if (!match) {
    return fallback < 0 ? ETCD_DEFAULT_LIMIT : Math.max(1, fallback || ETCD_DEFAULT_LIMIT);
  }
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("LIMIT 必须是大于 0 的整数。");
  }
  return value;
}

function readNamedEtcdOption(source: string, name: string): string | undefined {
  const match = source.match(new RegExp("\\b" + name + "\\s+", "i"));
  if (!match) return undefined;
  return readEtcdToken(source.slice((match.index || 0) + match[0].length)).name;
}

function readEtcdNamedCommand(text: string, prefix: RegExp): { name: string; rest: string } | undefined {
  const match = text.match(prefix);
  if (!match) return undefined;
  return readEtcdToken(text.slice(match[0].length));
}

function readEtcdToken(source: string): { name: string; rest: string } {
  const text = source.trimStart();
  if (!text) {
    throw new Error("缺少 Key 或前缀。");
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
    throw new Error("Key 引号未闭合。");
  }
  const match = text.match(/^(\S+)([\s\S]*)$/);
  if (!match) {
    throw new Error("缺少 Key 或前缀。");
  }
  return { name: match[1], rest: match[2] || "" };
}

function parseEtcdValueToken(value: string, keepRaw = false): string {
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

function quoteEtcdToken(value: string): string {
  return /^[^\s"'`;]+$/.test(value) ? value : JSON.stringify(value);
}

function quoteEtcdValue(value: string): string {
  return /^[^\s"'`;]+$/.test(value) ? value : JSON.stringify(value);
}

function bufferToText(value: Buffer | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function truncateEtcdValue(value: string): string {
  return value.length > ETCD_VALUE_PREVIEW_LENGTH
    ? `${value.slice(0, ETCD_VALUE_PREVIEW_LENGTH)}...`
    : value;
}

function stripTrailingSemicolon(value: string): string {
  return value.replace(/;\s*$/, "");
}
