import * as http from "http";
import * as https from "https";
import mysql from "mysql2/promise";
import { BSON, MongoClient, ObjectId, type Document, type Filter } from "mongodb";
import { Client as PgClient } from "pg";
import { createClient as createRedisClient } from "redis";
import {
  DatabaseType,
  DbConnectionWithSecret,
  getElasticsearchConfig,
  QueryResult,
  TableColumn,
  TableInfo,
  TableSummary,
} from "../types";

export class DatabaseService {
  async testConnection(connection: DbConnectionWithSecret): Promise<void> {
    await withClient(connection, undefined, async (client) => {
      await client.ping();
    });
  }

  async listDatabases(connection: DbConnectionWithSecret): Promise<string[]> {
    return withClient(connection, undefined, (client) => client.listDatabases());
  }

  async listTables(connection: DbConnectionWithSecret, database: string): Promise<string[]> {
    return withClient(connection, database, (client) => client.listTables());
  }

  async listTableSummaries(connection: DbConnectionWithSecret, database: string): Promise<TableSummary[]> {
    return withClient(connection, database, (client) => client.listTableSummaries());
  }

  async loadSchema(connection: DbConnectionWithSecret, database: string): Promise<TableInfo[]> {
    return withClient(connection, database, (client) => client.loadSchema());
  }

  async getCreateTableSql(connection: DbConnectionWithSecret, database: string, table: string): Promise<string> {
    return withClient(connection, database, (client) => client.getCreateTableSql(table));
  }

  async getDatabaseCreateTableSql(connection: DbConnectionWithSecret, database: string): Promise<Array<{ table: string; sql: string }>> {
    if (connection.type !== "mysql") {
      throw new Error("复制整个数据库表结构暂时只支持 MySQL。");
    }
    return withClient(connection, database, async (client) => {
      const tables = await client.listTables();
      const ddlList: Array<{ table: string; sql: string }> = [];
      for (const table of tables) {
        ddlList.push({ table, sql: await client.getCreateTableSql(table) });
      }
      return ddlList;
    });
  }

  async previewTable(
    connection: DbConnectionWithSecret,
    database: string,
    table: string,
    limit: number
  ): Promise<{ sql: string; result: QueryResult }> {
    if (connection.type === "redis") {
      const command = `INSPECT ${table}`;
      const result = await withClient(connection, database, (client) => client.query(command, limit));
      return { sql: command, result };
    }
    if (connection.type === "elasticsearch") {
      const size = limit < 0 ? 100 : Math.max(1, limit);
      const sql = `POST /${encodePathPart(table)}/_search\n${JSON.stringify({ query: { match_all: {} }, size }, null, 2)}`;
      const result = await withClient(connection, database, (client) => client.query(sql, limit));
      return { sql, result };
    }
    if (connection.type === "mongodb") {
      const size = limit < 0 ? 100 : Math.max(1, limit);
      const command = `db.getCollection(${JSON.stringify(table)}).find({}).limit(${size})`;
      const result = await withClient(connection, database, (client) => client.query(command, limit));
      return { sql: command, result };
    }
    return withClient(connection, database, async (client) => {
      const sql = limit < 0
        ? `SELECT * FROM ${client.quoteIdentifier(table)}`
        : `SELECT * FROM ${client.quoteIdentifier(table)} LIMIT ${Math.max(1, limit)}`;
      const result = await client.query(sql, limit);
      return { sql, result };
    });
  }

  async query(
    connection: DbConnectionWithSecret,
    database: string,
    sql: string,
    maxRows: number
  ): Promise<QueryResult> {
    return withClient(connection, database, (client) => client.query(sql, maxRows));
  }

  async queryStatements(
    connection: DbConnectionWithSecret,
    database: string,
    statements: string[],
    maxRows: number,
    beforeEach?: (statement: string, index: number) => void
  ): Promise<QueryResult[]> {
    const executableStatements = statements.map((statement) => statement.trim()).filter(Boolean);
    return withClient(connection, database, async (client) => {
      const transactionalClient = executableStatements.length > 1 && supportsClientTransactions(client) ? client : undefined;
      const results: QueryResult[] = [];
      let transactionStarted = false;
      let activeIndex = -1;
      try {
        if (transactionalClient) {
          await transactionalClient.beginTransaction();
          transactionStarted = true;
        }
        for (let index = 0; index < executableStatements.length; index += 1) {
          const statement = executableStatements[index];
          activeIndex = index;
          beforeEach?.(statement, index);
          results.push(await client.query(statement, maxRows));
        }
        if (transactionStarted) {
          await transactionalClient?.commit();
          transactionStarted = false;
        }
        return results;
      } catch (error) {
        if (transactionStarted) {
          try {
            await transactionalClient?.rollback();
          } catch (rollbackError) {
            throw new QueryStatementsError(error, activeIndex, executableStatements[activeIndex] || "", results, rollbackError);
          }
        }
        throw new QueryStatementsError(error, activeIndex, executableStatements[activeIndex] || "", results);
      }
    });
  }

  async queryMysqlInConsistentPages(
    connection: DbConnectionWithSecret,
    database: string,
    sql: string,
    rowLimit: number,
    pageSize: number
  ): Promise<QueryResult> {
    if (connection.type !== "mysql") {
      throw new Error("当前连接类型不支持 MySQL 分页事务导出。");
    }
    return withClient(connection, database, async (client) => {
      if (!(client instanceof MySqlClient)) {
        throw new Error("当前连接不是 MySQL 客户端。");
      }
      return client.queryInConsistentPages(sql, rowLimit, pageSize);
    });
  }

  async importMysqlTableData(params: {
    sourceConnection: DbConnectionWithSecret;
    sourceDatabase: string;
    sourceTable: string;
    targetConnection: DbConnectionWithSecret;
    targetDatabase: string;
    targetTable: string;
    mappings: Array<{ source: string; target: string }>;
    rowLimit: number;
    batchSize: number;
  }): Promise<{ insertedRows: number; elapsedMs: number }> {
    if (params.sourceConnection.type !== "mysql" || params.targetConnection.type !== "mysql") {
      throw new Error("当前导入功能暂时只支持 MySQL 到 MySQL。");
    }
    const sourceClient = await createClient(params.sourceConnection, params.sourceDatabase);
    const targetClient = await createClient(params.targetConnection, params.targetDatabase);
    try {
      if (!(sourceClient instanceof MySqlClient) || !(targetClient instanceof MySqlClient)) {
        throw new Error("当前导入功能暂时只支持 MySQL 到 MySQL。");
      }
      return await targetClient.importFromSource(sourceClient, params);
    } finally {
      await Promise.allSettled([sourceClient.dispose(), targetClient.dispose()]);
    }
  }

  async queryAdmin(
    connection: DbConnectionWithSecret,
    sql: string,
    maxRows: number
  ): Promise<QueryResult> {
    if (connection.type !== "mysql" && connection.type !== "postgres") {
      throw new Error("当前连接类型不支持管理 SQL。");
    }
    const adminDatabase = connection.type === "postgres" ? "postgres" : undefined;
    return withClient(connection, adminDatabase, (client) => client.query(sql, maxRows));
  }
}

interface DbClient {
  ping(): Promise<void>;
  listDatabases(): Promise<string[]>;
  listTables(): Promise<string[]>;
  listTableSummaries(): Promise<TableSummary[]>;
  loadSchema(): Promise<TableInfo[]>;
  getCreateTableSql(table: string): Promise<string>;
  query(sql: string, maxRows: number): Promise<QueryResult>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  quoteIdentifier(identifier: string): string;
  dispose(): Promise<void>;
}

class QueryStatementsError extends Error {
  readonly failedIndex: number;
  readonly statement: string;
  readonly results: QueryResult[];
  readonly rollbackError?: unknown;

  constructor(error: unknown, failedIndex: number, statement: string, results: QueryResult[], rollbackError?: unknown) {
    super(getClientErrorMessage(error));
    this.name = "QueryStatementsError";
    this.cause = error;
    this.failedIndex = failedIndex;
    this.statement = statement;
    this.results = results;
    this.rollbackError = rollbackError;
  }
}

function supportsClientTransactions(client: DbClient): client is DbClient & Required<Pick<DbClient, "beginTransaction" | "commit" | "rollback">> {
  return typeof client.beginTransaction === "function"
    && typeof client.commit === "function"
    && typeof client.rollback === "function";
}

function getClientErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withClient<T>(
  connection: DbConnectionWithSecret,
  database: string | undefined,
  callback: (client: DbClient) => Promise<T> | T
): Promise<T> {
  const client = await createClient(connection, database);
  try {
    return await callback(client);
  } finally {
    await client.dispose();
  }
}

async function createClient(connection: DbConnectionWithSecret, database?: string): Promise<DbClient> {
  if (connection.type === "mysql") {
    return MySqlClient.connect(connection, database);
  }
  if (connection.type === "postgres") {
    return PostgresClient.connect(connection, database);
  }
  if (connection.type === "redis") {
    return RedisWorkbenchClient.connect(connection, database);
  }
  if (connection.type === "mongodb") {
    return MongoWorkbenchClient.connect(connection, database);
  }

  return ElasticsearchWorkbenchClient.connect(connection);
}

