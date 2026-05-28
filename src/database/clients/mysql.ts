import mysql from "mysql2/promise";
import { DbConnectionWithSecret, QueryResult, TableColumn, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";
import { applySafetyLimit, sliceRows } from "../core/utils";

export class MySqlClient implements DbClient {
  private constructor(private readonly connection: mysql.Connection) {}

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<MySqlClient> {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: database || config.database,
      ssl: config.ssl ? {} : undefined,
      connectTimeout: 10000,
      multipleStatements: false,
      namedPlaceholders: true,
    });
    return new MySqlClient(connection);
  }

  async ping(): Promise<void> {
    await this.connection.ping();
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT SCHEMA_NAME AS name
       FROM INFORMATION_SCHEMA.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
       ORDER BY SCHEMA_NAME`
    );
    return rows.map((row) => String(row.name));
  }

  async listTables(): Promise<string[]> {
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS name
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`
    );
    return rows.map((row) => String(row.name));
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`
    );
    return rows.map((row) => ({
      name: String(row.name),
      comment: row.comment ? String(row.comment) : "",
    }));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT c.TABLE_NAME AS tableName, c.COLUMN_NAME AS columnName, c.COLUMN_TYPE AS columnType,
              c.IS_NULLABLE AS nullable, c.COLUMN_KEY AS columnKey, c.COLUMN_DEFAULT AS defaultValue,
              c.COLUMN_COMMENT AS columnComment, c.EXTRA AS extraInfo,
              c.CHARACTER_SET_NAME AS columnCharset, c.COLLATION_NAME AS columnCollation,
              t.TABLE_COMMENT AS tableComment, t.ENGINE AS tableEngine, t.TABLE_COLLATION AS tableCollation,
              csa.CHARACTER_SET_NAME AS tableCharset
       FROM INFORMATION_SCHEMA.COLUMNS c
       LEFT JOIN INFORMATION_SCHEMA.TABLES t
         ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
        AND c.TABLE_NAME = t.TABLE_NAME
       LEFT JOIN INFORMATION_SCHEMA.COLLATION_CHARACTER_SET_APPLICABILITY csa
         ON t.TABLE_COLLATION = csa.COLLATION_NAME
       WHERE c.TABLE_SCHEMA = DATABASE()
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
    );
    const [indexRows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
              COLUMN_NAME AS columnName, SEQ_IN_INDEX AS seqInIndex
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME <> 'PRIMARY'
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
    );
    const [foreignKeyRows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS constraintName,
              k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_NAME AS referencedTableName,
              k.REFERENCED_COLUMN_NAME AS referencedColumnName, k.ORDINAL_POSITION AS ordinalPosition,
              r.UPDATE_RULE AS updateRule, r.DELETE_RULE AS deleteRule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
       LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
         ON k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA
        AND k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`
    );
    let checkRows: mysql.RowDataPacket[] = [];
    try {
      [checkRows] = await this.connection.query<mysql.RowDataPacket[]>(
        `SELECT tc.TABLE_NAME AS tableName, tc.CONSTRAINT_NAME AS constraintName,
                cc.CHECK_CLAUSE AS checkClause
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
           ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
          AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
         WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'
         ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`
      );
    } catch {
      checkRows = [];
    }
    const [triggerRows] = await this.connection.query<mysql.RowDataPacket[]>(
      `SELECT EVENT_OBJECT_TABLE AS tableName, TRIGGER_NAME AS triggerName,
              ACTION_TIMING AS actionTiming, EVENT_MANIPULATION AS eventManipulation,
              ACTION_STATEMENT AS actionStatement
       FROM INFORMATION_SCHEMA.TRIGGERS
       WHERE TRIGGER_SCHEMA = DATABASE()
       ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`
    );

    const byTable = new Map<string, TableColumn[]>();
    const tableComments = new Map<string, string>();
    const tableOptions = new Map<string, { engine?: string; charset?: string; collation?: string }>();
    for (const row of rows) {
      const tableName = String(row.tableName);
      const columns = byTable.get(tableName) ?? [];
      tableComments.set(tableName, row.tableComment ? String(row.tableComment) : "");
      tableOptions.set(tableName, {
        engine: row.tableEngine ? String(row.tableEngine) : "",
        charset: row.tableCharset ? String(row.tableCharset) : "",
        collation: row.tableCollation ? String(row.tableCollation) : "",
      });
      columns.push({
        name: String(row.columnName),
        type: String(row.columnType),
        nullable: row.nullable === "YES",
        key: row.columnKey ? String(row.columnKey) : undefined,
        defaultValue: row.defaultValue === undefined ? undefined : row.defaultValue,
        comment: row.columnComment ? String(row.columnComment) : "",
        extra: row.extraInfo ? String(row.extraInfo) : "",
        charset: row.columnCharset ? String(row.columnCharset) : "",
        collation: row.columnCollation ? String(row.columnCollation) : "",
      });
      byTable.set(tableName, columns);
    }

    const indexesByTable = new Map<string, Map<string, { name: string; unique: boolean; columns: string[] }>>();
    for (const row of indexRows) {
      const tableName = String(row.tableName);
      const indexName = String(row.indexName);
      const tableIndexes = indexesByTable.get(tableName) ?? new Map<string, { name: string; unique: boolean; columns: string[] }>();
      const index = tableIndexes.get(indexName) ?? { name: indexName, unique: Number(row.nonUnique) === 0, columns: [] };
      index.columns.push(String(row.columnName));
      tableIndexes.set(indexName, index);
      indexesByTable.set(tableName, tableIndexes);
    }

    const foreignKeysByTable = new Map<string, Map<string, { name: string; columns: string[]; referenceTable: string; referenceColumns: string[]; onUpdate?: string; onDelete?: string }>>();
    for (const row of foreignKeyRows) {
      const tableName = String(row.tableName);
      const constraintName = String(row.constraintName);
      const tableForeignKeys = foreignKeysByTable.get(tableName) ?? new Map<string, { name: string; columns: string[]; referenceTable: string; referenceColumns: string[]; onUpdate?: string; onDelete?: string }>();
      const foreignKey = tableForeignKeys.get(constraintName) ?? {
        name: constraintName,
        columns: [],
        referenceTable: String(row.referencedTableName),
        referenceColumns: [],
        onUpdate: row.updateRule ? String(row.updateRule) : "",
        onDelete: row.deleteRule ? String(row.deleteRule) : "",
      };
      foreignKey.columns.push(String(row.columnName));
      foreignKey.referenceColumns.push(String(row.referencedColumnName));
      tableForeignKeys.set(constraintName, foreignKey);
      foreignKeysByTable.set(tableName, tableForeignKeys);
    }

    const checksByTable = new Map<string, Array<{ name: string; expression: string }>>();
    for (const row of checkRows) {
      const tableName = String(row.tableName);
      const checks = checksByTable.get(tableName) ?? [];
      checks.push({ name: String(row.constraintName), expression: row.checkClause ? String(row.checkClause) : "" });
      checksByTable.set(tableName, checks);
    }

    const triggersByTable = new Map<string, Array<{ name: string; timing: string; event: string; statement: string }>>();
    for (const row of triggerRows) {
      const tableName = String(row.tableName);
      const triggers = triggersByTable.get(tableName) ?? [];
      triggers.push({
        name: String(row.triggerName),
        timing: row.actionTiming ? String(row.actionTiming) : "",
        event: row.eventManipulation ? String(row.eventManipulation) : "",
        statement: row.actionStatement ? String(row.actionStatement) : "",
      });
      triggersByTable.set(tableName, triggers);
    }

    return [...byTable.entries()].map(([name, columns]) => ({
      name,
      columns,
      comment: tableComments.get(name) ?? "",
      engine: tableOptions.get(name)?.engine ?? "",
      charset: tableOptions.get(name)?.charset ?? "",
      collation: tableOptions.get(name)?.collation ?? "",
      indexes: [...(indexesByTable.get(name)?.values() ?? [])],
      foreignKeys: [...(foreignKeysByTable.get(name)?.values() ?? [])],
      checks: checksByTable.get(name) ?? [],
      triggers: triggersByTable.get(name) ?? [],
    }));
  }

  async getCreateTableSql(table: string): Promise<string> {
    const [rows] = await this.connection.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE ${this.quoteIdentifier(table)}`);
    const createSql = rows[0]?.["Create Table"];
    if (!createSql) {
      throw new Error(`未读取到 ${table} 的建表语句。`);
    }
    return String(createSql).replace(/;\s*$/, "") + ";";
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const normalizedSql = applySafetyLimit(sql, maxRows, "mysql");
    const startedAt = Date.now();
    const [rows, fields] = await this.connection.query(normalizedSql);
    const elapsedMs = Date.now() - startedAt;

    if (Array.isArray(rows)) {
      const records = rows as Record<string, unknown>[];
      const columns = fields.map((field) => field.name);
      return {
        columns,
        rows: sliceRows(records, maxRows),
        rowCount: records.length,
        elapsedMs,
      };
    }

    const packet = rows as mysql.ResultSetHeader;
    return {
      columns: ["affectedRows", "insertId", "changedRows"],
      rows: [{ affectedRows: packet.affectedRows, insertId: packet.insertId, changedRows: packet.changedRows }],
      rowCount: 1,
      affectedRows: packet.affectedRows,
      elapsedMs,
    };
  }

  async queryInConsistentPages(sql: string, rowLimit: number, pageSize: number): Promise<QueryResult> {
    const safeLimit = Math.max(1, Math.floor(rowLimit));
    const safePageSize = Math.max(1, Math.floor(pageSize));
    const trimmedSql = sql.trim().replace(/;\s*$/, "");
    const startedAt = Date.now();
    const rows: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let transactionStarted = false;

    try {
      await this.connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await this.connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
      transactionStarted = true;

      for (let offset = 0; offset < safeLimit; offset += safePageSize) {
        const limit = Math.min(safePageSize, safeLimit - offset);
        const pageSql = `SELECT * FROM (${trimmedSql}) AS ${this.quoteIdentifier("__dbw_export_page")} LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ""}`;
        const [pageRows, fields] = await this.connection.query(pageSql);
        if (!Array.isArray(pageRows)) {
          throw new Error("导出分页读取只支持 SELECT 查询结果。");
        }
        if (!columns.length) {
          columns = fields.map((field) => field.name);
        }
        const records = pageRows as Record<string, unknown>[];
        rows.push(...records);
        if (records.length < limit) {
          break;
        }
      }

      await this.connection.query("COMMIT");
      transactionStarted = false;
      return {
        columns,
        rows,
        rowCount: rows.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await this.connection.query("ROLLBACK");
        } catch {
          // 回滚失败时保留原始导出错误，避免遮蔽真正原因。
        }
      }
      throw error;
    }
  }

  async importFromSource(
    source: MySqlClient,
    params: {
      sourceTable: string;
      targetTable: string;
      mappings: Array<{ source: string; target: string }>;
      rowLimit: number;
      batchSize: number;
    }
  ): Promise<{ insertedRows: number; elapsedMs: number }> {
    const safeLimit = Math.max(1, Math.floor(params.rowLimit));
    const safeBatchSize = Math.max(1, Math.min(5000, Math.floor(params.batchSize || 500)));
    const mappings = params.mappings.filter((mapping) => mapping.source.trim() && mapping.target.trim());
    if (!mappings.length) {
      throw new Error("请至少配置一个字段映射。");
    }
    if (new Set(mappings.map((mapping) => mapping.target)).size !== mappings.length) {
      throw new Error("目标字段不能重复映射，请检查字段对应关系。");
    }

    const sourceColumns = mappings.map((mapping) => mapping.source);
    const targetColumns = mappings.map((mapping) => mapping.target);
    const sourceSql = `SELECT ${sourceColumns.map((column) => source.quoteIdentifier(column)).join(", ")} FROM ${source.quoteIdentifier(params.sourceTable)} LIMIT ? OFFSET ?`;
    const insertSql = `INSERT INTO ${this.quoteIdentifier(params.targetTable)} (${targetColumns.map((column) => this.quoteIdentifier(column)).join(", ")}) VALUES ?`;
    const startedAt = Date.now();
    let insertedRows = 0;
    let transactionStarted = false;
    let sourceTransactionStarted = false;

    try {
      await source.connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await source.connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
      sourceTransactionStarted = true;
      await this.connection.query("START TRANSACTION");
      transactionStarted = true;
      for (let offset = 0; offset < safeLimit; offset += safeBatchSize) {
        const limit = Math.min(safeBatchSize, safeLimit - offset);
        const [pageRows] = await source.connection.query(sourceSql, [limit, offset]);
        if (!Array.isArray(pageRows)) {
          throw new Error("源表分页读取只支持 SELECT 查询结果。");
        }
        const records = pageRows as Record<string, unknown>[];
        if (!records.length) {
          break;
        }
        const values = records.map((row) => sourceColumns.map((column) => row[column]));
        const [packet] = await this.connection.query(insertSql, [values]);
        insertedRows += (packet as mysql.ResultSetHeader).affectedRows ?? records.length;
        if (records.length < limit) {
          break;
        }
      }
      await this.connection.query("COMMIT");
      transactionStarted = false;
      await source.connection.query("COMMIT");
      sourceTransactionStarted = false;
      return { insertedRows, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      if (transactionStarted) {
        try {
          await this.connection.query("ROLLBACK");
        } catch {
          // 保留原始导入错误，避免回滚错误遮蔽真正原因。
        }
      }
      if (sourceTransactionStarted) {
        try {
          await source.connection.query("ROLLBACK");
        } catch {
          // 来源读取事务回滚失败不应遮蔽真正的导入错误。
        }
      }
      throw error;
    }
  }

  async beginTransaction(): Promise<void> {
    await this.connection.query("START TRANSACTION");
  }

  async commit(): Promise<void> {
    await this.connection.query("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.connection.query("ROLLBACK");
  }

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, "``")}\``;
  }

  async dispose(): Promise<void> {
    await this.connection.end();
  }
}
