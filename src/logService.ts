import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import { DbConnectionConfig, getLogConfig, OperationLogEntry, OperationLogSnapshot } from "./types";

type OperationType = OperationLogEntry["operationType"];
type LogStatus = OperationLogEntry["status"];

export type CreateOperationLogInput = {
  connection: DbConnectionConfig;
  database: string;
  table: string;
  operationType: OperationType;
  sql: string;
  rollbackOfLogId?: string;
  snapshots?: Array<{
    rowKey: Record<string, unknown>;
    beforeData?: Record<string, unknown> | null;
    afterData?: Record<string, unknown> | null;
  }>;
};

export class OperationLogService {
  private static databaseQueue: Promise<unknown> = Promise.resolve();
  private sqlJsPromise: Promise<SqlJsStatic> | undefined;

  async createPendingLog(input: CreateOperationLogInput): Promise<string | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    const id = randomUUID();
    await this.withDatabase((db) => {
      const targetKey = createTargetKey(input.connection.id, input.database, input.table);
      db.run(
        `INSERT INTO operation_logs (
          id, target_key, connection_id, connection_name, database_name, table_name,
          operation_type, sql_text, status, created_at, is_rollback, rollback_of_log_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          targetKey,
          input.connection.id,
          input.connection.name,
          input.database,
          input.table,
          input.operationType,
          input.sql,
          "pending",
          new Date().toISOString(),
          input.rollbackOfLogId ? 1 : 0,
          input.rollbackOfLogId ?? null,
        ]
      );

      for (const snapshot of input.snapshots ?? []) {
        db.run(
          `INSERT INTO row_snapshots (
            id, log_id, row_key_json, before_data_json, after_data_json
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            id,
            stringifyJson(snapshot.rowKey),
            stringifyNullableJson(snapshot.beforeData),
            stringifyNullableJson(snapshot.afterData),
          ]
        );
      }
      pruneOldLogs(db, targetKey, getLogRetentionLimit());
    });
    return id;
  }

  async completeLog(
    id: string | undefined,
    status: LogStatus,
    options: {
      errorMessage?: string;
      aiAnalysis?: string;
      snapshots?: Array<{
        rowKey: Record<string, unknown>;
        beforeData?: Record<string, unknown> | null;
        afterData?: Record<string, unknown> | null;
      }>;
    } = {}
  ): Promise<void> {
    if (!id || !this.isEnabled()) {
      return;
    }

    await this.withDatabase((db) => {
      db.run(
        "UPDATE operation_logs SET status = ?, completed_at = ?, error_message = ?, ai_analysis = COALESCE(?, ai_analysis) WHERE id = ?",
        [status, new Date().toISOString(), options.errorMessage ?? null, options.aiAnalysis ?? null, id]
      );
      for (const snapshot of options.snapshots ?? []) {
        const rowKeyJson = stringifyJson(snapshot.rowKey);
        db.run(
          `UPDATE row_snapshots
           SET before_data_json = COALESCE(?, before_data_json),
               after_data_json = COALESCE(?, after_data_json)
           WHERE log_id = ? AND row_key_json = ?`,
          [
            stringifyNullableJson(snapshot.beforeData),
            stringifyNullableJson(snapshot.afterData),
            id,
            rowKeyJson,
          ]
        );
        if (db.getRowsModified() === 0) {
          db.run(
            `INSERT INTO row_snapshots (
              id, log_id, row_key_json, before_data_json, after_data_json
            ) VALUES (?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              id,
              rowKeyJson,
              stringifyNullableJson(snapshot.beforeData),
              stringifyNullableJson(snapshot.afterData),
            ]
          );
        }
      }
    });
  }

  async listLogs(connection: DbConnectionConfig, database: string, table: string, limit = 100): Promise<OperationLogEntry[]> {
    if (!this.isEnabled()) {
      return [];
    }

    return this.withDatabase((db) => {
      const targetKey = createTargetKey(connection.id, database, table);
      const rows = selectRows(db, "SELECT * FROM operation_logs WHERE target_key = ? ORDER BY created_at DESC LIMIT ?", [targetKey, limit]);
      return attachRollbackLogs(rows.map((row) => {
        const id = String(row.id ?? "");
        const snapshotRows = selectRows(db, "SELECT * FROM row_snapshots WHERE log_id = ? ORDER BY id", [id]);
        return toLogEntry(row, snapshotRows);
      }));
    }, false);
  }

  async getLog(id: string): Promise<OperationLogEntry | undefined> {
    if (!this.isEnabled() || !id.trim()) {
      return undefined;
    }

    return this.withDatabase((db) => {
      const row = selectRows(db, "SELECT * FROM operation_logs WHERE id = ? LIMIT 1", [id])[0];
      if (!row) {
        return undefined;
      }
      const snapshotRows = selectRows(db, "SELECT * FROM row_snapshots WHERE log_id = ? ORDER BY id", [String(row.id ?? "")]);
      return toLogEntry(row, snapshotRows);
    }, false);
  }

  async setAiAnalysis(id: string | undefined, aiAnalysis: string): Promise<void> {
    if (!id || !this.isEnabled()) {
      return;
    }

    await this.withDatabase((db) => {
      db.run("UPDATE operation_logs SET ai_analysis = ? WHERE id = ?", [aiAnalysis, id]);
    });
  }

  async setTag(id: string | undefined, label: string, color: string): Promise<void> {
    if (!id || !this.isEnabled()) {
      return;
    }

    await this.withDatabase((db) => {
      db.run("UPDATE operation_logs SET tag_label = ?, tag_color = ? WHERE id = ?", [
        label.trim() || null,
        label.trim() ? normalizeTagColor(color) : null,
        id,
      ]);
    });
  }

  getResolvedLogDirectory(): string {
    const configured = getLogConfig().directory.trim();
    return configured || path.join(os.homedir(), "LoveyuDatabaseWorkbench", "logs");
  }

  private isEnabled(): boolean {
    return getLogConfig().enabled;
  }

  private async withDatabase<T>(callback: (db: Database) => T, write = true): Promise<T> {
    return OperationLogService.enqueueDatabaseTask(() => this.withDatabaseUnlocked(callback, write));
  }

  private static async enqueueDatabaseTask<T>(task: () => Promise<T>): Promise<T> {
    const run = OperationLogService.databaseQueue.then(task, task);
    OperationLogService.databaseQueue = run.catch(() => undefined);
    return run;
  }

  private async withDatabaseUnlocked<T>(callback: (db: Database) => T, write: boolean): Promise<T> {
    const SQL = await this.getSqlJs();
    const directory = this.getResolvedLogDirectory();
    const file = path.join(directory, "operation-logs.sqlite");
    await fs.mkdir(directory, { recursive: true });

    let data: Uint8Array | undefined;
    try {
      data = await fs.readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const db = new SQL.Database(data);
    try {
      ensureSchema(db);
      const result = callback(db);
      if (write) {
        await fs.writeFile(file, Buffer.from(db.export()));
      }
      return result;
    } finally {
      db.close();
    }
  }

  private getSqlJs(): Promise<SqlJsStatic> {
    if (!this.sqlJsPromise) {
      const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
      this.sqlJsPromise = initSqlJs({
        locateFile: (file) => file.endsWith(".wasm") ? wasmPath : file,
      });
    }
    return this.sqlJsPromise;
  }
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY,
      target_key TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_name TEXT NOT NULL,
      database_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      sql_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      error_message TEXT,
      ai_analysis TEXT,
      tag_label TEXT,
      tag_color TEXT,
      is_rollback INTEGER NOT NULL DEFAULT 0,
      rollback_of_log_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operation_logs_target_created
      ON operation_logs(target_key, created_at DESC);
    CREATE TABLE IF NOT EXISTS row_snapshots (
      id TEXT PRIMARY KEY,
      log_id TEXT NOT NULL,
      row_key_json TEXT NOT NULL,
      before_data_json TEXT,
      after_data_json TEXT,
      FOREIGN KEY(log_id) REFERENCES operation_logs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_row_snapshots_log_id ON row_snapshots(log_id);
  `);
  ensureColumn(db, "operation_logs", "ai_analysis", "TEXT");
  ensureColumn(db, "operation_logs", "tag_label", "TEXT");
  ensureColumn(db, "operation_logs", "tag_color", "TEXT");
  ensureColumn(db, "operation_logs", "is_rollback", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "operation_logs", "rollback_of_log_id", "TEXT");
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = selectRows(db, `PRAGMA table_info(${table})`).map((row) => String(row.name ?? ""));
  if (!columns.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function pruneOldLogs(db: Database, targetKey: string, maxEntries: number): void {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    return;
  }
  const oldLogs = selectRows(
    db,
    "SELECT id FROM operation_logs WHERE target_key = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?",
    [targetKey, maxEntries]
  ).map((row) => String(row.id ?? "")).filter(Boolean);
  for (const id of oldLogs) {
    db.run("DELETE FROM row_snapshots WHERE log_id = ?", [id]);
    db.run("DELETE FROM operation_logs WHERE id = ?", [id]);
  }
}

function getLogRetentionLimit(): number {
  const value = getLogConfig().maxEntriesPerTable;
  return Math.max(100, Math.min(100000, Math.floor(value || 1000)));
}

function selectRows(db: Database, sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
  const statement = db.prepare(sql, params);
  try {
    const rows: Record<string, SqlValue>[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

function toSnapshot(row: Record<string, SqlValue>): OperationLogSnapshot {
  return {
    id: String(row.id ?? ""),
    rowKey: parseJsonObject(row.row_key_json),
    beforeData: parseNullableJsonObject(row.before_data_json),
    afterData: parseNullableJsonObject(row.after_data_json),
  };
}

function toLogEntry(row: Record<string, SqlValue>, snapshotRows: Array<Record<string, SqlValue>>): OperationLogEntry {
  return {
    id: String(row.id ?? ""),
    operationType: normalizeOperationType(row.operation_type),
    sql: String(row.sql_text ?? ""),
    status: normalizeLogStatus(row.status),
    isRollback: Number(row.is_rollback ?? 0) === 1,
    rollbackOfLogId: row.rollback_of_log_id ? String(row.rollback_of_log_id) : undefined,
    connectionName: String(row.connection_name ?? ""),
    databaseName: String(row.database_name ?? ""),
    tableName: String(row.table_name ?? ""),
    createdAt: String(row.created_at ?? ""),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    aiAnalysis: row.ai_analysis ? String(row.ai_analysis) : undefined,
    tagLabel: row.tag_label ? String(row.tag_label) : undefined,
    tagColor: row.tag_color ? normalizeTagColor(String(row.tag_color)) : undefined,
    snapshots: snapshotRows.map(toSnapshot),
  };
}

function attachRollbackLogs(logs: OperationLogEntry[]): OperationLogEntry[] {
  const byParent = new Map<string, OperationLogEntry[]>();
  for (const log of logs) {
    if (!log.rollbackOfLogId) {
      continue;
    }
    const items = byParent.get(log.rollbackOfLogId) ?? [];
    items.push(log);
    byParent.set(log.rollbackOfLogId, items);
  }
  return logs.map((log) => ({
    ...log,
    rollbackLogs: byParent.get(log.id) ?? [],
  }));
}

function stringifyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value ?? {});
}

function stringifyNullableJson(value: Record<string, unknown> | null | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseNullableJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function createTargetKey(connectionId: string, database: string, table: string): string {
  return createHash("sha256")
    .update([connectionId, database, table].join("\0"))
    .digest("hex");
}

function normalizeOperationType(value: unknown): OperationType {
  return value === "insert" || value === "update" || value === "delete" || value === "schema" || value === "sql" ? value : "sql";
}

function normalizeLogStatus(value: unknown): LogStatus {
  return value === "pending" || value === "success" || value === "failed" ? value : "pending";
}

function normalizeTagColor(value: string): string {
  return ["red", "orange", "yellow", "green", "blue", "purple"].includes(value) ? value : "blue";
}