class MySqlClient implements DbClient {
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

function isPostgresGeneratedDefault(defaultValue: string | null | undefined): boolean {
  return /nextval\(/i.test(String(defaultValue || ""));
}

function toPostgresSqlLiteral(value: unknown): string {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

class PostgresClient implements DbClient {
  private constructor(private readonly client: PgClient) {}

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<PostgresClient> {
    const client = new PgClient({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: database || config.database || "postgres",
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
      statement_timeout: 30000,
    });
    await client.connect();
    return new PostgresClient(client);
  }

  async ping(): Promise<void> {
    await this.client.query("SELECT 1");
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname"
    );
    return result.rows.map((row) => row.datname);
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const result = await this.client.query<{ table_name: string; table_schema: string; raw_table_name: string; table_comment: string | null }>(
      `SELECT CASE WHEN t.table_schema = 'public' THEN t.table_name ELSE t.table_schema || '.' || t.table_name END AS table_name,
              t.table_schema AS table_schema,
              t.table_name AS raw_table_name,
              obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass::oid, 'pg_class') AS table_comment
       FROM information_schema.tables t
       WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema') AND t.table_schema NOT LIKE 'pg_toast%' AND t.table_schema NOT LIKE 'pg_temp_%' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_schema, t.table_name`
    );
    return result.rows.map((row) => ({
      name: row.table_name,
      schema: row.table_schema,
      displayName: row.raw_table_name,
      comment: row.table_comment ?? "",
    }));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const result = await this.client.query<{
      table_name: string;
      table_schema: string;
      raw_table_name: string;
      column_name: string;
      data_type: string;
      not_null: boolean;
      column_default: string | null;
      column_key: string | null;
      primary_key_name: string | null;
      column_comment: string | null;
      table_comment: string | null;
      is_identity: boolean;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS table_name,
              n.nspname AS table_schema,
              c.relname AS raw_table_name,
              a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
              a.attnotnull AS not_null,
              pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
              a.attidentity <> '' AS is_identity,
              CASE WHEN pk.conname IS NOT NULL THEN 'PRI' ELSE NULL END AS column_key,
              pk.conname AS primary_key_name,
              col_description(c.oid, a.attnum) AS column_comment,
              obj_description(c.oid, 'pg_class') AS table_comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
       LEFT JOIN (
         SELECT conrelid, conname, unnest(conkey) AS attnum
         FROM pg_constraint
         WHERE contype = 'p'
       ) pk ON pk.conrelid = c.oid AND pk.attnum = a.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY n.nspname, c.relname, a.attnum`
    );
    const indexRows = await this.client.query<{
      table_name: string;
      index_name: string;
      is_unique: boolean;
      column_name: string | null;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN t.relname ELSE n.nspname || '.' || t.relname END AS table_name,
              i.relname AS index_name,
              ix.indisunique AS is_unique,
              a.attname AS column_name
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, seq) ON ord.attnum > 0
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ord.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND ix.indisprimary = false
       ORDER BY n.nspname, t.relname, i.relname, ord.seq`
    );
    const foreignKeyRows = await this.client.query<{
      table_name: string;
      constraint_name: string;
      column_name: string;
      referenced_table_name: string;
      referenced_column_name: string;
      update_rule: string;
      delete_rule: string;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN t.relname ELSE n.nspname || '.' || t.relname END AS table_name,
              con.conname AS constraint_name,
              a.attname AS column_name,
              CASE WHEN rn.nspname = 'public' THEN rt.relname ELSE rn.nspname || '.' || rt.relname END AS referenced_table_name,
              ra.attname AS referenced_column_name,
              CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END AS update_rule,
              CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END AS delete_rule
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class rt ON rt.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rt.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, seq) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, seq) ON fk.seq = ck.seq
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ck.attnum
       JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = fk.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND con.contype = 'f'
       ORDER BY n.nspname, t.relname, con.conname, ck.seq`
    );
    const checkRows = await this.client.query<{
      table_name: string;
      constraint_name: string;
      expression: string;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN t.relname ELSE n.nspname || '.' || t.relname END AS table_name,
              con.conname AS constraint_name,
              regexp_replace(pg_get_constraintdef(con.oid), '^CHECK \\((.*)\\)$', '\\1') AS expression
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND con.contype = 'c'
       ORDER BY n.nspname, t.relname, con.conname`
    );
    const triggerRows = await this.client.query<{
      table_name: string;
      trigger_name: string;
      timing: string;
      event: string;
      statement: string;
      function_name: string | null;
      function_language: string | null;
      function_definition: string | null;
    }>(
      `SELECT CASE WHEN tn.nspname = 'public' THEN tbl.relname ELSE tn.nspname || '.' || tbl.relname END AS table_name,
              trg.tgname AS trigger_name,
              CASE
                WHEN (trg.tgtype::int & 2) <> 0 THEN 'BEFORE'
                WHEN (trg.tgtype::int & 64) <> 0 THEN 'INSTEAD OF'
                ELSE 'AFTER'
              END AS timing,
              concat_ws(' OR ',
                CASE WHEN (trg.tgtype::int & 4) <> 0 THEN 'INSERT' END,
                CASE WHEN (trg.tgtype::int & 8) <> 0 THEN 'DELETE' END,
                CASE WHEN (trg.tgtype::int & 16) <> 0 THEN 'UPDATE' END,
                CASE WHEN (trg.tgtype::int & 32) <> 0 THEN 'TRUNCATE' END
              ) AS event,
              pg_get_triggerdef(trg.oid, true) AS statement,
              CASE WHEN pn.nspname = 'public' THEN p.proname ELSE pn.nspname || '.' || p.proname END AS function_name,
              lang.lanname AS function_language,
              pg_get_functiondef(p.oid) AS function_definition
       FROM pg_trigger trg
       JOIN pg_class tbl ON tbl.oid = trg.tgrelid
       JOIN pg_namespace tn ON tn.oid = tbl.relnamespace
       JOIN pg_proc p ON p.oid = trg.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
       JOIN pg_language lang ON lang.oid = p.prolang
       WHERE NOT trg.tgisinternal
         AND tn.nspname NOT IN ('pg_catalog', 'information_schema')
         AND tn.nspname NOT LIKE 'pg_toast%'
         AND tn.nspname NOT LIKE 'pg_temp_%'
       ORDER BY tn.nspname, tbl.relname, trg.tgname`
    );
    const enumRows = await this.client.query<{
      table_name: string;
      column_name: string;
      type_schema: string;
      type_name: string;
      enum_values: unknown;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS table_name,
              n.nspname AS table_schema,
              c.relname AS raw_table_name,
              a.attname AS column_name,
              typn.nspname AS type_schema,
              typ.typname AS type_name,
              json_agg(e.enumlabel ORDER BY e.enumsortorder) AS enum_values
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_type typ ON typ.oid = a.atttypid
       JOIN pg_namespace typn ON typn.oid = typ.typnamespace
       JOIN pg_enum e ON e.enumtypid = typ.oid
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped
       GROUP BY n.nspname, c.relname, a.attname, a.attnum, typn.nspname, typ.typname
       ORDER BY n.nspname, c.relname, a.attnum`
    );

    const byTable = new Map<string, TableColumn[]>();
    const tableSchemas = new Map<string, string>();
    const tableDisplayNames = new Map<string, string>();
    const tableComments = new Map<string, string>();
    const primaryKeyNames = new Map<string, string>();
    const enumValuesByColumn = new Map(enumRows.rows.map((row) => [
      `${row.table_name}\u0000${row.column_name}`,
      normalizePostgresEnumValues(row.enum_values),
    ]));
    const customTypesByTable = new Map<string, Map<string, { name: string; kind: string; values: string[]; definition: string }>>();
    for (const row of enumRows.rows) {
      const values = normalizePostgresEnumValues(row.enum_values);
      if (!values.length) continue;
      const tableTypes = customTypesByTable.get(row.table_name) ?? new Map<string, { name: string; kind: string; values: string[]; definition: string }>();
      const typeName = formatPostgresCustomTypeName(row.type_schema, row.type_name);
      tableTypes.set(typeName, {
        name: typeName,
        kind: "enum",
        values,
        definition: `CREATE TYPE ${quotePostgresIdentifier(typeName)} AS ENUM (${values.map(toPostgresSqlLiteral).join(", ")});`,
      });
      customTypesByTable.set(row.table_name, tableTypes);
    }
    for (const row of result.rows) {
      const columns = byTable.get(row.table_name) ?? [];
      tableSchemas.set(row.table_name, row.table_schema);
      tableDisplayNames.set(row.table_name, row.raw_table_name);
      tableComments.set(row.table_name, row.table_comment ?? "");
      if (row.primary_key_name) {
        primaryKeyNames.set(row.table_name, row.primary_key_name);
      }
      const enumValues = enumValuesByColumn.get(`${row.table_name}\u0000${row.column_name}`) || [];
      columns.push({
        name: row.column_name,
        type: enumValues.length ? formatPostgresInlineEnumType(enumValues) : row.data_type,
        nullable: row.not_null !== true,
        key: row.column_key ?? undefined,
        defaultValue: row.column_default,
        comment: row.column_comment ?? "",
        extra: row.is_identity || isPostgresGeneratedDefault(row.column_default) ? "auto_increment" : "",
        enumValues: enumValues.length ? enumValues : undefined,
        enumTypeName: enumValues.length ? row.data_type : undefined,
      });
      byTable.set(row.table_name, columns);
    }

    const indexesByTable = new Map<string, Map<string, { name: string; unique: boolean; columns: string[] }>>();
    for (const row of indexRows.rows) {
      if (!row.column_name) continue;
      const tableIndexes = indexesByTable.get(row.table_name) ?? new Map<string, { name: string; unique: boolean; columns: string[] }>();
      const index = tableIndexes.get(row.index_name) ?? { name: row.index_name, unique: row.is_unique === true, columns: [] };
      index.columns.push(row.column_name);
      tableIndexes.set(row.index_name, index);
      indexesByTable.set(row.table_name, tableIndexes);
    }

    const foreignKeysByTable = new Map<string, Map<string, { name: string; columns: string[]; referenceTable: string; referenceColumns: string[]; onUpdate?: string; onDelete?: string }>>();
    for (const row of foreignKeyRows.rows) {
      const tableForeignKeys = foreignKeysByTable.get(row.table_name) ?? new Map<string, { name: string; columns: string[]; referenceTable: string; referenceColumns: string[]; onUpdate?: string; onDelete?: string }>();
      const foreignKey = tableForeignKeys.get(row.constraint_name) ?? {
        name: row.constraint_name,
        columns: [],
        referenceTable: row.referenced_table_name,
        referenceColumns: [],
        onUpdate: row.update_rule || "",
        onDelete: row.delete_rule || "",
      };
      foreignKey.columns.push(row.column_name);
      foreignKey.referenceColumns.push(row.referenced_column_name);
      tableForeignKeys.set(row.constraint_name, foreignKey);
      foreignKeysByTable.set(row.table_name, tableForeignKeys);
    }

    const checksByTable = new Map<string, Array<{ name: string; expression: string }>>();
    for (const row of checkRows.rows) {
      const checks = checksByTable.get(row.table_name) ?? [];
      checks.push({ name: row.constraint_name, expression: row.expression || "" });
      checksByTable.set(row.table_name, checks);
    }

    const triggersByTable = new Map<string, Array<{ name: string; timing: string; event: string; statement: string; functionName?: string; functionDefinition?: string }>>();
    const customFunctionsByTable = new Map<string, Map<string, { name: string; language?: string; definition: string }>>();
    for (const row of triggerRows.rows) {
      const triggers = triggersByTable.get(row.table_name) ?? [];
      const statement = extractPostgresTriggerStatement(row.statement || "");
      const functionName = row.function_name || "";
      const functionDefinition = row.function_definition || "";
      triggers.push({
        name: row.trigger_name,
        timing: row.timing || "",
        event: row.event || "",
        statement,
        functionName: functionName || undefined,
        functionDefinition: functionDefinition || undefined,
      });
      triggersByTable.set(row.table_name, triggers);
      if (functionName && functionDefinition) {
        const tableFunctions = customFunctionsByTable.get(row.table_name) ?? new Map<string, { name: string; language?: string; definition: string }>();
        tableFunctions.set(functionName, { name: functionName, language: row.function_language || "", definition: functionDefinition });
        customFunctionsByTable.set(row.table_name, tableFunctions);
      }
    }

    return [...byTable.entries()].map(([name, columns]) => ({
      name,
      schema: tableSchemas.get(name) ?? "",
      displayName: tableDisplayNames.get(name) ?? name,
      columns,
      comment: tableComments.get(name) ?? "",
      primaryKeyName: primaryKeyNames.get(name) ?? "",
      indexes: [...(indexesByTable.get(name)?.values() ?? [])],
      foreignKeys: [...(foreignKeysByTable.get(name)?.values() ?? [])],
      checks: checksByTable.get(name) ?? [],
      triggers: triggersByTable.get(name) ?? [],
      customFunctions: [...(customFunctionsByTable.get(name)?.values() ?? [])],
      customTypes: [...(customTypesByTable.get(name)?.values() ?? [])],
    }));
  }

  async getCreateTableSql(table: string): Promise<string> {
    const tableInfo = (await this.loadSchema()).find((item) => item.name === table || (item.schema === "public" && item.displayName === table));
    if (!tableInfo) {
      throw new Error(`未读取到 ${table} 的表结构。`);
    }

    const columnLines = tableInfo.columns.map((column) => {
      const defaultSql = column.defaultValue ? ` DEFAULT ${column.defaultValue}` : "";
      const identitySql = !column.defaultValue && /auto_increment/i.test(column.extra || "") ? " GENERATED BY DEFAULT AS IDENTITY" : "";
      const nullableSql = column.nullable ? "" : " NOT NULL";
      const columnType = column.enumTypeName || column.type;
      return `  ${this.quoteIdentifier(column.name)} ${columnType}${identitySql}${defaultSql}${nullableSql}`;
    });
    const primaryKeys = tableInfo.columns.filter((column) => column.key === "PRI").map((column) => column.name);
    if (primaryKeys.length) {
      const name = tableInfo.primaryKeyName || `${table}_pkey`;
      columnLines.push(`  CONSTRAINT ${this.quoteIdentifier(name)} PRIMARY KEY (${primaryKeys.map((key) => this.quoteIdentifier(key)).join(", ")})`);
    }
    for (const foreignKey of tableInfo.foreignKeys || []) {
      columnLines.push(
        `  CONSTRAINT ${this.quoteIdentifier(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map((column) => this.quoteIdentifier(column)).join(", ")}) REFERENCES ${this.quoteIdentifier(foreignKey.referenceTable)} (${foreignKey.referenceColumns.map((column) => this.quoteIdentifier(column)).join(", ")})${foreignKey.onUpdate ? ` ON UPDATE ${foreignKey.onUpdate}` : ""}${foreignKey.onDelete ? ` ON DELETE ${foreignKey.onDelete}` : ""}`
      );
    }
    for (const check of tableInfo.checks || []) {
      if (check.expression) {
        columnLines.push(`  CONSTRAINT ${this.quoteIdentifier(check.name)} CHECK (${check.expression})`);
      }
    }

    const enumTypeStatements: string[] = [];
    for (const column of tableInfo.columns) {
      if (!column.enumValues?.length) continue;
      const statement = `CREATE TYPE ${this.quoteIdentifier(column.enumTypeName || column.type)} AS ENUM (${column.enumValues.map(toPostgresSqlLiteral).join(", ")});`;
      if (!enumTypeStatements.includes(statement)) {
        enumTypeStatements.push(statement);
      }
    }
    const statements = [...enumTypeStatements, `CREATE TABLE ${this.quoteIdentifier(table)} (\n${columnLines.join(",\n")}\n);`];
    if (tableInfo.comment) {
      statements.push(`COMMENT ON TABLE ${this.quoteIdentifier(table)} IS ${toPostgresSqlLiteral(tableInfo.comment)};`);
    }
    for (const column of tableInfo.columns) {
      if (column.comment) {
        statements.push(`COMMENT ON COLUMN ${this.quoteIdentifier(table)}.${this.quoteIdentifier(column.name)} IS ${toPostgresSqlLiteral(column.comment)};`);
      }
    }
    for (const index of tableInfo.indexes || []) {
      const unique = index.unique ? "UNIQUE " : "";
      statements.push(`CREATE ${unique}INDEX ${this.quoteIdentifier(index.name)} ON ${this.quoteIdentifier(table)} (${index.columns.map((column) => this.quoteIdentifier(column)).join(", ")});`);
    }
    for (const customFunction of tableInfo.customFunctions || []) {
      if (customFunction.definition && !statements.includes(customFunction.definition)) {
        statements.push(customFunction.definition.trim().replace(/;\s*$/, ";"));
      }
    }
    for (const trigger of tableInfo.triggers || []) {
      if (trigger.statement) {
        statements.push(`CREATE TRIGGER ${this.quoteIdentifier(trigger.name)} ${trigger.timing || "BEFORE"} ${trigger.event || "INSERT"} ON ${this.quoteIdentifier(table)} FOR EACH ROW ${trigger.statement};`);
      }
    }
    return statements.join("\n");
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const normalizedSql = applySafetyLimit(sql, maxRows, "postgres");
    const startedAt = Date.now();
    const result = await this.client.query<Record<string, unknown>>(normalizedSql);
    const elapsedMs = Date.now() - startedAt;
    const rows = sliceRows(result.rows, maxRows);
    const columns = result.fields.map((field) => field.name);
    return {
      columns,
      rows,
      rowCount: result.rowCount ?? rows.length,
      affectedRows: result.rowCount ?? undefined,
      command: result.command,
      elapsedMs,
    };
  }

  async beginTransaction(): Promise<void> {
    await this.client.query("BEGIN");
  }

  async commit(): Promise<void> {
    await this.client.query("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.client.query("ROLLBACK");
  }

  quoteIdentifier(identifier: string): string {
    return quotePostgresIdentifier(identifier);
  }

  async dispose(): Promise<void> {
    await this.client.end();
  }
}


function quotePostgresIdentifier(identifier: string): string {
  return identifier
    .split(".")
    .map((part) => `"${part.replace(/"/g, "\"\"")}"`)
    .join(".");
}

