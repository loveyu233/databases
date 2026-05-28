import { QueryResult, TableInfo, TableSummary } from "../../types";

export interface DbClient {
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

export class QueryStatementsError extends Error {
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

export function supportsClientTransactions(client: DbClient): client is DbClient & Required<Pick<DbClient, "beginTransaction" | "commit" | "rollback">> {
  return typeof client.beginTransaction === "function"
    && typeof client.commit === "function"
    && typeof client.rollback === "function";
}

export function getClientErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
