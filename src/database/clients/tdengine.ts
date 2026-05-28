import type { TaosResult, TDengineMeta, WsSql } from "@tdengine/websocket";
import { DbConnectionWithSecret, QueryResult, TableColumn, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";
import { applySafetyLimit, sliceRows } from "../core/utils";

const TDENGINE_SYSTEM_DATABASES = new Set(["information_schema", "performance_schema"]);

type TDengineModule = typeof import("@tdengine/websocket");

let tdengineModule: TDengineModule | undefined;

type TDengineRowSet = {
  columns: string[];
  rows: Record<string, unknown>[];
};

export class TDengineClient implements DbClient {
  private reqId = 1;

  private constructor(private readonly connection: WsSql) {}

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<TDengineClient> {
    const { sqlConnect, WSConfig } = getTDengineModule();
    const protocol = config.ssl ? "wss" : "ws";
    const wsConfig = new WSConfig(`${protocol}://${config.host}:${config.port}`);
    wsConfig.setUser(config.username || "root");
    wsConfig.setPwd(config.password);
    wsConfig.setTimeOut(30000);
    const targetDatabase = database || config.database;
    if (targetDatabase) {
      wsConfig.setDb(targetDatabase);
    }
    return new TDengineClient(await sqlConnect(wsConfig));
  }

  async ping(): Promise<void> {
    await this.connection.version();
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.queryRows("SHOW DATABASES");
    return rows
      .map((row) => extractFirstString(row, ["name", "database", "db_name"]))
      .filter((name): name is string => Boolean(name && !TDENGINE_SYSTEM_DATABASES.has(name.toLowerCase())))
      .sort((left, right) => left.localeCompare(right));
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const summaries: TableSummary[] = [];
    const seen = new Set<string>();
    for (const item of await this.safeShowObjectSummaries("SHOW STABLES", "超级表")) {
      if (!seen.has(item.name)) {
        summaries.push(item);
        seen.add(item.name);
      }
    }
    for (const item of await this.safeShowObjectSummaries("SHOW TABLES", "表")) {
      if (!seen.has(item.name)) {
        summaries.push(item);
        seen.add(item.name);
      }
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const summaries = await this.listTableSummaries();
    const tables: TableInfo[] = [];
    for (const summary of summaries) {
      const columns = await this.describeTable(summary.name);
      tables.push({
        name: summary.name,
        comment: summary.comment,
        columns,
      });
    }
    return tables;
  }

  async getCreateTableSql(table: string): Promise<string> {
    const quoted = this.quoteIdentifier(table);
    for (const statement of [`SHOW CREATE STABLE ${quoted}`, `SHOW CREATE TABLE ${quoted}`]) {
      try {
        const rows = await this.queryRows(statement);
        const createSql = rows
          .flatMap((row) => Object.values(row))
          .map((value) => String(value ?? ""))
          .find((value) => /\bCREATE\s+(?:STABLE|TABLE)\b/i.test(value));
        if (createSql) {
          return createSql.trim().replace(/;\s*$/, "") + ";";
        }
      } catch {
        // TDengine 对普通表/超级表的 SHOW CREATE 支持可能不同，失败后继续尝试下一种。
      }
    }

    const columns = await this.describeTable(table);
    if (!columns.length) {
      throw new Error(`未读取到 ${table} 的表结构。`);
    }
    const tagColumns = columns.filter((column) => /\bTAG\b/i.test(column.comment || ""));
    const dataColumns = columns.filter((column) => !tagColumns.includes(column));
    const dataLines = dataColumns.map((column) => `  ${this.quoteIdentifier(column.name)} ${column.type}`);
    const tagSql = tagColumns.length
      ? ` TAGS (${tagColumns.map((column) => `${this.quoteIdentifier(column.name)} ${column.type}`).join(", ")})`
      : "";
    return `${tagColumns.length ? "CREATE STABLE" : "CREATE TABLE"} ${quoted} (\n${dataLines.join(",\n")}\n)${tagSql};`;
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const normalizedSql = applySafetyLimit(sql, maxRows, "tdengine");
    const startedAt = Date.now();
    if (isTDengineRowsQuery(normalizedSql)) {
      const rowSet = await this.queryRowSet(normalizedSql);
      const rows = rowSet.rows;
      const slicedRows = sliceRows(rows, maxRows);
      return {
        columns: rowSet.columns.length ? rowSet.columns : collectColumns(slicedRows, rows),
        rows: slicedRows,
        rowCount: rows.length,
        command: getTDengineCommand(normalizedSql),
        elapsedMs: Date.now() - startedAt,
      };
    }

    const result = await this.connection.exec(normalizedSql, this.nextReqId());
    const affectedRows = normalizeAffectedRows(result);
    return {
      columns: ["affectedRows"],
      rows: [{ affectedRows }],
      rowCount: 1,
      affectedRows,
      command: getTDengineCommand(normalizedSql),
      elapsedMs: Date.now() - startedAt,
    };
  }

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, "``")}\``;
  }

  async dispose(): Promise<void> {
    await this.connection.close();
  }

  private async safeShowObjectSummaries(sql: string, label: string): Promise<TableSummary[]> {
    try {
      const rows = await this.queryRows(sql);
      return rows
        .map((row) => extractFirstString(row, ["name", "table_name", "stable_name", "stb_name"]))
        .filter((name): name is string => Boolean(name))
        .map((name) => ({ name, comment: label }));
    } catch {
      return [];
    }
  }

  private async describeTable(table: string): Promise<TableColumn[]> {
    const rows = await this.queryRows(`DESCRIBE ${this.quoteIdentifier(table)}`);
    return rows.map((row, index) => normalizeDescribeRow(row, index));
  }

  private async queryRows(sql: string): Promise<Record<string, unknown>[]> {
    return (await this.queryRowSet(sql)).rows;
  }

  private async queryRowSet(sql: string): Promise<TDengineRowSet> {
    const rows = await this.connection.query(sql, this.nextReqId());
    try {
      const meta = rows.getMeta() ?? [];
      const result: Record<string, unknown>[] = [];
      while (await rows.next()) {
        const data = rows.getData() ?? [];
        result.push(normalizeTDengineRow(meta, data));
      }
      return {
        columns: meta.map((column) => column.name),
        rows: result,
      };
    } finally {
      await rows.close();
    }
  }

  private nextReqId(): number {
    this.reqId += 1;
    return this.reqId;
  }
}

