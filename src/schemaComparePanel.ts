import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DatabaseService } from "./database/clients";
import { areTableSchemasEqual, buildSchemaSyncSql } from "./schemaSync";
import { ConnectionStore } from "./storage";
import { DbConnectionConfig, DbConnectionWithSecret, TableInfo, TableSummary } from "./types";

type CompareInitMessage = {
  type: "init";
  source: ConnectionSummary & { database: string };
  sourceTables: TableSummary[];
  targetConnections: ConnectionSummary[];
};

type ConnectionSummary = {
  id: string;
  name: string;
  type: DbConnectionConfig["type"];
  host: string;
  port: number;
  username: string;
};

type CompareMessage =
  | { type: "ready" }
  | { type: "loadTargetDatabases"; connectionId: string }
  | { type: "loadTargetTables"; connectionId: string; database: string }
  | { type: "compare"; sourceTable: string; targetConnectionId: string; targetDatabase: string; targetTable: string }
  | { type: "executeSyncSql"; direction: "sourceToTarget" | "targetToSource"; sql: string; targetConnectionId: string; targetDatabase: string; table?: string; confirmed?: boolean }
  | { type: "copyText"; text: string; successMessage?: string };

const panels = new Map<string, SchemaComparePanel>();
const ALL_TABLES_VALUE = "__database_workbench_all_tables__";
const SCHEMA_COMPARE_INIT_TIMEOUT_MS = 30000;
const SCHEMA_COMPARE_TARGET_TIMEOUT_MS = 30000;
const SCHEMA_COMPARE_COMPARE_TIMEOUT_MS = 120000;
type CompareTableStatus = "same" | "changed" | "sourceOnly" | "targetOnly";
type DdlCompareRow = { source: string; target: string; status: "same" | "sourceOnly" | "targetOnly" };
type CompareTableRow = {
  table: string;
  sourceTable: string;
  targetTable: string;
  status: CompareTableStatus;
  sourceDdl?: string;
  targetDdl?: string;
  sourceToTargetSql?: string;
  targetToSourceSql?: string;
  ddlRows?: DdlCompareRow[];
};