function formatPostgresCustomTypeName(schema: string, name: string): string {
  return schema && schema !== "public" ? `${schema}.${name}` : name;
}

function extractPostgresTriggerStatement(triggerDefinition: string): string {
  const text = String(triggerDefinition || "").trim().replace(/;\s*$/, "");
  const match = text.match(/\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+[\s\S]+$/i);
  return match ? match[0].trim() : text;
}

function formatPostgresInlineEnumType(values: string[]): string {
  return `enum(${values.map(toPostgresSqlLiteral).join(",")})`;
}

function normalizePostgresEnumValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      return [];
    }
  }
  return [];
}

const MONGO_SCHEMA_SAMPLE_SIZE = 50;
const MONGO_DEFAULT_QUERY_LIMIT = 100;

class MongoWorkbenchClient implements DbClient {
  private constructor(
    private readonly client: MongoClient,
    private readonly databaseName: string
  ) {}

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<MongoWorkbenchClient> {
    const credentials = config.username
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
      : "";
    const uri = `mongodb://${credentials}${config.host}:${config.port}`;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      tls: config.ssl ? true : undefined,
      tlsAllowInvalidCertificates: config.allowInsecureTls ? true : undefined,
      authSource: config.username ? (config.database || "admin") : undefined,
    });
    await client.connect();
    return new MongoWorkbenchClient(client, database || config.database || "test");
  }

  async ping(): Promise<void> {
    await this.client.db("admin").command({ ping: 1 });
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.client.db("admin").admin().listDatabases();
    return result.databases
      .map((database) => database.name)
      .filter((name) => !["admin", "config", "local"].includes(name))
      .sort((left, right) => left.localeCompare(right));
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const collections = await this.db().listCollections({}, { nameOnly: false }).toArray();
    return collections
      .filter((collection) => collection.name && !collection.name.startsWith("system."))
      .map((collection) => ({
        name: collection.name,
        comment: `${collection.type || "collection"}${collection.options && Object.keys(collection.options).length ? " · options" : ""}`,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const summaries = await this.listTableSummaries();
    const tables: TableInfo[] = [];
    for (const summary of summaries) {
      const sample = await this.db().collection<Document>(summary.name).find({}).limit(MONGO_SCHEMA_SAMPLE_SIZE).toArray();
      tables.push({
        name: summary.name,
        comment: summary.comment,
        columns: inferMongoColumns(sample),
      });
    }
    return tables;
  }

  async getCreateTableSql(collectionName: string): Promise<string> {
    const collection = this.db().collection(collectionName);
    const indexes = await collection.indexes().catch(() => []);
    const statements = [`db.createCollection(${JSON.stringify(collectionName)});`];
    for (const index of indexes) {
      if (index.name === "_id_") continue;
      const { key, name, v, ns, ...options } = index as Record<string, unknown>;
      statements.push(`db.getCollection(${JSON.stringify(collectionName)}).createIndex(${JSON.stringify(key ?? {}, null, 2)}, ${JSON.stringify({ name, ...options }, null, 2)});`);
      void v;
      void ns;
    }
    return statements.join("\n");
  }

  async query(commandText: string, maxRows: number): Promise<QueryResult> {
    const startedAt = Date.now();
    const text = commandText.trim().replace(/;\s*$/, "");
    if (!text) {
      throw new Error("请输入 MongoDB 查询，例如 db.users.find({}).limit(30)。");
    }

    const command = parseMongoCommand(text);
    const result = await this.executeMongoCommand(command, maxRows);
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  quoteIdentifier(identifier: string): string {
    return identifier;
  }

  async dispose(): Promise<void> {
    await this.client.close();
  }

  private db() {
    return this.client.db(this.databaseName);
  }

  private async executeMongoCommand(command: MongoCommand, maxRows: number): Promise<QueryResult> {
    if (command.kind === "showDatabases") {
      const databases = await this.listDatabases();
      return buildMongoRowsResult(databases.map((name) => ({ name })), "show dbs");
    }
    if (command.kind === "showCollections") {
      const collections = await this.listTableSummaries();
      return buildMongoRowsResult(collections.map((collection) => ({ name: collection.name, comment: collection.comment || "" })), "show collections");
    }
    if (command.kind === "runCommand") {
      const result = await this.db().command(command.document);
      return buildMongoRowsResult([normalizeMongoDocument(result)], "runCommand");
    }
    if (command.kind === "dropDatabase") {
      const result = await this.db().dropDatabase();
      return buildMongoRowsResult([{ dropped: this.databaseName, ok: result }], "dropDatabase", 1);
    }
    if (command.kind === "createCollection") {
      const result = await this.db().createCollection(command.collection);
      return buildMongoRowsResult([{ collection: result.collectionName, ok: 1 }], "createCollection", 1);
    }

    const collection = this.db().collection<Document>(command.collection);
    if (command.kind === "createIndex") {
      const name = await collection.createIndex(command.keys, command.options);
      return buildMongoRowsResult([{ collection: command.collection, index: name, ok: 1 }], "createIndex", 1);
    }
    if (command.kind === "dropCollection") {
      const dropped = await collection.drop();
      return buildMongoRowsResult([{ collection: command.collection, dropped }], "drop", 1);
    }
    if (command.kind === "find") {
      const safeLimit = command.limit ?? (maxRows < 0 ? MONGO_DEFAULT_QUERY_LIMIT : Math.max(1, maxRows));
      const cursor = collection.find(command.filter, command.projection ? { projection: command.projection } : undefined);
      if (command.sort) cursor.sort(command.sort);
      if (command.skip) cursor.skip(command.skip);
      if (safeLimit > 0) cursor.limit(safeLimit);
      const documents = await cursor.toArray();
      return buildMongoRowsResult(documents.map(normalizeMongoDocument), "find");
    }
    if (command.kind === "countDocuments") {
      const totalRows = await collection.countDocuments(command.filter);
      return buildMongoRowsResult([{ totalRows }], "countDocuments");
    }
    if (command.kind === "aggregate") {
      const safeLimit = maxRows < 0 ? MONGO_DEFAULT_QUERY_LIMIT : Math.max(1, maxRows);
      const documents = await collection.aggregate(command.pipeline).limit(safeLimit).toArray();
      return buildMongoRowsResult(documents.map(normalizeMongoDocument), "aggregate");
    }
    if (command.kind === "insertOne") {
      const result = await collection.insertOne(command.document);
      return buildMongoRowsResult([{ acknowledged: result.acknowledged, insertedId: normalizeMongoValue(result.insertedId), insertId: normalizeMongoValue(result.insertedId) }], "insertOne", 1);
    }
    if (command.kind === "insertMany") {
      const result = await collection.insertMany(command.documents);
      return buildMongoRowsResult([{ acknowledged: result.acknowledged, insertedCount: result.insertedCount, insertedIds: normalizeMongoValue(result.insertedIds) }], "insertMany", result.insertedCount);
    }
    if (command.kind === "updateOne" || command.kind === "updateMany") {
      const result = command.kind === "updateOne"
        ? await collection.updateOne(command.filter, command.update)
        : await collection.updateMany(command.filter, command.update);
      return buildMongoRowsResult([{
        acknowledged: result.acknowledged,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: normalizeMongoValue(result.upsertedId),
      }], command.kind, result.modifiedCount);
    }
    if (command.kind === "deleteOne" || command.kind === "deleteMany") {
      const result = command.kind === "deleteOne"
        ? await collection.deleteOne(command.filter)
        : await collection.deleteMany(command.filter);
      return buildMongoRowsResult([{ acknowledged: result.acknowledged, deletedCount: result.deletedCount }], command.kind, result.deletedCount);
    }
    throw new Error("暂不支持该 MongoDB 命令。");
  }
}

type MongoCommand =
  | { kind: "showDatabases" }
  | { kind: "showCollections" }
  | { kind: "runCommand"; document: Document }
  | { kind: "dropDatabase" }
  | { kind: "createCollection"; collection: string }
  | { kind: "createIndex"; collection: string; keys: Document; options?: Document }
  | { kind: "dropCollection"; collection: string }
  | { kind: "find"; collection: string; filter: Filter<Document>; projection?: Document; sort?: Document; skip?: number; limit?: number }
  | { kind: "countDocuments"; collection: string; filter: Filter<Document> }
  | { kind: "aggregate"; collection: string; pipeline: Document[] }
  | { kind: "insertOne"; collection: string; document: Document }
  | { kind: "insertMany"; collection: string; documents: Document[] }
  | { kind: "updateOne" | "updateMany"; collection: string; filter: Filter<Document>; update: Document }
  | { kind: "deleteOne" | "deleteMany"; collection: string; filter: Filter<Document> };

function parseMongoCommand(text: string): MongoCommand {
  const trimmed = text.trim();
  if (/^show\s+dbs$/i.test(trimmed) || /^show\s+databases$/i.test(trimmed)) {
    return { kind: "showDatabases" };
  }
  if (/^show\s+collections$/i.test(trimmed) || /^show\s+tables$/i.test(trimmed)) {
    return { kind: "showCollections" };
  }
  if (/^db\.dropDatabase\s*\(\s*\)$/i.test(trimmed)) {
    return { kind: "dropDatabase" };
  }
  const runCommand = parseMongoDbMethodCall(trimmed, "runCommand");
  if (runCommand) {
    return { kind: "runCommand", document: parseMongoDocumentExpression(runCommand.args[0] || "{}", "命令 JSON") };
  }
  const createCollection = parseMongoDbMethodCall(trimmed, "createCollection");
  if (createCollection) {
    const collection = parseMongoStringArgument(createCollection.args[0], "集合名称");
    return { kind: "createCollection", collection };
  }

  const call = parseMongoCollectionMethodCall(trimmed);
  if (!call) {
    throw new Error("暂不支持该 MongoDB 查询格式。请使用 db.collection.find({})、db.getCollection(\"name\").find({}) 或 db.runCommand({})。");
  }
  const { collection, method, args, chain } = call;
  const lowerMethod = method.toLowerCase();
  if (lowerMethod === "find") {
    const chainOptions = parseMongoFindChain(chain);
    return {
      kind: "find",
      collection,
      filter: parseMongoDocumentExpression(args[0] || "{}", "find 过滤条件"),
      projection: args[1]?.trim() ? parseMongoDocumentExpression(args[1], "find projection") : undefined,
      ...chainOptions,
    };
  }
  if (lowerMethod === "countdocuments") {
    return { kind: "countDocuments", collection, filter: parseMongoDocumentExpression(args[0] || "{}", "countDocuments 过滤条件") };
  }
  if (lowerMethod === "aggregate") {
    const pipeline = parseMongoArrayExpression(args[0] || "[]", "aggregate pipeline");
    return { kind: "aggregate", collection, pipeline };
  }
  if (lowerMethod === "insertone") {
    return { kind: "insertOne", collection, document: parseMongoDocumentExpression(args[0] || "{}", "insertOne 文档") };
  }
  if (lowerMethod === "insertmany") {
    return { kind: "insertMany", collection, documents: parseMongoArrayExpression(args[0] || "[]", "insertMany 文档列表") };
  }
  if (lowerMethod === "updateone" || lowerMethod === "updatemany") {
    return {
      kind: lowerMethod === "updateone" ? "updateOne" : "updateMany",
      collection,
      filter: parseMongoDocumentExpression(args[0] || "{}", "update 过滤条件"),
      update: parseMongoDocumentExpression(args[1] || "{}", "update 更新内容"),
    };
  }
  if (lowerMethod === "deleteone" || lowerMethod === "deletemany") {
    return {
      kind: lowerMethod === "deleteone" ? "deleteOne" : "deleteMany",
      collection,
      filter: parseMongoDocumentExpression(args[0] || "{}", "delete 过滤条件"),
    };
  }
  if (lowerMethod === "drop") {
    return { kind: "dropCollection", collection };
  }
  if (lowerMethod === "createindex") {
    return {
      kind: "createIndex",
      collection,
      keys: parseMongoDocumentExpression(args[0] || "{}", "createIndex keys"),
      options: args[1]?.trim() ? parseMongoDocumentExpression(args[1], "createIndex options") : undefined,
    };
  }
  throw new Error(`暂不支持 MongoDB 方法 ${method}。`);
}

function parseMongoDbMethodCall(text: string, method: string): { args: string[] } | undefined {
  const prefix = `db.${method}(`;
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return undefined;
  }
  const openIndex = text.indexOf("(", 3 + method.length);
  const closeIndex = findMatchingBracket(text, openIndex, "(", ")");
  if (closeIndex < 0 || text.slice(closeIndex + 1).trim()) {
    return undefined;
  }
  return { args: splitMongoArguments(text.slice(openIndex + 1, closeIndex)) };
}

function parseMongoCollectionMethodCall(text: string): { collection: string; method: string; args: string[]; chain: string } | undefined {
  if (!text.startsWith("db.")) {
    return undefined;
  }
  let index = 3;
  let collection = "";
  if (text.startsWith("getCollection", index)) {
    const openIndex = text.indexOf("(", index);
    const closeIndex = findMatchingBracket(text, openIndex, "(", ")");
    if (openIndex < 0 || closeIndex < 0) return undefined;
    collection = parseMongoStringArgument(text.slice(openIndex + 1, closeIndex), "集合名称");
    index = closeIndex + 1;
  } else {
    const match = text.slice(index).match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (!match) return undefined;
    collection = match[1];
    index += match[1].length;
  }
  if (text[index] !== ".") return undefined;
  index += 1;
  const methodMatch = text.slice(index).match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (!methodMatch) return undefined;
  const method = methodMatch[1];
  index += method.length;
  if (text[index] !== "(") return undefined;
  const closeIndex = findMatchingBracket(text, index, "(", ")");
  if (closeIndex < 0) return undefined;
  return {
    collection,
    method,
    args: splitMongoArguments(text.slice(index + 1, closeIndex)),
    chain: text.slice(closeIndex + 1).trim(),
  };
}

function parseMongoFindChain(chain: string): { sort?: Document; skip?: number; limit?: number } {
  const options: { sort?: Document; skip?: number; limit?: number } = {};
  let rest = chain.trim();
  while (rest) {
    const match = rest.match(/^\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (!match) break;
    const method = match[1].toLowerCase();
    const openIndex = rest.indexOf("(", match[0].indexOf("("));
    const closeIndex = findMatchingBracket(rest, openIndex, "(", ")");
    if (closeIndex < 0) break;
    const args = splitMongoArguments(rest.slice(openIndex + 1, closeIndex));
    if (method === "sort") {
      options.sort = parseMongoDocumentExpression(args[0] || "{}", "sort");
    } else if (method === "skip") {
      options.skip = parseMongoNonNegativeInteger(args[0], "skip");
    } else if (method === "limit") {
      options.limit = parseMongoNonNegativeInteger(args[0], "limit");
    }
    rest = rest.slice(closeIndex + 1).trim();
  }
  return options;
}

function splitMongoArguments(source: string): string[] {
  return splitTopLevel(source, ",").map((item) => item.trim()).filter(Boolean);
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let escape = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      current += char;
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() || !parts.length) {
    parts.push(current);
  }
  return parts;
}

function findMatchingBracket(source: string, openIndex: number, open: string, close: string): number {
  if (openIndex < 0 || source[openIndex] !== open) {
    return -1;
  }
  let quote = "";
  let escape = false;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseMongoStringArgument(value: string | undefined, label: string): string {
  const text = String(value || "").trim();
  const match = text.match(/^(["'])([\s\S]*)\1$/);
  const name = match ? match[2].replace(/\\(["'\\])/g, "$1") : text;
  if (!name.trim()) {
    throw new Error(`${label}不能为空。`);
  }
  return name;
}

function parseMongoDocumentExpression(value: string, label: string): Document {
  const parsed = parseMongoExpression(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 对象。`);
  }
  return parsed as Document;
}

function parseMongoArrayExpression(value: string, label: string): Document[] {
  const parsed = parseMongoExpression(value, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 数组。`);
  }
  return parsed as Document[];
}

function parseMongoExpression(value: string, label: string): unknown {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${label}不能为空。`);
  }
  const normalized = normalizeMongoShellJson(text);
  try {
    return BSON.EJSON.parse(normalized, { relaxed: true });
  } catch (error) {
    const quotedKeys = quoteMongoShellKeys(normalized);
    try {
      return BSON.EJSON.parse(quotedKeys, { relaxed: true });
    } catch {
      throw new Error(`${label}解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function normalizeMongoShellJson(value: string): string {
  const replacedHelpers = value
    .replace(/\bObjectId\s*\(\s*(["'])([0-9a-fA-F]{24})\1\s*\)/g, '{"$oid":"$2"}')
    .replace(/\bISODate\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g, '{"$date":"$2"}')
    .replace(/\bnew\s+Date\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g, '{"$date":"$2"}');
  return normalizeSingleQuotedJsonStrings(replacedHelpers);
}

function normalizeSingleQuotedJsonStrings(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "'") {
      result += char;
      continue;
    }
    let content = "";
    index += 1;
    while (index < value.length) {
      const next = value[index];
      if (next === "\\" && index + 1 < value.length) {
        content += value[index + 1];
        index += 2;
        continue;
      }
      if (next === "'") {
        break;
      }
      content += next;
      index += 1;
    }
    result += JSON.stringify(content);
  }
  return result;
}

function quoteMongoShellKeys(value: string): string {
  return value.replace(/([{,]\s*)([$A-Za-z_][$A-Za-z0-9_]*(?:\.[A-Za-z_][$A-Za-z0-9_]*)?)\s*:/g, (_match, prefix: string, key: string) => `${prefix}${JSON.stringify(key)}:`);
}

function parseMongoNonNegativeInteger(value: string | undefined, label: string): number {
  const parsed = Number(String(value || "").trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是非负整数。`);
  }
  return parsed;
}

function inferMongoColumns(sample: Document[]): TableColumn[] {
  const fields = new Map<string, { type: string; seen: number; nullable: boolean }>();
  for (const document of sample) {
    for (const [key, value] of Object.entries(document)) {
      const current = fields.get(key);
      const type = getMongoValueType(value);
      fields.set(key, {
        type: current ? mergeMongoTypes(current.type, type) : type,
        seen: (current?.seen || 0) + 1,
        nullable: current?.nullable === true || value === null || value === undefined,
      });
    }
  }
  if (!fields.has("_id")) {
    fields.set("_id", { type: "objectId", seen: sample.length, nullable: false });
  }
  const total = Math.max(sample.length, 1);
  return [...fields.entries()]
    .sort(([left], [right]) => left === "_id" ? -1 : right === "_id" ? 1 : left.localeCompare(right))
    .map(([name, meta]) => ({
      name,
      type: meta.type,
      nullable: meta.nullable || meta.seen < total,
      key: name === "_id" ? "PRI" : undefined,
      comment: name === "_id" ? "MongoDB 文档 ID" : `采样 ${sample.length} 条文档推断`,
    }));
}

function getMongoValueType(value: unknown): string {
  if (value instanceof ObjectId) return "objectId";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  if (value === null || value === undefined) return "null";
  if (Buffer.isBuffer(value)) return "binary";
  if (typeof value === "object") return "object";
  return typeof value;
}

function mergeMongoTypes(left: string, right: string): string {
  if (left === right) return left;
  if (left === "null") return right;
  if (right === "null") return left;
  return left.split("|").includes(right) ? left : `${left}|${right}`;
}

function buildMongoRowsResult(rows: Record<string, unknown>[], command: string, affectedRows?: number): QueryResult {
  return {
    columns: collectMongoColumns(rows),
    rows,
    rowCount: rows.length,
    affectedRows,
    command,
    elapsedMs: 0,
  };
}

function collectMongoColumns(rows: Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }
  return [...columns];
}

function normalizeMongoDocument(document: Document): Record<string, unknown> {
  return normalizeMongoValue(document) as Record<string, unknown>;
}

function normalizeMongoValue(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(normalizeMongoValue);
  if (value && typeof value === "object") {
    const bsonType = (value as { _bsontype?: unknown })._bsontype;
    if (bsonType && typeof (value as { toString?: unknown }).toString === "function") {
      return String(value);
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeMongoValue(item)]));
  }
  return value;
}

const REDIS_SCAN_BATCH_SIZE = 200;
const REDIS_DETAIL_PAGE_SIZE_MAX = 500;
const REDIS_STRING_PREVIEW_BYTES = 4096;
const REDIS_SAFE_RANGE_LIMIT = 1000;

class RedisWorkbenchClient implements DbClient {
  private constructor(
    private readonly client: ReturnType<typeof createRedisClient>,
    private readonly database: number
  ) {}

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<RedisWorkbenchClient> {
    const client = createRedisClient({
      username: config.username || undefined,
      password: config.password || undefined,
      socket: {
        host: config.host,
        port: config.port,
        tls: config.ssl ? true : undefined,
      },
    });
    await client.connect();
    const db = parseRedisDatabase(database ?? config.database);
    if (db > 0) {
      await client.select(db);
    }
    return new RedisWorkbenchClient(client, db);
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async listDatabases(): Promise<string[]> {
    const count = await this.readDatabaseCount();
    return Array.from({ length: count }, (_, index) => `db${index}`);
  }

  private async readDatabaseCount(): Promise<number> {
    const configuredCount = await this.readConfiguredDatabaseCount();
    if (configuredCount > 0) {
      return configuredCount;
    }

    const keyspaceMaxIndex = await this.readKeyspaceMaxDatabaseIndex();
    const fallbackCount = Math.max(16, this.database + 1, keyspaceMaxIndex + 1);
    return this.clampDatabaseCount(fallbackCount);
  }

  private async readConfiguredDatabaseCount(): Promise<number> {
    try {
      const reply = await this.client.sendCommand(["CONFIG", "GET", "databases"]);
      return this.clampDatabaseCount(parseRedisConfigDatabasesReply(reply));
    } catch {
      return 0;
    }
  }

  private async readKeyspaceMaxDatabaseIndex(): Promise<number> {
    try {
      const reply = await this.client.sendCommand(["INFO", "keyspace"]);
      const matches = String(reply ?? "").matchAll(/^db(\d+):/gm);
      let maxIndex = -1;
      for (const match of matches) {
        maxIndex = Math.max(maxIndex, Number(match[1]));
      }
      return maxIndex;
    } catch {
      return -1;
    }
  }

  private clampDatabaseCount(count: number): number {
    if (!Number.isInteger(count) || count <= 0) {
      return 0;
    }
    return Math.min(count, 4096);
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const keys = await this.scanKeys("*", 200);
    const summaries: TableSummary[] = [];
    for (const key of keys) {
      const [type, ttl] = await Promise.all([
        this.client.type(key),
        this.client.ttl(key),
      ]);
      summaries.push({ name: key, comment: `${type}${ttl >= 0 ? ` · TTL ${ttl}s` : ""}` });
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const summaries = await this.listTableSummaries();
    return summaries.map((summary) => ({
      name: summary.name,
      comment: summary.comment,
      columns: [
        { name: "key", type: "redis-key", nullable: false, key: "PRI", comment: "Redis Key" },
        { name: "type", type: "redis-type", nullable: false, comment: "数据类型" },
        { name: "ttl", type: "seconds", nullable: true, comment: "剩余过期时间" },
        { name: "memory", type: "bytes", nullable: true, comment: "内存占用" },
        { name: "value", type: "redis-value", nullable: true, comment: "值预览" },
      ],
    }));
  }

  async getCreateTableSql(key: string): Promise<string> {
    const type = await this.client.type(key);
    const ttl = await this.client.ttl(key);
    return [`# Redis Key: ${key}`, `TYPE ${key} => ${type}`, `TTL ${key} => ${ttl}`].join("\n");
  }

  async query(commandText: string, maxRows: number): Promise<QueryResult> {
    const startedAt = Date.now();
    const text = commandText.trim();
    if (!text) {
      throw new Error("请输入 Redis 命令，或从左侧选择一个 Key。");
    }

    if (/^inspect\s+/i.test(text)) {
      const key = text.replace(/^inspect\s+/i, "").trim();
      const rows = await this.inspectKey(key, maxRows);
      return { columns: Object.keys(rows[0] ?? { key: "", type: "", ttl: "", value: "" }), rows, rowCount: rows.length, command: "INSPECT", elapsedMs: Date.now() - startedAt };
    }
    if (text.startsWith("__DBW_REDIS_DELETE__ ")) {
      const keys = JSON.parse(text.slice("__DBW_REDIS_DELETE__ ".length)) as string[];
      const deleted = keys.length ? Number(await this.client.sendCommand(["UNLINK", ...keys])) : 0;
      return { columns: ["deleted"], rows: [{ deleted }], rowCount: 1, command: "UNLINK", elapsedMs: Date.now() - startedAt };
    }
    if (text.startsWith("__DBW_REDIS_SET__ ")) {
      const payload = JSON.parse(text.slice("__DBW_REDIS_SET__ ".length)) as { key: string; value: string };
      const result = await this.client.set(payload.key, payload.value);
      return { columns: ["key", "result"], rows: [{ key: payload.key, result }], rowCount: 1, command: "SET", elapsedMs: Date.now() - startedAt };
    }
    if (text.startsWith("__DBW_REDIS_EXPIRE__ ")) {
      const payload = JSON.parse(text.slice("__DBW_REDIS_EXPIRE__ ".length)) as { key: string; seconds: number | null };
      const result = payload.seconds === null
        ? await this.client.persist(payload.key)
        : await this.client.expire(payload.key, payload.seconds);
      return { columns: ["key", "result"], rows: [{ key: payload.key, result }], rowCount: 1, command: payload.seconds === null ? "PERSIST" : "EXPIRE", elapsedMs: Date.now() - startedAt };
    }
    if (text.startsWith("__DBW_REDIS_INSPECT_PAGE__ ")) {
      const payload = JSON.parse(text.slice("__DBW_REDIS_INSPECT_PAGE__ ".length)) as { key: string; page?: number; pageSize?: number; search?: string; fuzzySearch?: boolean; sortDirection?: "asc" | "desc" };
      const result = await this.inspectKeyPage(payload.key, payload.pageSize || maxRows, payload.page || 1, payload.search || "", payload.fuzzySearch === true, payload.sortDirection);
      result.metadata = { ...(result.metadata || {}), memoryUsage: await this.getMemoryUsage(payload.key) };
      result.elapsedMs = Date.now() - startedAt;
      return result;
    }
    if (text.startsWith("__DBW_REDIS_DELETE_MEMBER__ ")) {
      const payload = JSON.parse(text.slice("__DBW_REDIS_DELETE_MEMBER__ ".length)) as { key: string; keyType?: string; row: Record<string, unknown> };
      const deleted = await this.deleteKeyMember(payload.key, payload.keyType || "", payload.row || {});
      return { columns: ["deleted"], rows: [{ deleted }], rowCount: 1, command: "DELETE_MEMBER", elapsedMs: Date.now() - startedAt };
    }

    const args = normalizeRedisCommandArgs(splitCommandLine(text));
    if (!args.length) {
      throw new Error("请输入 Redis 命令。");
    }
    if (String(args[0]).toUpperCase() === "KEYS_PAGE") {
      const pattern = args[1] || "*";
      const pageSize = Math.max(1, Number(args[2]) || Math.max(1, maxRows));
      const page = Math.max(1, Number(args[3]) || 1);
      const { rows, totalRows } = await this.listKeyRows(pattern, pageSize, page);
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      return {
        columns: ["key", "type", "ttl", "memory", "value"],
        rows,
        rowCount: rows.length,
        command: "KEYS_PAGE",
        elapsedMs: Date.now() - startedAt,
        pagination: {
          mode: "quick",
          table: "__redis_keys__",
          where: pattern === "*" ? "" : pattern,
          page,
          pageSize,
          totalRows,
          totalPages,
        },
      };
    }
    assertSafeRedisCommand(args);
    if (String(args[0]).toUpperCase() === "GET" && args[1]) {
      const value = await this.getStringPreview(args[1]);
      return { columns: ["value"], rows: [{ value }], rowCount: 1, command: "GET", elapsedMs: Date.now() - startedAt };
    }
    const reply = await this.client.sendCommand(args);
    const rows = normalizeRedisReply(reply, maxRows, args);
    return {
      columns: Object.keys(rows[0] ?? { result: "" }),
      rows,
      rowCount: rows.length,
      command: args[0]?.toUpperCase(),
      elapsedMs: Date.now() - startedAt,
    };
  }

  quoteIdentifier(identifier: string): string {
    return identifier;
  }

  async dispose(): Promise<void> {
    await this.client.quit();
  }

  private async scanKeys(pattern: string, limit: number): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const result = await this.client.scan(cursor, { MATCH: pattern || "*", COUNT: REDIS_SCAN_BATCH_SIZE });
      cursor = String(result.cursor);
      keys.push(...result.keys);
    } while (cursor !== "0" && keys.length < limit);
    return keys.slice(0, limit);
  }

  private async listKeyRows(pattern: string, pageSize: number, page: number): Promise<{ rows: Record<string, unknown>[]; totalRows: number }> {
    const safePageSize = Math.max(1, Math.min(REDIS_DETAIL_PAGE_SIZE_MAX, Math.floor(pageSize || 30)));
    const safePage = Math.max(1, Math.floor(page || 1));
    const { keys, totalRows } = await this.scanKeyPage(pattern || "*", safePageSize, safePage);
    const rows = await Promise.all(keys.map(async (key) => {
      const [type, ttl, value, memoryUsage] = await Promise.all([
        this.client.type(key),
        this.client.ttl(key),
        this.previewKeyValue(key),
        this.getMemoryUsage(key),
      ]);
      return { key, type, ttl: ttl >= 0 ? ttl : ttl === -1 ? "永久" : "无", memory: this.formatMemoryUsage(memoryUsage), value };
    }));
    return { rows, totalRows };
  }

  private async scanKeyPage(pattern: string, pageSize: number, page: number): Promise<{ keys: string[]; totalRows: number }> {
    const offset = (page - 1) * pageSize;
    const keys: string[] = [];
    let cursor = "0";
    let seen = 0;
    let hasMore = false;
    do {
      const result = await this.client.scan(cursor, { MATCH: pattern || "*", COUNT: REDIS_SCAN_BATCH_SIZE });
      cursor = String(result.cursor);
      for (const key of result.keys) {
        if (seen >= offset && keys.length < pageSize + 1) {
          keys.push(key);
        }
        seen += 1;
        if (keys.length >= pageSize + 1) {
          hasMore = true;
          break;
        }
      }
    } while (cursor !== "0" && !hasMore);

    const pageKeys = keys.slice(0, pageSize);
    const totalRows = hasMore ? page * pageSize + 1 : (page - 1) * pageSize + pageKeys.length;
    return { keys: pageKeys, totalRows };
  }

  private async getMemoryUsage(key: string): Promise<number | null> {
    try {
      return await this.client.memoryUsage(key);
    } catch {
      return null;
    }
  }

  private formatMemoryUsage(bytes: number | null): string {
    if (bytes === null || bytes === undefined) {
      return "未知";
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
  }

  private async previewKeyValue(key: string): Promise<string> {
    const type = await this.client.type(key);
    if (type === "string") {
      return await this.getStringPreview(key);
    }
    if (type === "hash") {
      const [total, items] = await Promise.all([
        this.client.hLen(key),
        this.collectIteratorItems(this.client.hScanIterator(key, { COUNT: 4 }), 4),
      ]);
      return this.formatRedisPreview(items.slice(0, 3).map((item) => `${this.shortRedisValue(item.field)}: ${this.shortRedisValue(item.value)}`), total);
    }
    if (type === "list") {
      const total = await this.client.lLen(key);
      const values = await this.client.lRange(key, 0, 2);
      return this.formatRedisPreview(values.map((value) => this.shortRedisValue(value)), total);
    }
    if (type === "set") {
      const [total, values] = await Promise.all([
        this.client.sCard(key),
        this.collectIteratorItems(this.client.sScanIterator(key, { COUNT: 4 }), 4),
      ]);
      return this.formatRedisPreview(values.slice(0, 3).map((value) => this.shortRedisValue(value)), total);
    }
    if (type === "zset") {
      const [total, values] = await Promise.all([
        this.client.zCard(key),
        this.client.zRangeWithScores(key, 0, 2),
      ]);
      return this.formatRedisPreview(values.map((item) => `${this.shortRedisValue(item.value)} (${item.score})`), total);
    }
    if (type === "stream") {
      const [total, values] = await Promise.all([
        this.client.xLen(key),
        this.client.xRange(key, "-", "+", { COUNT: 3 }),
      ]);
      return this.formatRedisPreview(values.map((item) => this.shortRedisValue(item.id)), total);
    }
    return "";
  }

  private async inspectKeyPage(key: string, pageSize: number, page: number, search = "", fuzzySearch = false, sortDirection: "asc" | "desc" = "asc"): Promise<QueryResult> {
    const type = await this.client.type(key);
    const ttl = await this.client.ttl(key);
    const safePageSize = Math.max(1, Math.min(REDIS_DETAIL_PAGE_SIZE_MAX, Math.floor(pageSize || 30)));
    const safePage = Math.max(1, Math.floor(page || 1));
    const start = (safePage - 1) * safePageSize;
    const end = start + safePageSize - 1;
    const searchText = search.trim();
    const match = (values: unknown[]) => this.matchesRedisSearch(values, searchText);

    if (searchText && !fuzzySearch) {
      return this.inspectKeyPageByScanSearch(key, type, ttl, safePageSize, safePage, searchText, sortDirection);
    }

    if (type === "none") {
      return this.buildRedisDetailResult("NONE", ["key", "type", "ttl", "value"], [{ key, type, ttl, value: "Key 不存在" }], safePage, safePageSize, 1, 0, searchText, sortDirection);
    }
    if (type === "string") {
      const value = await this.getStringPreview(key);
      const rows = !searchText || match([value]) ? [{ value }] : [];
      return this.buildRedisDetailResult("STRING", ["value"], rows, safePage, safePageSize, rows.length, ttl, searchText, sortDirection);
    }
    if (type === "hash") {
      if (searchText) {
        const { items, hasMore } = await this.collectMatchingIteratorPageWithMore(
          this.client.hScanIterator(key, { COUNT: safePageSize }),
          start,
          safePageSize,
          (item) => match([item.field, item.value])
        );
        const rows = items.map((item) => ({ field: item.field, value: item.value }));
        return this.buildRedisNativeSearchResult("HASH", ["field", "value"], rows, safePage, safePageSize, ttl, hasMore, searchText, sortDirection);
      }
      const totalRows = await this.client.hLen(key);
      const items = await this.collectIteratorPage(this.client.hScanIterator(key, { COUNT: safePageSize }), start, safePageSize);
      const rows = items.map((item) => ({ field: item.field, value: item.value }));
      return this.buildRedisDetailResult("HASH", ["field", "value"], rows, safePage, safePageSize, totalRows, ttl, searchText, sortDirection);
    }
    if (type === "list") {
      const totalRows = await this.client.lLen(key);
      if (searchText) {
        const { rows, hasMore } = await this.collectFilteredListPageWithMore(key, totalRows, start, safePageSize, searchText);
        return this.buildRedisNativeSearchResult("LIST", ["index", "value"], rows, safePage, safePageSize, ttl, hasMore, searchText, sortDirection);
      }
      const values = await this.client.lRange(key, start, end);
      const rows = values.map((value, index) => ({ index: start + index, value }));
      return this.buildRedisDetailResult("LIST", ["index", "value"], rows, safePage, safePageSize, totalRows, ttl, searchText, sortDirection);
    }
    if (type === "set") {
      if (searchText) {
        const { items, hasMore } = await this.collectMatchingIteratorPageWithMore(
          this.client.sScanIterator(key, { COUNT: safePageSize }),
          start,
          safePageSize,
          (member) => match([member])
        );
        const rows = items.map((member) => ({ member }));
        return this.buildRedisNativeSearchResult("SET", ["member"], rows, safePage, safePageSize, ttl, hasMore, searchText, sortDirection);
      }
      const totalRows = await this.client.sCard(key);
      const values = await this.collectIteratorPage(this.client.sScanIterator(key, { COUNT: safePageSize }), start, safePageSize);
      const rows = values.map((member) => ({ member }));
      return this.buildRedisDetailResult("SET", ["member"], rows, safePage, safePageSize, totalRows, ttl, searchText, sortDirection);
    }
    if (type === "zset") {
      if (searchText) {
        const { items, hasMore } = await this.collectMatchingIteratorPageWithMore(
          this.client.zScanIterator(key, { COUNT: Math.max(safePageSize, 100) }),
          start,
          safePageSize,
          (item) => match([item.value, item.score])
        );
        const rows = items.map((item, index) => ({ rank: start + index, member: item.value, score: item.score }));
        return this.buildRedisNativeSearchResult("ZSET", ["rank", "member", "score"], rows, safePage, safePageSize, ttl, hasMore, searchText, sortDirection);
      }
      const totalRows = await this.client.zCard(key);
      const values = await this.client.zRangeWithScores(key, start, end, { REV: sortDirection === "desc" });
      const rows = values.map((item, index) => ({ rank: start + index, member: item.value, score: item.score }));
      return this.buildRedisDetailResult("ZSET", ["rank", "member", "score"], rows, safePage, safePageSize, totalRows, ttl, searchText, sortDirection);
    }
    if (type === "stream") {
      const totalRows = await this.client.xLen(key);
      if (searchText) {
        const { items, hasMore } = await this.collectStreamPageWithMore(key, start, safePageSize, (item) => match([item.id, item.message]));
        const rows = items.map((item) => ({ id: item.id, value: JSON.stringify(item.message) }));
        return this.buildRedisNativeSearchResult("STREAM", ["id", "value"], rows, safePage, safePageSize, ttl, hasMore, searchText, sortDirection);
      }
      const { items, hasMore } = await this.collectStreamPageWithMore(key, start, safePageSize);
      const rows = items.map((item) => ({ id: item.id, value: JSON.stringify(item.message) }));
      const boundedTotal = hasMore ? safePage * safePageSize + 1 : Math.min(totalRows, (safePage - 1) * safePageSize + rows.length);
      return this.buildRedisDetailResult("STREAM", ["id", "value"], rows, safePage, safePageSize, boundedTotal, ttl, searchText, sortDirection);
    }
    return this.buildRedisDetailResult(type.toUpperCase(), ["value"], [{ value: `暂不支持查看 ${type} 类型` }], safePage, safePageSize, 1, ttl, searchText, sortDirection);
  }

  private async inspectKeyPageByScanSearch(
    key: string,
    type: string,
    ttl: number,
    pageSize: number,
    page: number,
    search: string,
    sortDirection: "asc" | "desc"
  ): Promise<QueryResult> {
    const start = (page - 1) * pageSize;
    if (type === "none") {
      return this.buildRedisDetailResult("NONE", ["key", "type", "ttl", "value"], [], page, pageSize, 0, ttl, search, sortDirection);
    }
    if (type === "string") {
      const value = await this.getStringPreview(key);
      const rows = value === search ? [{ value }] : [];
      return this.buildRedisDetailResult("STRING", ["value"], rows, page, pageSize, rows.length, ttl, search, sortDirection);
    }
    if (type === "hash") {
      const { items, hasMore } = await this.collectMatchingIteratorPageWithMore(
        this.client.hScanIterator(key, { COUNT: pageSize }),
        start,
        pageSize,
        (item) => this.matchesRedisExact([item.field, item.value], search)
      );
      const rows = items.map((item) => ({ field: item.field, value: item.value }));
      return this.buildRedisNativeSearchResult("HASH", ["field", "value"], rows, page, pageSize, ttl, hasMore, search, sortDirection);
    }
    if (type === "list") {
      const indexes = await this.findListIndexesByNativeSearch(key, search, start, pageSize + 1);
      const pageIndexes = indexes.slice(0, pageSize);
      const values = await Promise.all(pageIndexes.map((index) => this.client.lIndex(key, index)));
      const rows = pageIndexes.map((index, rowIndex) => ({ index, value: values[rowIndex] }));
      return this.buildRedisNativeSearchResult("LIST", ["index", "value"], rows, page, pageSize, ttl, indexes.length > pageSize, search, sortDirection);
    }
    if (type === "set") {
      const { items, hasMore } = await this.collectMatchingIteratorPageWithMore(
        this.client.sScanIterator(key, { COUNT: pageSize }),
        start,
        pageSize,
        (member) => this.matchesRedisExact([member], search)
      );
      const rows = items.map((member) => ({ member }));
      return this.buildRedisNativeSearchResult("SET", ["member"], rows, page, pageSize, ttl, hasMore, search, sortDirection);
    }
    if (type === "zset") {
      const { items, hasMore } = await this.collectMatchingIteratorPageWithMore(
        this.client.zScanIterator(key, { COUNT: pageSize }),
        start,
        pageSize,
        (item) => this.matchesRedisExact([item.value, item.score], search)
      );
      const rows = items.map((item, index) => ({ rank: start + index, member: item.value, score: item.score }));
      return this.buildRedisNativeSearchResult("ZSET", ["rank", "member", "score"], rows, page, pageSize, ttl, hasMore, search, sortDirection);
    }
    if (type === "stream") {
      try {
        const values = await this.client.xRange(key, search, search, { COUNT: pageSize + 1 });
        const rows = values.slice(0, pageSize).map((item) => ({ id: item.id, value: JSON.stringify(item.message) }));
        return this.buildRedisNativeSearchResult("STREAM", ["id", "value"], rows, page, pageSize, ttl, values.length > pageSize, search, sortDirection);
      } catch {
        return this.buildRedisNativeSearchResult("STREAM", ["id", "value"], [], page, pageSize, ttl, false, search, sortDirection);
      }
    }
    return this.buildRedisDetailResult(type.toUpperCase(), ["value"], [], page, pageSize, 0, ttl, search, sortDirection);
  }

  private buildRedisDetailResult(
    command: string,
    columns: string[],
    rows: Record<string, unknown>[],
    page: number,
    pageSize: number,
    totalRows: number,
    ttl: number,
    search = "",
    sortDirection: "asc" | "desc" = "asc"
  ): QueryResult {
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    return {
      columns,
      rows,
      rowCount: rows.length,
      command,
      elapsedMs: 0,
      pagination: {
        mode: "quick",
        page,
        pageSize,
        totalRows,
        totalPages,
        where: ttl >= 0 ? `TTL ${ttl}s` : ttl === -1 ? "TTL 永久" : "TTL 无",
        sortDirection,
        sql: search,
      },
    };
  }

  private buildRedisNativeSearchResult(
    command: string,
    columns: string[],
    rows: Record<string, unknown>[],
    page: number,
    pageSize: number,
    ttl: number,
    hasMore: boolean,
    search: string,
    sortDirection: "asc" | "desc"
  ): QueryResult {
    const totalRows = hasMore ? page * pageSize + 1 : (page - 1) * pageSize + rows.length;
    const totalPages = Math.max(1, hasMore ? page + 1 : page);
    return this.buildRedisDetailResult(command, columns, rows, page, pageSize, totalRows, ttl, search, sortDirection);
  }

  private async collectIteratorItems<T>(iterator: AsyncIterable<T[]>, limit: number): Promise<T[]> {
    const items: T[] = [];
    for await (const chunk of iterator) {
      items.push(...chunk);
      if (items.length >= limit) {
        break;
      }
    }
    return items.slice(0, limit);
  }

  private async collectIteratorPage<T>(iterator: AsyncIterable<T[]>, offset: number, limit: number): Promise<T[]> {
    const items: T[] = [];
    let seen = 0;
    for await (const chunk of iterator) {
      for (const item of chunk) {
        if (seen >= offset && items.length < limit) {
          items.push(item);
        }
        seen += 1;
        if (items.length >= limit) {
          return items;
        }
      }
    }
    return items;
  }

  private async collectMatchingIteratorPageWithMore<T>(
    iterator: AsyncIterable<T[]>,
    offset: number,
    limit: number,
    predicate: (item: T) => boolean
  ): Promise<{ items: T[]; hasMore: boolean }> {
    const items: T[] = [];
    let matched = 0;
    for await (const chunk of iterator) {
      for (const item of chunk) {
        if (!predicate(item)) {
          continue;
        }
        if (matched >= offset && items.length < limit + 1) {
          items.push(item);
        }
        matched += 1;
        if (items.length >= limit + 1) {
          return { items: items.slice(0, limit), hasMore: true };
        }
      }
    }
    return { items, hasMore: false };
  }

  private async collectFilteredIteratorPage<T>(iterator: AsyncIterable<T[]>, offset: number, limit: number, predicate: (item: T) => boolean): Promise<T[]> {
    const items: T[] = [];
    let matched = 0;
    for await (const chunk of iterator) {
      for (const item of chunk) {
        if (!predicate(item)) {
          continue;
        }
        if (matched >= offset && items.length < limit) {
          items.push(item);
        }
        matched += 1;
        if (items.length >= limit) {
          return items;
        }
      }
    }
    return items;
  }

  private async countFilteredIterator<T>(iterator: AsyncIterable<T[]>, predicate: (item: T) => boolean): Promise<number> {
    let total = 0;
    for await (const chunk of iterator) {
      for (const item of chunk) {
        if (predicate(item)) {
          total += 1;
        }
      }
    }
    return total;
  }

  private async collectFilteredListPageWithMore(key: string, totalRows: number, offset: number, limit: number, search: string): Promise<{ rows: Record<string, unknown>[]; hasMore: boolean }> {
    const rows: Record<string, unknown>[] = [];
    let matched = 0;
    const chunkSize = 500;
    for (let start = 0; start < totalRows; start += chunkSize) {
      const values = await this.client.lRange(key, start, Math.min(totalRows - 1, start + chunkSize - 1));
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (!this.matchesRedisSearch([value], search)) {
          continue;
        }
        if (matched >= offset && rows.length < limit + 1) {
          rows.push({ index: start + index, value });
        }
        matched += 1;
        if (rows.length >= limit + 1) {
          return { rows: rows.slice(0, limit), hasMore: true };
        }
      }
    }
    return { rows, hasMore: false };
  }

  private async collectStreamPageWithMore(
    key: string,
    offset: number,
    limit: number,
    predicate: (item: { id: string; message: Record<string, string> }) => boolean = () => true
  ): Promise<{ items: Array<{ id: string; message: Record<string, string> }>; hasMore: boolean }> {
    const items: Array<{ id: string; message: Record<string, string> }> = [];
    let cursor = "-";
    let matched = 0;
    while (true) {
      const chunk = await this.client.xRange(key, cursor, "+", { COUNT: REDIS_SCAN_BATCH_SIZE });
      if (!chunk.length) {
        return { items, hasMore: false };
      }
      for (const item of chunk) {
        if (!predicate(item)) {
          continue;
        }
        if (matched >= offset && items.length < limit + 1) {
          items.push(item);
        }
        matched += 1;
        if (items.length >= limit + 1) {
          return { items: items.slice(0, limit), hasMore: true };
        }
      }
      cursor = incrementRedisStreamId(chunk[chunk.length - 1].id);
    }
  }

  private async findListIndexesByNativeSearch(key: string, value: string, offset: number, limit: number): Promise<number[]> {
    const reply = await this.client.sendCommand(["LPOS", key, value, "RANK", String(offset + 1), "COUNT", String(limit)]);
    if (!Array.isArray(reply)) {
      return typeof reply === "number" ? [reply] : [];
    }
    return reply.map((item) => Number(item)).filter(Number.isInteger);
  }

  private async deleteKeyMember(key: string, keyType: string, row: Record<string, unknown>): Promise<number> {
    const type = (keyType || await this.client.type(key)).toLowerCase();
    if (type === "hash") {
      return await this.client.hDel(key, String(row.field ?? ""));
    }
    if (type === "list") {
      const index = Number(row.index);
      if (!Number.isInteger(index)) {
        throw new Error("删除 List 元素需要有效的 index。");
      }
      const marker = `__database_workbench_deleted_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
      await this.client.lSet(key, index, marker);
      return await this.client.lRem(key, 1, marker);
    }
    if (type === "set") {
      return await this.client.sRem(key, String(row.member ?? ""));
    }
    if (type === "zset") {
      return await this.client.zRem(key, String(row.member ?? ""));
    }
    if (type === "stream") {
      return await this.client.xDel(key, String(row.id ?? ""));
    }
    throw new Error(`暂不支持删除 ${type} 类型的元素。`);
  }

  private matchesRedisSearch(values: unknown[], search: string): boolean {
    if (!search) {
      return true;
    }
    const needle = search.toLowerCase();
    return values.some((value) => this.redisSearchText(value).toLowerCase().includes(needle));
  }

  private matchesRedisExact(values: unknown[], search: string): boolean {
    return values.some((value) => this.redisSearchText(value) === search);
  }

  private redisSearchText(value: unknown): string {
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private async getStringPreview(key: string): Promise<string> {
    const rawLength = await this.client.sendCommand(["STRLEN", key]);
    const length = Number(rawLength);
    const value = String(await this.client.sendCommand(["GETRANGE", key, "0", String(REDIS_STRING_PREVIEW_BYTES - 1)]) ?? "");
    return Number.isFinite(length) && length > REDIS_STRING_PREVIEW_BYTES
      ? `${value} ...（已截断，长度 ${length} 字节）`
      : value;
  }

  private formatRedisPreview(items: string[], total: number): string {
    if (total <= 0) {
      return "空";
    }
    const preview = items.length ? items.join(", ") : "空";
    return total > items.length ? `${preview}, ...` : preview;
  }

  private shortRedisValue(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }

  private async inspectKey(key: string, maxRows: number): Promise<Record<string, unknown>[]> {
    const type = await this.client.type(key);
    const ttl = await this.client.ttl(key);
    const limit = maxRows < 0 ? 200 : Math.max(1, maxRows);
    if (type === "none") {
      return [{ key, type, ttl, value: "Key 不存在" }];
    }
    if (type === "string") {
      return [{ key, type, ttl, value: await this.getStringPreview(key) }];
    }
    if (type === "hash") {
      const value = await this.collectIteratorItems(this.client.hScanIterator(key, { COUNT: limit }), limit);
      return value.map((item) => ({ key, type, ttl, field: item.field, value: item.value }));
    }
    if (type === "list") {
      const values = await this.client.lRange(key, 0, limit - 1);
      return values.map((value, index) => ({ key, type, ttl, index, value }));
    }
    if (type === "set") {
      const values = await this.collectIteratorItems(this.client.sScanIterator(key, { COUNT: limit }), limit);
      return values.map((value) => ({ key, type, ttl, member: value }));
    }
    if (type === "zset") {
      const values = await this.client.zRangeWithScores(key, 0, limit - 1);
      return values.map((item) => ({ key, type, ttl, member: item.value, score: item.score }));
    }
    if (type === "stream") {
      const values = await this.client.xRange(key, "-", "+", { COUNT: limit });
      return values.map((item) => ({ key, type, ttl, id: item.id, value: JSON.stringify(item.message) }));
    }
    return [{ key, type, ttl, value: `暂不支持预览 ${type} 类型` }];
  }
}

type ElasticHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

type ElasticSqlResponse = {
  columns?: Array<{ name: string }>;
  rows?: unknown[][];
};

class ElasticRestClient {
  private readonly baseUrl: URL;
  private readonly authorization: string | undefined;
  private readonly allowInsecureTls: boolean;

  constructor(config: DbConnectionWithSecret) {
    const protocol = config.ssl ? "https" : "http";
    this.baseUrl = new URL(`${protocol}://${config.host}:${config.port}`);
    this.allowInsecureTls = Boolean(config.allowInsecureTls);
    if (config.username || config.password) {
      const username = config.username || "elastic";
      this.authorization = `Basic ${Buffer.from(`${username}:${config.password}`).toString("base64")}`;
    }
  }

  async ping(): Promise<void> {
    await this.request("GET", "/");
  }

  async catIndices(indexPattern: string | undefined): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams({
      format: "json",
      h: "index,docs.count,store.size,health,status",
    });
    const path = `/_cat/indices${indexPattern ? `/${encodeElasticPathSegment(indexPattern)}` : ""}?${params.toString()}`;
    const response = await this.request("GET", path);
    return Array.isArray(response) ? response as Array<Record<string, unknown>> : [];
  }

  async getMapping(index: string): Promise<Record<string, { mappings?: unknown }>> {
    return await this.request("GET", `/${encodeElasticIndexPath(index)}/_mapping`) as Record<string, { mappings?: unknown }>;
  }

  async getSettings(index: string): Promise<Record<string, unknown>> {
    return await this.request("GET", `/${encodeElasticIndexPath(index)}/_settings`) as Record<string, unknown>;
  }

  async sqlQuery(query: string, fetchSize: number): Promise<ElasticSqlResponse> {
    return await this.request("POST", "/_sql", { query, fetch_size: fetchSize }) as ElasticSqlResponse;
  }

  async request(method: ElasticHttpMethod, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    const isHttps = url.protocol === "https:";
    const elasticConfig = getElasticsearchConfig();
    const timeoutMs = Math.max(1000, Math.min(600000, Math.floor(elasticConfig.requestTimeoutMs || 30000)));
    const maxResponseBytes = Math.max(1024 * 1024, Math.min(100 * 1024 * 1024, Math.floor(elasticConfig.maxResponseBytes || 10 * 1024 * 1024)));
    const allowInsecureTls = this.allowInsecureTls || elasticConfig.allowInsecureTls;
    const payload = this.serializeBody(body);
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (this.authorization) {
      headers.authorization = this.authorization;
    }
    if (payload !== undefined) {
      headers["content-type"] = typeof body === "string" ? "application/x-ndjson" : "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const fail = (request: http.ClientRequest, error: Error) => {
        if (settled) return;
        settled = true;
        request.destroy(error);
        reject(error);
      };
      const requestOptions: http.RequestOptions | https.RequestOptions = {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers,
        rejectUnauthorized: isHttps ? !allowInsecureTls : undefined,
      };
      const request = (isHttps ? https : http).request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (receivedBytes > maxResponseBytes) {
            fail(request, new Error(`Elasticsearch 响应超过 ${maxResponseBytes} 字节，请缩小查询范围或调大 databaseWorkbench.elasticsearch.maxResponseBytes。`));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 0;
          const parsed = parseElasticHttpBody(text);
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(formatElasticHttpError(statusCode, parsed, text)));
            return;
          }
          resolve(parsed);
        });
      });
      request.setTimeout(timeoutMs, () => {
        fail(request, new Error(`Elasticsearch 请求超过 ${timeoutMs}ms 未响应，已自动中止。`));
      });
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(formatElasticRequestError(error));
      });
      if (payload !== undefined) {
        request.write(payload);
      }
      request.end();
    });
  }

  async close(): Promise<void> {
    // 原生 HTTP 请求按需创建连接，这里无需显式释放。
  }

  private serializeBody(body: unknown): string | undefined {
    if (body === undefined) {
      return undefined;
    }
    return typeof body === "string" ? body : JSON.stringify(body);
  }
}

class ElasticsearchWorkbenchClient implements DbClient {
  private constructor(
    private readonly client: ElasticRestClient,
    private readonly indexPattern: string | undefined
  ) {}

  static async connect(config: DbConnectionWithSecret): Promise<ElasticsearchWorkbenchClient> {
    return new ElasticsearchWorkbenchClient(new ElasticRestClient(config), config.database?.trim() || undefined);
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async listDatabases(): Promise<string[]> {
    return ["indices"];
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const indices = await this.client.catIndices(this.indexPattern);
    return indices
      .filter((item) => !String(item.index ?? "").startsWith("."))
      .map((item) => ({
        name: String(item.index ?? ""),
        comment: `${item["docs.count"] ?? 0} docs · ${item["store.size"] ?? "-"} · ${item.health ?? ""}`,
      }))
      .filter((item) => item.name)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const summaries = await this.listTableSummaries();
    if (!summaries.length) {
      return [];
    }
    const result = await this.client.getMapping(summaries.map((item) => item.name).join(",") || "*");
    return summaries.map((summary) => {
      const mapping = result[summary.name]?.mappings ?? {};
      const fields = flattenElasticProperties(mapping);
      return {
        name: summary.name,
        comment: summary.comment,
        columns: fields.length ? fields : [
          { name: "_id", type: "keyword", nullable: false, key: "PRI", comment: "文档 ID" },
          { name: "_source", type: "object", nullable: true, comment: "原始文档" },
        ],
      };
    });
  }

  async getCreateTableSql(index: string): Promise<string> {
    const [mapping, settings] = await Promise.all([
      this.client.getMapping(index),
      this.client.getSettings(index),
    ]);
    return `PUT /${index}\n${JSON.stringify({ settings: settings[index], mappings: mapping[index] }, null, 2)}`;
  }

  async query(commandText: string, maxRows: number): Promise<QueryResult> {
    const startedAt = Date.now();
    const text = commandText.trim();
    if (!text) {
      throw new Error("请输入 Elasticsearch SQL，或 HTTP 请求：GET /index/_search {...}");
    }
    if (/^select\b/i.test(text)) {
      const response = await this.client.sqlQuery(text, maxRows < 0 ? 1000 : Math.max(1, maxRows));
      const columns = (response.columns ?? []).map((column) => column.name);
      const rows = (response.rows ?? []).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
      return { columns, rows, rowCount: rows.length, command: "SQL", elapsedMs: Date.now() - startedAt };
    }

    const request = withElasticSearchSizeLimit(parseElasticRequest(text), maxRows);
    const response = await this.client.request(request.method, request.path, request.body);
    const rows = normalizeElasticResponse(response, maxRows);
    return {
      columns: Object.keys(rows[0] ?? { result: "" }),
      rows,
      rowCount: rows.length,
      command: request.method,
      elapsedMs: Date.now() - startedAt,
    };
  }

  quoteIdentifier(identifier: string): string {
    return identifier;
  }

  async dispose(): Promise<void> {
    await this.client.close();
  }
}

function applySafetyLimit(sql: string, maxRows: number, type: DatabaseType): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (maxRows < 0 || !/^select\b/i.test(trimmed) || /\blimit\s+\d+/i.test(trimmed)) {
    return sql;
  }

  const safeLimit = Math.max(1, maxRows);
  return type === "postgres"
    ? `${trimmed} LIMIT ${safeLimit}`
    : `${trimmed} LIMIT ${safeLimit}`;
}

function sliceRows<T>(rows: T[], maxRows: number): T[] {
  return maxRows < 0 ? rows : rows.slice(0, maxRows);
}

function parseRedisConfigDatabasesReply(reply: unknown): number {
  if (Array.isArray(reply)) {
    for (let index = 0; index < reply.length - 1; index += 1) {
      if (String(reply[index]).toLowerCase() === "databases") {
        return Number(reply[index + 1]);
      }
    }
    return Number(reply[1] ?? reply[0]);
  }
  if (reply && typeof reply === "object") {
    const value = (reply as Record<string, unknown>).databases ?? (reply as Record<string, unknown>).DATABASES;
    return Number(value);
  }
  return Number(reply);
}

function assertSafeRedisCommand(args: string[]): void {
  const issue = analyzeRedisCommandRisk(args);
  if (!issue) {
    return;
  }
  throw new Error(`${issue.reason}${issue.suggestion ? ` 建议：${issue.suggestion}` : ""}`);
}

function analyzeRedisCommandRisk(args: string[]): { reason: string; suggestion?: string } | null {
  const command = String(args[0] || "").toUpperCase();
  if (!command) {
    return null;
  }
  if (["SCAN", "HSCAN", "SSCAN", "ZSCAN"].includes(command) && !hasRedisOptionalCountWithinLimit(args)) {
    return { reason: `${command} 的 COUNT 过大，可能让单次响应过重。`, suggestion: `${command} 使用 COUNT ${Math.min(100, REDIS_SAFE_RANGE_LIMIT)} 到 ${REDIS_SAFE_RANGE_LIMIT} 之间的值。` };
  }
  if (command === "KEYS") {
    return { reason: "KEYS 会阻塞扫描整个 DB，数据量大时会影响 Redis 服务。", suggestion: "改用 SCAN 0 MATCH pattern COUNT 100 分批查看。" };
  }
  if (command === "HGETALL") {
    return { reason: "HGETALL 会一次性拉取整个 Hash，大 Key 会占用大量内存和网络。", suggestion: "改用 HSCAN key 0 COUNT 100 分页查看。" };
  }
  if (command === "SMEMBERS") {
    return { reason: "SMEMBERS 会一次性拉取整个 Set，大 Key 会占用大量内存和网络。", suggestion: "改用 SSCAN key 0 COUNT 100 分页查看。" };
  }
  if (["MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE"].includes(command)) {
    return { reason: `${command} 是持续阻塞/订阅类命令，不适合在查询面板执行。` };
  }
  if (["FLUSHDB", "FLUSHALL"].includes(command)) {
    return { reason: `${command} 属于高危清库命令，已在查询面板中禁用。` };
  }
  if (command === "DEL") {
    return { reason: "DEL 删除大 Key 时可能阻塞 Redis 主线程。", suggestion: "改用 UNLINK key 异步释放内存。" };
  }
  if (command === "LRANGE") {
    const start = Number(args[2]);
    const stop = Number(args[3]);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < 0 || stop - start + 1 > REDIS_SAFE_RANGE_LIMIT) {
      return { reason: "LRANGE 范围过大或无界，可能一次性返回大量 List 元素。", suggestion: `限制范围，例如 LRANGE key 0 ${REDIS_SAFE_RANGE_LIMIT - 1}。` };
    }
  }
  if (["ZRANGE", "ZREVRANGE"].includes(command)) {
    const upperArgs = args.map((arg) => String(arg).toUpperCase());
    if (upperArgs.includes("LIMIT") && !hasRedisLimitWithinLimit(args)) {
      return { reason: `${command} LIMIT 数量过大，可能一次性返回大量 ZSet 元素。`, suggestion: `把 LIMIT count 控制在 ${REDIS_SAFE_RANGE_LIMIT} 以内。` };
    }
    if (!upperArgs.includes("LIMIT")) {
      const start = Number(args[2]);
      const stop = Number(args[3]);
      if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < 0 || Math.abs(stop - start) + 1 > REDIS_SAFE_RANGE_LIMIT) {
        return { reason: `${command} 范围过大或无界，可能一次性返回大量 ZSet 元素。`, suggestion: `限制范围，例如 ${command} key 0 ${REDIS_SAFE_RANGE_LIMIT - 1}${upperArgs.includes("WITHSCORES") ? " WITHSCORES" : ""}。` };
      }
    }
  }
  if (["XRANGE", "XREVRANGE"].includes(command) && !hasRedisCountWithinLimit(args)) {
    return { reason: `${command} 未设置安全 COUNT，可能一次性返回大量 Stream 消息。`, suggestion: `${command} key - + COUNT 100。` };
  }
  if (command === "XREAD") {
    const upperArgs = args.map((arg) => String(arg).toUpperCase());
    if (upperArgs.includes("BLOCK")) {
      return { reason: "XREAD BLOCK 是阻塞命令，不适合在查询面板执行。" };
    }
    if (!hasRedisCountWithinLimit(args)) {
      return { reason: "XREAD 未设置安全 COUNT，可能返回过多 Stream 消息。", suggestion: "加上 COUNT 100。" };
    }
  }
  if (command === "SORT") {
    const upperArgs = args.map((arg) => String(arg).toUpperCase());
    if (!upperArgs.includes("LIMIT")) {
      return { reason: "SORT 未设置 LIMIT 时可能遍历并返回大量元素。", suggestion: "加上 LIMIT 0 100。" };
    }
    if (!hasRedisLimitWithinLimit(args)) {
      return { reason: "SORT LIMIT 数量过大，可能一次性返回大量元素。", suggestion: `把 LIMIT count 控制在 ${REDIS_SAFE_RANGE_LIMIT} 以内。` };
    }
  }
  if (["MGET", "HMGET"].includes(command) && args.length - 1 > REDIS_SAFE_RANGE_LIMIT) {
    return { reason: `${command} 一次请求的字段或 Key 过多，可能导致响应过大。`, suggestion: `每次最多查询 ${REDIS_SAFE_RANGE_LIMIT} 个。` };
  }
  return null;
}

