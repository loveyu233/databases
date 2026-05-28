import { DbConnectionWithSecret, QueryResult, TableInfo, TableSummary } from "../types";
import { ElasticsearchWorkbenchClient } from "./clients/elasticsearch";
import { MongoWorkbenchClient } from "./clients/mongodb";
import { MySqlClient } from "./clients/mysql";
import { PostgresClient } from "./clients/postgres";
import { RedisWorkbenchClient } from "./clients/redis";
import { DbClient, QueryStatementsError, supportsClientTransactions } from "./core/client";

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

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}