export class SchemaComparePanel {
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly databaseService: DatabaseService,
    private readonly sourceConnection: DbConnectionConfig,
    private readonly sourceDatabase: string,
    private readonly panel: vscode.WebviewPanel
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: CompareMessage) => this.handleMessage(message), null, this.disposables);
    this.panel.webview.html = renderCompareHtml();
  }

  static open(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    databaseService: DatabaseService,
    sourceConnection: DbConnectionConfig,
    sourceDatabase: string
  ): void {
    const key = `${sourceConnection.id}:${sourceDatabase}`;
    const existing = panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "databaseWorkbench.schemaCompare",
      `表结构对比 · ${sourceDatabase}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panels.set(key, new SchemaComparePanel(context, store, databaseService, sourceConnection, sourceDatabase, panel));
  }

  private dispose(): void {
    panels.delete(`${this.sourceConnection.id}:${this.sourceDatabase}`);
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: CompareMessage): Promise<void> {
    try {
      if (message.type === "ready") {
        await this.sendInit();
        return;
      }
      if (message.type === "loadTargetDatabases") {
        await this.sendTargetDatabases(message.connectionId);
        return;
      }
      if (message.type === "loadTargetTables") {
        await this.sendTargetTables(message.connectionId, message.database);
        return;
      }
      if (message.type === "compare") {
        await this.compare(message);
        return;
      }
      if (message.type === "executeSyncSql") {
        await this.executeSyncSql(message);
        return;
      }
      if (message.type === "copyText") {
        await vscode.env.clipboard.writeText(message.text || "");
        vscode.window.showInformationMessage(message.successMessage || "已复制到剪贴板。");
      }
    } catch (error) {
      this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendInit(): Promise<void> {
    this.post({ type: "loading", message: "正在读取源库信息..." });
    const source = await withTimeout(
      this.requireConnection(this.sourceConnection.id),
      8000,
      "读取源库连接配置超时，请关闭对比页后重试。"
    );
    const sourceTables = await withTimeout(
      this.databaseService.listTableSummaries(source, this.sourceDatabase),
      SCHEMA_COMPARE_INIT_TIMEOUT_MS,
      `读取源库 ${this.sourceDatabase} 的表列表超时，请检查连接状态或稍后重试。`
    );
    const targetConnections = this.store.getAll()
      .filter((connection) => connection.type === this.sourceConnection.type && (connection.type === "mysql" || connection.type === "postgres"))
      .map(toConnectionSummary);
    const payload: CompareInitMessage = {
      type: "init",
      source: { ...toConnectionSummary(this.sourceConnection), database: this.sourceDatabase },
      sourceTables,
      targetConnections,
    };
    this.post(payload);
  }

  private async sendTargetDatabases(connectionId: string): Promise<void> {
    this.post({ type: "loading", message: "正在读取目标连接的数据库列表..." });
    const connection = await this.requireConnection(connectionId);
    this.assertCompatibleConnection(connection);
    const databases = await withTimeout(
      this.databaseService.listDatabases(connection),
      SCHEMA_COMPARE_TARGET_TIMEOUT_MS,
      "读取目标连接的数据库列表超时，请检查目标连接是否可用。"
    );
    this.post({ type: "targetDatabases", connectionId, databases });
  }

  private async sendTargetTables(connectionId: string, database: string): Promise<void> {
    this.post({ type: "loading", message: "正在读取目标库表列表..." });
    const connection = await this.requireConnection(connectionId);
    this.assertCompatibleConnection(connection);
    const tables = await withTimeout(
      this.databaseService.listTableSummaries(connection, database),
      SCHEMA_COMPARE_TARGET_TIMEOUT_MS,
      `读取目标库 ${database} 的表列表超时，请检查目标连接是否可用。`
    );
    this.post({ type: "targetTables", connectionId, database, tables });
  }

  private async compare(message: Extract<CompareMessage, { type: "compare" }>): Promise<void> {
    if (!message.sourceTable || !message.targetConnectionId || !message.targetDatabase || !message.targetTable) {
      throw new Error("请先完整选择源表和目标表。");
    }
    const compareAll = message.sourceTable === ALL_TABLES_VALUE && message.targetTable === ALL_TABLES_VALUE;
    if ((message.sourceTable === ALL_TABLES_VALUE) !== (message.targetTable === ALL_TABLES_VALUE)) {
      throw new Error("全部对比需要源表和目标表都选择“全部”；单表对比需要两边都选择具体表。");
    }

    const source = await this.requireConnection(this.sourceConnection.id);
    const target = await this.requireConnection(message.targetConnectionId);
    this.assertCompatibleConnection(source);
    this.assertCompatibleConnection(target);

    if (compareAll) {
      await this.compareAllTables(source, target, message.targetDatabase);
      return;
    }

    this.post({ type: "loading", message: "正在读取两边表结构..." });
    const [sourceDdl, targetDdl, sourceSchemaMap, targetSchemaMap] = await withTimeout(
      Promise.all([
        this.databaseService.getCreateTableSql(source, this.sourceDatabase, message.sourceTable),
        this.databaseService.getCreateTableSql(target, message.targetDatabase, message.targetTable),
        this.getSchemaMap(source, this.sourceDatabase),
        this.getSchemaMap(target, message.targetDatabase),
      ]),
      SCHEMA_COMPARE_COMPARE_TIMEOUT_MS,
      "读取单表结构超时，请检查两边数据库连接或缩小对比范围。"
    );
    const sourceTable = sourceSchemaMap.get(message.sourceTable);
    const targetTable = targetSchemaMap.get(message.targetTable);
    if (!sourceTable || !targetTable) {
      throw new Error("未读取到完整表结构元数据，请刷新后重试。");
    }

    const dialect = source.type as "mysql" | "postgres";
    const forwardResult = buildSchemaSyncSql(dialect, sourceTable, targetTable);
    const backwardResult = buildSchemaSyncSql(dialect, targetTable, sourceTable);
    const same = forwardResult.statements.length === 0 && backwardResult.statements.length === 0;
    const diff = buildSimpleDiff(sourceDdl, targetDdl);
    const sourceToTargetSql = forwardResult.sql;
    const targetToSourceSql = backwardResult.sql;

    this.post({
      type: "compareResult",
      same,
      sourceDdl,
      targetDdl,
      sourceToTargetSql,
      targetToSourceSql,
      diff,
      tableRows: [{
        table: message.sourceTable === message.targetTable ? message.sourceTable : `${message.sourceTable} ↔ ${message.targetTable}`,
        sourceTable: message.sourceTable,
        targetTable: message.targetTable,
        status: same ? "same" : "changed",
        sourceDdl,
        targetDdl,
        sourceToTargetSql,
        targetToSourceSql,
        ddlRows: buildDdlCompareRows(sourceDdl, targetDdl),
      }],
      ddlRows: buildDdlCompareRows(sourceDdl, targetDdl),
      aiFailed: false,
      sourceLabel: `${this.sourceConnection.name} / ${this.sourceDatabase} / ${message.sourceTable}`,
      targetLabel: `${target.name} / ${message.targetDatabase} / ${message.targetTable}`,
    });
  }

  private async compareAllTables(source: DbConnectionWithSecret, target: DbConnectionWithSecret, targetDatabase: string): Promise<void> {
    this.post({ type: "loading", message: "正在读取两边全部表结构..." });
    const [sourceList, targetList, sourceSchemaMap, targetSchemaMap] = await withTimeout(
      Promise.all([
        this.getDatabaseCreateTableSqlList(source, this.sourceDatabase),
        this.getDatabaseCreateTableSqlList(target, targetDatabase),
        this.getSchemaMap(source, this.sourceDatabase),
        this.getSchemaMap(target, targetDatabase),
      ]),
      SCHEMA_COMPARE_COMPARE_TIMEOUT_MS,
      "读取两边全部表结构超时，请检查连接状态或改为单表对比。"
    );
    const sourceDdl = formatDatabaseDdl(sourceList);
    const targetDdl = formatDatabaseDdl(targetList);
    const sourceMap = new Map(sourceList.map((item) => [item.table, item.sql]));
    const targetMap = new Map(targetList.map((item) => [item.table, item.sql]));
    const sourceTables = [...sourceSchemaMap.keys()].sort();
    const targetTables = [...targetSchemaMap.keys()].sort();
    const commonTables = sourceTables.filter((table) => targetSchemaMap.has(table));
    const sourceOnlyTables = sourceTables.filter((table) => !targetSchemaMap.has(table));
    const targetOnlyTables = targetTables.filter((table) => !sourceSchemaMap.has(table));
    const dialect = source.type as "mysql" | "postgres";
    const changedTables = commonTables.filter((table) => {
      const sourceTable = sourceSchemaMap.get(table);
      const targetTable = targetSchemaMap.get(table);
      return !sourceTable || !targetTable || !areTableSchemasEqual(dialect, sourceTable, targetTable);
    });
    const changedTableSet = new Set(changedTables);
    const sameTables = commonTables.filter((table) => !changedTableSet.has(table));
    const tableRows = buildCompareTableRows(sourceOnlyTables, targetOnlyTables, changedTables, sameTables, sourceMap, targetMap);
    const same = sourceOnlyTables.length === 0 && targetOnlyTables.length === 0 && changedTables.length === 0;
    const diff = buildDatabaseDiff(sourceOnlyTables, targetOnlyTables, changedTables);
    const forwardParts: string[] = [];
    const backwardParts: string[] = [];
    const rowByTable = new Map(tableRows.map((row) => [row.table, row]));

    for (const table of sourceOnlyTables) {
      const sourceToTargetSql = buildCreateTableSection(table, sourceMap.get(table) || "", "目标库缺少该表，直接使用源库 CREATE TABLE 创建。");
      const targetToSourceSql = buildDropTableSection(source.type, table, "源库存在但目标库不存在；源库同步成目标库需要删除源库该表。");
      forwardParts.push(sourceToTargetSql);
      backwardParts.push(targetToSourceSql);
      const row = rowByTable.get(table);
      if (row) {
        row.sourceToTargetSql = sourceToTargetSql;
        row.targetToSourceSql = targetToSourceSql;
      }
    }
    for (const table of targetOnlyTables) {
      const targetToSourceSql = buildCreateTableSection(table, targetMap.get(table) || "", "源库缺少该表，直接使用目标库 CREATE TABLE 创建。");
      const sourceToTargetSql = buildDropTableSection(source.type, table, "目标库存在但源库不存在；目标库同步成源库需要删除目标库该表。");
      backwardParts.push(targetToSourceSql);
      forwardParts.push(sourceToTargetSql);
      const row = rowByTable.get(table);
      if (row) {
        row.sourceToTargetSql = sourceToTargetSql;
        row.targetToSourceSql = targetToSourceSql;
      }
    }

    if (changedTables.length) {
      this.post({ type: "loading", message: `正在根据元数据生成同步 SQL：共 ${changedTables.length} 张差异表...` });
      for (const table of changedTables) {
        const sourceTable = sourceSchemaMap.get(table);
        const targetTable = targetSchemaMap.get(table);
        if (!sourceTable || !targetTable) continue;
        const sourceToTargetSql = buildAlterTableSection(table, buildSchemaSyncSql(dialect, sourceTable, targetTable).sql, "目标库同步成源库");
        const targetToSourceSql = buildAlterTableSection(table, buildSchemaSyncSql(dialect, targetTable, sourceTable).sql, "源库同步成目标库");
        forwardParts.push(sourceToTargetSql);
        backwardParts.push(targetToSourceSql);
        const row = rowByTable.get(table);
        if (row) {
          row.sourceToTargetSql = sourceToTargetSql;
          row.targetToSourceSql = targetToSourceSql;
        }
      }
    }

    this.post({
      type: "compareResult",
      same,
      sourceDdl,
      targetDdl,
      sourceToTargetSql: forwardParts.length ? forwardParts.join("\n\n") : "-- 两边表结构一致，无需执行 SQL。",
      targetToSourceSql: backwardParts.length ? backwardParts.join("\n\n") : "-- 两边表结构一致，无需执行 SQL。",
      diff,
      tableRows,
      ddlRows: [],
      aiFailed: false,
      sourceLabel: `${this.sourceConnection.name} / ${this.sourceDatabase} / 全部表`,
      targetLabel: `${target.name} / ${targetDatabase} / 全部表`,
    });
  }

  private async executeSyncSql(message: Extract<CompareMessage, { type: "executeSyncSql" }>): Promise<void> {
    const statements = splitExecutableSqlStatements(message.sql || "");
    if (!statements.length) {
      throw new Error("当前内容没有可执行 SQL，可能只有说明性注释或结构对比提示。");
    }

    const connection = message.direction === "sourceToTarget"
      ? await this.requireConnection(message.targetConnectionId)
      : await this.requireConnection(this.sourceConnection.id);
    const database = message.direction === "sourceToTarget" ? message.targetDatabase : this.sourceDatabase;
    this.assertCompatibleConnection(connection);

    const directionText = message.direction === "sourceToTarget" ? "目标库同步成源库" : "源库同步成目标库";
    if (message.confirmed !== true) {
      this.post({
        type: "sqlConfirmPreview",
        title: `确认执行 ${directionText}${message.table ? `（${message.table}）` : ""}？`,
        sql: statements.join("\n\n"),
        action: { ...message, confirmed: true },
      });
      return;
    }

    for (let index = 0; index < statements.length; index += 1) {
      this.post({ type: "loading", message: `正在执行同步 SQL：${directionText}（${index + 1}/${statements.length}）...` });
      await this.databaseService.query(connection, database, statements[index], 1);
    }
    this.post({ type: "executeResult", ok: true, message: `执行完成：${directionText}，共 ${statements.length} 条 SQL。建议重新对比确认结果。` });
  }

  private async getDatabaseCreateTableSqlList(connection: DbConnectionWithSecret, database: string): Promise<Array<{ table: string; sql: string }>> {
    const ddlList = connection.type === "mysql"
      ? await this.databaseService.getDatabaseCreateTableSql(connection, database)
      : await this.getDatabaseCreateTableSqlSequentially(connection, database);
    return ddlList.sort((left, right) => left.table.localeCompare(right.table));
  }

  private async getSchemaMap(connection: DbConnectionWithSecret, database: string): Promise<Map<string, TableInfo>> {
    const schema = await this.databaseService.loadSchema(connection, database);
    return new Map(schema.map((table) => [table.name, table]));
  }

  private async getDatabaseCreateTableSqlSequentially(connection: DbConnectionWithSecret, database: string): Promise<Array<{ table: string; sql: string }>> {
    const tables = await this.databaseService.listTables(connection, database);
    const ddlList: Array<{ table: string; sql: string }> = [];
    for (const table of tables) {
      ddlList.push({ table, sql: await this.databaseService.getCreateTableSql(connection, database, table) });
    }
    return ddlList;
  }

  private async requireConnection(connectionId: string) {
    const connection = await this.store.getWithSecret(connectionId);
    if (!connection) {
      throw new Error("连接配置不存在，请刷新连接树后重试。");
    }
    return connection;
  }

  private assertCompatibleConnection(connection: DbConnectionConfig): void {
    if (connection.type !== this.sourceConnection.type || (connection.type !== "mysql" && connection.type !== "postgres")) {
      throw new Error("表结构对比暂时只支持同类型 MySQL 或 PostgreSQL 连接。");
    }
  }

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
  }
}

function toConnectionSummary(connection: DbConnectionConfig): ConnectionSummary {
  return {
    id: connection.id,
    name: connection.name,
    type: connection.type,
    host: connection.host,
    port: connection.port,
    username: connection.username,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function buildSimpleDiff(left: string, right: string): Array<{ kind: "added" | "removed"; text: string }> {
  const leftLines = normalizeDiffLines(left);
  const rightLines = normalizeDiffLines(right);
  const rightSet = new Set(rightLines);
  const leftSet = new Set(leftLines);
  const removed = leftLines.filter((line) => !rightSet.has(line)).slice(0, 80).map((text) => ({ kind: "removed" as const, text }));
  const added = rightLines.filter((line) => !leftSet.has(line)).slice(0, 80).map((text) => ({ kind: "added" as const, text }));
  return [...removed, ...added];
}

function normalizeDiffLines(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean);
}

function formatDatabaseDdl(ddlList: Array<{ table: string; sql: string }>): string {
  if (!ddlList.length) {
    return "-- 当前数据库没有表。";
  }
  return ddlList
    .map((item) => `-- 表结构：${item.table}\n${ensureSqlSemicolon(item.sql)}`)
    .join("\n\n");
}

function buildDatabaseDiff(sourceOnlyTables: string[], targetOnlyTables: string[], changedTables: string[]): Array<{ kind: "added" | "removed"; text: string }> {
  return [
    ...sourceOnlyTables.map((table) => ({ kind: "removed" as const, text: `源库独有表：${table}` })),
    ...targetOnlyTables.map((table) => ({ kind: "added" as const, text: `目标库独有表：${table}` })),
    ...changedTables.map((table) => ({ kind: "added" as const, text: `同名表结构不同：${table}` })),
  ];
}

function buildCompareTableRows(
  sourceOnlyTables: string[],
  targetOnlyTables: string[],
  changedTables: string[],
  sameTables: string[],
  sourceMap: Map<string, string>,
  targetMap: Map<string, string>
): CompareTableRow[] {
  const rows: CompareTableRow[] = [
    ...changedTables.map((table) => buildCompareTableRow(table, table, table, "changed", sourceMap, targetMap)),
    ...sourceOnlyTables.map((table) => buildCompareTableRow(table, table, "", "sourceOnly", sourceMap, targetMap)),
    ...targetOnlyTables.map((table) => buildCompareTableRow(table, "", table, "targetOnly", sourceMap, targetMap)),
    ...sameTables.map((table) => buildCompareTableRow(table, table, table, "same", sourceMap, targetMap)),
  ];
  const weight: Record<CompareTableStatus, number> = { changed: 0, sourceOnly: 1, targetOnly: 2, same: 3 };
  return rows.sort((left, right) => weight[left.status] - weight[right.status] || left.table.localeCompare(right.table));
}

function buildCompareTableRow(
  table: string,
  sourceTable: string,
  targetTable: string,
  status: CompareTableStatus,
  sourceMap: Map<string, string>,
  targetMap: Map<string, string>
): CompareTableRow {
  const sourceDdl = sourceTable ? sourceMap.get(sourceTable) || "" : "";
  const targetDdl = targetTable ? targetMap.get(targetTable) || "" : "";
  return {
    table,
    sourceTable,
    targetTable,
    status,
    sourceDdl,
    targetDdl,
    ddlRows: buildDdlCompareRows(sourceDdl, targetDdl),
  };
}

function buildDdlCompareRows(sourceDdl: string, targetDdl: string): DdlCompareRow[] {
  const sourceLines = normalizeDiffLines(sourceDdl);
  const targetLines = normalizeDiffLines(targetDdl);
  const targetSet = new Set(targetLines);
  const sourceSet = new Set(sourceLines);
  const sameRows = sourceLines
    .filter((line) => targetSet.has(line))
    .slice(0, 120)
    .map((line) => ({ source: line, target: line, status: "same" as const }));
  const sourceOnlyRows = sourceLines
    .filter((line) => !targetSet.has(line))
    .slice(0, 160)
    .map((line) => ({ source: line, target: "", status: "sourceOnly" as const }));
  const targetOnlyRows = targetLines
    .filter((line) => !sourceSet.has(line))
    .slice(0, 160)
    .map((line) => ({ source: "", target: line, status: "targetOnly" as const }));
  return [...sourceOnlyRows, ...targetOnlyRows, ...sameRows];
}

function buildCreateTableSection(table: string, sql: string, reason: string): string {
  return [
    `-- ${reason}`,
    `-- 表：${table}`,
    ensureSqlSemicolon(sql),
  ].join("\n");
}

function buildDropTableSection(type: DbConnectionConfig["type"], table: string, reason: string): string {
  return [
    `-- ${reason}`,
    `-- 表：${table}`,
    `DROP TABLE ${quoteTableIdentifier(type, table)};`,
  ].join("\n");
}

function buildAlterTableSection(table: string, sql: string, title: string): string {
  return [
    `-- ${title}：${table}`,
    sql.trim() || "-- 没有生成可执行 SQL。",
  ].join("\n");
}

function quoteTableIdentifier(type: DbConnectionConfig["type"], table: string): string {
  if (type === "postgres") {
    return `"${table.replace(/"/g, "\"\"")}"`;
  }
  return `\`${table.replace(/`/g, "``")}\``;
}