function hasRedisOptionalCountWithinLimit(args: string[]): boolean {
  const upperArgs = args.map((arg) => String(arg).toUpperCase());
  const index = upperArgs.indexOf("COUNT");
  if (index < 0) {
    return true;
  }
  const count = Number(args[index + 1]);
  return Number.isInteger(count) && count > 0 && count <= REDIS_SAFE_RANGE_LIMIT;
}

function hasRedisLimitWithinLimit(args: string[]): boolean {
  const upperArgs = args.map((arg) => String(arg).toUpperCase());
  const index = upperArgs.indexOf("LIMIT");
  if (index < 0) {
    return false;
  }
  const count = Number(args[index + 2]);
  return Number.isInteger(count) && count > 0 && count <= REDIS_SAFE_RANGE_LIMIT;
}

function hasRedisCountWithinLimit(args: string[]): boolean {
  const upperArgs = args.map((arg) => String(arg).toUpperCase());
  const index = upperArgs.indexOf("COUNT");
  if (index < 0) {
    return false;
  }
  const count = Number(args[index + 1]);
  return Number.isInteger(count) && count > 0 && count <= REDIS_SAFE_RANGE_LIMIT;
}

function incrementRedisStreamId(id: string): string {
  const match = id.match(/^(\d+)-(\d+)$/);
  if (!match) {
    return id;
  }
  return `${match[1]}-${Number(match[2]) + 1}`;
}