function getTDengineModule(): TDengineModule {
  if (!tdengineModule) {
    tdengineModule = loadTDengineModuleWithoutFileLogger();
    tdengineModule.setLogLevel("error");
  }
  return tdengineModule;
}

function loadTDengineModuleWithoutFileLogger(): TDengineModule {
  const nodeModule = require("module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = nodeModule._load;
  nodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "winston-daily-rotate-file") {
      const winston = originalLoad.call(this, "winston", parent, isMain) as {
        transports: { Console: new (options?: Record<string, unknown>) => unknown };
      };
      return function SilentTDengineRotateFile(options?: Record<string, unknown>): unknown {
        return new winston.transports.Console({
          level: String(options?.level || "error"),
          silent: true,
        });
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("@tdengine/websocket") as TDengineModule;
  } finally {
    nodeModule._load = originalLoad;
  }
}

function isTDengineRowsQuery(sql: string): boolean {
  return /^(select|with|show|describe|desc|explain)\b/i.test(sql.trim());
}

function getTDengineCommand(sql: string): string {
  return sql.trim().split(/\s+/, 1)[0]?.toUpperCase() || "SQL";
}

function normalizeAffectedRows(result: TaosResult): number {
  const value = result.getAffectRows();
  return typeof value === "number" ? value : 0;
}

function normalizeTDengineRow(meta: TDengineMeta[], data: unknown[]): Record<string, unknown> {
  return Object.fromEntries(meta.map((column, index) => [column.name, normalizeTDengineValue(data[index])]));
}

function normalizeTDengineValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeTDengineValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeTDengineValue(item)]));
  }
  return value;
}

function normalizeDescribeRow(row: Record<string, unknown>, index: number): TableColumn {
  const field = extractFirstString(row, ["field", "Field", "name", "column_name"]) || `column_${index + 1}`;
  const rawType = extractFirstString(row, ["type", "Type", "data_type"]) || "unknown";
  const length = extractFirstString(row, ["length", "Length"]);
  const note = extractFirstString(row, ["note", "Note", "comment", "Comment"], false) || "";
  const type = length && Number(length) > 0 && /^(binary|varchar|nchar|varbinary)$/i.test(rawType)
    ? `${rawType}(${length})`
    : rawType;
  return {
    name: field,
    type,
    nullable: index !== 0,
    key: index === 0 && /^timestamp$/i.test(rawType) ? "PRI" : undefined,
    comment: note,
  };
}

function extractFirstString(row: Record<string, unknown>, candidates: string[], fallbackToFirst = true): string | undefined {
  const lowerKeyMap = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  for (const candidate of candidates) {
    const key = Object.prototype.hasOwnProperty.call(row, candidate)
      ? candidate
      : lowerKeyMap.get(candidate.toLowerCase());
    if (!key) continue;
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  if (!fallbackToFirst) {
    return undefined;
  }
  const first = Object.values(row).find((value) => value !== undefined && value !== null && String(value).trim());
  return first === undefined ? undefined : String(first).trim();
}

function collectColumns(rows: Record<string, unknown>[], allRows: Record<string, unknown>[]): string[] {
  const source = rows.length ? rows : allRows;
  const columns: string[] = [];
  for (const row of source) {
    for (const column of Object.keys(row)) {
      if (!columns.includes(column)) {
        columns.push(column);
      }
    }
  }
  return columns.length ? columns : ["result"];
}