function splitExecutableSqlStatements(sql: string): string[] {
  return splitSqlStatements(stripMarkdownSqlFence(sql))
    .map(stripSqlComments)
    .map((statement) => statement.trim())
    .filter((statement) => /^(alter|create|drop|rename|truncate|comment|grant|revoke|insert|update|delete)\b/i.test(statement));
}

function stripMarkdownSqlFence(sql: string): string {
  return sql
    .replace(/^\s*```(?:sql)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | "" = "";
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";
    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      current += char;
      if ((quote === "'" || quote === "\"") && char === "\\" && next) {
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) {
        if (next === quote && quote !== "`") {
          current += next;
          index += 1;
          continue;
        }
        quote = "";
      }
      continue;
    }
    if (char === "-" && next === "-") {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "#") {
      current += char;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(--|#).*$/, ""))
    .join("\n");
}

function ensureSqlSemicolon(sql: string): string {
  return `${sql.trim().replace(/;\s*$/, "")};`;
}

function renderCompareHtml(): string {
  const nonce = randomUUID().replace(/-/g, "");
  return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --card: color-mix(in srgb, var(--vscode-sideBar-background) 94%, var(--vscode-editor-background));
      --card-soft: color-mix(in srgb, var(--vscode-sideBar-background) 84%, var(--vscode-editor-background));
      --line: color-mix(in srgb, var(--vscode-panel-border) 78%, transparent);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --ok: var(--vscode-testing-iconPassed, #4aa36b);
      --warn: var(--vscode-editorWarning-foreground, #d19a66);
      --danger: var(--vscode-errorForeground, #f48771);
      --add: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
      --del: var(--vscode-gitDecoration-deletedResourceForeground, #f48771);
    }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--bg); font-family: var(--vscode-font-family); overflow: hidden; }
    .shell { height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 8px; padding: 9px; }
    .topbar { border: 1px solid var(--line); border-radius: 12px; background: linear-gradient(135deg, color-mix(in srgb, var(--card) 96%, var(--accent)), var(--card)); display: grid; grid-template-columns: minmax(190px, .7fr) minmax(520px, 2fr) auto; gap: 10px; align-items: center; padding: 8px 10px; }
    h1 { margin: 0; font-size: 15px; line-height: 1.2; }
    .meta, .sub, .status { color: var(--muted); font-size: 11px; line-height: 1.45; }
    .meta { margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .selector-grid { display: grid; grid-template-columns: .75fr 1fr .85fr .75fr; gap: 7px; min-width: 0; }
    .field { min-width: 0; }
    .field label { display: block; color: var(--muted); font-size: 10px; margin-bottom: 3px; }
    select { width: 100%; height: 29px; padding: 0 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 8px; outline: none; font-family: var(--vscode-font-family); font-size: 12px; }
    select:focus { border-color: var(--vscode-focusBorder); }
    button { border: 0; border-radius: 8px; padding: 7px 10px; color: var(--accent-fg); background: var(--accent); cursor: pointer; font-size: 12px; white-space: nowrap; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.arrow { width: 100%; padding: 9px 7px; font-weight: 700; border: 1px solid var(--line); }
    button.arrow.left { color: var(--del); background: color-mix(in srgb, var(--del) 10%, transparent); border-color: color-mix(in srgb, var(--del) 30%, var(--line)); }
    button.arrow.right { color: var(--add); background: color-mix(in srgb, var(--add) 10%, transparent); border-color: color-mix(in srgb, var(--add) 30%, var(--line)); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .actions { display: grid; grid-template-columns: auto auto; gap: 7px; justify-content: end; }
    .status { grid-column: 1 / -1; max-width: 300px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }
    .workspace { min-height: 0; display: grid; grid-template-columns: 292px minmax(0, 1fr); gap: 8px; }
    .card { min-width: 0; min-height: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--card); overflow: hidden; }
    .card-head { min-height: 33px; padding: 0 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--card-soft) 82%, transparent); }
    .card-title { font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .leftbar { display: grid; grid-template-rows: auto minmax(0, 1fr); }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; padding: 7px; border-bottom: 1px solid var(--line); }
    .stat { border: 1px solid var(--line); border-radius: 9px; padding: 7px 6px; background: color-mix(in srgb, var(--bg) 62%, transparent); }
    .stat strong { display: block; font-size: 16px; line-height: 1; margin-bottom: 4px; }
    .stat span { color: var(--muted); font-size: 10px; }
    .stat.changed strong { color: var(--warn); } .stat.same strong { color: var(--ok); } .stat.sourceOnly strong { color: var(--add); } .stat.targetOnly strong { color: var(--del); }
    .filters { display: flex; gap: 5px; padding: 7px; overflow-x: auto; border-bottom: 1px solid var(--line); }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted); font-size: 11px; cursor: pointer; white-space: nowrap; }
    .pill.active { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
    .table-list { overflow: auto; min-height: 0; }
    .table-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; align-items: center; padding: 7px 8px; border-bottom: 1px solid var(--line); cursor: pointer; }
    .table-row:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .table-row.active { background: color-mix(in srgb, var(--accent) 16%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
    .table-name { min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; font-size: 10px; }
    .chip.same { color: var(--ok); } .chip.changed { color: var(--warn); background: color-mix(in srgb, var(--warn) 11%, transparent); } .chip.sourceOnly { color: var(--add); background: color-mix(in srgb, var(--add) 10%, transparent); } .chip.targetOnly { color: var(--del); background: color-mix(in srgb, var(--del) 10%, transparent); }
    .main { min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 8px; }
    .stage { display: grid; grid-template-columns: minmax(0, 1fr) 124px minmax(0, 1fr); gap: 8px; min-height: 138px; }
    .summary-panel { display: grid; grid-template-rows: 33px minmax(0, 1fr); }
    .summary-body { padding: 10px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; align-content: start; }
    .summary-cell { border: 1px solid var(--line); border-radius: 10px; padding: 8px; background: color-mix(in srgb, var(--bg) 62%, transparent); min-width: 0; }
    .summary-cell strong { display: block; font-size: 18px; margin-bottom: 4px; }
    .summary-cell span { color: var(--muted); font-size: 11px; }
    .center-rail { display: grid; grid-template-rows: auto auto auto; gap: 8px; align-content: center; min-height: 0; }
    .rail-card { border: 1px solid var(--line); border-radius: 12px; padding: 9px 8px; background: color-mix(in srgb, var(--card) 88%, var(--bg)); text-align: center; }
    .rail-title { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
    .rail-table { font-family: var(--vscode-editor-font-family); font-size: 12px; word-break: break-all; }
    .visual-card { display: grid; grid-template-rows: 33px minmax(0, 1fr); }
    .visual-body { position: relative; min-height: 0; overflow: hidden; }
    .visual-diff { height: 100%; overflow: auto; padding: 8px; }
    .visual-row { display: grid; grid-template-columns: minmax(0, 1fr) 42px minmax(0, 1fr); gap: 7px; align-items: stretch; margin-bottom: 7px; }
    .element-card { border: 1px solid var(--line); border-radius: 10px; padding: 8px; background: color-mix(in srgb, var(--bg) 58%, transparent); min-width: 0; }
    .element-card.missing { opacity: .45; border-style: dashed; display: flex; align-items: center; justify-content: center; color: var(--muted); }
    .element-card.create { border-color: color-mix(in srgb, var(--add) 32%, var(--line)); background: color-mix(in srgb, var(--add) 8%, transparent); }
    .element-card.delete { border-color: color-mix(in srgb, var(--del) 32%, var(--line)); background: color-mix(in srgb, var(--del) 8%, transparent); }
    .element-card.modify { border-color: color-mix(in srgb, var(--warn) 36%, var(--line)); background: color-mix(in srgb, var(--warn) 8%, transparent); }
    .element-head { display: flex; gap: 6px; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .element-kind { color: var(--muted); font-size: 10px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 6px; white-space: nowrap; }
    .element-name { font-family: var(--vscode-editor-font-family); font-size: 12px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tag-list { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag { border: 1px solid var(--line); border-radius: 999px; padding: 2px 6px; color: var(--muted); font-size: 10px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail-text { color: var(--muted); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
    .visual-arrow { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: var(--muted); border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--card-soft) 70%, transparent); font-size: 11px; text-align: center; padding: 5px; }
    .visual-arrow strong { display: block; font-size: 15px; line-height: 1; }
    .visual-arrow.create { color: var(--add); } .visual-arrow.delete { color: var(--del); } .visual-arrow.modify { color: var(--warn); }
    .compare-overlay { position: absolute; inset: 8px; z-index: 3; display: none; align-items: center; justify-content: center; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 12px; background: color-mix(in srgb, var(--card) 90%, transparent); backdrop-filter: blur(2px); }
    .compare-overlay.active { display: flex; }
    .compare-loader { width: min(520px, 92%); border: 1px solid var(--line); border-radius: 14px; padding: 16px; background: color-mix(in srgb, var(--bg) 72%, var(--card)); box-shadow: 0 18px 48px color-mix(in srgb, #000 24%, transparent); }
    .compare-loader-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .compare-orbit { width: 38px; height: 38px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--accent) 20%, transparent); border-top-color: var(--accent); animation: compareSpin 1s linear infinite; }
    .compare-title { font-weight: 700; font-size: 13px; }
    .compare-message { color: var(--muted); font-size: 12px; margin-top: 3px; }
	    .compare-progress { height: 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 18%, transparent); overflow: hidden; }
	    .compare-progress::after { content: ""; display: block; width: 34%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, transparent, var(--accent), transparent); animation: compareSweep 1.25s ease-in-out infinite; }
	    @keyframes compareSpin { to { transform: rotate(360deg); } }
	    @keyframes compareSweep { 0% { transform: translateX(-120%); opacity: .35; } 50% { opacity: 1; } 100% { transform: translateX(260%); opacity: .35; } }
	    .sql-confirm-overlay { position: fixed; inset: 0; z-index: 20; display: none; align-items: center; justify-content: center; padding: clamp(12px, 3vw, 30px); background: rgba(0,0,0,.46); overflow: hidden; }
	    .sql-confirm-overlay.open { display: flex; }
	    .sql-confirm-card { width: min(1040px, calc(100vw - clamp(24px, 6vw, 60px))); max-width: calc(100vw - clamp(24px, 6vw, 60px)); height: min(76vh, calc(100vh - clamp(24px, 6vw, 60px))); min-height: min(360px, calc(100vh - clamp(24px, 6vw, 60px))); max-height: calc(100vh - clamp(24px, 6vw, 60px)); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: var(--card); box-shadow: 0 24px 70px rgba(0,0,0,.48); }
	    .sql-confirm-head { padding: 14px 16px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,255,255,.035), transparent); }
	    .sql-confirm-title { font-weight: 700; color: var(--fg); }
	    .sql-confirm-subtitle { margin-top: 4px; color: var(--muted); font-size: 12px; }
	    .sql-confirm-body { min-height: 0; padding: 14px 16px; overflow: hidden; }
	    .sql-confirm-code { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); white-space: pre; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.6; overscroll-behavior: contain; }
	    .sql-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: rgba(255,255,255,.015); }
	    .empty { color: var(--muted); border: 1px dashed var(--line); border-radius: 10px; padding: 13px; margin: 8px; text-align: center; font-size: 12px; }
    @media (max-width: 1080px) {
      body { overflow: auto; }
      .shell { height: auto; min-height: 100vh; }
      .topbar, .workspace, .stage { grid-template-columns: 1fr; }
      .selector-grid { grid-template-columns: 1fr 1fr; }
      .main, .leftbar, .visual-card { min-height: 260px; }
      .status { text-align: left; max-width: none; }
      .visual-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div>
        <h1>表结构对比工作台</h1>
        <div class="meta" id="sourceMeta">正在读取源库信息...</div>
      </div>
      <div class="selector-grid">
        <div class="field"><label>源表</label><select id="sourceTable"></select></div>
        <div class="field"><label>目标连接</label><select id="targetConnection"></select></div>
        <div class="field"><label>目标库</label><select id="targetDatabase"></select></div>
        <div class="field"><label>目标表</label><select id="targetTable"></select></div>
      </div>
      <div class="actions">
        <button class="secondary" id="refreshBtn">重新读取</button>
        <button id="compareBtn">开始对比</button>
        <div class="status" id="status"></div>
      </div>
    </section>

    <section class="workspace">
      <aside class="card leftbar">
        <div>
          <div class="card-head"><span class="card-title">表差异列表</span><span class="sub" id="dialectBadge">SQL</span></div>
          <div class="stats">
            <div class="stat changed"><strong id="changedCount">0</strong><span>不同</span></div>
            <div class="stat same"><strong id="sameCount">0</strong><span>一致</span></div>
            <div class="stat sourceOnly"><strong id="sourceOnlyCount">0</strong><span>源独有</span></div>
            <div class="stat targetOnly"><strong id="targetOnlyCount">0</strong><span>目标独有</span></div>
          </div>
          <div class="filters" id="filterPills">
            <span class="pill active" data-filter="all">全部</span>
            <span class="pill" data-filter="changed">不同</span>
            <span class="pill" data-filter="sourceOnly">源独有</span>
            <span class="pill" data-filter="targetOnly">目标独有</span>
            <span class="pill" data-filter="same">一致</span>
          </div>
        </div>
        <div class="table-list" id="tableCompareBody"><div class="empty">选择目标库后点击开始对比。</div></div>
      </aside>

      <section class="main">
        <div class="stage">
          <div class="card summary-panel">
            <div class="card-head"><span class="card-title" id="sourceTitle">源表</span><span class="sub">作为基准</span></div>
            <div class="summary-body" id="sourceSummary"></div>
          </div>
          <div class="center-rail">
            <div class="rail-card">
              <div class="rail-title">当前表</div>
              <div class="rail-table" id="activeTableName">未选择</div>
            </div>
            <button class="arrow right" id="execSourceToTarget">同步到目标 →</button>
            <button class="arrow left" id="execTargetToSource">← 同步到源</button>
          </div>
          <div class="card summary-panel">
            <div class="card-head"><span class="card-title" id="targetTitle">目标表</span><span class="sub">待同步对象</span></div>
            <div class="summary-body" id="targetSummary"></div>
          </div>
        </div>

        <div class="card visual-card">
          <div class="card-head"><span class="card-title">可视化差异</span><span class="sub" id="visualHint">字段、索引、约束和表选项会按左右对照展示</span></div>
          <div class="visual-body">
            <div class="compare-overlay" id="compareOverlay">
              <div class="compare-loader">
                <div class="compare-loader-head">
                  <div class="compare-orbit"></div>
                  <div>
                    <div class="compare-title">正在逐表对比结构</div>
                    <div class="compare-message" id="compareMessage">正在读取两边表结构...</div>
                  </div>
                </div>
                <div class="compare-progress"></div>
              </div>
            </div>
            <div class="visual-diff" id="visualDiff"><div class="empty">对比后选择一张表查看差异。</div></div>
          </div>
        </div>
      </section>
    </section>
	  </main>
	  <div class="sql-confirm-overlay" id="sqlConfirmOverlay" role="dialog" aria-modal="true" aria-labelledby="sqlConfirmTitle">
	    <div class="sql-confirm-card">
	      <div class="sql-confirm-head">
	        <div class="sql-confirm-title" id="sqlConfirmTitle">确认执行 SQL</div>
	        <div class="sql-confirm-subtitle">请检查即将执行的 SQL，内容较长时可以在下方区域滚动查看。</div>
	      </div>
	      <div class="sql-confirm-body"><pre class="sql-confirm-code" id="sqlConfirmCode"></pre></div>
	      <div class="sql-confirm-actions">
	        <button class="secondary" id="cancelSqlConfirmBtn">取消</button>
	        <button id="confirmSqlConfirmBtn">确认执行</button>
	      </div>
	    </div>
	  </div>

	  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ALL_TABLES_VALUE = "${ALL_TABLES_VALUE}";
	    const state = { init: null, last: null, tableFilter: "all", activeIndex: -1, pendingRefresh: null, mergeNextSingleResult: false, comparing: false, initWatchdogId: null, pendingSqlAction: null };
    const $ = (selector) => document.querySelector(selector);

    function setStatus(message, kind) {
      const el = $("#status");
      el.textContent = message || "";
      el.title = message || "";
      el.className = "status" + (kind ? " " + kind : "");
    }
    function setCompareRunning(running, message) {
      state.comparing = running;
      $("#compareBtn").disabled = running;
      $("#compareBtn").textContent = running ? "对比中..." : "开始对比";
      const overlay = $("#compareOverlay");
      if (overlay) overlay.classList.toggle("active", running);
      const label = $("#compareMessage");
      if (label && message) label.textContent = message;
    }
    function scheduleInitWatchdog() {
      if (state.initWatchdogId) {
        window.clearTimeout(state.initWatchdogId);
      }
      state.initWatchdogId = window.setTimeout(() => {
        if (!state.init) {
          const message = "读取源库信息仍未返回，请检查连接是否可用，或点击“重新读取”再试。";
          setStatus(message, "error");
          if ($("#sourceMeta")) {
            $("#sourceMeta").textContent = message;
            $("#sourceMeta").title = message;
          }
        }
      }, ${SCHEMA_COMPARE_INIT_TIMEOUT_MS + 5000});
    }
    function escapeHtml(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
    function option(value, label, description) {
      const item = document.createElement("option");
      item.value = value;
      item.textContent = description ? label + " · " + description : label;
      return item;
    }
    function fillSelect(selector, items, getValue, getLabel, getDescription) {
      const el = $(selector);
      el.innerHTML = "";
      items.forEach((item) => el.appendChild(option(getValue(item), getLabel(item), getDescription ? getDescription(item) : "")));
    }
    function selected(selector) { return $(selector).value || ""; }
    function activeRow() {
      const rows = (state.last && state.last.tableRows) || [];
      return rows[state.activeIndex] || null;
    }
    function loadTargetDatabases() {
      const connectionId = selected("#targetConnection");
      $("#targetDatabase").innerHTML = "";
      $("#targetTable").innerHTML = "";
      if (connectionId) {
        setStatus("正在读取目标连接的数据库列表...", "");
        vscode.postMessage({ type: "loadTargetDatabases", connectionId });
      }
    }
    function loadTargetTables() {
      const connectionId = selected("#targetConnection");
      const database = selected("#targetDatabase");
      $("#targetTable").innerHTML = "";
      if (connectionId && database) {
        setStatus("正在读取目标库表列表...", "");
        vscode.postMessage({ type: "loadTargetTables", connectionId, database });
      }
    }
    function getStatusText(status) {
      if (status === "same") return "一致";
      if (status === "changed") return "不同";
      if (status === "sourceOnly") return "源独有";
      if (status === "targetOnly") return "目标独有";
      return "未知";
    }
    function renderStats(rows) {
      const list = rows || [];
      const count = (status) => list.filter((item) => item.status === status).length;
      $("#changedCount").textContent = count("changed");
      $("#sameCount").textContent = count("same");
      $("#sourceOnlyCount").textContent = count("sourceOnly");
      $("#targetOnlyCount").textContent = count("targetOnly");
    }
    function getFilteredRows() {
      const rows = (state.last && state.last.tableRows) || [];
      return state.tableFilter === "all" ? rows : rows.filter((item) => item.status === state.tableFilter);
    }
    function renderTableCompare() {
      const body = $("#tableCompareBody");
      if (!state.last) {
        body.innerHTML = '<div class="empty">选择目标库后点击开始对比。</div>';
        return;
      }
      const rows = state.last.tableRows || [];
      const filtered = getFilteredRows();
      if (!filtered.length) {
        body.innerHTML = '<div class="empty">当前筛选没有结果。</div>';
        return;
      }
      body.innerHTML = filtered.map((item) => {
        const index = rows.indexOf(item);
        return '<div class="table-row' + (index === state.activeIndex ? ' active' : '') + '" data-index="' + index + '">'
          + '<div class="table-name" title="' + escapeHtml(item.table) + '">' + escapeHtml(item.table) + '</div>'
          + '<span class="chip ' + escapeHtml(item.status) + '">' + getStatusText(item.status) + '</span>'
          + '</div>';
      }).join("");
    }
    function parseElement(line) {
      const raw = String(line || "").trim().replace(/,$/, "");
      if (!raw) return { key: "empty", kind: "空", name: "—", tags: [], detail: "" };
      const lower = raw.toLowerCase();
      const tick = String.fromCharCode(96);
      let match = raw.match(new RegExp("^" + tick + "([^" + tick + "]+)" + tick + "\\s+(.+)$")) || raw.match(/^"([^"]+)"\s+(.+)$/);
      if (match && !/^(primary|unique|key|constraint|foreign|check)\b/i.test(match[1])) {
        const rest = match[2];
        const tags = [];
        const type = (rest.match(/^([a-zA-Z]+(?:\s+[a-zA-Z]+)?(?:\([^)]*\))?(?:\s+unsigned)?)/) || [])[1] || "类型未知";
        tags.push(type);
        tags.push(/not null/i.test(rest) ? "非 NULL" : "可 NULL");
        const def = rest.match(/default\s+((?:'[^']*')|(?:"[^"]*")|[^\s]+)/i);
        if (def) tags.push("默认 " + def[1]);
        if (/auto_increment|serial|identity/i.test(rest)) tags.push("自增");
        const comment = rest.match(/comment\s+'([^']*)'/i);
        return { key: "column:" + match[1], kind: "字段", name: match[1], tags, detail: comment ? comment[1] : rest };
      }
      if (/primary\s+key/i.test(lower)) return { key: "key:primary", kind: "主键", name: "PRIMARY", tags: [columnsFromLine(raw)], detail: raw };
      match = raw.match(new RegExp("^unique\\s+key\\s+" + tick + "?([^" + tick + "\\s(]+)" + tick + "?", "i")) || raw.match(new RegExp("^unique\\s+index\\s+" + tick + "?([^" + tick + "\\s(]+)" + tick + "?", "i"));
      if (match) return { key: "index:" + match[1], kind: "唯一索引", name: match[1], tags: [columnsFromLine(raw)], detail: raw };
      match = raw.match(new RegExp("^(?:key|index)\\s+" + tick + "?([^" + tick + "\\s(]+)" + tick + "?", "i"));
      if (match) return { key: "index:" + match[1], kind: "索引", name: match[1], tags: [columnsFromLine(raw)], detail: raw };
      match = raw.match(new RegExp("^constraint\\s+" + tick + "?([^" + tick + "\\s]+)" + tick + "?", "i"));
      if (match) return { key: "constraint:" + match[1], kind: /foreign\s+key/i.test(raw) ? "外键" : "检查", name: match[1], tags: [columnsFromLine(raw)].filter(Boolean), detail: raw };
      if (/check\s*\(/i.test(raw)) return { key: "check:" + raw.replace(/\s+/g, " ").slice(0, 60), kind: "检查", name: "CHECK", tags: [], detail: raw };
      match = raw.match(new RegExp("^create\\s+table\\s+" + tick + "?([^" + tick + "\\s(]+)" + tick + "?", "i"));
      if (match) return { key: "table:" + match[1], kind: "表", name: match[1], tags: [], detail: "表定义" };
      if (/engine=|charset=|collate=|comment=/i.test(raw)) return { key: "option:table", kind: "表选项", name: "TABLE OPTIONS", tags: raw.match(/(engine|charset|collate|comment)\s*=\s*[^\s]+/ig) || [], detail: raw };
      return { key: "other:" + raw.toLowerCase().slice(0, 80), kind: "其他", name: raw.slice(0, 42), tags: [], detail: raw };
    }
    function columnsFromLine(line) {
      const inside = (String(line).match(/\(([^)]*)\)/) || [])[1] || "";
      return inside.split(String.fromCharCode(96)).join("").replace(/"/g, "").trim();
    }
    function groupDiffRows(rows) {
      const groups = new Map();
      (rows || []).filter((item) => item.status !== "same").forEach((item) => {
        const source = parseElement(item.source);
        const target = parseElement(item.target);
        const key = item.source ? source.key : target.key;
        const group = groups.get(key) || { key, status: "changed", source: null, target: null };
        if (item.source) group.source = source;
        if (item.target) group.target = target;
        group.status = group.source && group.target ? "changed" : (group.source ? "sourceOnly" : "targetOnly");
        groups.set(key, group);
      });
      return [...groups.values()];
    }
    function operationFor(group, side) {
      if (group.status === "changed") return { kind: "modify", text: side === "source" ? "修改为目标" : "修改为源", icon: "改" };
      if (group.status === "sourceOnly") return side === "source"
        ? { kind: "delete", text: "源变目标需删除", icon: "删" }
        : { kind: "create", text: "目标变源需新增", icon: "增" };
      if (group.status === "targetOnly") return side === "source"
        ? { kind: "create", text: "源变目标需新增", icon: "增" }
        : { kind: "delete", text: "目标变源需删除", icon: "删" };
      return { kind: "modify", text: "保持一致", icon: "=" };
    }
    function renderOperationCard(group, side) {
      const operation = operationFor(group, side);
      const element = side === "source" ? (group.source || group.target) : (group.target || group.source);
      if (!element) return '<div class="element-card missing">不存在</div>';
      return '<div class="element-card ' + escapeHtml(operation.kind) + '" title="' + escapeHtml(element.detail) + '">'
        + '<div class="element-head"><span class="element-kind">' + escapeHtml(operation.text) + '</span><span class="element-name">' + escapeHtml(element.name) + '</span></div>'
        + '<div class="tag-list"><span class="tag">' + escapeHtml(element.kind) + '</span>'
        + (element.tags && element.tags.length ? element.tags.slice(0, 5).map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join("") : '')
        + '</div>'
        + (!element.tags || !element.tags.length ? '<div class="detail-text">' + escapeHtml(element.detail || "—") + '</div>' : '')
        + '</div>';
    }
    function renderVisualDiff(row) {
      const container = $("#visualDiff");
      if (!row || row.status === "same") {
        container.innerHTML = '<div class="empty">当前表结构一致，没有差异。</div>';
        return;
      }
      const groups = groupDiffRows(row.ddlRows || []);
      if (!groups.length) {
        container.innerHTML = '<div class="empty">当前表结构一致，没有差异。</div>';
        return;
      }
      container.innerHTML = groups.map((group) => {
        const left = operationFor(group, "source");
        const right = operationFor(group, "target");
        return '<div class="visual-row">'
          + renderOperationCard(group, "source")
          + '<div class="visual-arrow modify"><strong>⇄</strong><span>' + escapeHtml(left.icon + " / " + right.icon) + '</span></div>'
          + renderOperationCard(group, "target")
          + '</div>';
      }).join("");
    }
    function canAttemptSync(row, direction) {
      if (!row || row.status === "same") return false;
      if (row.status === "changed") return true;
      if (row.status === "sourceOnly" || row.status === "targetOnly") return true;
      return false;
    }
    function countVisual(row, side) {
      if (!row || row.status === "same") return 0;
      return groupDiffRows(row && row.ddlRows || []).length;
    }
    function actionCounts(row, side) {
      if (!row || row.status === "same") {
        return { add: 0, remove: 0, change: 0 };
      }
      const groups = groupDiffRows(row && row.ddlRows || []);
      const sourceOnly = groups.filter((item) => item.status === "sourceOnly").length;
      const targetOnly = groups.filter((item) => item.status === "targetOnly").length;
      return {
        add: side === "source" ? targetOnly : sourceOnly,
        remove: side === "source" ? sourceOnly : targetOnly,
        change: groups.filter((item) => item.status === "changed").length,
      };
    }
    function renderSummary(selector, row, side) {
      const exists = side === "source" ? !!(row && row.sourceTable) : !!(row && row.targetTable);
      const diffCount = countVisual(row, side);
      const counts = actionCounts(row, side);
      const third = "+" + counts.add + " / -" + counts.remove + " / 改" + counts.change;
      const thirdLabel = side === "source" ? "源变目标需操作" : "目标变源需操作";
      $(selector).innerHTML = '<div class="summary-cell"><strong>' + (exists ? "存在" : "缺失") + '</strong><span>表状态</span></div>'
        + '<div class="summary-cell"><strong>' + diffCount + '</strong><span>差异项</span></div>'
        + '<div class="summary-cell"><strong>' + third + '</strong><span>' + thirdLabel + '</span></div>';
    }
    function renderSelectedDetail() {
      const row = activeRow();
      if (!row) {
        $("#activeTableName").textContent = "未选择";
        $("#sourceTitle").textContent = "源表";
        $("#targetTitle").textContent = "目标表";
        $("#sourceSummary").innerHTML = "";
        $("#targetSummary").innerHTML = "";
        $("#execSourceToTarget").disabled = true;
        $("#execTargetToSource").disabled = true;
        renderVisualDiff(null);
        return;
      }
      $("#activeTableName").textContent = row.table + " · " + getStatusText(row.status);
      $("#sourceTitle").textContent = "源表 · " + (row.sourceTable || "不存在");
      $("#targetTitle").textContent = "目标表 · " + (row.targetTable || "不存在");
      renderSummary("#sourceSummary", row, "source");
      renderSummary("#targetSummary", row, "target");
      $("#execSourceToTarget").disabled = !canAttemptSync(row, "sourceToTarget");
      $("#execTargetToSource").disabled = !canAttemptSync(row, "targetToSource");
      renderVisualDiff(row);
    }
    function renderInit(message) {
      setCompareRunning(false);
      if (state.initWatchdogId) {
        window.clearTimeout(state.initWatchdogId);
        state.initWatchdogId = null;
      }
      state.init = message;
      state.last = null;
      state.activeIndex = -1;
      $("#sourceMeta").textContent = message.source.name + " / " + message.source.database + " · " + message.source.host + ":" + message.source.port;
      $("#dialectBadge").textContent = message.source.type.toUpperCase();
      fillSelect("#sourceTable", message.sourceTables || [], (item) => item.name, (item) => item.name, (item) => item.comment || "");
      $("#sourceTable").prepend(option(ALL_TABLES_VALUE, "全部表", "对比整个库"));
      $("#sourceTable").value = ALL_TABLES_VALUE;
      fillSelect("#targetConnection", message.targetConnections || [], (item) => item.id, (item) => item.name, (item) => item.host + ":" + item.port);
      const sameConnection = (message.targetConnections || []).find((item) => item.id === message.source.id);
      if (sameConnection) $("#targetConnection").value = sameConnection.id;
      renderStats([]);
      renderTableCompare();
      renderSelectedDetail();
      loadTargetDatabases();
      setStatus("选择目标库和表后开始对比。", "");
    }
    function mergeSingleTableResult(message) {
      const updated = (message.tableRows || [])[0];
      if (!updated || !state.last) return false;
      const rows = state.last.tableRows || [];
      const index = rows.findIndex((item) => item.table === updated.table || (updated.sourceTable && item.sourceTable === updated.sourceTable) || (updated.targetTable && item.targetTable === updated.targetTable));
      if (index >= 0) {
        rows[index] = updated;
        state.activeIndex = index;
      } else {
        rows.unshift(updated);
        state.activeIndex = 0;
      }
      state.last.tableRows = rows;
      renderStats(rows);
      renderTableCompare();
      renderSelectedDetail();
      setStatus(updated.status === "same" ? "同步后重新对比完成：当前表已一致。" : "同步后重新对比完成：当前表仍有差异。", updated.status === "same" ? "ok" : "");
      return true;
    }
    function renderResult(message) {
      setCompareRunning(false);
      if (state.mergeNextSingleResult && state.last && (message.tableRows || []).length === 1) {
        state.mergeNextSingleResult = false;
        if (mergeSingleTableResult(message)) return;
      }
      state.mergeNextSingleResult = false;
      state.last = message;
      const rows = message.tableRows || [];
      const preferred = rows.findIndex((item) => item.status !== "same");
      state.activeIndex = preferred >= 0 ? preferred : (rows.length ? 0 : -1);
      renderStats(rows);
      renderTableCompare();
      renderSelectedDetail();
      const diffCount = (message.diff || []).length;
      setStatus(message.same ? "对比完成：结构一致。" : "对比完成：发现 " + diffCount + " 个差异点。", message.same ? "ok" : "");
    }
    function buildRefreshTarget(row, direction) {
      let sourceTable = row.sourceTable || row.table || "";
      let targetTable = row.targetTable || row.table || "";
      if (direction === "sourceToTarget" && !targetTable) targetTable = sourceTable;
      if (direction === "targetToSource" && !sourceTable) sourceTable = targetTable;
      const fullRefresh = (row.status === "sourceOnly" && direction === "targetToSource") || (row.status === "targetOnly" && direction === "sourceToTarget");
      return { sourceTable, targetTable, fullRefresh };
    }
	    function executeDirection(direction) {
	      const row = activeRow();
	      if (!row) return;
	      const sql = direction === "sourceToTarget" ? row.sourceToTargetSql : row.targetToSourceSql;
	      state.pendingRefresh = buildRefreshTarget(row, direction);
	      vscode.postMessage({ type: "executeSyncSql", direction, sql: sql || "", targetConnectionId: selected("#targetConnection"), targetDatabase: selected("#targetDatabase"), table: row.table });
	    }
	    function openSqlConfirm(message) {
	      state.pendingSqlAction = message.action || null;
	      $("#sqlConfirmTitle").textContent = message.title || "确认执行 SQL";
	      const code = $("#sqlConfirmCode");
	      code.textContent = formatSqlPreview(message.sql || "");
	      $("#sqlConfirmOverlay").classList.add("open");
	      code.scrollTop = 0;
	      code.scrollLeft = 0;
	    }
	    function closeSqlConfirm(canceled) {
	      $("#sqlConfirmOverlay").classList.remove("open");
	      $("#sqlConfirmCode").textContent = "";
	      if (canceled) {
	        state.pendingRefresh = null;
	        setStatus("已取消执行。", "");
	      }
	      state.pendingSqlAction = null;
	    }
	    function confirmSqlAction() {
	      const action = state.pendingSqlAction;
	      closeSqlConfirm(false);
	      if (action && action.type) {
	        vscode.postMessage(action);
	        setStatus("正在执行已确认的 SQL...", "");
	      }
	    }
	    function formatSqlPreview(sql) {
	      return String(sql || "")
	        .replace(/\\r\\n/g, "\\n")
	        .replace(/;\\s*/g, ";\\n")
	        .replace(/\\b(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|SELECT|FROM|WHERE|SET|VALUES|ADD|MODIFY|CHANGE|RENAME|CONSTRAINT|PRIMARY KEY|FOREIGN KEY|REFERENCES|DEFAULT|COMMENT)\\b/gi, (match) => match.toUpperCase())
	        .trim();
	    }
    $("#targetConnection").addEventListener("change", loadTargetDatabases);
    $("#targetDatabase").addEventListener("change", loadTargetTables);
    $("#sourceTable").addEventListener("change", () => {
      const sourceTable = selected("#sourceTable");
      if (sourceTable === ALL_TABLES_VALUE) { $("#targetTable").value = ALL_TABLES_VALUE; return; }
      if ([...$("#targetTable").options].some((item) => item.value === sourceTable)) $("#targetTable").value = sourceTable;
    });
    $("#filterPills").addEventListener("click", (event) => {
      const pill = event.target.closest("[data-filter]");
      if (!pill) return;
      state.tableFilter = pill.getAttribute("data-filter") || "all";
      document.querySelectorAll(".pill").forEach((item) => item.classList.toggle("active", item === pill));
      const filtered = getFilteredRows();
      if (filtered.length && !filtered.includes(activeRow())) state.activeIndex = (state.last.tableRows || []).indexOf(filtered[0]);
      renderTableCompare();
      renderSelectedDetail();
    });
    $("#tableCompareBody").addEventListener("click", (event) => {
      const row = event.target.closest("[data-index]");
      if (!row) return;
      state.activeIndex = Number(row.getAttribute("data-index"));
      renderTableCompare();
      renderSelectedDetail();
    });
	    $("#execSourceToTarget").addEventListener("click", () => executeDirection("sourceToTarget"));
	    $("#execTargetToSource").addEventListener("click", () => executeDirection("targetToSource"));
	    $("#cancelSqlConfirmBtn").addEventListener("click", () => closeSqlConfirm(true));
	    $("#confirmSqlConfirmBtn").addEventListener("click", () => confirmSqlAction());
	    $("#sqlConfirmOverlay").addEventListener("click", (event) => {
	      if (event.target === $("#sqlConfirmOverlay")) closeSqlConfirm(true);
	    });
    $("#refreshBtn").addEventListener("click", () => {
      state.init = null;
      setStatus("正在重新读取...", "");
      if ($("#sourceMeta")) {
        $("#sourceMeta").textContent = "正在重新读取源库信息...";
        $("#sourceMeta").title = "";
      }
      scheduleInitWatchdog();
      vscode.postMessage({ type: "ready" });
    });
    $("#compareBtn").addEventListener("click", () => {
      setCompareRunning(true, "正在逐表读取并对比结构...");
      setStatus("正在对比表结构...", "");
      vscode.postMessage({ type: "compare", sourceTable: selected("#sourceTable"), targetConnectionId: selected("#targetConnection"), targetDatabase: selected("#targetDatabase"), targetTable: selected("#targetTable") });
    });
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "init") renderInit(message);
      if (message.type === "targetDatabases") {
        fillSelect("#targetDatabase", message.databases || [], (item) => item, (item) => item);
        if ((message.databases || []).includes(state.init && state.init.source && state.init.source.database)) $("#targetDatabase").value = state.init.source.database;
        loadTargetTables();
      }
      if (message.type === "targetTables") {
        fillSelect("#targetTable", message.tables || [], (item) => item.name, (item) => item.name, (item) => item.comment || "");
        $("#targetTable").prepend(option(ALL_TABLES_VALUE, "全部表", "对比整个库"));
        const sourceTable = selected("#sourceTable");
        if (sourceTable === ALL_TABLES_VALUE) $("#targetTable").value = ALL_TABLES_VALUE;
        else if ((message.tables || []).some((item) => item.name === sourceTable)) $("#targetTable").value = sourceTable;
      }
      if (message.type === "loading") {
        setStatus(message.message || "正在处理...", "");
        if (!state.init && $("#sourceMeta")) {
          $("#sourceMeta").textContent = message.message || "正在读取源库信息...";
          $("#sourceMeta").title = message.message || "";
        }
        if (state.comparing) {
          $("#compareMessage").textContent = message.message || "正在逐表对比结构...";
        }
      }
	      if (message.type === "compareResult") renderResult(message);
	      if (message.type === "sqlConfirmPreview") {
	        openSqlConfirm(message);
	      }
	      if (message.type === "executeResult") {
        if (message.ok && state.pendingRefresh) {
          const refresh = state.pendingRefresh;
          state.pendingRefresh = null;
          const compareAll = selected("#sourceTable") === ALL_TABLES_VALUE && selected("#targetTable") === ALL_TABLES_VALUE;
          state.mergeNextSingleResult = compareAll && !refresh.fullRefresh;
          setCompareRunning(true, "同步完成，正在重新对比当前表...");
          setStatus("同步执行完成，正在重新对比当前表...", "");
          vscode.postMessage({
            type: "compare",
            sourceTable: refresh.fullRefresh ? ALL_TABLES_VALUE : refresh.sourceTable,
            targetConnectionId: selected("#targetConnection"),
            targetDatabase: selected("#targetDatabase"),
            targetTable: refresh.fullRefresh ? ALL_TABLES_VALUE : refresh.targetTable,
          });
        } else {
          state.pendingRefresh = null;
          setStatus(message.message || "执行完成", message.ok ? "ok" : "");
        }
      }
      if (message.type === "error") {
        state.pendingRefresh = null;
        state.mergeNextSingleResult = false;
        setCompareRunning(false);
        if (!state.init && state.initWatchdogId) {
          window.clearTimeout(state.initWatchdogId);
          state.initWatchdogId = null;
        }
        setStatus(message.message || "操作失败", "error");
        if (!state.init && $("#sourceMeta")) {
          $("#sourceMeta").textContent = message.message || "读取源库信息失败";
          $("#sourceMeta").title = message.message || "";
        }
      }
    });
    scheduleInitWatchdog();
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