function parseRedisDatabase(value: string | undefined): number {
  const match = String(value ?? "0").match(/\d+/);
  const db = match ? Number(match[0]) : 0;
  return Number.isInteger(db) && db >= 0 ? db : 0;
}

function splitCommandLine(input: string): string[] {
  const matches = input.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\\.|[^\s]+/g) ?? [];
  return matches.map((part) => {
    if ((part.startsWith("\"") && part.endsWith("\"")) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    }
    return part;
  });
}

function normalizeRedisCommandArgs(args: string[]): string[] {
  return args.map((arg) => String(arg).toUpperCase() === "WITHSCORE" ? "WITHSCORES" : arg);
}

function normalizeRedisReply(reply: unknown, maxRows: number, args: string[] = []): Record<string, unknown>[] {
  const limit = maxRows < 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, maxRows);
  if (Array.isArray(reply) && isRedisZSetRangeWithScores(args)) {
    return normalizeRedisZSetRangeWithScores(reply, limit, args);
  }
  if (Array.isArray(reply)) {
    return reply.slice(0, limit).map((value, index) => Array.isArray(value)
      ? { index, value: JSON.stringify(value) }
      : value && typeof value === "object"
        ? { index, ...value as Record<string, unknown> }
        : { index, value });
  }
  if (reply && typeof reply === "object") {
    return Object.entries(reply as Record<string, unknown>).slice(0, limit).map(([key, value]) => ({ key, value }));
  }
  return [{ result: reply }];
}

function isRedisZSetRangeWithScores(args: string[]): boolean {
  const command = String(args[0] || "").toUpperCase();
  return ["ZRANGE", "ZREVRANGE"].includes(command)
    && args.some((arg) => String(arg).toUpperCase() === "WITHSCORES");
}

function normalizeRedisZSetRangeWithScores(reply: unknown[], limit: number, args: string[]): Record<string, unknown>[] {
  const command = String(args[0] || "").toUpperCase();
  const start = Number(args[2]);
  const rankBase = Number.isInteger(start) && start >= 0 ? start : 0;
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < reply.length - 1 && rows.length < limit; index += 2) {
    rows.push({
      rank: rankBase + rows.length,
      member: reply[index],
      score: parseRedisScore(reply[index + 1]),
    });
  }
  return rows;
}

function parseRedisScore(value: unknown): unknown {
  const text = String(value ?? "");
  const numberValue = Number(text);
  return Number.isFinite(numberValue) && text.trim() !== "" ? numberValue : value;
}

function encodeElasticPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2A/g, "*").replace(/%2C/g, ",");
}

function encodeElasticIndexPath(value: string): string {
  return value.split(",").map((item) => encodeElasticPathSegment(item)).join(",");
}

function parseElasticHttpBody(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatElasticHttpError(statusCode: number, parsed: unknown, rawText: string): string {
  const body = parsed as { error?: unknown };
  const error = body && typeof body === "object" ? body.error : undefined;
  if (typeof error === "string") {
    return `Elasticsearch 请求失败 (${statusCode}): ${error}`;
  }
  if (error && typeof error === "object") {
    const detail = error as { type?: string; reason?: string; root_cause?: Array<{ reason?: string }> };
    const reason = detail.reason || detail.root_cause?.map((item) => item.reason).filter(Boolean).join("; ");
    return `Elasticsearch 请求失败 (${statusCode})${detail.type ? ` ${detail.type}` : ""}${reason ? `: ${reason}` : ""}`;
  }
  return `Elasticsearch 请求失败 (${statusCode})${rawText ? `: ${rawText.slice(0, 500)}` : ""}`;
}

function formatElasticRequestError(error: Error): Error {
  if (/self signed certificate|certificate chain|unable to verify/i.test(error.message)) {
    return new Error(`${error.message}。当前 Elasticsearch 使用了自签名或未受信任证书，请编辑该 ES 连接，在启用 SSL 后选择“允许自签名证书”（仅限本地 Docker 或可信内网）。`);
  }
  return error;
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

function parseElasticRequest(input: string): { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown } {
  const match = input.match(/^(GET|POST|PUT|DELETE)\s+(\S+)\s*([\s\S]*)$/i);
  if (!match) {
    if (input.startsWith("{")) {
      return { method: "POST", path: "/_search", body: JSON.parse(input) };
    }
    throw new Error("请输入 Elasticsearch SQL，或形如 GET /index/_search 的 HTTP 请求。");
  }
  const bodyText = match[3]?.trim();
  return {
    method: match[1].toUpperCase() as "GET" | "POST" | "PUT" | "DELETE",
    path: match[2],
    body: bodyText ? parseElasticRequestBody(bodyText) : undefined,
  };
}

function withElasticSearchSizeLimit(
  request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown },
  maxRows: number
): { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown } {
  if (!/\/_search(?:\?|$)/.test(request.path) || request.body === undefined || typeof request.body !== "object" || Array.isArray(request.body)) {
    return request;
  }
  const body = request.body as Record<string, unknown>;
  if (body.size !== undefined) {
    return request;
  }
  return {
    ...request,
    body: {
      ...body,
      size: maxRows < 0 ? 1000 : Math.max(1, maxRows),
    },
  };
}

function parseElasticRequestBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    if (bodyText.trim().split(/\r?\n/).filter(Boolean).length > 1) {
      return bodyText.endsWith("\n") ? bodyText : `${bodyText}\n`;
    }
    throw error;
  }
}

function normalizeElasticResponse(response: unknown, maxRows: number): Record<string, unknown>[] {
  const body = response as Record<string, unknown>;
  if (typeof body.count === "number") {
    return [{ totalRows: body.count }];
  }
  const hits = (body.hits as { hits?: Array<Record<string, unknown>> } | undefined)?.hits;
  const limit = maxRows < 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, maxRows);
  if (Array.isArray(hits)) {
    return hits.slice(0, limit).map((hit) => ({
      ...(hit._source && typeof hit._source === "object" ? hit._source as Record<string, unknown> : { _source: JSON.stringify(hit._source ?? null) }),
      _index: hit._index,
      _id: hit._id,
      _score: hit._score,
    }));
  }
  if (Array.isArray(body.rows) && Array.isArray(body.columns)) {
    const columns = (body.columns as Array<{ name: string }>).map((column) => column.name);
    return (body.rows as unknown[][]).slice(0, limit).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  }
  return [{ result: JSON.stringify(response, null, 2) }];
}

function flattenElasticProperties(mapping: unknown): TableColumn[] {
  const root = mapping as { properties?: Record<string, unknown> };
  const output: TableColumn[] = [
    { name: "_id", type: "keyword", nullable: false, key: "PRI", comment: "文档 ID" },
  ];
  const visit = (prefix: string, properties: Record<string, unknown> | undefined) => {
    for (const [name, raw] of Object.entries(properties ?? {})) {
      const field = raw as { type?: string; properties?: Record<string, unknown> };
      const path = prefix ? `${prefix}.${name}` : name;
      output.push({ name: path, type: field.type ?? "object", nullable: true, comment: field.type ? "mapping 字段" : "对象字段" });
      if (field.properties) {
        visit(path, field.properties);
      }
    }
  };
  visit("", root.properties);
  return output;
}
