import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { generateCreateTableSqlByPrompt, generateSqlByPrompt, translateDatabaseErrorToChinese } from "./ai";
import { DatabaseService } from "./database/clients";
import { hasProFeature, requireProFeature } from "./license/offlineLicense";
import { OperationLogService, type CreateOperationLogInput } from "./logService";
import { ConnectionStore } from "./storage";
import {
  DbConnectionConfig,
  DbConnectionWithSecret,
  getAiConfigurationMessage,
  getAiConfig,
  getExportConfig,
  getQueryConfig,
  getTableDisplayConfig,
  isAiConfigured,
  OperationLogEntry,
  PanelMessage,
  QuickRefreshQuery,
  QueryResult,
  SchemaCapabilities,
  TableInfo,
} from "./types";

type SchemaEditorMode = "editTable" | "createTable";
type WorkbenchPanelOptions = {
  schemaEditorMode?: SchemaEditorMode;
  queryConsole?: boolean;
};
export type ActiveWorkbenchTreeSelection =
  | { kind: "database"; connectionId: string; database: string }
  | { kind: "table"; connectionId: string; database: string; table: string };
type SqlPaginationPlan = {
  executableSql: string;
  baseSql?: string;
  countSql?: string;
  page?: number;
  pageSize?: number;
  isSelect: boolean;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
};
type RollbackPlan = {
  table: string;
  statements: string[];
  primaryKeys: string[];
  primaryValuesList: Array<Record<string, unknown>>;
};
type SqlStatementSelection = {
  statements: string[];
  mode: "single" | "all";
};

export class DatabaseWorkbenchPanel {
  private static readonly panels = new Map<string, DatabaseWorkbenchPanel>();
  private static readonly completionUsageStateKey = "databaseWorkbench.completionUsage";
  private static readonly activeTreeSelectionChangedEmitter = new vscode.EventEmitter<ActiveWorkbenchTreeSelection | undefined>();
  static readonly onDidChangeActiveTreeSelection = DatabaseWorkbenchPanel.activeTreeSelectionChangedEmitter.event;
  private static activePanelKey = "";

  private readonly disposables: vscode.Disposable[] = [];
  private schema: TableInfo[] = [];
  private selectedTable: string | undefined;
  private schemaLoaded = false;
  private pendingSchemaEditorMode: SchemaEditorMode | undefined;
  private readonly queryConsole: boolean;
  private schemaCapabilities: SchemaCapabilities = { supportsNotEmptyStringCheck: false };
  private lastQueryErrorSql = "";
  private panelKey: string;
  private readonly createTablePanel: boolean;
  private readonly operationLogService = new OperationLogService();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly databaseService: DatabaseService,
    private readonly connection: DbConnectionConfig,
    private readonly database: string,
    initialTable?: string,
    panelKey?: string,
    options?: WorkbenchPanelOptions
  ) {
    this.panelKey = panelKey ?? `${connection.id}:${database}`;
    this.queryConsole = options?.queryConsole === true;
    this.createTablePanel = options?.schemaEditorMode === "createTable";
    this.selectedTable = initialTable;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(() => this.updateActiveTableHighlight(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: PanelMessage) => this.handleMessage(message), null, this.disposables);
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.updateActiveTableHighlight();
  }

  static open(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    databaseService: DatabaseService,
    connection: DbConnectionConfig,
    database: string,
    table?: string,
    options?: WorkbenchPanelOptions
  ): DatabaseWorkbenchPanel {
    const isCreateTablePanel = options?.schemaEditorMode === "createTable";
    const key = DatabaseWorkbenchPanel.buildPanelKey(connection, database, table, isCreateTablePanel, options?.queryConsole === true);
    const existing = DatabaseWorkbenchPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      if (table) {
        void existing.selectTable(table, true).then(() => {
          if (options?.schemaEditorMode) existing.requestSchemaEditor(options.schemaEditorMode);
        });
      } else if (options?.schemaEditorMode) {
        existing.requestSchemaEditor(options.schemaEditorMode);
      }
      return existing;
    }

    const title = options?.queryConsole
      ? `查询控制台 · ${database}`
      : isCreateTablePanel
      ? `正在创建 · ${database}`
      : table ? `${table} · ${database}` : `${connection.name} / ${database}`;
    const panel = vscode.window.createWebviewPanel(
      "databaseWorkbench.query",
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );

    const instance = new DatabaseWorkbenchPanel(panel, context, store, databaseService, connection, database, table, key, options);
    if (options?.schemaEditorMode) {
      instance.pendingSchemaEditorMode = options.schemaEditorMode;
    }
    DatabaseWorkbenchPanel.panels.set(key, instance);
    return instance;
  }

  static async refreshOpenConnection(connectionId: string): Promise<void> {
    const panels = [...DatabaseWorkbenchPanel.panels.values()]
      .filter((panel) => panel.connection.id === connectionId && !panel.createTablePanel);
    await DatabaseWorkbenchPanel.refreshPanels(panels);
  }

  static async refreshOpenDatabase(connectionId: string, database: string): Promise<void> {
    const panels = [...DatabaseWorkbenchPanel.panels.values()]
      .filter((panel) => panel.connection.id === connectionId && panel.database === database && !panel.createTablePanel);
    await DatabaseWorkbenchPanel.refreshPanels(panels);
  }

  static refreshTableDisplayConfig(): void {
    const tableDisplay = getTableDisplayConfig();
    for (const panel of DatabaseWorkbenchPanel.panels.values()) {
      panel.panel.webview.postMessage({ type: "tableDisplayConfig", tableDisplay });
    }
  }

  static async refreshTableData(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    databaseService: DatabaseService,
    connection: DbConnectionConfig,
    database: string,
    table: string
  ): Promise<void> {
    const key = DatabaseWorkbenchPanel.buildPanelKey(connection, database, table, false, false);
    const existing = DatabaseWorkbenchPanel.panels.get(key);
    if (!existing) {
      DatabaseWorkbenchPanel.open(context, store, databaseService, connection, database, table);
      return;
    }

    existing.panel.reveal(vscode.ViewColumn.One);
    await existing.selectTable(table, true);
  }

  private static async refreshPanels(panels: DatabaseWorkbenchPanel[]): Promise<void> {
    const results = await Promise.allSettled(panels.map((panel) => panel.refreshPanelData()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) {
      throw new Error(getErrorMessage(failed.reason));
    }
  }

  private static buildPanelKey(
    connection: DbConnectionConfig,
    database: string,
    table: string | undefined,
    isCreateTablePanel: boolean,
    isQueryConsole: boolean
  ): string {
    if (isQueryConsole) {
      return JSON.stringify([connection.id, database, "query_console"]);
    }
    if (isCreateTablePanel) {
      return JSON.stringify([connection.id, database, "__create_table__"]);
    }
    return table
      ? JSON.stringify([connection.id, database, "table", table])
      : JSON.stringify([connection.id, database, "database"]);
  }

  private dispose(): void {
    DatabaseWorkbenchPanel.panels.delete(this.panelKey);
    if (DatabaseWorkbenchPanel.activePanelKey === this.panelKey) {
      DatabaseWorkbenchPanel.activePanelKey = "";
      DatabaseWorkbenchPanel.activeTreeSelectionChangedEmitter.fire({ kind: "database", connectionId: this.connection.id, database: this.database });
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private updateActiveTableHighlight(): void {
    if (!this.panel.active) {
      if (DatabaseWorkbenchPanel.activePanelKey === this.panelKey) {
        DatabaseWorkbenchPanel.activePanelKey = "";
        DatabaseWorkbenchPanel.activeTreeSelectionChangedEmitter.fire({ kind: "database", connectionId: this.connection.id, database: this.database });
      }
      return;
    }

    DatabaseWorkbenchPanel.activePanelKey = this.panelKey;
    const selection: ActiveWorkbenchTreeSelection = !this.queryConsole && !this.createTablePanel && this.selectedTable
      ? { kind: "table", connectionId: this.connection.id, database: this.database, table: this.selectedTable }
      : { kind: "database", connectionId: this.connection.id, database: this.database };
    DatabaseWorkbenchPanel.activeTreeSelectionChangedEmitter.fire(selection);
  }

  private async refreshPanelData(): Promise<void> {
    if (this.createTablePanel) {
      return;
    }
    await this.loadSchema(true);
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.loadSchema();
          return;
        case "refreshSchema":
          await this.loadSchema(true);
          return;
        case "previewTable":
          await this.selectTable(message.table, true);
          return;
        case "quickQuery":
          this.lastQueryErrorSql = "";
          await this.runQuickQuery(message.table, message.where, message.limit, message.page, message.sortColumn, message.sortDirection);
          return;
        case "runSql":
          this.lastQueryErrorSql = message.sql;
          await this.runSql(message.sql, message.limit, message.page, message.sortColumn, message.sortDirection);
          return;
        case "copyTableDdl":
          await this.copyTableDdl(message.table);
          return;
        case "copyText":
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.setStatusBarMessage(message.successMessage, 2000);
          return;
        case "exportPreview":
          await this.exportPreview(message);
          return;
        case "loadImportSourceDatabases":
          await this.loadImportSourceDatabases(message.connectionId);
          return;
        case "loadImportSourceTables":
          await this.loadImportSourceTables(message.connectionId, message.database);
          return;
        case "loadImportSourceSchema":
          await this.loadImportSourceSchema(message.connectionId, message.database, message.table);
          return;
        case "importTableData":
          await this.importTableData(message);
          return;
        case "copySchemaDraftSql":
          await this.copySchemaDraftSql(message.draft);
          return;
        case "previewSchemaDraftSql":
          await this.previewSchemaDraftSql(message.draft);
          return;
        case "applySchemaDraft":
          await this.applySchemaDraft(message.draft, message.confirmed === true);
          return;
        case "generateCreateTableDraft":
          await this.generateCreateTableDraft(message.prompt);
          return;
        case "closeCreateTablePanel":
          this.panel.dispose();
          return;
        case "insertRow":
          await this.insertRow(message.table, message.values, message.confirmed === true);
          return;
        case "deleteRow":
          await this.deleteRow(message.table, message.primaryKeys, message.primaryValues, message.confirmed === true);
          return;
        case "deleteRows":
          await this.deleteRows(message.table, message.primaryKeys, message.primaryValuesList, message.confirmed === true);
          return;
        case "redisDeleteKeys":
          await this.redisDeleteKeys(message.keys, message.confirmed === true);
          return;
        case "redisUpdateKeys":
          await this.redisUpdateKeys(message.updates, message.confirmed === true);
          return;
        case "redisUpdateTtls":
          await this.redisUpdateTtls(message.updates, message.confirmed === true);
          return;
        case "redisInspectKey":
          await this.redisInspectKey(message.key, message.page, message.pageSize, message.search, message.fuzzySearch, message.sortDirection);
          return;
        case "redisDeleteMember":
          await this.redisDeleteMember(message.key, message.keyType, message.row, message.page, message.pageSize, message.search, message.fuzzySearch, message.sortDirection, message.confirmed === true);
          return;
        case "loadOperationLogs":
          await this.loadOperationLogs(message.table);
          return;
        case "rollbackOperationLog":
          await this.rollbackOperationLog(message.logId, message.confirmed === true);
          return;
        case "analyzeOperationLogError":
          await this.analyzeOperationLogError(message.logId);
          return;
        case "markOperationLog":
          await this.markOperationLog(message.logId, message.label, message.color);
          return;
        case "updateCells":
          await this.updateCells(message.table, message.primaryKeys, message.updates, message.confirmed === true, message.refreshQuery);
          return;
        case "generateSql":
          await this.generateSql(message.prompt, message.tableNames);
          return;
        case "saveCompletionUsage":
          await this.saveCompletionUsage(message.completionUsage);
          return;
      }
    } catch (error) {
      if (message.type === "generateCreateTableDraft" || message.type === "previewSchemaDraftSql" || message.type === "applySchemaDraft") {
        this.panel.webview.postMessage({ type: "schemaDraftError", message: getErrorMessage(error) });
        return;
      }
      await this.postError("query", error);
    }
  }

  private postSqlConfirmPreview(
    title: string,
    sql: string,
    action: PanelMessage,
    status?: string,
    cancelAction?: PanelMessage
  ): void {
    this.panel.webview.postMessage({
      type: "sqlConfirmPreview",
      title,
      sql,
      action,
      status,
      cancelAction,
    });
  }

  private async loadSchema(force = false): Promise<void> {
    if (force) {
      this.schema = [];
      this.schemaLoaded = false;
    }

    this.panel.webview.postMessage({ type: "loading", area: "schema", message: "正在读取表结构..." });
    const connection = await this.requireConnection();
    this.schema = await this.databaseService.loadSchema(connection, this.database);
    this.schemaCapabilities = await this.loadSchemaCapabilities(connection);
    const queryConfig = getQueryConfig();

    this.panel.webview.postMessage({
      type: "init",
      database: this.database,
      connectionId: this.connection.id,
      connectionName: this.connection.name,
      connectionType: this.connection.type,
      tables: this.schema,
      selectedTable: this.selectedTable,
      defaultLimit: queryConfig.defaultLimit,
      tableDisplay: getTableDisplayConfig(),
      schemaCapabilities: this.schemaCapabilities,
      completionUsage: this.getCompletionUsage(),
      queryConsole: this.queryConsole,
      connections: this.store.getAll()
        .filter((connection) => connection.type === "mysql")
        .map((connection) => ({
          id: connection.id,
          name: connection.name,
          type: connection.type,
          host: connection.host,
          port: connection.port,
          username: connection.username,
        })),
    });

    const shouldAutoOpenTable = !this.queryConsole && this.pendingSchemaEditorMode !== "createTable" && this.connection.type !== "redis";
    const tableToOpen = shouldAutoOpenTable ? this.selectedTable ?? this.schema[0]?.name : undefined;
    if (tableToOpen) {
      await this.selectTable(tableToOpen, true);
    } else if (this.connection.type === "redis" && !this.selectedTable) {
      this.panel.title = `${this.database} · ${this.connection.name}`;
      await this.runQuickQuery("__redis_keys__", "", queryConfig.defaultLimit, 1, undefined, undefined, false);
    }
    this.schemaLoaded = true;
    this.flushSchemaEditorRequest();
  }

  private async selectTable(table: string, preview: boolean): Promise<void> {
    this.selectedTable = table;
    this.panel.title = `${table} · ${this.database}`;
    this.updateActiveTableHighlight();

    if (this.schema.length === 0) {
      await this.postSelectedTable({ name: table, columns: [] });
      if (preview) {
        await this.previewTable(table);
      }
      return;
    }

    const tableInfo = this.findTable(table) ?? { name: table, columns: [] };
    this.selectedTable = tableInfo.name;
    this.panel.title = `${tableInfo.name} · ${this.database}`;
    this.updateActiveTableHighlight();

    await this.postSelectedTable(tableInfo);

    if (preview) {
      await this.previewTable(table);
    }
  }

  private async postSelectedTable(table: TableInfo): Promise<void> {
    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "tableSelected", table, connectionType: this.connection.type, defaultLimit: queryConfig.defaultLimit, tableDisplay: getTableDisplayConfig(), schemaCapabilities: this.schemaCapabilities });
  }

  private requestSchemaEditor(mode: SchemaEditorMode): void {
    this.pendingSchemaEditorMode = mode;
    if (mode === "createTable") {
      this.selectedTable = undefined;
      this.panel.title = `正在创建 · ${this.database}`;
      this.updateActiveTableHighlight();
    }
    if (this.schemaLoaded) {
      this.flushSchemaEditorRequest();
    }
  }

  private flushSchemaEditorRequest(): void {
    if (!this.pendingSchemaEditorMode) {
      return;
    }
    const mode = this.pendingSchemaEditorMode;
    this.pendingSchemaEditorMode = undefined;
    this.panel.webview.postMessage({ type: "openSchemaEditor", mode });
  }

  private async previewTable(table: string): Promise<void> {
    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: `正在预览 ${table}...` });
    await this.runQuickQuery(table, "", queryConfig.defaultLimit, 1, undefined, undefined, false);
  }

  private async runQuickQuery(
    table: string,
    where: string,
    limit: number,
    page = 1,
    sortColumn?: string,
    sortDirection?: "asc" | "desc",
    showLoading = true
  ): Promise<void> {
    if (!table.trim()) {
      throw new Error("请先从左侧数据库树选择一张表。");
    }

    const safeLimit = clampLimit(limit || getQueryConfig().defaultLimit);
    const safePage = Math.max(1, Math.floor(page || 1));
    const connection = await this.requireConnection();
    const queryConfig = getQueryConfig();
    if (showLoading) {
      this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在执行快速查询..." });
    }
    if (this.connection.type === "redis") {
      const command = table === "__redis_keys__"
        ? `KEYS_PAGE ${JSON.stringify(where.trim() || "*")} ${safeLimit} ${safePage}`
        : where.trim() || `INSPECT ${table}`;
      this.lastQueryErrorSql = command;
      const result = await this.databaseService.query(connection, this.database, command, safeLimit < 0 ? -1 : queryConfig.maxRows);
      this.panel.webview.postMessage({ type: "result", sql: command, result });
      return;
    }
    if (this.connection.type === "elasticsearch") {
      let totalRows = 0;
      let totalPages = 1;
      let currentPage = safePage;
      if (safeLimit > 0) {
        const countBody = buildElasticQuickCountBody(where);
        const countRequest = `POST /${encodeURIComponent(table)}/_count\n${JSON.stringify(countBody, null, 2)}`;
        this.lastQueryErrorSql = countRequest;
        const countResult = await this.databaseService.query(connection, this.database, countRequest, 1);
        totalRows = readTotalRows(countResult);
        totalPages = Math.max(1, Math.ceil(totalRows / safeLimit));
        currentPage = Math.min(safePage, totalPages);
      }
      const size = safeLimit < 0 ? queryConfig.maxRows : Math.max(1, safeLimit);
      const from = safeLimit > 0 ? (currentPage - 1) * size : 0;
      const body = buildElasticQuickSearchBody(where, size, from, sortColumn, sortDirection);
      const request = `POST /${encodeURIComponent(table)}/_search\n${JSON.stringify(body, null, 2)}`;
      this.lastQueryErrorSql = request;
      const result = await this.databaseService.query(connection, this.database, request, safeLimit < 0 ? -1 : queryConfig.maxRows);
      if (safeLimit > 0) {
        result.pagination = {
          mode: "quick",
          table,
          where,
          page: currentPage,
          pageSize: safeLimit,
          totalRows,
          totalPages,
          sortColumn,
          sortDirection: normalizeSortDirection(sortDirection),
        };
      }
      this.panel.webview.postMessage({ type: "result", sql: request, result });
      return;
    }
    let totalRows = 0;
    let totalPages = 1;
    let currentPage = safePage;
    if (safeLimit > 0) {
      const countSql = buildQuickCountSql(this.connection.type, table, where);
      this.lastQueryErrorSql = countSql;
      const countResult = await this.databaseService.query(connection, this.database, countSql, 1);
      totalRows = readTotalRows(countResult);
      totalPages = Math.max(1, Math.ceil(totalRows / safeLimit));
      currentPage = Math.min(safePage, totalPages);
    }
    const sql = buildQuickQuerySql(this.connection.type, table, where, safeLimit, currentPage, sortColumn, sortDirection);
    this.lastQueryErrorSql = sql;
    const result = await this.databaseService.query(connection, this.database, sql, safeLimit < 0 ? -1 : queryConfig.maxRows);
    if (safeLimit > 0) {
      result.pagination = {
        mode: "quick",
        table,
        where,
        page: currentPage,
        pageSize: safeLimit,
        totalRows,
        totalPages,
        sortColumn,
        sortDirection: normalizeSortDirection(sortDirection),
      };
    }
    this.panel.webview.postMessage({ type: "result", sql, result });
  }

  private async runSql(sql: string, limit?: number, page?: number, sortColumn?: string, sortDirection?: "asc" | "desc"): Promise<void> {
    if (!sql.trim()) {
      throw new Error(this.connection.type === "redis" ? "请先输入 Redis 命令。" : this.connection.type === "elasticsearch" ? "请先输入 Elasticsearch 查询。" : "请先输入 SQL。");
    }

    let executableSql = sql.trim();
    let executeAllStatements: string[] | undefined;
    if (this.connection.type !== "redis" && this.connection.type !== "elasticsearch") {
      const picked = await this.pickSqlStatementToRun(executableSql);
      if (!picked) {
        this.panel.webview.postMessage({ type: "loading", area: "query", message: "已取消执行。" });
        return;
      }
      if (picked.mode === "all") {
        executeAllStatements = picked.statements;
      } else {
        executableSql = picked.statements[0] ?? executableSql;
      }
    }

    const connection = await this.requireConnection();
    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: this.connection.type === "redis" ? "正在执行 Redis 命令..." : this.connection.type === "elasticsearch" ? "正在执行 Elasticsearch 查询..." : "正在执行 SQL..." });
    if (this.connection.type === "redis" || this.connection.type === "elasticsearch") {
      this.lastQueryErrorSql = executableSql;
      const result = await this.databaseService.query(connection, this.database, executableSql, clampLimit(limit ?? queryConfig.defaultLimit));
      this.panel.webview.postMessage({ type: "result", sql: executableSql, result });
      return;
    }
    if (executeAllStatements) {
      await this.runSqlStatements(connection, executeAllStatements, limit);
      return;
    }
    const safeLimit = clampLimit(limit ?? queryConfig.defaultLimit);
    let plan = buildSqlPaginationPlan(this.connection.type, executableSql, safeLimit, page, sortColumn, sortDirection);
    let totalRows = 0;
    let totalPages = 1;
    if (plan.countSql && plan.pageSize && plan.pageSize > 0) {
      this.lastQueryErrorSql = plan.countSql;
      const countResult = await this.databaseService.query(connection, this.database, plan.countSql, 1);
      totalRows = readTotalRows(countResult);
      totalPages = Math.max(1, Math.ceil(totalRows / plan.pageSize));
      const currentPage = Math.min(plan.page ?? 1, totalPages);
      if (currentPage !== plan.page) {
        plan = buildSqlPaginationPlan(this.connection.type, plan.baseSql ?? executableSql, plan.pageSize, currentPage, sortColumn, sortDirection);
      }
    }

    this.lastQueryErrorSql = plan.executableSql;
    let logId: string | undefined;
    if (!plan.isSelect) {
      logId = await this.createPendingOperationLog({
        connection: this.connection,
        database: this.database,
        table: this.selectedTable ?? "",
        operationType: "sql",
        sql: plan.executableSql,
      });
    }

    let result: QueryResult;
    try {
      result = await this.databaseService.query(connection, this.database, plan.executableSql, plan.isSelect ? -1 : queryConfig.maxRows);
      await this.operationLogService.completeLog(logId, "success");
    } catch (error) {
      await this.completeFailedOperationLog(logId, error, plan.executableSql);
      throw error;
    }
    if (plan.countSql && plan.baseSql && plan.page && plan.pageSize && plan.pageSize > 0) {
      result.pagination = {
        mode: "sql",
        sql: plan.baseSql,
        page: plan.page,
        pageSize: plan.pageSize,
        totalRows,
        totalPages,
        sortColumn: plan.sortColumn,
        sortDirection: plan.sortDirection,
      };
    }
    this.panel.webview.postMessage({ type: "result", sql: plan.executableSql, result });
  }

  private async runSqlStatements(connection: DbConnectionWithSecret, statements: string[], limit?: number): Promise<void> {
    const queryConfig = getQueryConfig();
    const safeLimit = clampLimit(limit ?? queryConfig.defaultLimit);
    const rows: Record<string, unknown>[] = [];
    const executedSql: string[] = [];

    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      const plan = buildSqlPaginationPlan(this.connection.type, statement, safeLimit);
      this.lastQueryErrorSql = plan.executableSql;
      this.panel.webview.postMessage({ type: "loading", area: "query", message: `正在执行第 ${index + 1} / ${statements.length} 条 SQL...` });
      let logId: string | undefined;
      if (!plan.isSelect) {
        logId = await this.createPendingOperationLog({
          connection: this.connection,
          database: this.database,
          table: this.selectedTable ?? "",
          operationType: "sql",
          sql: plan.executableSql,
        });
      }
      try {
        const result = await this.databaseService.query(connection, this.database, plan.executableSql, plan.isSelect ? -1 : queryConfig.maxRows);
        await this.operationLogService.completeLog(logId, "success");
        executedSql.push(plan.executableSql);
        rows.push({
          index: index + 1,
          title: getSqlStatementTitle(statement) || `SQL ${index + 1}`,
          type: plan.isSelect ? "查询" : "修改",
          affectedRows: result.affectedRows ?? result.rowCount ?? 0,
          status: "成功",
        });
      } catch (error) {
        await this.completeFailedOperationLog(logId, error, plan.executableSql);
        rows.push({
          index: index + 1,
          title: getSqlStatementTitle(statement) || `SQL ${index + 1}`,
          type: plan.isSelect ? "查询" : "修改",
          affectedRows: 0,
          status: `失败：${getErrorMessage(error)}`,
        });
        const summary: QueryResult = {
          columns: ["index", "title", "type", "affectedRows", "status"],
          rows,
          rowCount: rows.length,
          elapsedMs: 0,
        };
        this.panel.webview.postMessage({ type: "result", sql: executedSql.concat(plan.executableSql).join("\n"), result: summary });
        throw error;
      }
    }

    const summary: QueryResult = {
      columns: ["index", "title", "type", "affectedRows", "status"],
      rows,
      rowCount: rows.length,
      elapsedMs: 0,
    };
    this.panel.webview.postMessage({ type: "result", sql: executedSql.join("\n"), result: summary });
  }

  private async pickSqlStatementToRun(sql: string): Promise<SqlStatementSelection | undefined> {
    const statements = splitSqlStatements(sql);
    if (statements.length <= 1) {
      return { statements: [statements[0] ?? sql.trim()], mode: "single" };
    }

    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "全部执行",
          description: `${statements.length} 条 SQL 将按顺序执行`,
          detail: "适合执行一组建表、改表或批量初始化 SQL。执行中遇到错误会停止。",
          statements,
          mode: "all" as const,
        },
        ...statements.map((statement, index) => ({
          label: getSqlStatementTitle(statement) || `SQL ${index + 1}`,
          description: createSqlPreview(stripSqlLeadingComments(statement), 96),
          detail: statement,
          statements: [statement],
          mode: "single" as const,
        })),
      ],
      {
        title: "选择要执行的 SQL",
        placeHolder: "检测到多条 SQL，可以选择单条执行，也可以全部按顺序执行",
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
    return picked ? { statements: picked.statements, mode: picked.mode } : undefined;
  }

  private async copyTableDdl(table: string): Promise<void> {
    if (!table.trim()) {
      throw new Error("请先从左侧数据库树选择一张表。");
    }

    const connection = await this.requireConnection();
    const ddl = await this.databaseService.getCreateTableSql(connection, this.database, table);
    await vscode.env.clipboard.writeText(ddl);
    vscode.window.setStatusBarMessage("Database Workbench: 结构信息已复制到剪贴板。", 2000);
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "结构信息已复制到剪贴板。" });
  }

  private async exportPreview(message: Extract<PanelMessage, { type: "exportPreview" }>): Promise<void> {
    if (this.connection.type !== "mysql") {
      throw new Error("当前导出暂时只支持 MySQL 数据预览。");
    }

    const table = String(message.table || this.selectedTable || "").trim();
    if (!table) {
      throw new Error("请先从左侧数据库树选择一张表。");
    }

    const rowLimit = Math.max(1, Math.floor(Number(message.rowLimit) || 0));
    const exportConfig = getExportConfig();
    const maxExportRows = Math.max(1, Math.min(1_000_000, Math.floor(exportConfig.maxRows || 10000)));
    if (message.mode !== "sql" && rowLimit > maxExportRows) {
      throw new Error(`单次最多导出 ${maxExportRows} 行，请缩小导出行数或在设置中调整 databaseWorkbench.export.maxRows。`);
    }
    const format = message.format === "sql" ? "sql" : "xlsx";
    const extension = format === "sql" ? "sql" : "xlsx";
    const defaultName = `${sanitizeFileName(this.connection.name)}_${sanitizeFileName(this.database)}_${sanitizeFileName(table)}.${extension}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
      filters: format === "sql"
        ? { "SQL 文件": ["sql"] }
        : { "Excel 工作簿": ["xlsx"] },
      saveLabel: "保存导出文件",
      title: "保存预览数据导出文件",
    });
    if (!target) {
      this.panel.webview.postMessage({ type: "loading", area: "query", message: "已取消导出。" });
      return;
    }

    const result = message.mode === "sql"
      ? this.getCachedSqlExportResult(message, maxExportRows)
      : await this.queryPreviewForExport(message, table, rowLimit, exportConfig);
    const { columns, rows } = pickExportRows(result.columns || [], result.rows || [], message.columns || []);
    if (!columns.length) {
      throw new Error("请至少选择一个需要导出的字段。");
    }
    const content = format === "sql"
      ? Buffer.from(buildPreviewInsertSql(table, rows, columns), "utf8")
      : buildXlsxBuffer(table, columns, rows, message.columnAliases || {});
    const outputPath = target.fsPath.toLowerCase().endsWith(`.${extension}`) ? target.fsPath : `${target.fsPath}.${extension}`;
    await fs.writeFile(outputPath, content);
    vscode.window.showInformationMessage(`已导出 ${rows.length} 行到 ${outputPath}`);
    this.panel.webview.postMessage({ type: "loading", area: "query", message: `已导出 ${rows.length} 行到 ${outputPath}` });
  }

  private getCachedSqlExportResult(
    message: Extract<PanelMessage, { type: "exportPreview" }>,
    maxExportRows: number
  ): QueryResult {
    const columns = Array.isArray(message.resultColumns) ? message.resultColumns : [];
    const rows = Array.isArray(message.resultRows) ? message.resultRows : [];
    if (rows.length > maxExportRows) {
      throw new Error(`当前 SQL 结果有 ${rows.length} 行，超过单次导出上限 ${maxExportRows} 行。`);
    }
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在导出当前 SQL 查询结果..." });
    return {
      columns,
      rows,
      rowCount: rows.length,
      elapsedMs: 0,
    };
  }

  private async queryPreviewForExport(
    message: Extract<PanelMessage, { type: "exportPreview" }>,
    table: string,
    rowLimit: number,
    exportConfig: ReturnType<typeof getExportConfig>
  ): Promise<QueryResult> {
    const exportSql = buildExportPreviewSql(this.connection.type, table, message, rowLimit, this.getDefaultExportSortColumns(table));
    const exportTransactionThreshold = Math.max(1, Math.min(100000, Math.floor(exportConfig.transactionThreshold || 100)));
    const exportPageSize = Math.max(1, Math.min(5000, Math.floor(exportConfig.pageSize || 100)));
    const usePagedTransaction = rowLimit >= exportTransactionThreshold;
    this.panel.webview.postMessage({ type: "loading", area: "query", message: usePagedTransaction ? "正在通过事务分页导出预览数据..." : "正在导出预览数据..." });
    const connection = await this.requireConnection();
    return usePagedTransaction
      ? await this.databaseService.queryMysqlInConsistentPages(connection, this.database, exportSql, rowLimit, exportPageSize)
      : await this.databaseService.query(connection, this.database, exportSql, rowLimit);
  }

  private getDefaultExportSortColumns(table: string): string[] {
    const tableInfo = this.findTable(table);
    const columns = tableInfo?.columns || [];
    const primaryKeys = columns.filter((column) => column.key === "PRI").map((column) => column.name);
    if (primaryKeys.length) {
      return primaryKeys;
    }
    const firstColumn = columns[0]?.name;
    return firstColumn ? [firstColumn] : [];
  }

  private async loadImportSourceDatabases(connectionId: string): Promise<void> {
    const connection = await this.requireConnectionById(connectionId);
    if (connection.type !== "mysql") {
      throw new Error("导入数据暂时只支持 MySQL 来源。");
    }
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在读取来源连接的数据库列表..." });
    const databases = await this.databaseService.listDatabases(connection);
    this.panel.webview.postMessage({ type: "importSourceDatabases", connectionId, databases });
  }

  private async loadImportSourceTables(connectionId: string, database: string): Promise<void> {
    const connection = await this.requireConnectionById(connectionId);
    if (connection.type !== "mysql") {
      throw new Error("导入数据暂时只支持 MySQL 来源。");
    }
    if (!database.trim()) {
      throw new Error("请选择来源数据库。");
    }
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在读取来源库表结构..." });
    const tables = await this.databaseService.loadSchema(connection, database);
    this.panel.webview.postMessage({ type: "importSourceTables", connectionId, database, tables });
  }

  private async loadImportSourceSchema(connectionId: string, database: string, table: string): Promise<void> {
    const connection = await this.requireConnectionById(connectionId);
    if (connection.type !== "mysql") {
      throw new Error("导入数据暂时只支持 MySQL 来源。");
    }
    if (!database.trim() || !table.trim()) {
      throw new Error("请选择来源数据库和来源表。");
    }
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在读取来源表字段..." });
    const schema = await this.databaseService.loadSchema(connection, database);
    const tableInfo = schema.find((item) => item.name === table);
    if (!tableInfo) {
      throw new Error(`未找到来源表 ${table}。`);
    }
    this.panel.webview.postMessage({
      type: "importSourceSchema",
      connectionId,
      database,
      table,
      columns: tableInfo.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        comment: column.comment,
      })),
    });
  }

  private async importTableData(message: Extract<PanelMessage, { type: "importTableData" }>): Promise<void> {
    if (this.connection.type !== "mysql") {
      throw new Error("导入数据暂时只支持导入到 MySQL 表。");
    }
    if (!message.targetTable.trim()) {
      throw new Error("请先选择当前目标表。");
    }
    const mappings = message.mappings
      .map((mapping) => ({ source: String(mapping.source || "").trim(), target: String(mapping.target || "").trim() }))
      .filter((mapping) => mapping.source && mapping.target);
    if (!mappings.length) {
      throw new Error("请至少配置一个需要导入的字段映射。");
    }
    if (new Set(mappings.map((mapping) => mapping.target)).size !== mappings.length) {
      throw new Error("目标字段不能重复映射，请检查字段对应关系。");
    }
    const rowLimit = Math.max(1, Math.floor(Number(message.rowLimit || 0)));
    const batchSize = Math.max(1, Math.min(5000, Math.floor(Number(message.batchSize || 500))));
    const sourceConnection = await this.requireConnectionById(message.sourceConnectionId);
    const targetConnection = await this.requireConnection();
    const sqlPreview = buildImportPreviewSql(
      sourceConnection,
      message.sourceDatabase,
      message.sourceTable,
      this.database,
      message.targetTable,
      mappings,
      rowLimit,
      batchSize
    );
    if (message.confirmed !== true) {
      this.postSqlConfirmPreview(
        "确认执行下面的数据导入吗？导入会开启事务，任一批次失败会整体回滚。",
        sqlPreview,
        { ...message, confirmed: true },
        "请确认即将执行的数据导入 SQL。"
      );
      return;
    }

    this.panel.webview.postMessage({ type: "loading", area: "query", message: `正在分批导入数据，每批 ${batchSize} 行...` });
    const logId = await this.createPendingOperationLog({
      connection: this.connection,
      database: this.database,
      table: message.targetTable,
      operationType: "insert",
      sql: sqlPreview,
    });
    try {
      this.lastQueryErrorSql = sqlPreview;
      const result = await this.databaseService.importMysqlTableData({
        sourceConnection,
        sourceDatabase: message.sourceDatabase,
        sourceTable: message.sourceTable,
        targetConnection,
        targetDatabase: this.database,
        targetTable: message.targetTable,
        mappings,
        rowLimit,
        batchSize,
      });
      await this.operationLogService.completeLog(logId, "success");
      this.panel.webview.postMessage({
        type: "importCompleted",
        insertedRows: result.insertedRows,
        message: `导入完成：成功写入 ${result.insertedRows} 行，用时 ${result.elapsedMs} ms。`,
      });
      await this.previewTable(message.targetTable);
    } catch (error) {
      await this.completeFailedOperationLog(logId, error, sqlPreview);
      throw error;
    } finally {
      this.lastQueryErrorSql = "";
    }
  }

  private async copySchemaDraftSql(draft: Record<string, unknown>): Promise<void> {
    if (isCreateTableDraft(draft)) {
      const sql = buildCreateTableDraftSql(draft, this.connection.type).join("\n");
      if (!sql.trim()) {
        throw new Error("当前新表结构没有可复制的 SQL。");
      }

      await vscode.env.clipboard.writeText(sql);
      vscode.window.setStatusBarMessage("Database Workbench: 新建表 SQL 已复制到剪贴板。", 2000);
      this.panel.webview.postMessage({ type: "loading", area: "query", message: "新建表 SQL 已复制到剪贴板。" });
      return;
    }

    const originalTableName = this.selectedTable;
    if (!originalTableName) {
      throw new Error("请先选择一张表。");
    }

    const originalTable = this.findTable(originalTableName);
    if (!originalTable) {
      throw new Error("未读取到当前表结构，请先刷新数据。");
    }

    const sql = buildSchemaDraftSql(originalTable, draft, this.connection.type).join("\n");
    if (!sql.trim()) {
      throw new Error("当前表结构没有可复制的修改 SQL。");
    }

    await vscode.env.clipboard.writeText(sql);
    vscode.window.setStatusBarMessage("Database Workbench: 表结构修改 SQL 已复制到剪贴板。", 2000);
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "表结构修改 SQL 已复制到剪贴板。" });
  }

  private async previewSchemaDraftSql(draft: Record<string, unknown>): Promise<void> {
    const { createMode, statements } = this.buildSchemaDraftStatements(draft);
    if (statements.length === 0) {
      vscode.window.setStatusBarMessage("Database Workbench: 表结构没有可提交的修改。", 2000);
      this.panel.webview.postMessage({ type: "schemaDraftError", message: "表结构没有可提交的修改。" });
      return;
    }
    this.panel.webview.postMessage({
      type: "schemaDraftPreview",
      title: createMode ? "确认执行下面的新建表 SQL 吗？" : "确认执行下面的表结构修改 SQL 吗？",
      sql: statements.join("\n"),
    });
  }

  private buildSchemaDraftStatements(draft: Record<string, unknown>): {
    createMode: boolean;
    originalTableName?: string;
    originalTable?: TableInfo;
    statements: string[];
  } {
    if (this.connection.type !== "mysql" && this.connection.type !== "postgres") {
      throw new Error("当前表结构提交暂时只支持 MySQL 和 PostgreSQL。");
    }

    const createMode = isCreateTableDraft(draft);
    const originalTableName = this.selectedTable;
    const originalTable = createMode ? undefined : originalTableName ? this.findTable(originalTableName) : undefined;
    if (!createMode && !originalTableName) {
      throw new Error("请先选择一张表。");
    }
    if (!createMode && !originalTable) {
      throw new Error("未读取到当前表结构，请先刷新数据。");
    }

    const statements = createMode ? buildCreateTableDraftSql(draft, this.connection.type) : buildSchemaDraftSql(originalTable as TableInfo, draft, this.connection.type);
    return { createMode, originalTableName, originalTable, statements };
  }

  private async applySchemaDraft(draft: Record<string, unknown>, confirmed: boolean): Promise<void> {
    const { createMode, originalTableName, originalTable, statements } = this.buildSchemaDraftStatements(draft);
    if (statements.length === 0) {
      vscode.window.setStatusBarMessage("Database Workbench: 表结构没有可提交的修改。", 2000);
      return;
    }

    const sqlPreview = statements.join("\n");
    if (!confirmed) {
      this.panel.webview.postMessage({
        type: "schemaDraftPreview",
        title: createMode ? "确认执行下面的新建表 SQL 吗？" : "确认执行下面的表结构修改 SQL 吗？",
        sql: sqlPreview,
      });
      return;
    }

    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在提交表结构修改..." });
    let logId: string | undefined;
    try {
      const connection = await this.requireConnection();
      const logTableName = getDraftTableName(draft) || originalTableName || "";
      logId = await this.createPendingOperationLog({
        connection: this.connection,
        database: this.database,
        table: logTableName,
        operationType: "schema",
        sql: sqlPreview,
        snapshots: [{
          rowKey: { table: logTableName },
          beforeData: originalTable ? originalTable as unknown as Record<string, unknown> : null,
        }],
      });
      for (const statement of statements) {
        this.lastQueryErrorSql = statement;
        await this.databaseService.query(connection, this.database, statement, queryConfig.maxRows);
      }
    } catch (error) {
      await this.completeFailedOperationLog(logId, error, sqlPreview);
      const canExplainWithAi = isAiConfigured() && await this.hasProFeature("ai");
      if (!canExplainWithAi) {
        this.panel.webview.postMessage({ type: "schemaDraftError", message: getErrorMessage(error) });
        if (isAiConfigured()) {
          void this.requireProFeature("ai", "AI 错误解释");
        }
        return;
      }

      this.panel.webview.postMessage({ type: "schemaDraftError", message: "提交失败，正在使用 AI 翻译错误..." });
      this.panel.webview.postMessage({ type: "schemaDraftError", message: await this.formatSchemaDraftError(error, sqlPreview) });
      return;
    }

    const nextTableName = getDraftTableName(draft) || originalTableName;
    this.selectedTable = nextTableName;
    await this.loadSchema(true);
    const afterTable = nextTableName ? this.findTable(nextTableName) : undefined;
    await this.operationLogService.completeLog(logId, "success", {
      snapshots: [{
        rowKey: { table: nextTableName ?? "" },
        afterData: afterTable ? afterTable as unknown as Record<string, unknown> : null,
      }],
    });
    await vscode.commands.executeCommand("databaseWorkbench.refresh");
    this.panel.webview.postMessage({ type: "schemaDraftApplied" });
    vscode.window.setStatusBarMessage(createMode ? "Database Workbench: 新表已创建。" : "Database Workbench: 表结构修改已提交。", 2000);
  }

  private async formatSchemaDraftError(error: unknown, sql: string): Promise<string> {
    return this.formatDatabaseError(error, sql);
  }

  private async formatDatabaseError(error: unknown, sql: string, aiConfig = getAiConfig()): Promise<string> {
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (!isAiConfigured(aiConfig) || !await this.hasProFeature("ai")) {
      return rawMessage;
    }

    try {
      return await translateDatabaseErrorToChinese(rawMessage, sql, aiConfig);
    } catch {
      return rawMessage;
    }
  }

  private async updateCells(
    table: string,
    primaryKeys: string[],
    updates: Array<{ primaryValues: Record<string, unknown>; changes: Record<string, unknown> }>,
    confirmed: boolean,
    refreshQuery?: QuickRefreshQuery
  ): Promise<void> {
    if (!table || primaryKeys.length === 0 || updates.length === 0) {
      throw new Error("缺少主键或修改内容，无法构造 UPDATE。");
    }

    const statements = updates.map((update) => buildUpdateSql(this.connection.type, table, primaryKeys, update.primaryValues, update.changes));
    const sqlPreview = statements.join("\n");
    if (!confirmed) {
      this.panel.webview.postMessage({
        type: "updateCellsPreview",
        title: "确认执行下面的 UPDATE 语句吗？",
        sql: sqlPreview,
        table,
        primaryKeys,
        updates,
        refreshQuery,
      });
      return;
    }

    const connection = await this.requireConnection();
    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在提交单元格修改..." });
    const primaryValuesList = updates.map((update) => update.primaryValues);
    const beforeRows = await this.queryRowsByPrimaryKeys(connection, table, primaryKeys, primaryValuesList);
    const logId = await this.createPendingOperationLog({
      connection: this.connection,
      database: this.database,
      table,
      operationType: "update",
      sql: sqlPreview,
      snapshots: primaryValuesList.map((primaryValues) => ({
        rowKey: primaryValues,
        beforeData: findRowByPrimaryValues(beforeRows, primaryValues),
      })),
    });
    try {
      for (const statement of statements) {
        this.lastQueryErrorSql = statement;
        await this.databaseService.query(connection, this.database, statement, queryConfig.maxRows);
      }
      const afterRows = await this.queryRowsByPrimaryKeys(connection, table, primaryKeys, primaryValuesList);
      await this.operationLogService.completeLog(logId, "success", {
        snapshots: primaryValuesList.map((primaryValues) => ({
          rowKey: primaryValues,
          afterData: findRowByPrimaryValues(afterRows, primaryValues),
        })),
      });
    } catch (error) {
      await this.completeFailedOperationLog(logId, error, sqlPreview);
      throw error;
    }
    this.panel.webview.postMessage({ type: "editsApplied" });
    if (refreshQuery?.table) {
      await this.runQuickQuery(
        refreshQuery.table,
        String(refreshQuery.where ?? ""),
        Number(refreshQuery.limit || getQueryConfig().defaultLimit),
        refreshQuery.page,
        refreshQuery.sortColumn,
        refreshQuery.sortDirection,
        false
      );
      return;
    }
    await this.previewTable(table);
  }

  private async insertRow(table: string, values: Record<string, unknown>, confirmed: boolean): Promise<void> {
    if (!table.trim()) {
      throw new Error("请先从左侧数据库树选择一张表。");
    }

    const statement = buildInsertSql(this.connection.type, table, values);
    if (!confirmed) {
      this.postSqlConfirmPreview(
        "确认执行下面的 INSERT 语句吗？",
        statement,
        { type: "insertRow", table, values, confirmed: true },
        "请确认即将执行的 INSERT SQL。"
      );
      return;
    }

    const connection = await this.requireConnection();
    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在添加新数据..." });
    this.lastQueryErrorSql = statement;
    const logId = await this.createPendingOperationLog({
      connection: this.connection,
      database: this.database,
      table,
      operationType: "insert",
      sql: statement,
    });
    try {
      const insertResult = await this.databaseService.query(connection, this.database, statement, queryConfig.maxRows);
      const primaryKeys = this.getPrimaryKeys(table);
      const primaryValues = this.getInsertedPrimaryValues(table, primaryKeys, values, insertResult);
      const afterData = primaryValues
        ? findRowByPrimaryValues(await this.queryRowsByPrimaryKeys(connection, table, primaryKeys, [primaryValues]), primaryValues)
        : values;
      await this.operationLogService.completeLog(logId, "success", {
        snapshots: [{
          rowKey: primaryValues ?? {},
          afterData,
        }],
      });
    } catch (error) {
      await this.completeFailedOperationLog(logId, error, statement);
      throw error;
    }
    this.panel.webview.postMessage({ type: "editsApplied" });
    await this.previewTable(table);
  }

  private async deleteRow(table: string, primaryKeys: string[], primaryValues: Record<string, unknown>, confirmed: boolean): Promise<void> {
    await this.deleteRows(table, primaryKeys, [primaryValues], confirmed);
  }

  private async deleteRows(table: string, primaryKeys: string[], primaryValuesList: Array<Record<string, unknown>>, confirmed: boolean): Promise<void> {
    if (!table.trim() || primaryKeys.length === 0) {
      throw new Error("缺少表名或主键，无法构造 DELETE。");
    }
    if (!primaryValuesList.length) {
      throw new Error("缺少要删除的行，无法构造 DELETE。");
    }

    const statement = buildDeleteRowsSql(this.connection.type, table, primaryKeys, primaryValuesList);
    if (!confirmed) {
      this.postSqlConfirmPreview(
        primaryValuesList.length > 1 ? `确认删除选中的 ${primaryValuesList.length} 行数据吗？` : "确认执行下面的 DELETE 语句吗？",
        statement,
        { type: "deleteRows", table, primaryKeys, primaryValuesList, confirmed: true },
        "请确认即将执行的 DELETE SQL。"
      );
      return;
    }

    const connection = await this.requireConnection();
    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在删除数据..." });
    this.lastQueryErrorSql = statement;
    const beforeRows = await this.queryRowsByPrimaryKeys(connection, table, primaryKeys, primaryValuesList);
    const logId = await this.createPendingOperationLog({
      connection: this.connection,
      database: this.database,
      table,
      operationType: "delete",
      sql: statement,
      snapshots: primaryValuesList.map((primaryValues) => ({
        rowKey: primaryValues,
        beforeData: findRowByPrimaryValues(beforeRows, primaryValues),
      })),
    });
    try {
      await this.databaseService.query(connection, this.database, statement, queryConfig.maxRows);
      await this.operationLogService.completeLog(logId, "success", {
        snapshots: primaryValuesList.map((primaryValues) => ({
          rowKey: primaryValues,
          afterData: null,
        })),
      });
    } catch (error) {
      await this.completeFailedOperationLog(logId, error, statement);
      throw error;
    }
    this.panel.webview.postMessage({ type: "editsApplied" });
    await this.previewTable(table);
  }

  private async redisDeleteKeys(keys: string[], confirmed: boolean): Promise<void> {
    if (this.connection.type !== "redis") {
      throw new Error("当前连接不是 Redis。");
    }
    const safeKeys = [...new Set(keys.map((key) => String(key || "").trim()).filter(Boolean))];
    if (!safeKeys.length) {
      throw new Error("请选择要删除的 Redis Key。");
    }
    const commandPreview = `UNLINK ${safeKeys.join(" ")}`;
    if (!confirmed) {
      this.postSqlConfirmPreview(
        safeKeys.length > 1 ? `确认删除选中的 ${safeKeys.length} 个 Redis Key 吗？` : `确认删除 Redis Key「${safeKeys[0]}」吗？`,
        commandPreview,
        { type: "redisDeleteKeys", keys: safeKeys, confirmed: true },
        "请确认即将执行的 Redis 删除命令。"
      );
      return;
    }

    const connection = await this.requireConnection();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在删除 Redis Key..." });
    const command = "__DBW_REDIS_DELETE__ " + JSON.stringify(safeKeys);
    this.lastQueryErrorSql = commandPreview;
    await this.databaseService.query(connection, this.database, command, getQueryConfig().maxRows);
    this.panel.webview.postMessage({ type: "editsApplied" });
  }

  private async redisUpdateKeys(updates: Array<{ key: string; value: string }>, confirmed: boolean): Promise<void> {
    if (this.connection.type !== "redis") {
      throw new Error("当前连接不是 Redis。");
    }
    const safeUpdates = updates
      .map((item) => ({ key: String(item.key || "").trim(), value: String(item.value ?? "") }))
      .filter((item) => item.key);
    if (!safeUpdates.length) {
      throw new Error("没有可提交的 Redis Key 修改。");
    }
    const commandPreview = safeUpdates.map((item) => `SET ${item.key} ${item.value}`).join("\n");
    if (!confirmed) {
      this.postSqlConfirmPreview(
        safeUpdates.length > 1 ? `确认修改 ${safeUpdates.length} 个 Redis 字符串 Key 吗？` : `确认修改 Redis Key「${safeUpdates[0].key}」吗？`,
        commandPreview,
        { type: "redisUpdateKeys", updates: safeUpdates, confirmed: true },
        "请确认即将执行的 Redis SET 命令。"
      );
      return;
    }

    const connection = await this.requireConnection();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在保存 Redis Key..." });
    this.lastQueryErrorSql = commandPreview;
    for (const update of safeUpdates) {
      await this.databaseService.query(connection, this.database, "__DBW_REDIS_SET__ " + JSON.stringify(update), getQueryConfig().maxRows);
    }
    this.panel.webview.postMessage({ type: "editsApplied" });
  }

  private async redisUpdateTtls(updates: Array<{ key: string; ttl: string }>, confirmed: boolean): Promise<void> {
    if (this.connection.type !== "redis") {
      throw new Error("当前连接不是 Redis。");
    }
    const safeUpdates = updates
      .map((item) => ({ key: String(item.key || "").trim(), ttl: String(item.ttl ?? "").trim() }))
      .filter((item) => item.key && item.ttl);
    if (!safeUpdates.length) {
      throw new Error("没有可提交的 Redis TTL 修改。");
    }
    const parsedUpdates = safeUpdates.map((item) => ({ ...item, parsed: parseRedisTtlInput(item.ttl) }));
    const commandPreview = parsedUpdates
      .map((item) => item.parsed.seconds === null ? `PERSIST ${item.key}` : `EXPIRE ${item.key} ${item.parsed.seconds}`)
      .join("\n");
    if (!confirmed) {
      this.postSqlConfirmPreview(
        parsedUpdates.length > 1 ? `确认修改 ${parsedUpdates.length} 个 Redis Key 的过期时间吗？` : `确认修改 Redis Key「${parsedUpdates[0].key}」的过期时间吗？`,
        commandPreview,
        { type: "redisUpdateTtls", updates: safeUpdates, confirmed: true },
        "请确认即将执行的 Redis TTL 命令。"
      );
      return;
    }

    const connection = await this.requireConnection();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在设置 Redis 过期时间..." });
    this.lastQueryErrorSql = commandPreview;
    for (const update of parsedUpdates) {
      await this.databaseService.query(connection, this.database, "__DBW_REDIS_EXPIRE__ " + JSON.stringify({ key: update.key, seconds: update.parsed.seconds }), getQueryConfig().maxRows);
    }
    this.panel.webview.postMessage({ type: "editsApplied" });
  }

  private async redisInspectKey(key: string, page: number, pageSize: number, search = "", fuzzySearch = false, sortDirection: "asc" | "desc" = "asc"): Promise<void> {
    if (this.connection.type !== "redis") {
      throw new Error("当前连接不是 Redis。");
    }
    const safeKey = String(key || "").trim();
    if (!safeKey) {
      throw new Error("请选择要查看的 Redis Key。");
    }

    const queryConfig = getQueryConfig();
    const safePageSize = Math.max(1, Math.min(queryConfig.maxRows, Math.floor(Number(pageSize) || queryConfig.defaultLimit)));
    const safePage = Math.max(1, Math.floor(Number(page) || 1));
    const command = "__DBW_REDIS_INSPECT_PAGE__ " + JSON.stringify({ key: safeKey, page: safePage, pageSize: safePageSize, search: String(search || ""), fuzzySearch: fuzzySearch === true, sortDirection: normalizeSortDirection(sortDirection) });
    const connection = await this.requireConnection();
    const result = await this.databaseService.query(connection, this.database, command, safePageSize);
    this.panel.webview.postMessage({
      type: "redisKeyDetail",
      key: safeKey,
      keyType: result.command || "",
      page: result.pagination?.page || safePage,
      pageSize: result.pagination?.pageSize || safePageSize,
      totalRows: result.pagination?.totalRows ?? result.rowCount,
      totalPages: result.pagination?.totalPages || 1,
      columns: result.columns,
      rows: result.rows,
      search: result.pagination?.sql || "",
      fuzzySearch: fuzzySearch === true,
      sortDirection: normalizeSortDirection(result.pagination?.sortDirection),
      memoryUsage: typeof result.metadata?.memoryUsage === "number" ? result.metadata.memoryUsage : null,
    });
  }

  private async redisDeleteMember(
    key: string,
    keyType: string,
    row: Record<string, unknown>,
    page: number,
    pageSize: number,
    search = "",
    fuzzySearch = false,
    sortDirection: "asc" | "desc" = "asc",
    confirmed = false
  ): Promise<void> {
    if (this.connection.type !== "redis") {
      throw new Error("当前连接不是 Redis。");
    }
    const safeKey = String(key || "").trim();
    if (!safeKey) {
      throw new Error("请选择要删除元素的 Redis Key。");
    }
    const safeType = String(keyType || "").toLowerCase();
    const commandPreview = this.buildRedisDeleteMemberPreview(safeKey, safeType, row);
    if (!confirmed) {
      this.postSqlConfirmPreview(
        `确认删除 Redis ${safeType || "Key"} 中的这个元素吗？`,
        commandPreview,
        { type: "redisDeleteMember", key: safeKey, keyType: safeType, row, page, pageSize, search, fuzzySearch, sortDirection, confirmed: true },
        "请确认即将执行的 Redis 删除元素命令。"
      );
      return;
    }

    const connection = await this.requireConnection();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在删除 Redis 元素..." });
    this.lastQueryErrorSql = commandPreview;
    const command = "__DBW_REDIS_DELETE_MEMBER__ " + JSON.stringify({ key: safeKey, keyType: safeType, row });
    await this.databaseService.query(connection, this.database, command, getQueryConfig().maxRows);
    this.panel.webview.postMessage({ type: "editsApplied" });
    await this.redisInspectKey(safeKey, page, pageSize, search, fuzzySearch, sortDirection);
  }

  private buildRedisDeleteMemberPreview(key: string, keyType: string, row: Record<string, unknown>): string {
    if (keyType === "hash") return `HDEL ${key} ${String(row.field ?? "")}`;
    if (keyType === "list") return `LSET ${key} ${String(row.index ?? "")} <delete-marker>\nLREM ${key} 1 <delete-marker>`;
    if (keyType === "set") return `SREM ${key} ${String(row.member ?? "")}`;
    if (keyType === "zset") return `ZREM ${key} ${String(row.member ?? "")}`;
    if (keyType === "stream") return `XDEL ${key} ${String(row.id ?? "")}`;
    return `删除 ${key} 中的元素`;
  }

  private async generateSql(prompt: string, tableNames: string[] = []): Promise<void> {
    if (!await this.requireProFeature("ai", "AI 生成 SQL")) {
      return;
    }

    if (!prompt.trim()) {
      throw new Error("请先输入查询描述，或在编辑器中使用 @ai{你的描述} / <ai>你的描述</ai> 标签。");
    }

    if (this.schema.length === 0) {
      await this.loadSchema(true);
    }

    const selectedNames = this.getAiSchemaTableNames(tableNames);
    const tablesForAi = this.getAiSchemaTables(selectedNames);
    const focusedPrompt = selectedNames.length
      ? `当前重点表：${selectedNames.join(", ")}\n${prompt}`
      : prompt;
    this.panel.webview.postMessage({ type: "loading", area: "ai", message: getAiLoadingMessage(this.connection.type) });
    const sql = await generateSqlByPrompt(focusedPrompt, tablesForAi, getAiConfig(), this.database, this.connection.type);
    this.panel.webview.postMessage({ type: "generatedSql", sql });
  }

  private async generateCreateTableDraft(prompt: string): Promise<void> {
    if (!await this.requireProFeature("ai", "AI 辅助建表")) {
      return;
    }
    if (this.connection.type !== "mysql" && this.connection.type !== "postgres") {
      throw new Error("AI 辅助建表暂时只支持 MySQL 和 PostgreSQL。");
    }
    if (!prompt.trim()) {
      throw new Error("请先输入新表的需求描述。");
    }
    if (this.schema.length === 0) {
      await this.loadSchema(true);
    }
    this.panel.webview.postMessage({ type: "loading", area: "schema", message: "正在使用 AI 生成建表 SQL..." });
    const sql = await generateCreateTableSqlByPrompt({
      dialect: this.connection.type,
      database: this.database,
      prompt,
      existingTables: this.schema,
    }, getAiConfig());
    this.panel.webview.postMessage({ type: "generatedCreateTableSql", sql });
  }

  private getAiSchemaTableNames(tableNames: string[]): string[] {
    const names = new Set<string>();
    if (this.selectedTable) {
      names.add(this.selectedTable);
    }
    for (const name of tableNames) {
      const table = this.schema.find((item) => item.name.toLowerCase() === String(name).toLowerCase());
      if (table) {
        names.add(table.name);
      }
    }
    return [...names];
  }

  private getAiSchemaTables(tableNames: string[]): TableInfo[] {
    if (!tableNames.length) {
      return this.schema;
    }
    const wanted = new Set(tableNames.map((name) => name.toLowerCase()));
    const tables = this.schema.filter((table) => wanted.has(table.name.toLowerCase()));
    return tables.length ? tables : this.schema;
  }

  private async loadOperationLogs(table: string): Promise<void> {
    if (!await this.requireProFeature("logs", "操作日志查看")) {
      this.panel.webview.postMessage({ type: "operationLogs", logs: [] });
      return;
    }

    if (!table.trim()) {
      throw new Error("请先选择一张表。");
    }

    const logs = await this.operationLogService.listLogs(this.connection, this.database, table, 100);
    const connection = await this.requireConnection();
    for (const log of logs) {
      const snapshotsWithPrimaryKey = log.snapshots.filter((snapshot) => Object.keys(snapshot.rowKey).length > 0);
      if (!snapshotsWithPrimaryKey.length || log.operationType === "schema" || !log.tableName) {
        continue;
      }
      const primaryKeys = Object.keys(snapshotsWithPrimaryKey[0].rowKey);
      try {
        const currentRows = await this.queryRowsByPrimaryKeys(connection, log.tableName, primaryKeys, snapshotsWithPrimaryKey.map((snapshot) => snapshot.rowKey));
        for (const snapshot of snapshotsWithPrimaryKey) {
          snapshot.currentData = findRowByPrimaryValues(currentRows, snapshot.rowKey);
        }
      } catch {
        for (const snapshot of snapshotsWithPrimaryKey) {
          snapshot.currentData = null;
        }
      }
    }
    this.panel.webview.postMessage({ type: "operationLogs", logs });
  }

  private async rollbackOperationLog(logId: string, confirmed: boolean): Promise<void> {
    if (!await this.requireProFeature("logs", "操作日志回滚")) {
      return;
    }

    this.lastQueryErrorSql = "";
    const log = await this.operationLogService.getLog(logId);
    if (!log) {
      throw new Error("未找到这条操作日志，无法回滚。");
    }
    if (log.databaseName !== this.database) {
      throw new Error("这条日志不属于当前数据库，无法回滚。");
    }

    const rollback = buildRollbackSql(this.connection.type, log);
    const connection = await this.requireConnection();
    await this.validateRollbackCurrentRows(connection, rollback, log);
    const sqlPreview = rollback.statements.join("\n");
    if (!confirmed) {
      this.postSqlConfirmPreview(
        "确认执行下面的回滚 SQL 吗？",
        sqlPreview,
        { type: "rollbackOperationLog", logId, confirmed: true },
        "请确认即将执行的日志回滚 SQL。",
        { type: "loadOperationLogs", table: log.tableName }
      );
      return;
    }

    const queryConfig = getQueryConfig();
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在执行日志回滚..." });
    const rollbackLogId = await this.createPendingOperationLog({
      connection: this.connection,
      database: this.database,
      table: log.tableName,
      operationType: "sql",
      sql: sqlPreview,
      rollbackOfLogId: log.id,
    });
    try {
      for (const statement of rollback.statements) {
        this.lastQueryErrorSql = statement;
        await this.databaseService.query(connection, this.database, statement, queryConfig.maxRows);
      }
      await this.operationLogService.completeLog(rollbackLogId, "success");
    } catch (error) {
      await this.completeFailedOperationLog(rollbackLogId, error, sqlPreview);
      throw error;
    }

    vscode.window.setStatusBarMessage("Database Workbench: 日志回滚已执行。", 2000);
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "日志回滚已执行，已刷新当前表数据。" });
    await this.previewTable(log.tableName);
    await this.loadOperationLogs(log.tableName);
  }

  private async validateRollbackCurrentRows(
    connection: DbConnectionWithSecret,
    rollback: RollbackPlan,
    log: OperationLogEntry
  ): Promise<void> {
    if (!rollback.primaryKeys.length || !rollback.primaryValuesList.length) {
      return;
    }
    const currentRows = await this.queryRowsByPrimaryKeys(connection, rollback.table, rollback.primaryKeys, rollback.primaryValuesList);
    for (const snapshot of log.snapshots) {
      const current = findRowByPrimaryValues(currentRows, snapshot.rowKey);
      if (log.operationType === "delete") {
        if (current) {
          this.lastQueryErrorSql = "";
          throw new Error("当前数据中已存在待恢复主键，直接回滚可能造成主键冲突。");
        }
        continue;
      }
      if (!current) {
        this.lastQueryErrorSql = "";
        throw new Error("当前数据已不存在，无法安全回滚这条日志。");
      }
      if (snapshot.afterData && !isRecordSubsetEqual(current, snapshot.afterData)) {
        this.lastQueryErrorSql = "";
        throw new Error("当前数据已发生变化，无法安全回滚这条日志。");
      }
    }
  }

  private async analyzeOperationLogError(logId: string): Promise<void> {
    if (!await this.requireProFeature("logs", "操作日志分析")) {
      return;
    }
    if (!await this.requireProFeature("ai", "AI 分析日志错误")) {
      return;
    }

    this.lastQueryErrorSql = "";
    const log = await this.operationLogService.getLog(logId);
    if (!log) {
      throw new Error("未找到这条操作日志，无法进行 AI 分析。");
    }
    if (!log.errorMessage) {
      throw new Error("这条操作日志没有错误信息，不需要 AI 分析。");
    }
    if (!isAiConfigured()) {
      throw new Error(getAiConfigurationMessage());
    }

    this.panel.webview.postMessage({ type: "loading", area: "query", message: "正在使用 AI 分析日志错误..." });
    const analysis = await this.formatLogDatabaseError(new Error(log.errorMessage), log.sql);
    await this.operationLogService.setAiAnalysis(log.id, analysis);
    await this.loadOperationLogs(log.tableName || this.selectedTable || "");
  }

  private async markOperationLog(logId: string, label: string, color: string): Promise<void> {
    if (!await this.requireProFeature("logs", "操作日志标记")) {
      return;
    }

    this.lastQueryErrorSql = "";
    const log = await this.operationLogService.getLog(logId);
    if (!log) {
      throw new Error("未找到这条操作日志，无法标记。");
    }
    if (log.databaseName !== this.database) {
      throw new Error("这条日志不属于当前数据库，无法标记。");
    }
    if (log.isRollback) {
      throw new Error("该记录为回滚记录不支持标记");
    }

    await this.operationLogService.setTag(log.id, label, color);
    await this.loadOperationLogs(log.tableName || this.selectedTable || "");
  }

  private async completeFailedOperationLog(logId: string | undefined, error: unknown, sql: string): Promise<void> {
    const errorMessage = getErrorMessage(error);
    let aiAnalysis: string | undefined;
    if (isAiConfigured() && await this.hasProFeature("ai")) {
      try {
        aiAnalysis = await this.formatLogDatabaseError(error, sql);
      } catch {
        aiAnalysis = undefined;
      }
    }
    await this.operationLogService.completeLog(logId, "failed", { errorMessage, aiAnalysis });
  }

  private async formatLogDatabaseError(error: unknown, sql: string): Promise<string> {
    const rawMessage = getErrorMessage(error);
    const aiConfig = getAiConfig();
    const logAiConfig = {
      ...aiConfig,
      errorTranslationTimeoutMs: aiConfig.errorTranslationTimeoutMs * 3,
    };
    if (!isAiConfigured(logAiConfig)) {
      throw new Error(getAiConfigurationMessage());
    }
    return translateDatabaseErrorToChinese(rawMessage, sql, logAiConfig);
  }

  private findTable(table: string): TableInfo | undefined {
    return this.schema.find((item) => item.name === table);
  }

  private getPrimaryKeys(table: string): string[] {
    return (this.findTable(table)?.columns ?? [])
      .filter((column) => column.key === "PRI")
      .map((column) => column.name);
  }

  private getInsertedPrimaryValues(
    table: string,
    primaryKeys: string[],
    values: Record<string, unknown>,
    result: QueryResult
  ): Record<string, unknown> | undefined {
    if (!primaryKeys.length) {
      return undefined;
    }

    const explicitValues = Object.fromEntries(primaryKeys.map((key) => [key, values[key]]));
    if (primaryKeys.every((key) => explicitValues[key] !== undefined && explicitValues[key] !== null)) {
      return explicitValues;
    }

    const insertId = result.rows[0]?.insertId;
    if (primaryKeys.length === 1 && insertId !== undefined && insertId !== null) {
      return { [primaryKeys[0]]: insertId };
    }

    const generatedPrimaryKey = (this.findTable(table)?.columns ?? []).find((column) => column.key === "PRI" && /auto_increment/i.test(column.extra ?? ""));
    if (generatedPrimaryKey && result.rows[0]?.insertId !== undefined && result.rows[0]?.insertId !== null) {
      return { [generatedPrimaryKey.name]: result.rows[0].insertId };
    }

    return undefined;
  }

  private async queryRowsByPrimaryKeys(
    connection: DbConnectionWithSecret,
    table: string,
    primaryKeys: string[],
    primaryValuesList: Array<Record<string, unknown>>
  ): Promise<Record<string, unknown>[]> {
    if (!primaryKeys.length || !primaryValuesList.length) {
      return [];
    }
    const sql = buildSelectRowsByPrimaryKeysSql(this.connection.type, table, primaryKeys, primaryValuesList);
    this.lastQueryErrorSql = sql;
    const result = await this.databaseService.query(connection, this.database, sql, -1);
    return result.rows;
  }

  private async loadSchemaCapabilities(connection: Awaited<ReturnType<ConnectionStore["getWithSecret"]>>): Promise<SchemaCapabilities> {
    if (!connection) {
      return { supportsNotEmptyStringCheck: false };
    }
    if (connection.type === "postgres") {
      return { supportsNotEmptyStringCheck: true };
    }
    if (connection.type !== "mysql") {
      return { supportsNotEmptyStringCheck: false };
    }

    try {
      const result = await this.databaseService.query(connection, this.database, "SELECT VERSION() AS version", 1);
      const version = String(result.rows[0]?.version ?? "");
      return {
        mysqlVersion: version,
        supportsNotEmptyStringCheck: isMySqlCheckConstraintEnforcedVersion(version),
      };
    } catch {
      return { supportsNotEmptyStringCheck: false };
    }
  }

  private async requireConnection() {
    const connection = await this.store.getWithSecret(this.connection.id);
    if (!connection) {
      throw new Error("连接配置不存在，可能已被删除。");
    }

    return connection;
  }

  private async requireConnectionById(connectionId: string): Promise<DbConnectionWithSecret> {
    const connection = await this.store.getWithSecret(connectionId);
    if (!connection) {
      throw new Error("来源连接配置不存在，可能已被删除。");
    }
    return connection;
  }

  private async postError(area: "schema" | "query" | "ai", error: unknown): Promise<void> {
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (area === "query" && this.lastQueryErrorSql.trim()) {
      const canExplainWithAi = isAiConfigured() && await this.hasProFeature("ai");
      if (!canExplainWithAi) {
        this.panel.webview.postMessage({ type: "error", area, message: rawMessage });
        if (isAiConfigured()) {
          void this.requireProFeature("ai", "AI 错误解释");
        }
        return;
      }
      const failedLabel = this.connection.type === "redis" ? "Redis命令执行失败" : this.connection.type === "elasticsearch" ? "Elasticsearch查询执行失败" : "SQL执行失败";
      this.panel.webview.postMessage({ type: "error", area, message: `${failedLabel}，正在使用 AI 搜索错误...` });
      const message = await this.formatDatabaseError(error, this.lastQueryErrorSql);
      this.panel.webview.postMessage({ type: "error", area, message });
      return;
    }
    this.panel.webview.postMessage({ type: "error", area, message: rawMessage });
  }

  private getCompletionUsage(): Record<string, number> {
    const value = this.context.globalState.get<Record<string, number>>(DatabaseWorkbenchPanel.completionUsageStateKey, {});
    return sanitizeCompletionUsage(value);
  }

  private async saveCompletionUsage(value: Record<string, number>): Promise<void> {
    await this.context.globalState.update(DatabaseWorkbenchPanel.completionUsageStateKey, sanitizeCompletionUsage(value));
  }

  private async createPendingOperationLog(input: CreateOperationLogInput): Promise<string | undefined> {
    if (!await this.hasProFeature("logs")) {
      return undefined;
    }
    return this.operationLogService.createPendingLog(input);
  }

  private async hasProFeature(feature: "ai" | "logs"): Promise<boolean> {
    return hasProFeature(this.context, feature);
  }

  private async requireProFeature(feature: "ai" | "logs", featureName: string): Promise<boolean> {
    return requireProFeature(this.context, feature, featureName);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Database Workbench</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1f1f1f);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --muted: var(--vscode-descriptionForeground, #8b949e);
      --panel: var(--vscode-sideBar-background, #252526);
      --panel-2: var(--vscode-editorWidget-background, #2d2d30);
      --line: var(--vscode-panel-border, #3c3c3c);
      --input: var(--vscode-input-background, #313131);
      --button: var(--vscode-button-background, #0e639c);
      --button-fg: var(--vscode-button-foreground, #ffffff);
      --button-hover: var(--vscode-button-hoverBackground, #1177bb);
      --danger: var(--vscode-errorForeground, #f48771);
      --ok: var(--vscode-testing-iconPassed, #73c991);
      --radius: 10px;
      --data-table-font-size: 12px;
      --mono: "SFMono-Regular", "Cascadia Code", "Menlo", monospace;
      --sans: "Avenir Next", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--fg);
      background: var(--bg);
      font-family: var(--sans);
      overflow: hidden;
    }
    button, input, textarea { font: inherit; }
    button {
      border: 0;
      border-radius: 7px;
      color: var(--button-fg);
      background: var(--button);
      padding: 7px 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { background: var(--button-hover); }
    button:disabled { cursor: not-allowed; opacity: .58; }
    button.secondary { color: var(--fg); background: transparent; border: 1px solid var(--line); }
    button.secondary:hover { background: var(--panel-2); }
    button.danger { color: #fff; background: var(--danger); border-color: var(--danger); }
    button.danger:hover { background: color-mix(in srgb, var(--danger) 82%, #000); }
    button.link { color: var(--muted); background: transparent; padding: 4px 0; }

    .page { height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.025), transparent);
      align-items: center;
    }
    .title-row { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 12px; }
    .title-row strong { color: var(--fg); font-size: 14px; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sep { color: var(--muted); opacity: .7; }
    .summary { display: contents; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; background: rgba(255,255,255,.025); white-space: nowrap; }
    .table-comment {
      display: inline-block;
      max-width: min(420px, 40vw);
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
    }
    .top-actions { display: flex; align-items: center; gap: 8px; }
    .auto-refresh {
      width: 48px;
      height: 31px;
      padding: 5px 6px;
      text-align: center;
      font-family: var(--mono);
      font-size: 12px;
    }
    .field-picker { position: relative; }
    .field-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 20;
      display: none;
      min-width: 230px;
      max-width: 320px;
      max-height: 320px;
      overflow: auto;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel-2);
      box-shadow: 0 12px 30px rgba(0,0,0,.28);
    }
    .field-picker.open .field-menu { display: block; }
    .field-menu-head { display: flex; justify-content: space-between; gap: 8px; padding: 4px 4px 8px; border-bottom: 1px solid var(--line); margin-bottom: 6px; }
    .field-menu-head button { color: var(--muted); background: transparent; border: 0; padding: 2px 4px; font-size: 12px; }
    .field-option { display: flex; align-items: center; gap: 8px; padding: 6px 5px; border-radius: 6px; color: var(--fg); font-family: var(--mono); font-size: 12px; cursor: pointer; }
    .field-option:hover { background: rgba(127,127,127,.12); }
    .field-option input { margin: 0; }
    .field-empty { color: var(--muted); padding: 8px 5px; font-size: 12px; }

    .main { min-height: 0; height: 100%; overflow: hidden; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
    .quick {
      padding: 14px 22px;
      border-bottom: 1px solid var(--line);
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 64px auto auto auto;
      gap: 9px;
      align-items: center;
      background: rgba(255,255,255,.012);
    }
    .field {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--fg);
      background: var(--input);
      padding: 8px 10px;
      outline: none;
    }
    input[type="number"] {
      appearance: textfield;
      -moz-appearance: textfield;
    }
    input[type="number"]::-webkit-outer-spin-button,
    input[type="number"]::-webkit-inner-spin-button {
      margin: 0;
      -webkit-appearance: none;
    }
	    .field:focus, textarea:focus { border-color: var(--button); }
	    #limitInput { text-align: center; padding-left: 6px; padding-right: 6px; }
	    .sql-highlight-wrap {
	      position: relative;
	      min-width: 0;
	      min-height: 0;
	    }
	    .sql-highlight-wrap .field,
	    .sql-highlight-wrap textarea {
	      position: relative;
	      z-index: 1;
	      color: transparent;
	      -webkit-text-fill-color: transparent;
	      caret-color: var(--fg);
	      background: transparent;
	    }
	    .sql-highlight-wrap .field::placeholder,
	    .sql-highlight-wrap textarea::placeholder {
	      color: var(--muted);
	      -webkit-text-fill-color: var(--muted);
	    }
	    .sql-highlight-wrap .field::selection,
	    .sql-highlight-wrap textarea::selection {
	      color: transparent;
	      -webkit-text-fill-color: transparent;
	      background: rgba(14, 99, 156, .38);
	    }
	    .sql-highlight-code {
	      position: absolute;
	      inset: 0;
	      z-index: 0;
	      box-sizing: border-box;
	      margin: 0;
	      overflow: hidden;
	      pointer-events: none;
	      border: 1px solid var(--line);
	      border-radius: 7px;
	      color: var(--fg);
	      background: var(--input);
	      white-space: pre-wrap;
	      overflow-wrap: anywhere;
	      font-family: var(--mono);
	      font-size: 12px;
	      line-height: 1.55;
	    }
	    .quick-sql-highlight .field,
	    .quick-sql-highlight .sql-highlight-code {
	      height: 100%;
	      min-height: 34px;
	      padding: 8px 10px;
	      font-family: var(--mono);
	      font-size: 12px;
	      line-height: 1.45;
	      white-space: pre;
	      overflow-wrap: normal;
	      font-weight: 400;
	      letter-spacing: normal;
	      font-variant-ligatures: none;
	      font-kerning: none;
	      tab-size: 2;
	    }
	    .quick-sql-highlight {
	      width: 100%;
	    }
	    .quick-sql-highlight .field {
	      width: 100%;
	      box-sizing: border-box;
	      display: block;
	      resize: none;
	      overflow: hidden;
	    }
	    .quick-sql-highlight .sql-highlight-code .sql-token-keyword,
	    .quick-sql-highlight .sql-highlight-code .sql-token-table {
	      font-weight: 400;
	      border-radius: 0;
	      padding: 0;
	    }
	    .editor-sql-highlight textarea {
	      background: transparent;
	    }
	    .editor-sql-highlight .sql-highlight-code {
	      padding: 11px 12px;
	      border-radius: var(--radius);
	    }
	    .sql-highlight-code .sql-token-keyword,
	    .code-suggest-label .sql-token-keyword { color: #7dd3fc; font-weight: 700; }
	    .sql-highlight-code .sql-token-string,
	    .code-suggest-label .sql-token-string { color: #f9a8d4; }
	    .sql-highlight-code .sql-token-number,
	    .code-suggest-label .sql-token-number { color: #fbbf24; }
	    .sql-highlight-code .sql-token-comment,
	    .code-suggest-label .sql-token-comment { color: var(--muted); font-style: italic; }
	    .sql-highlight-code .sql-token-field,
	    .code-suggest-label .sql-token-field { color: #c4b5fd; }
	    .sql-highlight-code .sql-token-table,
	    .code-suggest-label .sql-token-table { font-weight: 750; border-radius: 4px; padding: 0 2px; }
	    .sql-highlight-code .sql-token-table-0,
	    .sql-highlight-code .sql-token-field-0,
	    .code-suggest-label .sql-token-table-0,
	    .code-suggest-label .sql-token-field-0 { color: #34d399; }
	    .sql-highlight-code .sql-token-table-1,
	    .sql-highlight-code .sql-token-field-1,
	    .code-suggest-label .sql-token-table-1,
	    .code-suggest-label .sql-token-field-1 { color: #60a5fa; }
	    .sql-highlight-code .sql-token-table-2,
	    .sql-highlight-code .sql-token-field-2,
	    .code-suggest-label .sql-token-table-2,
	    .code-suggest-label .sql-token-field-2 { color: #f472b6; }
	    .sql-highlight-code .sql-token-table-3,
	    .sql-highlight-code .sql-token-field-3,
	    .code-suggest-label .sql-token-table-3,
	    .code-suggest-label .sql-token-field-3 { color: #fbbf24; }
	    .sql-highlight-code .sql-token-table-4,
	    .sql-highlight-code .sql-token-field-4,
	    .code-suggest-label .sql-token-table-4,
	    .code-suggest-label .sql-token-field-4 { color: #a78bfa; }
	    .sql-highlight-code .sql-token-table-5,
	    .sql-highlight-code .sql-token-field-5,
	    .code-suggest-label .sql-token-table-5,
	    .code-suggest-label .sql-token-field-5 { color: #fb7185; }
	    .sql-highlight-code .sql-token-table-6,
	    .sql-highlight-code .sql-token-field-6,
	    .code-suggest-label .sql-token-table-6,
	    .code-suggest-label .sql-token-field-6 { color: #2dd4bf; }
	    .sql-highlight-code .sql-token-table-7,
	    .sql-highlight-code .sql-token-field-7,
	    .code-suggest-label .sql-token-table-7,
	    .code-suggest-label .sql-token-field-7 { color: #c084fc; }

	    .sql-drawer { border-bottom: 1px solid var(--line); background: var(--panel); display: none; }
    .sql-drawer.open { display: block; }
    .drawer-grid { display: grid; grid-template-columns: 1fr; gap: 12px; padding: 14px 22px; }
    .sql-editor-row { min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 10px; align-items: stretch; }
    label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    textarea {
      width: 100%;
      min-height: 172px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--fg);
      background: var(--input);
      padding: 11px 12px;
      outline: none;
      font-family: var(--mono);
      line-height: 1.55;
      font-size: 12px;
    }
    textarea.sql-tag-invalid { border-color: rgba(244, 135, 113, .7); }
    .drawer-actions, .ai-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; align-items: center; }
    .drawer-actions { justify-content: flex-end; margin-top: 0; }
    .hint { color: var(--muted); font-size: 12px; line-height: 1.6; }
    code { font-family: var(--mono); color: var(--fg); background: rgba(255,255,255,.05); padding: 1px 4px; border-radius: 4px; }
    .refine { display: none; margin-top: 12px; }
    .refine.visible { display: block; }
    .code-suggest {
      position: fixed;
      z-index: 140;
      display: none;
      min-width: 260px;
      max-width: min(520px, 80vw);
      max-height: 280px;
      overflow: auto;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel-2);
      box-shadow: 0 16px 42px rgba(0,0,0,.34);
    }
    .code-suggest.open { display: block; }
    .code-suggest-item {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 7px 8px;
      border: 0;
      border-radius: 7px;
      color: var(--fg);
      background: transparent;
      text-align: left;
      font-family: var(--mono);
      font-size: 12px;
    }
    .code-suggest-item:hover,
    .code-suggest-item.active { background: rgba(14, 99, 156, .22); }
    .code-suggest-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .code-suggest-kind { color: var(--muted); font-family: var(--font); font-size: 11px; }
    .code-suggest-empty { color: var(--muted); padding: 8px; font-size: 12px; }
    .sql-tag-validation {
      display: none;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-top: 8px;
      padding: 7px 9px;
      border: 1px solid rgba(244, 135, 113, .35);
      border-radius: 8px;
      color: var(--muted);
      background: rgba(244, 135, 113, .08);
      font-size: 12px;
      line-height: 1.5;
    }
    .sql-tag-validation.visible { display: flex; }
    .sql-tag-error {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--danger);
      border: 1px solid rgba(244, 135, 113, .45);
      border-radius: 999px;
      padding: 1px 7px;
      background: rgba(244, 135, 113, .12);
      font-family: var(--mono);
    }

    .ai-workspace {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(320px, .95fr);
      gap: 14px;
      align-items: stretch;
      min-height: 340px;
      height: clamp(340px, 40vh, 480px);
    }
    .ai-editor-card, .ai-timeline-card {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 2px);
      background: linear-gradient(180deg, rgba(255,255,255,.026), rgba(255,255,255,.01));
      box-shadow: 0 14px 38px rgba(0,0,0,.16);
    }
    .ai-editor-card { display: grid; grid-template-rows: auto minmax(0, 1fr); padding: 12px; }
    .ai-editor-card textarea { height: 100%; min-height: 0; resize: none; }
    .ai-timeline-card { display: grid; grid-template-rows: auto auto minmax(0, 1fr); overflow: hidden; }
    .ai-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 12px 10px;
      border-bottom: 1px solid rgba(127,127,127,.12);
    }
    .ai-card-title { color: var(--fg); font-weight: 650; font-size: 13px; }
    .ai-card-subtitle { color: var(--muted); font-size: 11px; margin-top: 3px; }
    .ai-card-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
    .ai-prompt-area { padding: 11px 12px; border-bottom: 1px solid rgba(127,127,127,.12); }
    .ai-prompt-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; color: var(--muted); font-size: 12px; }
    .ai-prompt-label strong { color: var(--fg); font-weight: 650; }
    #aiPromptInput { min-height: 78px; max-height: 180px; resize: vertical; }
    .ai-timeline { min-height: 0; overflow: auto; padding: 12px 12px 14px 20px; }
    .ai-timeline-empty {
      display: grid;
      place-items: center;
      min-height: 128px;
      color: var(--muted);
      border: 1px dashed rgba(127,127,127,.24);
      border-radius: 10px;
      text-align: center;
      line-height: 1.7;
      padding: 16px;
    }
    .ai-timeline-item {
      position: relative;
      padding: 0 0 14px 16px;
      border-left: 1px solid rgba(127,127,127,.28);
    }
    .ai-timeline-item.child {
      margin-left: calc(var(--ai-depth, 1) * 22px);
      padding-left: 18px;
      border-left-style: dashed;
      border-left-color: color-mix(in srgb, var(--button) 34%, var(--line));
    }
    .ai-timeline-item:last-child { padding-bottom: 0; }
    .ai-timeline-dot {
      position: absolute;
      left: -5px;
      top: 4px;
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--button);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--button) 16%, transparent);
    }
    .ai-timeline-item.failed .ai-timeline-dot { background: var(--danger); box-shadow: 0 0 0 4px rgba(244, 135, 113, .14); }
    .ai-timeline-item.child .ai-timeline-dot { background: var(--muted); box-shadow: 0 0 0 4px rgba(127,127,127,.12); }
    .ai-timeline-item.running .ai-timeline-dot { animation: pulse-dot 1.2s ease-in-out infinite; }
    @keyframes pulse-dot { 0%, 100% { transform: scale(1); opacity: .8; } 50% { transform: scale(1.35); opacity: 1; } }
    .ai-timeline-box {
      border: 1px solid rgba(127,127,127,.2);
      border-radius: 10px;
      background: var(--panel-2);
      overflow: hidden;
    }
    .ai-timeline-item.applied .ai-timeline-box { border-color: color-mix(in srgb, var(--button) 55%, var(--line)); }
    .ai-timeline-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(127,127,127,.12); }
    .ai-timeline-title { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--fg); font-size: 12px; font-weight: 650; }
    .ai-timeline-time { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .ai-applied-badge { color: var(--button-fg); background: var(--button); border-radius: 999px; padding: 1px 6px; font-size: 10px; font-weight: 500; }
    .ai-timeline-body { padding: 9px 10px 10px; display: grid; gap: 8px; }
    .ai-prompt-preview { color: var(--muted); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .ai-sql-preview {
      margin: 0;
      max-height: 118px;
      overflow: auto;
      color: var(--fg);
      background: rgba(0,0,0,.14);
      border: 1px solid rgba(127,127,127,.14);
      border-radius: 8px;
      padding: 8px;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
    }
    .ai-timeline-actions { display: flex; flex-wrap: wrap; gap: 7px; }
    .ai-timeline-actions button { padding: 5px 8px; font-size: 11px; }

    .result-area { position: relative; min-width: 0; min-height: 0; overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); align-self: stretch; }
    .status { min-height: 37px; padding: 7px 22px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 12px; }
    .status-text { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-actions { margin-left: auto; display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: 0 0 auto; }
    .status-export { padding: 5px 10px; font-size: 12px; }
    .hidden { display: none !important; }
    .status strong { color: var(--ok); }
    .status.error { color: var(--danger); }
    .grid-scroll { min-width: 0; max-width: 100%; min-height: 0; overflow-x: hidden; overflow-y: auto; }
    .grid-scroll.has-pager { padding-bottom: 58px; scroll-padding-bottom: 58px; }
    .pager {
      display: none;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 10;
      justify-content: center;
      align-items: center;
      gap: 6px;
      min-height: 42px;
      padding: 8px 16px;
      border-top: 1px solid var(--line);
      background: var(--bg);
      box-shadow: 0 -10px 28px rgba(0,0,0,.2);
    }
    .pager.visible { display: flex; }
    .pager button {
      min-width: 34px;
      padding: 5px 9px;
      color: var(--fg);
      background: transparent;
      border: 1px solid var(--line);
    }
    .pager button:hover:not(:disabled), .pager button.active { background: var(--button); color: var(--button-fg); border-color: var(--button); }
    .pager button:disabled { cursor: not-allowed; opacity: .45; }
    .pager-ellipsis { color: var(--muted); padding: 0 2px; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-family: var(--mono); font-size: 12px; }
    .data-table { width: max-content; min-width: max(100%, calc(var(--column-count, 1) * 120px)); font-size: var(--data-table-font-size); }
    th { position: sticky; top: 0; z-index: 2; text-align: center; color: var(--fg); background: var(--panel-2); border-bottom: 1px solid var(--line); }
    th, td { height: 33px; padding: 0 10px; border-bottom: 1px solid rgba(127,127,127,.18); white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .data-table th, .data-table td { min-width: 120px; }
    .table-x-scroll-row { display: none; }
    .grid-scroll.wide-table .table-x-scroll-row { display: table-row; }
    .table-x-scroll-row th {
      top: var(--result-header-height, 33px);
      z-index: 3;
      height: 16px;
      min-width: 0;
      max-width: none;
      padding: 0;
      overflow: visible;
      border-bottom: 1px solid var(--line);
      background: var(--panel-2);
    }
    .table-x-scroll {
      position: sticky;
      left: 0;
      height: 16px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-gutter: stable;
    }
    .table-x-scroll-inner { height: 1px; }
    td { text-align: center; }
    .insert-row td { background: rgba(115, 201, 145, .08); border-bottom-color: rgba(115, 201, 145, .28); }
    .data-row.selected-row td {
      background: rgba(14, 99, 156, .13);
      box-shadow: inset 0 1px 0 rgba(14, 99, 156, .36), inset 0 -1px 0 rgba(14, 99, 156, .36);
    }
    .data-row.selected-row td:first-child { box-shadow: inset 2px 0 0 var(--button), inset 0 1px 0 rgba(14, 99, 156, .36), inset 0 -1px 0 rgba(14, 99, 156, .36); }
    .data-row.deleting-row td {
      background: rgba(244, 135, 113, .12);
      box-shadow: inset 0 1px 0 rgba(244, 135, 113, .35), inset 0 -1px 0 rgba(244, 135, 113, .35);
    }
    .data-row.deleting-row td:first-child { box-shadow: inset 2px 0 0 var(--danger), inset 0 1px 0 rgba(244, 135, 113, .35), inset 0 -1px 0 rgba(244, 135, 113, .35); }
    .auto-cell { color: var(--muted); font-style: italic; }
    .sort-header { display: inline-flex; align-items: center; justify-content: center; gap: 6px; max-width: 100%; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
    .sort-header:hover { color: var(--button-fg); background: transparent; }
    .plain-header { display: inline-flex; align-items: center; justify-content: center; max-width: 100%; color: inherit; }
    .sort-label { min-width: 0; display: inline-flex; flex-direction: column; gap: 2px; line-height: 1.15; }
    .sort-name { overflow: hidden; text-overflow: ellipsis; }
    .sort-comment { max-width: 180px; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-family: var(--font); font-size: 11px; font-weight: 400; }
    .sort-mark { color: var(--muted); font-size: 10px; }
    .sort-header.active .sort-mark { color: var(--fg); }
    .editable-cell { cursor: pointer; }
    .editable-cell:hover { outline: 1px solid var(--button); outline-offset: -1px; background: rgba(14, 99, 156, .12); }
    .inspectable-cell { cursor: pointer; }
    .inspectable-cell:hover { outline: 1px solid var(--button); outline-offset: -1px; background: rgba(14, 99, 156, .1); }
    .cell-newline-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: 0 3px;
      color: var(--muted);
      font-size: 10px;
      line-height: 1;
      vertical-align: 1px;
    }
    .pending-cell { background: rgba(255, 193, 7, .16); }
    .row-context-menu {
      position: fixed;
      z-index: 120;
      display: none;
      min-width: 120px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      box-shadow: 0 14px 34px rgba(0,0,0,.34);
    }
    .row-context-menu.open { display: block; }
    .row-context-menu button {
      width: 100%;
      padding: 7px 10px;
      color: var(--danger);
      background: transparent;
      text-align: left;
    }
    .row-context-menu button:hover { background: rgba(244, 135, 113, .12); }
    .edit-overlay {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(0, 0, 0, .35);
    }
    .edit-overlay.open { display: flex; }
    .redis-detail-overlay {
      position: fixed;
      inset: 0;
      z-index: 98;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
      background: rgba(0, 0, 0, .36);
    }
    .redis-detail-overlay.open { display: flex; }
    .redis-detail-dialog {
      width: min(920px, 94vw);
      height: min(650px, 86vh);
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: var(--panel-2);
      box-shadow: 0 22px 60px rgba(0,0,0,.42);
    }
    .redis-detail-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.035), transparent);
    }
    .redis-detail-title { font-weight: 650; color: var(--fg); }
    .redis-detail-meta { margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 12px; word-break: break-all; }
    .redis-detail-toolbar {
      display: flex;
      align-items: stretch;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      background: rgba(127,127,127,.04);
    }
    .redis-detail-fuzzy {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
      min-height: 34px;
      margin: 0;
      padding: 0 11px 0 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      transition: border-color .15s ease, background .15s ease, color .15s ease;
    }
    .redis-detail-fuzzy:hover {
      border-color: rgba(14, 99, 156, .55);
      background: rgba(14, 99, 156, .08);
      color: var(--fg);
    }
    .redis-detail-fuzzy input {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      opacity: 0;
      pointer-events: none;
    }
    .redis-detail-fuzzy-track {
      position: relative;
      width: 30px;
      height: 16px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(127,127,127,.16);
      transition: border-color .15s ease, background .15s ease;
    }
    .redis-detail-fuzzy-track::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--muted);
      transition: transform .15s ease, background .15s ease;
    }
    .redis-detail-fuzzy input:checked + .redis-detail-fuzzy-track {
      border-color: var(--button);
      background: rgba(14, 99, 156, .24);
    }
    .redis-detail-fuzzy input:checked + .redis-detail-fuzzy-track::after {
      transform: translateX(14px);
      background: var(--button-fg);
    }
    .redis-detail-fuzzy input:checked ~ .redis-detail-fuzzy-text {
      color: var(--fg);
    }
    .redis-detail-fuzzy-text { line-height: 1; }
    .redis-detail-toolbar > input.field { flex: 1; min-width: 0; height: 34px; }
    .redis-detail-toolbar > button { height: 34px; display: inline-flex; align-items: center; }
    .redis-score-sort {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .redis-score-sort:hover { color: var(--button-fg); background: transparent; }
    .redis-detail-body { min-height: 0; overflow: auto; background: var(--bg); }
    .redis-detail-body table { table-layout: fixed; }
    .redis-detail-body td { text-align: left; white-space: pre-wrap; word-break: break-word; max-width: none; height: auto; min-height: 33px; padding: 8px 10px; }
    .redis-detail-body th { text-align: left; }
    .redis-detail-empty { height: 100%; display: grid; place-items: center; color: var(--muted); }
    .redis-detail-pager {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 6px;
      min-height: 48px;
      padding: 8px 16px;
      border-top: 1px solid var(--line);
      background: var(--panel-2);
    }
    .redis-detail-pager:empty { display: none; }
    .redis-detail-pager button {
      min-width: 34px;
      padding: 5px 9px;
      color: var(--fg);
      background: transparent;
      border: 1px solid var(--line);
    }
    .redis-detail-pager button:hover:not(:disabled),
    .redis-detail-pager button.active { background: var(--button); color: var(--button-fg); border-color: var(--button); }
    .redis-detail-pager button:disabled { cursor: not-allowed; opacity: .45; }
    .redis-detail-context-menu {
      position: fixed;
      z-index: 130;
      display: none;
      min-width: 132px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      box-shadow: 0 14px 34px rgba(0,0,0,.34);
    }
    .redis-detail-context-menu.open { display: block; }
    .redis-detail-context-menu button {
      width: 100%;
      padding: 7px 10px;
      color: var(--danger);
      background: transparent;
      text-align: left;
    }
    .redis-detail-context-menu button:hover { background: rgba(244, 135, 113, .12); }
    .edit-dialog {
      width: min(680px, 92vw);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel-2);
      box-shadow: 0 18px 48px rgba(0,0,0,.38);
      overflow: hidden;
    }
    .edit-dialog-head { padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .edit-dialog-title { font-weight: 650; color: var(--fg); }
    .edit-dialog-meta { margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .edit-shortcuts {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(127,127,127,.06);
    }
    .edit-shortcuts.visible { display: flex; }
    .edit-shortcut-label { min-width: 0; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .edit-shortcut-actions { display: flex; align-items: center; gap: 8px; }
    .edit-shortcuts button { padding: 5px 10px; }
    .edit-shortcuts button.hidden { display: none; }
    .cell-editor {
      width: 100%;
      min-height: 180px;
      border: 0;
      color: var(--fg);
      background: var(--input);
      padding: 12px 14px;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.6;
      outline: none;
      resize: vertical;
    }
    .cell-editor.json-editor { min-height: 260px; }
    .cell-editor.hidden { display: none; }
    .json-editor-wrap {
      position: relative;
      background: var(--input);
    }
    .json-editor-wrap.hidden { display: none; }
    .json-editor-highlight {
      display: none;
      position: absolute;
      inset: 0;
      margin: 0;
      padding: 12px 14px;
      color: var(--fg);
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      overflow: hidden;
      pointer-events: none;
      tab-size: 2;
    }
    .json-editor-wrap.json-active .json-editor-highlight { display: block; }
    .json-editor-wrap.json-active .cell-editor {
      position: relative;
      z-index: 1;
      color: transparent;
      -webkit-text-fill-color: transparent;
      background: transparent;
      caret-color: var(--fg);
      tab-size: 2;
    }
    .json-editor-wrap.json-active .cell-editor::selection {
      background: rgba(78, 151, 224, .24);
    }
    .json-editor-wrap.json-active .cell-editor::placeholder {
      color: var(--muted);
      -webkit-text-fill-color: var(--muted);
    }
    .json-token.key { color: #4fc1ff; font-weight: 600; }
    .json-token.string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
    .json-token.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
    .json-token.boolean { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
    .json-token.null { color: #c586c0; }
    .json-token.punctuation { color: var(--muted); }
    .enum-editor {
      display: none;
      padding: 14px;
      background: var(--input);
    }
    .enum-editor.visible { display: block; }
    .enum-editor-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .enum-current { font-family: var(--mono); color: var(--fg); }
    .enum-options { display: flex; flex-wrap: wrap; gap: 8px; }
    .enum-option {
      border: 1px solid var(--line);
      color: var(--fg);
      background: transparent;
      font-family: var(--mono);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .enum-option.current { border-color: var(--ok); box-shadow: inset 0 0 0 1px var(--ok); }
    .enum-option.selected { color: var(--button-fg); background: var(--button); border-color: var(--button); }
    .enum-option.current.selected { box-shadow: inset 0 0 0 1px var(--ok), 0 0 0 1px var(--button); }
    .cell-editor.invalid { box-shadow: inset 0 0 0 1px var(--danger); }
    .edit-error {
      display: none;
      padding: 8px 14px;
      border-top: 1px solid rgba(244, 135, 113, .35);
      color: var(--danger);
      background: rgba(244, 135, 113, .08);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
    }
    .edit-error.visible { display: block; }
    .edit-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 14px;
      border-top: 1px solid var(--line);
    }
    .log-overlay {
      position: fixed;
      inset: 0;
      z-index: 95;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
      background: rgba(0, 0, 0, .38);
    }
    .log-overlay.open { display: flex; }
    .log-card {
      width: min(1180px, 96vw);
      height: min(760px, 92vh);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: var(--panel-2);
      box-shadow: 0 24px 70px rgba(0,0,0,.45);
    }
    .log-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.035), transparent);
    }
    .log-title-row { display: flex; align-items: center; gap: 12px; }
    .log-title { font-weight: 650; color: var(--fg); }
    .log-subtitle { margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .log-filter-colors { display: inline-flex; align-items: center; gap: 8px; }
    .log-filter-dot {
      width: 13px;
      height: 13px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: var(--tag-color);
      box-shadow: 0 0 0 1px rgba(255,255,255,.14);
    }
    .log-filter-dot:hover { background: var(--tag-color); transform: translateY(-1px); }
    .log-filter-dot.active { box-shadow: 0 0 0 2px var(--panel-2), 0 0 0 4px var(--tag-color); }
    .log-body { min-height: 0; display: grid; grid-template-columns: 310px minmax(0, 1fr); }
    .log-list { overflow: auto; padding: 10px; border-right: 1px solid var(--line); background: rgba(255,255,255,.015); }
    .log-item {
      width: 100%;
      display: grid;
      gap: 4px;
      margin: 2px 0;
      padding: 9px 10px;
      border: 1px solid transparent;
      border-radius: 9px;
      color: var(--fg);
      background: transparent;
      text-align: left;
    }
    .log-item:hover { border-color: var(--line); background: rgba(127,127,127,.10); }
    .log-item.active { border-color: var(--button); background: rgba(14, 99, 156, .18); }
    .log-item-main { display: flex; justify-content: space-between; gap: 8px; align-items: center; font-size: 12px; }
    .log-title-left { min-width: 0; display: inline-flex; align-items: center; gap: 7px; }
    .log-op { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); font-weight: 650; }
    .log-status { color: var(--muted); font-size: 11px; }
    .log-status.failed { color: var(--danger); }
    .log-item-time { color: var(--muted); font-family: var(--mono); font-size: 11px; }
    .log-tag-line { min-width: 0; display: inline-flex; }
    .log-tag-pill {
      min-width: 0;
      max-width: 120px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--fg);
      background: rgba(127,127,127,.08);
      font-size: 11px;
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .log-tag-pill::before {
      content: "";
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: var(--tag-color, var(--button));
    }
    .tag-red { --tag-color: #e15f5f; }
    .tag-orange { --tag-color: #d9863d; }
    .tag-yellow { --tag-color: #c9a227; }
    .tag-green { --tag-color: #4fa96b; }
    .tag-blue { --tag-color: #4f8ecb; }
    .tag-purple { --tag-color: #9d78d8; }
    .log-detail { min-width: 0; overflow: auto; padding: 16px; }
    .log-sql {
      margin: 0 0 14px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--input);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.55;
    }
    .log-section-title { margin: 14px 0 8px; color: var(--muted); font-size: 12px; }
    .log-section-title-row { min-width: 0; display: flex; align-items: flex-start; gap: 10px; flex: 1 1 auto; }
    .log-inline-error {
      min-width: 0;
      max-width: calc(100% - 96px);
      color: var(--danger);
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.5;
    }
    .log-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .log-detail-head .log-section-title { margin: 0; }
    .log-detail-actions { display: flex; align-items: center; gap: 8px; }
    .rollback-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border: 1px solid transparent;
      border-radius: 999px;
      color: var(--muted);
      background: rgba(14, 99, 156, .14);
      font-size: 11px;
    }
    .log-rollback {
      padding: 6px 12px;
      color: var(--button-fg);
      background: var(--button);
    }
    .log-rollback:disabled {
      cursor: not-allowed;
      opacity: .55;
      color: var(--muted);
      background: transparent;
      border: 1px solid var(--line);
    }
    .log-ai-actions { display: flex; justify-content: flex-end; margin: -6px 0 14px; }
    .log-ai-actions button { padding: 6px 12px; }
    .log-relation {
      margin: 0 0 14px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255,255,255,.025);
    }
    .log-relation-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
    .log-relation-title strong { color: var(--fg); }
    .log-jump { padding: 4px 9px; color: var(--fg); background: transparent; border: 1px solid var(--line); }
    .log-jump:hover { background: var(--panel-2); }
    .log-relation-sql {
      margin: 0;
      max-height: 130px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.55;
    }
    .log-row-card { margin-bottom: 14px; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
    .log-row-key { padding: 8px 10px; color: var(--muted); background: rgba(255,255,255,.025); font-family: var(--mono); font-size: 12px; }
    .log-compare { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
    .log-compare th, .log-compare td { height: auto; max-width: 260px; padding: 8px 10px; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }
    .log-compare .changed { background: rgba(255, 193, 7, .10); }
    .log-empty { color: var(--muted); padding: 42px 16px; text-align: center; }
    .log-context-menu {
      position: fixed;
      z-index: 130;
      display: none;
      min-width: 112px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      box-shadow: 0 14px 34px rgba(0,0,0,.34);
    }
    .log-context-menu.open { display: block; }
    .log-context-menu button {
      width: 100%;
      padding: 7px 10px;
      color: var(--fg);
      background: transparent;
      text-align: left;
    }
    .log-context-menu button:hover { background: rgba(127,127,127,.12); }
    .log-tag-overlay {
      position: fixed;
      inset: 0;
      z-index: 140;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
      background: rgba(0, 0, 0, .28);
    }
    .log-tag-overlay.open { display: flex; }
    .log-tag-dialog {
      width: min(430px, 92vw);
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: var(--panel-2);
      box-shadow: 0 18px 48px rgba(0,0,0,.38);
    }
    .log-tag-head { padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .log-tag-title { font-weight: 650; }
    .log-tag-meta { margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .log-tag-body { padding: 14px; display: grid; gap: 12px; }
    .log-tag-input {
      width: 100%;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--fg);
      background: var(--input);
      outline: none;
    }
    .log-tag-input:focus { border-color: var(--button); }
    .log-tag-help { color: var(--muted); font-size: 12px; }
    .log-tag-colors { display: flex; align-items: center; gap: 10px; }
    .tag-color-button {
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: var(--tag-color);
      box-shadow: 0 0 0 1px rgba(255,255,255,.12);
    }
    .tag-color-button:hover { background: var(--tag-color); transform: translateY(-1px); }
    .tag-color-button.active { box-shadow: 0 0 0 2px var(--panel-2), 0 0 0 4px var(--tag-color); }
    .log-tag-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--line); }
	    .discard-refresh-overlay,
	    .quick-refresh-overlay {
	      position: fixed;
	      inset: 0;
	      z-index: 145;
	      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
	      background: rgba(0, 0, 0, .38);
	    }
	    .discard-refresh-overlay.open,
	    .quick-refresh-overlay.open { display: flex; }
	    .discard-refresh-dialog,
	    .quick-refresh-dialog {
	      width: min(460px, 92vw);
	      border: 1px solid var(--line);
	      border-radius: 13px;
      overflow: hidden;
	      background: var(--panel-2);
	      box-shadow: 0 20px 56px rgba(0,0,0,.42);
	    }
	    .discard-refresh-head,
	    .quick-refresh-head { padding: 14px 16px 8px; }
	    .discard-refresh-title,
	    .quick-refresh-title { font-weight: 650; color: var(--fg); }
	    .discard-refresh-body,
	    .quick-refresh-body { padding: 0 16px 16px; color: var(--muted); font-size: 13px; line-height: 1.7; }
	    .discard-refresh-actions,
	    .quick-refresh-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: rgba(255,255,255,.015); }
    .export-overlay {
      position: fixed;
      inset: 0;
      z-index: 170;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
      background: rgba(0,0,0,.42);
    }
    .export-overlay.open { display: flex; }
    .export-dialog {
      width: min(560px, 96vw);
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 24px 70px rgba(0,0,0,.38);
      padding: 16px;
    }
    .export-title { color: var(--fg); font-size: 15px; font-weight: 700; }
    .export-meta { margin-top: 8px; color: var(--muted); line-height: 1.7; }
    .export-form { display: grid; gap: 10px; margin-top: 14px; }
    .export-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; align-items: center; }
    .export-row span { color: var(--muted); font-size: 12px; }
    .export-field-panel { margin-top: 4px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--panel-2); }
    .export-field-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    .export-field-head button { padding: 3px 7px; font-size: 11px; }
    .export-field-list { max-height: 220px; overflow: auto; display: grid; gap: 0; }
    .export-field-item { display: grid; grid-template-columns: 22px minmax(120px, 1fr) minmax(120px, 1fr); gap: 10px; align-items: center; padding: 8px 10px; border-bottom: 1px solid rgba(127,127,127,.09); transition: background .15s ease, opacity .15s ease, transform .15s ease; }
    .export-field-item:last-child { border-bottom: 0; }
    .export-field-item.dragging { opacity: .55; background: rgba(127,127,127,.10); }
    .export-drag-handle { width: 22px; height: 26px; border: 1px solid transparent; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); cursor: grab; user-select: none; }
    .export-drag-handle:hover { border-color: var(--line); color: var(--fg); background: rgba(127,127,127,.08); }
    .export-drag-handle:active { cursor: grabbing; }
    .export-field-check { min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--fg); font-size: 12px; cursor: pointer; }
    .export-field-check span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .export-alias { min-width: 0; }
    .export-dialog.sql-mode .export-field-item { grid-template-columns: 22px minmax(120px, 1fr); }
    .export-dialog.sql-mode .export-alias,
    .export-dialog.sql-mode .export-alias-tip { display: none; }
    .export-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .import-dialog { width: min(980px, 94vw); max-height: min(760px, 92vh); overflow: auto; }
    .import-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: end; }
    .import-grid label { min-width: 0; display: grid; gap: 6px; margin: 0; }
    .import-grid label span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .import-grid .field { width: 100%; box-sizing: border-box; }
    .import-field-map { max-height: 300px; overflow: auto; display: grid; gap: 8px; padding: 10px; background: var(--panel-2); }
    .import-map-row { display: grid; grid-template-columns: minmax(130px, 1fr) 24px minmax(130px, 1fr) auto; gap: 8px; align-items: center; }
    .import-map-row .field { width: 100%; box-sizing: border-box; }
    .import-map-row .arrow { color: var(--muted); text-align: center; }
    .import-map-row button { padding: 5px 8px; white-space: nowrap; }
    .import-add-map { margin: 10px; }
    .import-summary { min-width: 0; min-height: 35px; display: flex; align-items: center; color: var(--muted); font-size: 12px; line-height: 1.45; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 8px; background: rgba(127,127,127,.04); box-sizing: border-box; }
    tr:hover td { background: rgba(127,127,127,.08); }
    .empty { color: var(--muted); padding: 46px 22px; text-align: center; }
    .empty strong { display: block; color: var(--fg); font-size: 16px; margin-bottom: 8px; }
    .schema-overlay {
      position: fixed;
      inset: 0;
      z-index: 90;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
      background: rgba(0, 0, 0, .38);
    }
    .schema-overlay.open { display: flex; }
    .schema-card {
      width: min(1120px, 96vw);
      height: min(760px, 92vh);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: var(--panel-2);
      box-shadow: 0 24px 70px rgba(0,0,0,.45);
    }
    .schema-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.035), transparent);
    }
    .schema-title { font-weight: 650; color: var(--fg); }
    .schema-subtitle { margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .schema-body { min-height: 0; display: grid; grid-template-columns: 280px minmax(0, 1fr); }
    .schema-tree {
      overflow: auto;
      padding: 12px;
      border-right: 1px solid var(--line);
      background: rgba(255,255,255,.015);
    }
    .schema-node {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 2px 0;
      padding: 7px 8px;
      border: 1px solid transparent;
      color: var(--fg);
      background: transparent;
      text-align: left;
      font-family: var(--mono);
      font-size: 12px;
    }
    .schema-label {
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .schema-action {
      width: 22px;
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      padding: 0;
      margin-left: auto;
      opacity: 0;
      color: var(--fg);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      transition: opacity .12s ease, background .12s ease;
    }
    .schema-node.section:hover .schema-add,
    .schema-node.child:hover .schema-delete { opacity: 1; }
    .schema-add:hover { background: var(--button); color: var(--button-fg); border-color: var(--button); }
    .schema-delete:hover { background: var(--danger); color: white; border-color: var(--danger); }
    .schema-node:hover { border-color: var(--line); background: rgba(127,127,127,.10); }
    .schema-node.active { border-color: var(--button); background: rgba(14, 99, 156, .18); }
    .schema-node.pending-delete {
      border-color: var(--danger);
      background: rgba(244, 135, 113, .10);
    }
    .schema-node.pending-delete .schema-label {
      color: var(--danger);
      text-decoration: line-through;
    }
    .schema-node.root { font-weight: 700; }
    .schema-node.section { margin-top: 10px; color: var(--muted); text-transform: none; }
    .schema-node.child { padding-left: 22px; }
    .schema-node.dragging { opacity: .45; }
    .schema-node.drop-before { border-top-color: var(--button); }
    .schema-node.drop-after { border-bottom-color: var(--button); }
    .schema-count { color: var(--muted); font-size: 11px; }
    .schema-detail { min-width: 0; overflow: auto; padding: 18px; }
    .schema-detail-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .schema-detail-title h3 { margin: 0; font-size: 17px; font-weight: 650; }
    .schema-detail-title span { color: var(--muted); font-size: 12px; }
    .schema-form { display: grid; gap: 12px; }
    .schema-form-row {
      display: grid;
      grid-template-columns: 120px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .schema-form-row label { margin: 0; }
    .schema-checks { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
    .schema-checks label { display: inline-flex; align-items: center; gap: 7px; margin: 0; color: var(--fg); }
    .schema-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .schema-table th, .schema-table td { height: 34px; max-width: none; }
    .schema-table tr { cursor: pointer; }
    .schema-table tr.dragging { opacity: .45; }
    .schema-table tr.drop-before { box-shadow: inset 0 2px 0 var(--button); }
    .schema-table tr.drop-after { box-shadow: inset 0 -2px 0 var(--button); }
    .schema-muted { color: var(--muted); line-height: 1.7; }
    .schema-footer {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .schema-footer-error {
      min-width: 0;
      flex: 1 1 auto;
      color: var(--danger);
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .schema-footer-actions { display: flex; flex: 0 0 auto; gap: 8px; }
    .ai-schema-button.hidden { display: none; }
    .ai-create-table-overlay {
      position: fixed;
      inset: 0;
      z-index: 120;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
      background: rgba(0, 0, 0, .42);
    }
    .ai-create-table-overlay.open { display: flex; }
    .ai-create-table-card {
      width: min(720px, 94vw);
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: var(--panel-2);
      box-shadow: 0 24px 70px rgba(0,0,0,.45);
    }
    .ai-create-table-head {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.035), transparent);
    }
    .ai-create-table-title { font-weight: 650; color: var(--fg); }
    .ai-create-table-subtitle { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .ai-create-table-body { padding: 14px 16px; display: grid; gap: 10px; }
    .ai-create-table-body textarea { min-height: 190px; resize: vertical; }
    .ai-create-table-loading {
      display: none;
      align-items: center;
      gap: 9px;
      min-height: 30px;
      padding: 8px 10px;
      border: 1px solid rgba(127,127,127,.18);
      border-radius: 10px;
      color: var(--muted);
      background: rgba(255,255,255,.025);
      font-size: 12px;
    }
    .ai-create-table-loading.show { display: inline-flex; }
    .ai-create-table-spinner {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid rgba(127,127,127,.28);
      border-top-color: var(--button);
      animation: dbw-spin .85s linear infinite;
    }
    @keyframes dbw-spin { to { transform: rotate(360deg); } }
    .ai-create-table-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
	    .schema-confirm-overlay {
	      position: fixed;
	      inset: 0;
	      z-index: 130;
	      display: none;
	      align-items: center;
	      justify-content: center;
	      padding: clamp(12px, 3vw, 30px);
	      background: rgba(0, 0, 0, .46);
	      overflow: hidden;
	    }
	    .schema-confirm-overlay.open { display: flex; }
	    .schema-confirm-card {
	      width: min(1040px, calc(100vw - clamp(24px, 6vw, 60px)));
	      max-width: calc(100vw - clamp(24px, 6vw, 60px));
	      height: min(76vh, calc(100vh - clamp(24px, 6vw, 60px)));
	      min-height: min(360px, calc(100vh - clamp(24px, 6vw, 60px)));
	      max-height: calc(100vh - clamp(24px, 6vw, 60px));
	      display: grid;
	      grid-template-rows: auto minmax(0, 1fr) auto;
	      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: var(--panel-2);
      box-shadow: 0 24px 70px rgba(0,0,0,.48);
    }
    .schema-confirm-head {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.035), transparent);
    }
    .schema-confirm-title { font-weight: 650; color: var(--fg); }
    .schema-confirm-subtitle { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .schema-confirm-body {
      min-height: 0;
      padding: 14px 16px;
      overflow: hidden;
    }
	    .schema-confirm-sql {
	      width: 100%;
	      max-width: 100%;
	      height: 100%;
	      min-height: 0;
	      max-height: none;
	      box-sizing: border-box;
      margin: 0;
      padding: 12px;
      overflow-x: hidden;
      overflow-y: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      color: var(--fg);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      font-family: var(--mono);
      font-size: var(--sql-confirm-font-size, 15px);
	      line-height: 1.6;
	      overscroll-behavior: contain;
	    }
	    .schema-confirm-sql .sql-token-keyword { color: #7dd3fc; font-weight: 700; }
	    .schema-confirm-sql .sql-token-string { color: #f9a8d4; }
	    .schema-confirm-sql .sql-token-number { color: #fbbf24; }
	    .schema-confirm-sql .sql-token-comment { color: var(--muted); font-style: italic; }
	    .schema-confirm-sql .sql-token-field { color: #c4b5fd; }
	    .schema-confirm-sql .sql-token-table { font-weight: 750; border-radius: 4px; padding: 0 2px; }
	    .schema-confirm-sql .sql-token-table-0, .schema-confirm-sql .sql-token-field-0 { color: #34d399; }
	    .schema-confirm-sql .sql-token-table-1, .schema-confirm-sql .sql-token-field-1 { color: #60a5fa; }
	    .schema-confirm-sql .sql-token-table-2, .schema-confirm-sql .sql-token-field-2 { color: #f472b6; }
	    .schema-confirm-sql .sql-token-table-3, .schema-confirm-sql .sql-token-field-3 { color: #fbbf24; }
	    .schema-confirm-sql .sql-token-table-4, .schema-confirm-sql .sql-token-field-4 { color: #a78bfa; }
	    .schema-confirm-sql .sql-token-table-5, .schema-confirm-sql .sql-token-field-5 { color: #fb7185; }
	    .schema-confirm-sql .sql-token-table-6, .schema-confirm-sql .sql-token-field-6 { color: #2dd4bf; }
	    .schema-confirm-sql .sql-token-table-7, .schema-confirm-sql .sql-token-field-7 { color: #c084fc; }
	    .schema-confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--line);
      background: rgba(255,255,255,.015);
    }

    @media (max-width: 860px) {
      body { overflow: hidden; }
      .page { height: 100vh; min-height: 0; }
      .main { min-height: 0; height: 100%; }
      .result-area { min-height: 0; }
      .topbar, .quick, .drawer-grid, .sql-editor-row, .ai-workspace { grid-template-columns: 1fr; }
      .drawer-actions { flex-direction: row; margin-top: 0; }
      .title-row { flex-wrap: wrap; }
      .top-actions { justify-content: start; }
      .schema-card { height: 92vh; }
      .schema-body { grid-template-columns: 1fr; grid-template-rows: 220px minmax(0, 1fr); }
      .schema-tree { border-right: 0; border-bottom: 1px solid var(--line); }
      .schema-form-row { grid-template-columns: 1fr; }
      .import-grid { grid-template-columns: 1fr; }
      .import-map-row { grid-template-columns: minmax(0, 1fr); }
      .import-map-row .arrow { display: none; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="topbar">
      <div class="title-row">
        <span id="crumb">Database Workbench</span>
        <span class="sep">/</span>
        <strong id="tableTitle">选择一张表</strong>
        <span class="summary" id="summary"><span class="pill">等待选择</span></span>
      </div>
      <div class="top-actions">
        <button class="secondary" id="refreshBtn">刷新数据</button>
        <input class="field auto-refresh" id="autoRefreshInput" inputmode="numeric" pattern="\\d*" value="0" title="自动刷新间隔，单位秒；0 表示关闭自动刷新" />
        <button class="secondary" id="copyStructureBtn">复制表结构</button>
        <button class="secondary" id="editStructureBtn">修改表结构</button>
	        <div class="field-picker" id="fieldPicker">
	          <button class="secondary" id="fieldPickerBtn">选择显示字段</button>
	          <div class="field-menu" id="fieldMenu">
	            <div class="field-menu-head">
	              <button id="selectAllFieldsBtn">全选</button>
              <button id="clearFieldsBtn">清空</button>
            </div>
	            <div id="fieldOptions"><div class="field-empty">查询后可选择展示字段</div></div>
	          </div>
	        </div>
	        <button class="secondary" id="operationLogBtn">操作日志</button>
	      </div>
	    </header>

    <section class="main">
	    <section class="quick">
	      <div class="sql-highlight-wrap quick-sql-highlight">
	        <pre class="sql-highlight-code" id="whereHighlight" aria-hidden="true"></pre>
	        <textarea class="field" id="whereInput" rows="1" wrap="off" spellcheck="false" placeholder="快速条件：例如 status = 'paid' AND id > 100"></textarea>
	      </div>
	      <input class="field" id="limitInput" type="number" max="5000" value="30" title="限制行数；输入负数表示查询全部" />
	      <button id="quickBtn">查询</button>
        <button class="secondary" id="toggleSqlBtn">打开 SQL / AI</button>
        <button class="secondary" id="quickAddBtn">快速添加</button>
      </section>

      <section class="sql-drawer" id="sqlDrawer">
        <div class="drawer-grid">
          <div class="ai-workspace">
            <div class="ai-editor-card">
              <label for="sqlInput">SQL 编辑器</label>
	            <div class="sql-editor-row">
	              <div class="sql-highlight-wrap editor-sql-highlight">
	                <pre class="sql-highlight-code" id="sqlHighlight" aria-hidden="true"></pre>
	                <textarea id="sqlInput" spellcheck="false" placeholder="这里保持纯净，只放当前要执行的 SQL / Redis 命令 / Elasticsearch 查询。AI 提问和 @ai{}、@gen{}、@table{} 请写到右侧时间线输入框。"></textarea>
	              </div>
                <div class="drawer-actions">
                  <button id="runSqlBtn">执行 SQL</button>
                  <button class="secondary" id="formatBtn">格式化</button>
                </div>
              </div>
            </div>
            <aside class="ai-timeline-card" aria-label="AI 时间线">
              <div class="ai-card-head">
                <div>
                  <div class="ai-card-title">AI 时间线</div>
                  <div class="ai-card-subtitle">提问历史仅保留在当前标签页，关闭后自动清空。</div>
                </div>
                <div class="ai-card-actions">
                  <button class="secondary" id="clearAiTimelineBtn">清空</button>
                  <button class="secondary" id="aiFromSqlBtn">发送给 AI</button>
                </div>
              </div>
              <div class="ai-prompt-area">
                <label class="ai-prompt-label" for="aiPromptInput"><strong>继续告诉 AI：</strong><span>支持 @ai{}、&lt;ai&gt;&lt;/ai&gt;、@gen{}、&lt;gen&gt;&lt;/gen&gt;、@table{}、&lt;table&gt;&lt;/table&gt;</span></label>
                <textarea id="aiPromptInput" spellcheck="false" placeholder="例如：查询当前表 created_at 为空的数据；或 @ai{把当前 SQL 改成按 created_at 倒序}；用 @table{users} 添加额外表结构。"></textarea>
                <div class="sql-tag-validation" id="sqlTagValidation"></div>
              </div>
              <div class="ai-timeline" id="aiTimeline"></div>
            </aside>
          </div>
        </div>
      </section>

      <section class="result-area">
        <div class="status" id="status">
          <span class="status-text" id="statusText">等待从左侧选择表。</span>
          <div class="status-actions">
            <button class="secondary status-export hidden" id="importPreviewBtn">导入</button>
            <button class="secondary status-export hidden" id="exportPreviewBtn">导出</button>
          </div>
        </div>
        <div class="grid-scroll" id="result"><div class="empty"><strong>还没有数据</strong>从左侧数据库树点击表名，右侧会展示预览数据。</div></div>
        <div class="pager" id="pager"></div>
      </section>
    </section>
  </main>
  <div class="row-context-menu" id="rowContextMenu">
    <button id="deleteRowBtn">删除该行</button>
  </div>
  <div class="code-suggest" id="codeSuggest"></div>
  <div class="export-overlay" id="exportOverlay" role="dialog" aria-modal="true" aria-labelledby="exportDialogTitle">
    <div class="export-dialog" id="exportDialog">
      <div class="export-title" id="exportDialogTitle">导出预览数据</div>
      <div class="export-meta">当前预览一共有 <strong id="exportTotalRows">0</strong> 行，可自定义本次导出的行数。</div>
      <div class="export-form">
        <label class="export-row"><span>导出行数</span><input class="field" id="exportRowLimitInput" type="number" min="1" value="30" /></label>
        <label class="export-row"><span>导出类型</span><select class="field" id="exportFormatSelect"><option value="xlsx">Excel（.xlsx）</option><option value="sql">SQL 文件（.sql）</option></select></label>
        <div class="export-field-panel">
          <div class="export-field-head">
            <span>导出字段 <span class="export-alias-tip">· 拖拽调整 Excel 列顺序 · Excel 表头可自定义别名</span></span>
            <div>
              <button class="secondary" id="selectAllExportFieldsBtn">全选</button>
              <button class="secondary" id="clearExportFieldsBtn">清空</button>
            </div>
          </div>
          <div class="export-field-list" id="exportFieldList"></div>
        </div>
      </div>
      <div class="export-actions">
        <button class="secondary" id="cancelExportBtn">取消</button>
        <button id="confirmExportBtn">确认导出</button>
      </div>
    </div>
  </div>
  <div class="export-overlay" id="importOverlay" role="dialog" aria-modal="true" aria-labelledby="importDialogTitle">
    <div class="export-dialog import-dialog" id="importDialog">
      <div class="export-title" id="importDialogTitle">从其他表导入数据</div>
      <div class="export-meta">把来源表字段映射到当前表字段。提交后会按批写入并开启事务，任一批次失败会整体回滚。</div>
      <div class="export-form">
        <div class="import-grid">
          <label><span>来源连接</span><select class="field" id="importSourceConnection"></select></label>
          <label><span>来源数据库</span><select class="field" id="importSourceDatabase"></select></label>
          <label><span>来源表</span><select class="field" id="importSourceTable"></select></label>
          <label><span>导入数量</span><input class="field" id="importRowLimitInput" type="number" min="1" value="30" /></label>
          <label><span>批大小</span><input class="field" id="importBatchSizeInput" type="number" min="1" max="5000" value="500" /></label>
          <div class="import-summary" id="importSummary">选择来源表后配置字段映射。</div>
        </div>
        <div class="export-field-panel">
          <div class="export-field-head">
            <span>字段映射 · 左侧来源字段，右侧当前表字段；不需要导入的字段可以删除映射</span>
            <div>
              <button class="secondary" id="autoImportMapBtn">自动匹配</button>
              <button class="secondary" id="clearImportMapBtn">清空</button>
            </div>
          </div>
          <div class="import-field-map" id="importFieldMap"></div>
          <button class="secondary import-add-map" id="addImportMapBtn">添加映射</button>
        </div>
      </div>
      <div class="export-actions">
        <button class="secondary" id="cancelImportBtn">取消</button>
        <button id="confirmImportBtn">确认导入</button>
      </div>
    </div>
  </div>

  <div class="redis-detail-overlay" id="redisDetailOverlay" role="dialog" aria-modal="true" aria-labelledby="redisDetailTitle">
    <div class="redis-detail-dialog">
      <div class="redis-detail-head">
        <div>
          <div class="redis-detail-title" id="redisDetailTitle">Redis Key 详情</div>
          <div class="redis-detail-meta" id="redisDetailMeta"></div>
        </div>
        <button class="secondary" id="closeRedisDetailBtn">关闭</button>
      </div>
      <div class="redis-detail-toolbar">
        <label class="redis-detail-fuzzy" title="开启后会在插件侧遍历并做包含匹配；关闭时只使用 Redis 原生命令搜索。">
          <input type="checkbox" id="redisDetailFuzzySearch" />
          <span class="redis-detail-fuzzy-track" aria-hidden="true"></span>
          <span class="redis-detail-fuzzy-text">模糊搜索</span>
        </label>
        <input class="field" id="redisDetailSearchInput" placeholder="原生搜索：Hash/Set/ZSet 使用 SCAN 精确匹配；List 使用精确值" />
        <button class="secondary" id="redisDetailSearchBtn">搜索</button>
        <button class="secondary" id="redisDetailClearSearchBtn">清空</button>
      </div>
      <div class="redis-detail-body" id="redisDetailBody"></div>
      <div class="redis-detail-pager" id="redisDetailPager"></div>
    </div>
  </div>
  <div class="redis-detail-context-menu" id="redisDetailContextMenu">
    <button id="deleteRedisDetailItemBtn">删除该元素</button>
  </div>

  <div class="schema-overlay" id="schemaOverlay" role="dialog" aria-modal="true" aria-labelledby="schemaDialogTitle">
    <div class="schema-card">
      <div class="schema-head">
        <div>
          <div class="schema-title" id="schemaDialogTitle">修改表结构</div>
          <div class="schema-subtitle" id="schemaDialogMeta">选择一张表后可查看和编辑结构草案</div>
        </div>
        <button class="secondary" id="closeSchemaEditorBtn">关闭</button>
      </div>
      <div class="schema-body">
        <nav class="schema-tree" id="schemaTree"></nav>
        <section class="schema-detail" id="schemaDetail"></section>
      </div>
      <div class="schema-footer">
        <span class="schema-footer-error" id="schemaSubmitError" title=""></span>
        <div class="schema-footer-actions">
          <button class="secondary ai-schema-button hidden" id="aiCreateTableBtn">AI 辅助建表</button>
          <button class="secondary" id="resetSchemaDraftBtn">重置草案</button>
          <button class="secondary" id="copySchemaChangeSqlBtn">复制修改 SQL</button>
          <button id="applySchemaDraftBtn">提交修改</button>
        </div>
      </div>
    </div>
  </div>

  <div class="ai-create-table-overlay" id="aiCreateTableOverlay" role="dialog" aria-modal="true" aria-labelledby="aiCreateTableTitle">
    <div class="ai-create-table-card">
      <div class="ai-create-table-head">
        <div class="ai-create-table-title" id="aiCreateTableTitle">AI 辅助建表</div>
        <div class="ai-create-table-subtitle">描述这张表的业务用途、核心字段、索引和关联关系。AI 会生成建表 SQL，并自动映射到添加表草案。</div>
      </div>
      <div class="ai-create-table-body">
        <textarea id="aiCreateTablePrompt" spellcheck="false" placeholder="例如：创建博客文章表，包含标题、摘要、正文、作者、发布状态、发布时间，标题和状态要方便查询；所有字段要有清楚中文描述。"></textarea>
        <div class="hint">提示：AI 请求中会明确要求表和每个字段都写清楚描述。生成后请仍然检查字段类型、默认值、索引和约束。</div>
        <div class="ai-create-table-loading" id="aiCreateTableLoading" aria-live="polite">
          <span class="ai-create-table-spinner" aria-hidden="true"></span>
          <span id="aiCreateTableLoadingText">正在调用 AI 执行.</span>
        </div>
      </div>
      <div class="ai-create-table-actions">
        <button class="secondary" id="cancelAiCreateTableBtn">取消</button>
        <button id="confirmAiCreateTableBtn">确认生成</button>
      </div>
    </div>
  </div>

  <div class="schema-confirm-overlay" id="schemaConfirmOverlay" role="dialog" aria-modal="true" aria-labelledby="schemaConfirmTitle">
    <div class="schema-confirm-card">
      <div class="schema-confirm-head">
        <div class="schema-confirm-title" id="schemaConfirmTitle">确认执行 SQL</div>
        <div class="schema-confirm-subtitle">请检查即将执行的 SQL，内容较长时可以在下方区域滚动查看。</div>
      </div>
      <div class="schema-confirm-body">
        <pre class="schema-confirm-sql" id="schemaConfirmSql"></pre>
      </div>
      <div class="schema-confirm-actions">
        <button class="secondary" id="cancelSchemaConfirmBtn">取消</button>
        <button id="confirmSchemaApplyBtn">确认执行</button>
      </div>
    </div>
  </div>

	  <div class="edit-overlay" id="editOverlay" role="dialog" aria-modal="true" aria-labelledby="editDialogTitle">
	    <div class="edit-dialog">
      <div class="edit-dialog-head">
        <div class="edit-dialog-title" id="editDialogTitle">编辑字段值</div>
        <div class="edit-dialog-meta" id="editDialogMeta"></div>
      </div>
      <div class="edit-shortcuts" id="editShortcuts">
        <span class="edit-shortcut-label" id="editShortcutLabel">时间类型字段，可快速填入北京时间。</span>
        <div class="edit-shortcut-actions">
          <button class="secondary" id="fillNowBtn">填入当前时间</button>
          <button class="secondary hidden" id="formatJsonBtn">格式化 JSON</button>
          <button class="secondary hidden" id="setNullBtn">NULL</button>
        </div>
      </div>
      <div class="json-editor-wrap" id="jsonEditorWrap">
        <pre class="json-editor-highlight" id="jsonEditorHighlight" aria-hidden="true"></pre>
        <textarea class="cell-editor" id="cellEditor" spellcheck="false"></textarea>
      </div>
      <div class="enum-editor" id="enumEditor">
        <div class="enum-editor-head">
          <span>当前值：<strong class="enum-current" id="enumCurrentValue"></strong></span>
          <span>点击下方枚举值进行选择</span>
        </div>
        <div class="enum-options" id="enumOptions"></div>
      </div>
      <div class="edit-error" id="editError"></div>
      <div class="edit-dialog-actions">
        <button class="secondary" id="cancelCellEditBtn">取消</button>
        <button id="saveCellEditBtn">暂存修改</button>
      </div>
	    </div>
	  </div>

	  <div class="log-overlay" id="logOverlay" role="dialog" aria-modal="true" aria-labelledby="logDialogTitle">
	    <div class="log-card">
	      <div class="log-head">
	        <div>
	          <div class="log-title-row">
	            <div class="log-title" id="logDialogTitle">操作日志</div>
	            <div class="log-filter-colors" id="logTagFilterColors" aria-label="按标签颜色筛选"></div>
	          </div>
	          <div class="log-subtitle" id="logDialogMeta">记录通过插件执行的修改 SQL 与数据快照</div>
	        </div>
	        <button class="secondary" id="closeLogBtn">关闭</button>
	      </div>
	      <div class="log-body">
	        <nav class="log-list" id="logList"></nav>
	        <section class="log-detail" id="logDetail"></section>
	      </div>
	    </div>
	  </div>
  <div class="log-context-menu" id="logContextMenu">
    <button id="markLogBtn">标记</button>
  </div>

  <div class="log-tag-overlay" id="logTagOverlay" role="dialog" aria-modal="true" aria-labelledby="logTagDialogTitle">
    <div class="log-tag-dialog">
      <div class="log-tag-head">
        <div class="log-tag-title" id="logTagDialogTitle">标记操作日志</div>
        <div class="log-tag-meta" id="logTagMeta"></div>
      </div>
      <div class="log-tag-body">
        <input class="log-tag-input" id="logTagInput" placeholder="输入标签描述，例如：误删后已回滚" />
        <div class="log-tag-colors" id="logTagColors" aria-label="选择标签颜色"></div>
        <div class="log-tag-help">留空保存会清除这条日志的标记。</div>
      </div>
      <div class="log-tag-actions">
        <button class="secondary" id="cancelLogTagBtn">取消</button>
        <button id="saveLogTagBtn">保存</button>
      </div>
    </div>
  </div>

	  <div class="discard-refresh-overlay" id="discardRefreshOverlay" role="dialog" aria-modal="true" aria-labelledby="discardRefreshTitle">
	    <div class="discard-refresh-dialog">
	      <div class="discard-refresh-head">
	        <div class="discard-refresh-title" id="discardRefreshTitle">确认刷新数据</div>
	      </div>
      <div class="discard-refresh-body">刷新数据会丢失暂存的修改数据，是否确认？</div>
      <div class="discard-refresh-actions">
        <button class="secondary" id="cancelDiscardRefreshBtn">取消</button>
        <button id="confirmDiscardRefreshBtn">确认</button>
      </div>
	    </div>
	  </div>

	  <div class="quick-refresh-overlay" id="quickRefreshOverlay" role="dialog" aria-modal="true" aria-labelledby="quickRefreshTitle">
	    <div class="quick-refresh-dialog">
	      <div class="quick-refresh-head">
	        <div class="quick-refresh-title" id="quickRefreshTitle">确认刷新数据</div>
	      </div>
	      <div class="quick-refresh-body">检测到快速条件中有内容，是否按照快速条件的内容进行刷新数据？</div>
	      <div class="quick-refresh-actions">
	        <button class="secondary" id="refreshWithoutQuickBtn">否</button>
	        <button id="refreshWithQuickBtn">是</button>
	      </div>
	    </div>
	  </div>

	  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let webviewPersistedState = typeof vscode.getState === "function" ? (vscode.getState() || {}) : {};
	    const state = { database: "", connectionId: "", connectionName: "", connectionType: "mysql", queryConsole: false, connections: [], tables: [], selectedTable: "", currentTable: null, schemaEditor: null, defaultLimit: 30, tableDisplay: { showColumnComments: true, hiddenColumnCommentNames: ["id", "created_at", "updated_at", "deleted_at"], dataGridFontSize: 12, sqlConfirmFontSize: 15 }, schemaCapabilities: { supportsNotEmptyStringCheck: false }, lastSql: "", currentResult: null, sortColumn: "", sortDirection: "asc", fieldColumns: [], selectedColumns: [], fieldSelectionInitialized: false, lastQueryMode: "preview", primaryKeys: [], columnTypes: {}, columnComments: {}, columnMeta: {}, pendingEdits: {}, quickInsert: { active: false, values: {} }, rowSelection: { selected: [], dragging: false, anchor: null, deleting: false }, importSource: { databases: [], tables: [], columns: [], mappings: [] }, redisDetail: { key: "", keyType: "", page: 1, pageSize: 30, totalRows: 0, totalPages: 1, columns: [], rows: [], search: "", fuzzySearch: false, sortDirection: "asc", memoryUsage: null, contextRowIndex: -1 }, operationLogs: [], selectedLogId: "", rollbackingLogId: "", rollbackError: null, logContextLogId: "", activeLogTagColor: "", logTagDraft: { logId: "", color: "blue" }, aiTimeline: [], aiActiveTimelineId: "", aiContinueParentId: "", aiContinueSourceId: "" };
    const $ = (selector) => document.querySelector(selector);
	    const sqlInput = $("#sqlInput");
	    const sqlHighlight = $("#sqlHighlight");
    const aiPromptInput = $("#aiPromptInput");
    const aiTimeline = $("#aiTimeline");
    const sqlTagValidation = $("#sqlTagValidation");
	    const whereInput = $("#whereInput");
	    const whereHighlight = $("#whereHighlight");
    const limitInput = $("#limitInput");
    const autoRefreshInput = $("#autoRefreshInput");
    const status = $("#status");
    const statusText = $("#statusText");
    const result = $("#result");
    const pager = $("#pager");
    let syncingTableHorizontalScroll = false;
    let resultHorizontalResizeObserver = null;
	    const exportOverlay = $("#exportOverlay");
	    const exportDialog = $("#exportDialog");
	    const exportRowLimitInput = $("#exportRowLimitInput");
	    const exportFormatSelect = $("#exportFormatSelect");
	    const exportFieldList = $("#exportFieldList");
	    const importOverlay = $("#importOverlay");
	    const importSourceConnection = $("#importSourceConnection");
	    const importSourceDatabase = $("#importSourceDatabase");
	    const importSourceTable = $("#importSourceTable");
	    const importRowLimitInput = $("#importRowLimitInput");
	    const importBatchSizeInput = $("#importBatchSizeInput");
	    const importFieldMap = $("#importFieldMap");
    const rowContextMenu = $("#rowContextMenu");
    const codeSuggest = $("#codeSuggest");
    const fieldPicker = $("#fieldPicker");
    const fieldOptions = $("#fieldOptions");
    const editOverlay = $("#editOverlay");
    const redisDetailOverlay = $("#redisDetailOverlay");
    const redisDetailBody = $("#redisDetailBody");
    const redisDetailPager = $("#redisDetailPager");
    const redisDetailSearchInput = $("#redisDetailSearchInput");
    const redisDetailFuzzySearch = $("#redisDetailFuzzySearch");
    const redisDetailContextMenu = $("#redisDetailContextMenu");
    const logOverlay = $("#logOverlay");
    const logList = $("#logList");
	    const logDetail = $("#logDetail");
	    const logContextMenu = $("#logContextMenu");
	    const logTagOverlay = $("#logTagOverlay");
	    const discardRefreshOverlay = $("#discardRefreshOverlay");
	    const quickRefreshOverlay = $("#quickRefreshOverlay");
    const logTagInput = $("#logTagInput");
    const logTagColors = $("#logTagColors");
    const logTagFilterColors = $("#logTagFilterColors");
    const schemaOverlay = $("#schemaOverlay");
    const schemaTree = $("#schemaTree");
    const schemaDetail = $("#schemaDetail");
    const aiCreateTableOverlay = $("#aiCreateTableOverlay");
    const aiCreateTablePrompt = $("#aiCreateTablePrompt");
    const aiCreateTableLoading = $("#aiCreateTableLoading");
    const aiCreateTableLoadingText = $("#aiCreateTableLoadingText");
    const cancelAiCreateTableBtn = $("#cancelAiCreateTableBtn");
    const confirmAiCreateTableBtn = $("#confirmAiCreateTableBtn");
    const schemaConfirmOverlay = $("#schemaConfirmOverlay");
    const schemaConfirmTitle = $("#schemaConfirmTitle");
    const schemaConfirmSql = $("#schemaConfirmSql");
    const editShortcuts = $("#editShortcuts");
    const editShortcutLabel = $("#editShortcutLabel");
    const jsonEditorWrap = $("#jsonEditorWrap");
    const jsonEditorHighlight = $("#jsonEditorHighlight");
    const cellEditor = $("#cellEditor");
    const enumEditor = $("#enumEditor");
    const enumOptions = $("#enumOptions");
    const enumCurrentValue = $("#enumCurrentValue");
    const editError = $("#editError");
    let activeEdit = null;
	    let activeContextRowIndex = null;
	    let pendingSchemaConfirmDraft = null;
	    let pendingUpdateConfirmPayload = null;
	    let pendingSqlConfirmAction = null;
	    let pendingSqlConfirmCancelAction = null;
    let aiCreateTableLoadingTimer = null;
    let schemaErrorTimer = null;
    let statusLoadingTimer = null;
	    let autoRefreshTimer = null;
	    let autoRefreshWaiting = false;
	    let pendingDiscardRefreshOptions = null;
	    let preserveSqlInputOnNextResult = false;
    let activeCompletion = null;
    let pendingAiTimelineId = "";
    let completionUsage = normalizeCompletionUsage(webviewPersistedState.completionUsage);
    const autocompleteBound = new WeakSet();
    const composingInputs = new WeakSet();
    const mysqlKeywords = [
      "SELECT", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IS NULL", "IS NOT NULL", "IN", "LIKE", "BETWEEN", "EXISTS",
      "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "ON", "AS", "GROUP BY", "HAVING",
      "ORDER BY", "ASC", "DESC", "LIMIT", "OFFSET", "UNION", "UNION ALL", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
      "DELETE", "CREATE", "ALTER", "DROP", "TABLE", "INDEX", "VIEW", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES",
      "CONSTRAINT", "CHECK", "DEFAULT", "AUTO_INCREMENT", "COMMENT", "ENGINE", "CHARSET", "COLLATE", "TRUE", "FALSE",
      "CASE", "WHEN", "THEN", "ELSE", "END", "IF", "IFNULL", "COALESCE", "CAST", "CONVERT", "COUNT", "SUM", "AVG",
      "MIN", "MAX", "JSON_TYPE", "JSON_EXTRACT", "JSON_UNQUOTE", "JSON_SET", "JSON_OBJECT", "JSON_ARRAY", "CURRENT_TIMESTAMP",
      "CURRENT_DATE", "CURRENT_TIME", "NOW", "DATE_FORMAT", "DATE_ADD", "DATE_SUB", "TRIM"
    ];
    const mysqlDataTypes = [
      "bigint unsigned", "int unsigned", "tinyint", "boolean", "varchar(255)", "varchar(128)", "char(36)", "text",
      "longtext", "json", "datetime", "timestamp", "date", "time", "decimal(10,2)", "double", "float"
    ];
    const mysqlDefaultValues = ["NULL", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME", "0", "1", "''"];
    const postgresKeywords = [
      "SELECT", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IS NULL", "IS NOT NULL", "IN", "LIKE", "ILIKE", "BETWEEN", "EXISTS",
      "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "ON", "AS", "GROUP BY", "HAVING",
      "ORDER BY", "ASC", "DESC", "LIMIT", "OFFSET", "UNION", "UNION ALL", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
      "DELETE", "CREATE", "ALTER", "DROP", "TABLE", "INDEX", "VIEW", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES",
      "CONSTRAINT", "CHECK", "DEFAULT", "SERIAL", "BIGSERIAL", "TRUE", "FALSE", "RETURNING",
      "CASE", "WHEN", "THEN", "ELSE", "END", "COALESCE", "COUNT", "SUM", "AVG", "MIN", "MAX", "NOW", "CURRENT_TIMESTAMP", "CURRENT_DATE", "TRIM"
    ];
    const redisCommands = [
      "GET", "GETRANGE", "STRLEN", "SET", "UNLINK", "EXISTS", "EXPIRE", "TTL", "TYPE", "SCAN", "INFO", "DBSIZE", "SELECT", "PING",
      "HGET", "HSCAN", "HSET", "HMGET", "HDEL", "HLEN", "LRANGE", "LPUSH", "RPUSH", "LLEN", "LPOP", "RPOP",
      "SSCAN", "SADD", "SREM", "SCARD", "ZRANGE", "ZSCAN", "ZADD", "ZREM", "ZCARD", "XRANGE", "XREAD", "XLEN", "MEMORY USAGE"
    ];
    const elasticKeywords = [
      "SELECT", "FROM", "WHERE", "ORDER BY", "LIMIT", "DESC", "ASC", "AND", "OR", "NOT", "LIKE", "RLIKE", "MATCH", "QUERY",
      "GET", "POST", "PUT", "DELETE"
    ];
    const logTagColorOptions = [
      { key: "red", label: "红色" },
      { key: "orange", label: "橙色" },
      { key: "yellow", label: "黄色" },
      { key: "green", label: "绿色" },
      { key: "blue", label: "蓝色" },
      { key: "purple", label: "紫色" },
    ];

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "init") {
	        state.database = message.database;
	        state.connectionId = message.connectionId || state.connectionId;
	        state.connectionName = message.connectionName;
	        state.connectionType = message.connectionType || "mysql";
	        state.queryConsole = message.queryConsole === true;
	        state.connections = message.connections || [];
	        state.tables = message.tables || [];
        state.selectedTable = message.selectedTable || state.selectedTable;
        state.defaultLimit = message.defaultLimit || 30;
        state.tableDisplay = normalizeTableDisplayConfig(message.tableDisplay);
        applyTableDisplayConfig();
        state.schemaCapabilities = normalizeSchemaCapabilities(message.schemaCapabilities);
        completionUsage = normalizeCompletionUsage(message.completionUsage || webviewPersistedState.completionUsage);
        limitInput.value = String(state.defaultLimit);
        $("#crumb").textContent = state.connectionName + " / " + state.database;
	        applyConnectionMode();
	        updateAllSqlHighlights();
	        renderAiTimeline();
        if (state.queryConsole) {
          renderQueryConsoleIntro();
        } else if (state.connectionType === "redis" && !state.selectedTable) {
          renderRedisDatabaseOverview();
        } else if (state.selectedTable) {
          renderTableInfo({ name: state.selectedTable, columns: [] }, state.defaultLimit);
        } else {
          renderEmptyTable();
        }
        return;
      }
      if (message.type === "tableSelected") {
        state.connectionType = message.connectionType || state.connectionType;
        state.tableDisplay = normalizeTableDisplayConfig(message.tableDisplay);
        applyTableDisplayConfig();
        state.schemaCapabilities = normalizeSchemaCapabilities(message.schemaCapabilities);
	        applyConnectionMode();
	        renderTableInfo(message.table, message.defaultLimit);
	        updateAllSqlHighlights();
	        return;
      }
      if (message.type === "tableDisplayConfig") {
        state.tableDisplay = normalizeTableDisplayConfig(message.tableDisplay);
        applyTableDisplayConfig();
        if (state.currentResult) {
          renderResult(state.currentResult);
        }
        return;
      }
      if (message.type === "loading") {
        setStatus(message.message, false);
        return;
      }
      if (message.type === "result") {
        autoRefreshWaiting = false;
        state.lastSql = message.sql || state.lastSql;
        if (preserveSqlInputOnNextResult) {
          preserveSqlInputOnNextResult = false;
	        } else if (state.lastQueryMode === "sql") {
	          sqlInput.value = state.lastSql;
	          updateSqlInputHighlight(sqlInput);
	        }
        renderResult(message.result);
        return;
      }
      if (message.type === "editsApplied") {
        clearPendingEdits();
        if (state.connectionType === "redis") {
          refreshData();
        }
        return;
      }
      if (message.type === "rowDeleteCanceled") {
        state.rowSelection.deleting = false;
        renderRowSelection();
        return;
      }
	      if (message.type === "redisKeyDetail") {
        state.redisDetail = {
          key: message.key || state.redisDetail.key,
          keyType: message.keyType || state.redisDetail.keyType,
          page: message.page || 1,
          pageSize: message.pageSize || state.redisDetail.pageSize || state.defaultLimit,
          totalRows: message.totalRows || 0,
          totalPages: message.totalPages || 1,
          columns: message.columns || [],
          rows: message.rows || [],
          search: message.search || "",
          fuzzySearch: message.fuzzySearch === true,
          sortDirection: message.sortDirection || "asc",
          memoryUsage: typeof message.memoryUsage === "number" ? message.memoryUsage : null,
          contextRowIndex: -1,
        };
        renderRedisKeyDetail();
	        return;
	      }
	      if (message.type === "importSourceDatabases") {
	        state.importSource.databases = message.databases || [];
	        fillImportSelect(importSourceDatabase, state.importSource.databases, (item) => item, (item) => item);
	        if (state.importSource.databases.includes(state.database)) importSourceDatabase.value = state.database;
	        loadImportSourceTables();
	        return;
	      }
	      if (message.type === "importSourceTables") {
	        state.importSource.tables = message.tables || [];
	        fillImportSelect(importSourceTable, state.importSource.tables, (item) => item.name, (item) => item.comment ? item.name + " · " + item.comment : item.name);
	        if (state.importSource.tables.some((item) => item.name === state.selectedTable)) importSourceTable.value = state.selectedTable;
	        loadImportSourceSchema();
	        return;
	      }
	      if (message.type === "importSourceSchema") {
	        state.importSource.columns = message.columns || [];
	        autoBuildImportMappings();
	        renderImportMappings();
	        updateImportSummary();
	        return;
	      }
	      if (message.type === "importCompleted") {
	        closeImportDialog();
	        setStatus(message.message || ("导入完成：" + (message.insertedRows || 0) + " 行。"), false);
	        return;
	      }
	      if (message.type === "operationLogs") {
        state.operationLogs = message.logs || [];
        state.selectedLogId = state.selectedLogId && state.operationLogs.some((log) => log.id === state.selectedLogId)
          ? state.selectedLogId
          : state.operationLogs[0]?.id || "";
        state.rollbackingLogId = "";
        renderOperationLogs();
        return;
      }
      if (message.type === "schemaDraftApplied") {
        state.schemaEditor = null;
        pendingSchemaConfirmDraft = null;
        pendingUpdateConfirmPayload = null;
        closeSchemaConfirmDialog();
        closeSchemaEditor();
        setSchemaSubmitError("");
        setStatus("表结构修改已提交，已刷新数据。", false);
        return;
      }
      if (message.type === "schemaDraftPreview") {
        openSchemaConfirmDialog(message.title || "确认执行 SQL", message.sql || "");
        setStatus("请确认即将执行的表结构 SQL。", false);
        return;
      }
	      if (message.type === "updateCellsPreview") {
	        openUpdateCellsConfirmDialog(message);
	        setStatus("请确认即将执行的 UPDATE SQL。", false);
	        return;
	      }
	      if (message.type === "sqlConfirmPreview") {
	        openSqlActionConfirmDialog(message);
	        setStatus(message.status || "请确认即将执行的 SQL。", false);
	        return;
	      }
      if (message.type === "schemaDraftError") {
        setAiCreateTableLoading(false);
        setSchemaSubmitError(message.message || "表结构修改提交失败。");
        restoreResultStatus();
        return;
      }
      if (message.type === "openSchemaEditor") {
        if (message.mode === "createTable") {
          openCreateTableSchemaEditor();
        } else {
          openSchemaEditor();
        }
        return;
      }
      if (message.type === "generatedSql") {
        state.lastSql = message.sql;
        applyGeneratedSql(message.sql);
        updateAiTableTagValidation(true);
        openDrawer();
        setStatus("AI 已生成内容，已追加到时间线并应用到编辑器；如果不满意，可以在“继续告诉 AI”里继续描述。", false);
        return;
      }
      if (message.type === "generatedCreateTableSql") {
        setAiCreateTableLoading(false);
        applyGeneratedCreateTableSql(message.sql || "");
        return;
      }
      if (message.type === "error") {
        autoRefreshWaiting = false;
        preserveSqlInputOnNextResult = false;
        if (message.area === "ai") {
          markPendingAiTimelineFailed(message.message || "AI 请求失败");
        }
        if (logOverlay.classList.contains("open")) {
          if (state.rollbackingLogId) {
            state.rollbackError = { logId: state.rollbackingLogId, message: message.message };
            state.selectedLogId = state.rollbackingLogId;
            state.rollbackingLogId = "";
          }
          renderOperationLogs();
        }
        setStatus(message.message, true);
      }
    });

    // 尽早通知扩展侧初始化，避免后续非关键交互绑定异常导致表页一直停留在静态占位态。
    vscode.postMessage({ type: "ready" });

	    $("#refreshBtn").addEventListener("click", () => refreshData({ confirmQuickWhere: true }));
	    $("#cancelDiscardRefreshBtn").addEventListener("click", () => closeDiscardRefreshDialog());
	    $("#confirmDiscardRefreshBtn").addEventListener("click", () => confirmDiscardRefresh());
	    $("#refreshWithoutQuickBtn").addEventListener("click", () => confirmQuickRefresh(false));
	    $("#refreshWithQuickBtn").addEventListener("click", () => confirmQuickRefresh(true));
	    discardRefreshOverlay.addEventListener("click", (event) => {
	      if (event.target === discardRefreshOverlay) closeDiscardRefreshDialog();
	    });
	    quickRefreshOverlay.addEventListener("click", (event) => {
	      if (event.target === quickRefreshOverlay) closeQuickRefreshDialog();
	    });
    autoRefreshInput.addEventListener("input", () => {
      autoRefreshInput.value = sanitizeAutoRefreshValue(autoRefreshInput.value);
      updateAutoRefreshTimer();
    });
    autoRefreshInput.addEventListener("blur", () => {
      if (!autoRefreshInput.value) autoRefreshInput.value = "0";
      updateAutoRefreshTimer();
    });
    autoRefreshInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        if (!autoRefreshInput.value) autoRefreshInput.value = "0";
        updateAutoRefreshTimer();
      }
    });
    $("#copyStructureBtn").addEventListener("click", () => copyCurrentTableStructure());
    $("#editStructureBtn").addEventListener("click", () => openSchemaEditor());
    $("#operationLogBtn").addEventListener("click", () => openOperationLogs());
    $("#closeLogBtn").addEventListener("click", () => closeOperationLogs());
    logOverlay.addEventListener("click", (event) => {
      if (event.target === logOverlay) closeOperationLogs();
    });
    $("#markLogBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      openLogTagDialog(state.logContextLogId || state.selectedLogId);
    });
    $("#cancelLogTagBtn").addEventListener("click", () => closeLogTagDialog());
    $("#saveLogTagBtn").addEventListener("click", () => saveOperationLogTag());
    logContextMenu.addEventListener("click", (event) => event.stopPropagation());
    logTagOverlay.addEventListener("click", (event) => {
      if (event.target === logTagOverlay) closeLogTagDialog();
    });
    logTagInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        saveOperationLogTag();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeLogTagDialog();
      }
    });
    $("#closeSchemaEditorBtn").addEventListener("click", () => closeSchemaEditor());
    $("#aiCreateTableBtn").addEventListener("click", () => openAiCreateTableDialog());
    cancelAiCreateTableBtn.addEventListener("click", () => closeAiCreateTableDialog());
    confirmAiCreateTableBtn.addEventListener("click", () => submitAiCreateTablePrompt());
    $("#cancelSchemaConfirmBtn").addEventListener("click", () => closeSchemaConfirmDialog());
    $("#confirmSchemaApplyBtn").addEventListener("click", () => confirmSchemaDraftApply());
    aiCreateTableOverlay.addEventListener("click", (event) => {
      if (event.target === aiCreateTableOverlay) closeAiCreateTableDialog();
    });
    schemaConfirmOverlay.addEventListener("click", (event) => {
      if (event.target === schemaConfirmOverlay) closeSchemaConfirmDialog();
    });
    aiCreateTablePrompt.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitAiCreateTablePrompt();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeAiCreateTableDialog();
      }
    });
    $("#resetSchemaDraftBtn").addEventListener("click", () => {
      if (state.schemaEditor?.mode === "createTable") {
        state.schemaEditor = createNewTableSchemaEditorState();
      } else {
        if (!state.currentTable) return;
        state.schemaEditor = createSchemaEditorState(state.currentTable);
      }
      setSchemaSubmitError("");
      renderSchemaEditor();
    });
    $("#copySchemaChangeSqlBtn").addEventListener("click", () => copySchemaChangeSql());
    $("#applySchemaDraftBtn").addEventListener("click", () => applySchemaDraft());
    schemaOverlay.addEventListener("click", (event) => {
      if (event.target === schemaOverlay) closeSchemaEditor();
    });
    $("#fieldPickerBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      fieldPicker.classList.toggle("open");
    });
    $("#fieldMenu").addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", () => fieldPicker.classList.remove("open"));
    $("#selectAllFieldsBtn").addEventListener("click", () => {
      state.fieldSelectionInitialized = true;
      state.selectedColumns = [...state.fieldColumns];
      renderFieldOptions();
      rerenderCurrentResult();
    });
    $("#clearFieldsBtn").addEventListener("click", () => {
      state.fieldSelectionInitialized = true;
      state.selectedColumns = [];
      renderFieldOptions();
      rerenderCurrentResult();
    });
	    $("#exportPreviewBtn").addEventListener("click", () => openExportDialog());
	    $("#importPreviewBtn").addEventListener("click", () => openImportDialog());
	    $("#cancelExportBtn").addEventListener("click", () => closeExportDialog());
	    $("#confirmExportBtn").addEventListener("click", () => submitExportDialog());
	    exportOverlay.addEventListener("click", (event) => {
	      if (event.target === exportOverlay) closeExportDialog();
	    });
	    $("#cancelImportBtn").addEventListener("click", () => closeImportDialog());
	    $("#confirmImportBtn").addEventListener("click", () => submitImportDialog());
	    $("#autoImportMapBtn").addEventListener("click", () => { autoBuildImportMappings(); renderImportMappings(); updateImportSummary(); });
	    $("#clearImportMapBtn").addEventListener("click", () => { state.importSource.mappings = []; renderImportMappings(); updateImportSummary(); });
	    $("#addImportMapBtn").addEventListener("click", () => { state.importSource.mappings.push({ source: "", target: "" }); renderImportMappings(); updateImportSummary(); });
	    importSourceConnection.addEventListener("change", () => loadImportSourceDatabases());
	    importSourceDatabase.addEventListener("change", () => loadImportSourceTables());
	    importSourceTable.addEventListener("change", () => loadImportSourceSchema());
	    importOverlay.addEventListener("click", (event) => {
	      if (event.target === importOverlay) closeImportDialog();
	    });
	    exportFormatSelect.addEventListener("change", () => syncExportFormatMode());
    $("#selectAllExportFieldsBtn").addEventListener("click", () => setExportFieldsChecked(true));
    $("#clearExportFieldsBtn").addEventListener("click", () => setExportFieldsChecked(false));
    $("#cancelCellEditBtn").addEventListener("click", () => closeCellEditDialog());
    $("#saveCellEditBtn").addEventListener("click", () => commitDialogEdit(false));
    $("#closeRedisDetailBtn").addEventListener("click", () => closeRedisKeyDetail());
    redisDetailOverlay.addEventListener("click", (event) => {
      if (event.target === redisDetailOverlay) closeRedisKeyDetail();
    });
    $("#redisDetailSearchBtn").addEventListener("click", () => searchRedisKeyDetail());
    $("#redisDetailClearSearchBtn").addEventListener("click", () => {
      redisDetailSearchInput.value = "";
      searchRedisKeyDetail();
    });
    redisDetailSearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        searchRedisKeyDetail();
      }
    });
    redisDetailFuzzySearch.addEventListener("change", () => {
      updateRedisDetailSearchPlaceholder();
      if (redisDetailSearchInput.value.trim()) {
        searchRedisKeyDetail();
      }
    });
    $("#deleteRedisDetailItemBtn").addEventListener("click", () => deleteRedisDetailItem());
    redisDetailContextMenu.addEventListener("click", (event) => event.stopPropagation());
    $("#fillNowBtn").addEventListener("click", () => {
      if (!activeEdit?.temporalKind) return;
      activeEdit.nullSelected = false;
      cellEditor.value = formatNowForTemporalKind(activeEdit.temporalKind);
      clearEditError();
      updateJsonHighlight();
      cellEditor.focus();
      moveCursorToEnd(cellEditor);
    });
    $("#formatJsonBtn").addEventListener("click", () => {
      if (!activeEdit?.jsonLike) return;
      const formatted = tryFormatJsonText(cellEditor.value);
      if (formatted === undefined) return;
      cellEditor.value = formatted;
      activeEdit.nullSelected = false;
      clearEditError();
      updateJsonHighlight();
      cellEditor.focus();
      moveCursorToEnd(cellEditor);
    });
    $("#setNullBtn").addEventListener("click", () => {
      if (!activeEdit?.nullable) return;
      activeEdit.nullSelected = true;
      activeEdit.enumSelected = "";
      cellEditor.value = "NULL";
      clearEditError();
      updateJsonHighlight();
      editShortcutLabel.textContent = "已选择 NULL，暂存后会把该字段写入数据库 NULL。";
      enumOptions.querySelectorAll(".enum-option.selected").forEach((button) => button.classList.remove("selected"));
      commitDialogEdit(false);
    });
    editOverlay.addEventListener("click", (event) => {
      if (event.target === editOverlay) closeCellEditDialog();
    });
    cellEditor.addEventListener("keydown", (event) => {
      if (activeEdit?.jsonLike && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "{" || event.key === "[") {
          event.preventDefault();
          insertJsonBlock(event.key, event.key === "{" ? "}" : "]");
          return;
        }
        if (event.key === '"') {
          event.preventDefault();
          insertJsonPair('"', '"');
          return;
        }
      }
      if (event.key === "Tab") {
        event.preventDefault();
        insertEditorIndent(event.shiftKey);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        commitDialogEdit(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCellEditDialog();
      }
    });
    cellEditor.addEventListener("input", () => {
      if (activeEdit) activeEdit.nullSelected = false;
      if (activeEdit?.jsonLike) clearEditError();
      updateJsonHighlight();
    });
    cellEditor.addEventListener("scroll", () => syncJsonHighlightScroll());
    $("#toggleSqlBtn").addEventListener("click", () => toggleDrawer());
    attachSqlAutocomplete(sqlInput, "sql");
    attachSqlAutocomplete(aiPromptInput, "ai-prompt");
    aiPromptInput.addEventListener("input", () => updateAiTableTagValidation(false));
    aiPromptInput.addEventListener("click", () => updateAiTableTagValidation(false));
    aiPromptInput.addEventListener("keyup", () => updateAiTableTagValidation(false));
    aiPromptInput.addEventListener("blur", () => updateAiTableTagValidation(true));
    attachSqlAutocomplete(whereInput, "where");
    $("#quickAddBtn").addEventListener("click", () => toggleQuickInsert());
    $("#deleteRowBtn").addEventListener("click", () => deleteContextRow());
    document.addEventListener("click", () => {
      hideRowContextMenu();
      hideLogContextMenu();
      hideRedisDetailContextMenu();
      hideCodeSuggest();
    });
    document.addEventListener("mouseup", () => {
      if (state.rowSelection.dragging) {
        state.rowSelection.dragging = false;
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideRowContextMenu();
        hideLogContextMenu();
        hideRedisDetailContextMenu();
        closeLogTagDialog();
        closeDiscardRefreshDialog();
        closeRedisKeyDetail();
      }
    });
    $("#quickBtn").addEventListener("click", () => {
      if (hasPendingEdits()) submitPendingEdits(); else runQuickQuery();
    });
    whereInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        if (hasPendingEdits()) submitPendingEdits(); else runQuickQuery();
      }
    });
    limitInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        if (hasPendingEdits()) submitPendingEdits(); else runQuickQuery();
      }
    });
    $("#runSqlBtn").addEventListener("click", () => {
      state.lastQueryMode = "sql";
      state.sortColumn = "";
      state.sortDirection = "asc";
      const executableSql = getExecutableSqlFromEditor();
      if (!executableSql) {
        setStatus(state.connectionType === "redis" ? "请先输入需要执行的 Redis 命令。" : state.connectionType === "elasticsearch" ? "请先输入需要执行的 Elasticsearch 查询。" : "请先输入或生成需要执行的 SQL。", true);
        return;
      }
      preserveSqlInputOnNextResult = true;
      vscode.postMessage({ type: "runSql", sql: executableSql, limit: Number(limitInput.value || state.defaultLimit), page: 1 });
    });
    $("#aiFromSqlBtn").addEventListener("click", () => sendAiTimelinePrompt());
    aiPromptInput.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        sendAiTimelinePrompt();
      }
    });
    $("#clearAiTimelineBtn").addEventListener("click", () => {
      state.aiTimeline = [];
      state.aiActiveTimelineId = "";
      state.aiContinueParentId = "";
      state.aiContinueSourceId = "";
      pendingAiTimelineId = "";
      renderAiTimeline();
    });
	    $("#formatBtn").addEventListener("click", () => {
	      sqlInput.value = formatEditorText(sqlInput.value);
	      updateSqlInputHighlight(sqlInput);
	      sqlInput.focus();
      moveCursorToEnd(sqlInput);
    });

    function formatEditorText(value) {
      return state.connectionType === "elasticsearch" ? formatElasticRequestText(value) : formatSqlText(value);
    }

    function formatSqlText(sql) {
      const text = String(sql || "").trim();
      if (!text) return "";
      const protectedSql = protectSqlLiterals(text);
      let formatted = protectedSql.text
        .replace(/\\s+/g, " ")
        .replace(/\\s*,\\s*/g, ", ")
        .trim();

      formatted = newlineSqlKeyword(formatted, /\\b(UNION\\s+ALL|UNION)\\b/gi, "");
      formatted = newlineSqlKeyword(formatted, /\\b(SELECT|FROM|WHERE|GROUP\\s+BY|ORDER\\s+BY|HAVING|LIMIT|OFFSET|VALUES|SET|RETURNING)\\b/gi, "");
      formatted = newlineSqlKeyword(formatted, /\\b((?:LEFT|RIGHT|INNER|FULL|CROSS)(?:\\s+OUTER)?\\s+JOIN|JOIN)\\b/gi, "");
      formatted = newlineSqlKeyword(formatted, /\\b(ON)\\b/gi, "  ");
      formatted = newlineSqlKeyword(formatted, /\\b(AND|OR)\\b/gi, "  ");
      formatted = formatted.replace(/,\\s*/g, ",\\n  ");
      formatted = formatted.replace(/\\n{3,}/g, "\\n\\n").trim();
      return restoreSqlLiterals(formatted, protectedSql.literals);
    }

	    function formatConfirmSqlPreview(sql) {
	      const formatted = formatSqlText(sql);
	      return expandJsonSqlLiterals(formatted);
	    }

		    function renderHighlightedConfirmSql(sql, options = {}) {
		      const tokens = tokenizeConfirmSql(sql);
		      const tableStyles = collectConfirmSqlTableStyles(tokens, options);
	      let html = "";
	      for (let index = 0; index < tokens.length; index += 1) {
	        const token = tokens[index];
	        if (token.type === "space" || token.type === "symbol") {
	          html += escapeHtml(token.value);
	          continue;
	        }
	        const normalized = normalizeSqlIdentifier(token.value);
	        const upper = normalized.toUpperCase();
	        if (token.type === "comment") {
	          html += wrapConfirmSqlToken(token.value, "sql-token-comment");
	        } else if (token.type === "string") {
	          html += wrapConfirmSqlToken(token.value, "sql-token-string");
	        } else if (token.type === "number") {
	          html += wrapConfirmSqlToken(token.value, "sql-token-number");
	        } else if (isConfirmSqlKeyword(upper)) {
	          html += wrapConfirmSqlToken(token.value, "sql-token-keyword");
		        } else if (tableStyles.has(normalized.toLowerCase())) {
		          html += wrapConfirmSqlToken(token.value, "sql-token-table " + tableStyles.get(normalized.toLowerCase()));
		        } else if (token.type === "identifier" || token.type === "word") {
		          const fieldStyle = getConfirmSqlFieldOwnerStyle(tokens, index, tableStyles) || getImplicitCurrentFieldStyle(normalized, options, tableStyles);
		          html += wrapConfirmSqlToken(token.value, fieldStyle ? "sql-token-field " + fieldStyle.replace("sql-token-table", "sql-token-field") : "sql-token-field");
	        } else {
	          html += escapeHtml(token.value);
	        }
	      }
	      return html;
	    }

	    function wrapConfirmSqlToken(value, className) {
	      return '<span class="' + className + '">' + escapeHtml(value) + '</span>';
	    }

	    function tokenizeConfirmSql(sql) {
	      const text = String(sql || "");
	      const tokens = [];
	      for (let index = 0; index < text.length; index += 1) {
	        const char = text[index];
	        if (/\\s/.test(char)) {
	          let value = char;
	          while (index + 1 < text.length && /\\s/.test(text[index + 1])) value += text[++index];
	          tokens.push({ type: "space", value });
	          continue;
	        }
	        if (char === "-" && text[index + 1] === "-") {
	          let value = char + text[++index];
	          while (index + 1 < text.length && text[index + 1] !== "\\n") value += text[++index];
	          tokens.push({ type: "comment", value });
	          continue;
	        }
	        if (char === "/" && text[index + 1] === "*") {
	          let value = char + text[++index];
	          while (index + 1 < text.length) {
	            const next = text[++index];
	            value += next;
	            if (next === "/" && text[index - 1] === "*") break;
	          }
	          tokens.push({ type: "comment", value });
	          continue;
	        }
	        if (char === "'") {
	          let value = char;
	          while (index + 1 < text.length) {
	            const next = text[++index];
	            value += next;
	            if (next === "\\\\" && index + 1 < text.length) {
	              value += text[++index];
	              continue;
	            }
	            if (next === "'" && text[index + 1] === "'") {
	              value += text[++index];
	              continue;
	            }
	            if (next === "'") break;
	          }
	          tokens.push({ type: "string", value });
	          continue;
	        }
	        if (char === '"' || char === String.fromCharCode(96)) {
	          const quote = char;
	          let value = char;
	          while (index + 1 < text.length) {
	            const next = text[++index];
	            value += next;
	            if (next === quote) break;
	          }
	          tokens.push({ type: "identifier", value });
	          continue;
	        }
	        if (/[0-9]/.test(char)) {
	          let value = char;
	          while (index + 1 < text.length && /[0-9.]/.test(text[index + 1])) value += text[++index];
	          tokens.push({ type: "number", value });
	          continue;
	        }
	        if (isSqlIdentifierStart(char)) {
	          let value = char;
	          while (index + 1 < text.length && isSqlIdentifierPart(text[index + 1])) value += text[++index];
	          tokens.push({ type: "word", value });
	          continue;
	        }
	        tokens.push({ type: "symbol", value: char });
	      }
	      return tokens;
	    }

		    function collectConfirmSqlTableStyles(tokens, options = {}) {
		      const tableStyles = new Map();
		      const names = [];
	      const significant = tokens.map((token, index) => ({ token, index })).filter((item) => item.token.type !== "space" && item.token.type !== "comment");
	      const addTable = (name) => {
	        const normalized = normalizeSqlIdentifier(name).toLowerCase();
	        if (!normalized || isConfirmSqlKeyword(normalized.toUpperCase())) return "";
	        if (tableStyles.has(normalized)) return tableStyles.get(normalized);
	        const style = "sql-token-table-" + (names.length % 8);
	        tableStyles.set(normalized, style);
		        names.push(normalized);
		        return style;
		      };
		      if (options.seedCurrentTable && state.selectedTable) {
		        addTable(state.selectedTable);
		      }
	      let expectTable = false;
	      let inFromList = false;
	      for (let pos = 0; pos < significant.length; pos += 1) {
	        const current = significant[pos].token;
	        const normalized = normalizeSqlIdentifier(current.value);
	        const upper = normalized.toUpperCase();
	        if (inFromList && isSqlClauseBoundary(upper)) {
	          inFromList = false;
	        }
	        if (["FROM", "JOIN", "UPDATE", "INTO"].includes(upper) || (upper === "TABLE" && shouldSqlTableKeywordExpectName(significant, pos))) {
	          expectTable = true;
	          inFromList = upper === "FROM";
	          continue;
	        }
	        if (expectTable && isSqlNameToken(current)) {
	          const qualified = readQualifiedSqlName(significant, pos);
	          const style = addTable(qualified.name);
	          addConfirmSqlAliasStyle(significant, qualified.endPos + 1, style, tableStyles);
	          pos = qualified.endPos;
	          expectTable = false;
	          continue;
	        }
	        if (inFromList && current.value === ",") {
	          expectTable = true;
	        }
	      }
	      return tableStyles;
	    }

	    function addConfirmSqlAliasStyle(significant, pos, style, tableStyles) {
	      if (!style || pos >= significant.length) return;
	      let aliasPos = pos;
	      const maybeAs = normalizeSqlIdentifier(significant[aliasPos]?.token?.value || "").toUpperCase();
	      if (maybeAs === "AS") aliasPos += 1;
	      const alias = significant[aliasPos]?.token;
	      const aliasName = normalizeSqlIdentifier(alias?.value || "");
	      const aliasUpper = aliasName.toUpperCase();
	      if (!isSqlNameToken(alias) || isConfirmSqlKeyword(aliasUpper) || isSqlClauseBoundary(aliasUpper)) return;
	      tableStyles.set(aliasName.toLowerCase(), style);
	}

		    function getConfirmSqlFieldOwnerStyle(tokens, index, tableStyles) {
		      const prevDot = findSignificantSqlToken(tokens, index, -1);
		      if (!prevDot || prevDot.value !== ".") return "";
		      const owner = findSignificantSqlToken(tokens, prevDot.index, -1);
		      if (!owner) return "";
		      return tableStyles.get(normalizeSqlIdentifier(owner.value).toLowerCase()) || "";
		    }

		    function getImplicitCurrentFieldStyle(identifier, options, tableStyles) {
		      if (!options.seedCurrentTable || !state.selectedTable) return "";
		      const table = findSchemaTable(state.selectedTable);
		      const normalized = String(identifier || "").toLowerCase();
		      if (!table || !(table.columns || []).some((column) => String(column.name).toLowerCase() === normalized)) return "";
		      return tableStyles.get(String(table.name).toLowerCase()) || tableStyles.get(String(state.selectedTable).toLowerCase()) || "";
		    }

	    function readQualifiedSqlName(significant, pos) {
	      let name = significant[pos].token.value;
	      let endPos = pos;
	      while (endPos + 2 < significant.length && significant[endPos + 1].token.value === "." && isSqlNameToken(significant[endPos + 2].token)) {
	        endPos += 2;
	        name = significant[endPos].token.value;
	      }
	      return { name, endPos };
	    }

	    function shouldSqlTableKeywordExpectName(significant, pos) {
	      const prev = significant[pos - 1]?.token;
	      const upper = normalizeSqlIdentifier(prev?.value || "").toUpperCase();
	      return ["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "DESCRIBE", "DESC"].includes(upper);
	    }

	    function findSignificantSqlToken(tokens, start, direction) {
	      for (let index = start + direction; index >= 0 && index < tokens.length; index += direction) {
	        if (tokens[index].type !== "space" && tokens[index].type !== "comment") return { ...tokens[index], index };
	      }
	      return null;
	    }

	    function isSqlClauseBoundary(upper) {
	      return ["WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "SET", "VALUES", "RETURNING", "ON", "USING"].includes(upper);
	    }

	    function isSqlNameToken(token) {
	      return token && (token.type === "word" || token.type === "identifier");
	    }

	    function normalizeSqlIdentifier(value) {
	      const text = String(value || "").trim();
	      if ((text.startsWith(String.fromCharCode(96)) && text.endsWith(String.fromCharCode(96))) || (text.startsWith('"') && text.endsWith('"'))) {
	        return text.slice(1, -1);
	      }
	      return text;
	    }

	    function isSqlIdentifierStart(char) {
	      return /[A-Za-z_$]/.test(char) || char.charCodeAt(0) > 127;
	    }

	    function isSqlIdentifierPart(char) {
	      return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 127;
	    }

	    function isConfirmSqlKeyword(upper) {
	      return [
		        "ADD", "AFTER", "ALL", "ALTER", "AND", "ANY", "ARRAY", "AS", "ASC", "BEGIN", "BETWEEN", "BIGSERIAL", "BY", "CASCADE", "CASE", "CAST", "CHANGE",
		        "CHECK", "COLLATE", "COLUMN", "COMMENT", "COMMIT", "CONFLICT", "CONSTRAINT", "CREATE", "CROSS", "CURRENT_DATE", "CURRENT_TIMESTAMP", "DATABASE",
		        "DEFAULT", "DELETE", "DESC", "DISTINCT", "DO", "DROP", "ELSE", "END", "ENGINE", "EXISTS", "EXPIRE", "FALSE", "FOREIGN", "FROM", "FULL", "GROUP",
		        "HAVING", "IF", "ILIKE", "IN", "INDEX", "INNER", "INSERT", "INTERVAL", "INTO", "IS", "JOIN", "JSONB", "KEY", "LEFT", "LIKE", "LIMIT", "MODIFY",
		        "NOT", "NOTHING", "NULL", "OFFSET", "ON", "OR", "ORDER", "OUTER", "OVER", "PARTITION", "PERSIST", "PRIMARY", "RECURSIVE", "REFERENCES", "RENAME",
		        "RETURNING", "RIGHT", "SELECT", "SERIAL", "SET", "TABLE", "THEN", "TO", "TRUE", "TRUNCATE", "UNION", "UNIQUE", "UNLINK", "UPDATE", "USING",
		        "VALUES", "WHEN", "WHERE", "WINDOW", "WITH"
	      ].includes(upper);
	    }

	    function expandJsonSqlLiterals(sql) {
      const text = String(sql || "");
      let result = "";
      for (let index = 0; index < text.length; index += 1) {
        const quote = text[index];
        if (quote !== "'") {
          result += quote;
          continue;
        }

        let literal = quote;
        index += 1;
        while (index < text.length) {
          const char = text[index];
          literal += char;
          if (char === "\\\\" && index + 1 < text.length) {
            index += 1;
            literal += text[index];
            continue;
          }
          if (char === "'") {
            if (text[index + 1] === "'") {
              index += 1;
              literal += text[index];
              continue;
            }
            break;
          }
          index += 1;
        }
        result += formatSqlLiteralForConfirm(literal);
      }
      return result;
    }

    function formatSqlLiteralForConfirm(literal) {
      if (literal.length < 160 || literal[0] !== "'" || literal[literal.length - 1] !== "'") {
        return literal;
      }
      const raw = literal.slice(1, -1).replace(/''/g, "'");
      const trimmed = raw.trim();
      if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
        return literal;
      }
      try {
        const formattedJson = JSON.stringify(JSON.parse(trimmed), null, 2);
        return "'\\n" + formattedJson + "\\n'";
      } catch {
        return literal;
      }
    }

    function formatElasticRequestText(value) {
      const text = String(value || "").trim();
      if (!text) return "";
      const match = text.match(/^(GET|POST|PUT|DELETE)\\s+(\\S+)\\s*([\\s\\S]*)$/i);
      if (!match) {
        return tryFormatJsonText(text) || text;
      }
      const body = match[3]?.trim();
      return match[1].toUpperCase() + " " + match[2] + (body ? "\\n" + (tryFormatJsonText(body) || body) : "");
    }

    function newlineSqlKeyword(sql, pattern, indent) {
      return sql.replace(pattern, (match) => "\\n" + indent + match.toUpperCase().replace(/\\s+/g, " "));
    }

    function protectSqlLiterals(sql) {
      const literals = [];
      let text = "";
      for (let index = 0; index < sql.length; index += 1) {
        const quote = sql[index];
        if (quote !== "'" && quote !== '"' && quote !== String.fromCharCode(96)) {
          text += quote;
          continue;
        }
        let literal = quote;
        index += 1;
        while (index < sql.length) {
          const char = sql[index];
          literal += char;
          if ((quote === "'" || quote === '"') && char === "\\\\" && index + 1 < sql.length) {
            index += 1;
            literal += sql[index];
            continue;
          }
          if (char === quote) {
            if (sql[index + 1] === quote && quote !== String.fromCharCode(96)) {
              index += 1;
              literal += sql[index];
              continue;
            }
            break;
          }
          index += 1;
        }
        const token = "__SQL_LITERAL_" + literals.length + "__";
        literals.push(literal);
        text += token;
      }
      return { text, literals };
    }

    function restoreSqlLiterals(sql, literals) {
      return literals.reduce((text, literal, index) => text.split("__SQL_LITERAL_" + index + "__").join(literal), sql);
    }

    function attachSchemaAutocomplete(input) {
      const path = input.getAttribute("data-schema-path") || "";
      if (/\\.type$/.test(path)) return attachSqlAutocomplete(input, "schema-type");
      if (/\\.(defaultValue|onUpdate)$/.test(path)) return attachSqlAutocomplete(input, "schema-default");
      if (/\\.referenceTable$/.test(path)) return attachSqlAutocomplete(input, "schema-table");
      if (/\\.(referenceColumns|expression|statement)$/.test(path)) return attachSqlAutocomplete(input, "schema-sql");
      return undefined;
    }

	    function attachSqlAutocomplete(input, mode) {
	      if (!input || autocompleteBound.has(input)) return;
	      autocompleteBound.add(input);
	      input.setAttribute("autocomplete", "off");
      input.addEventListener("compositionstart", () => {
        composingInputs.add(input);
        if (activeCompletion?.input === input) hideCodeSuggest();
      });
      input.addEventListener("compositionend", () => {
        composingInputs.delete(input);
        if (activeCompletion?.input === input) hideCodeSuggest();
      });
	      input.addEventListener("input", (event) => {
	        updateSqlInputHighlight(input);
	        if (event.isComposing || composingInputs.has(input)) {
	          if (activeCompletion?.input === input) hideCodeSuggest();
	          return;
	        }
	        showCodeSuggest(input, mode, false);
	      });
	      input.addEventListener("scroll", () => syncSqlHighlightScroll(input));
	      input.addEventListener("click", (event) => {
	        event.stopPropagation();
	        updateSqlInputHighlight(input);
	        if (activeCompletion?.input === input) showCodeSuggest(input, mode, false);
	      });
      input.addEventListener("keydown", (event) => {
        if (event.isComposing || composingInputs.has(input)) {
          if (activeCompletion?.input === input) hideCodeSuggest();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === " ") {
          stopAutocompleteKey(event);
          showCodeSuggest(input, mode, true);
          return;
        }
        if (!activeCompletion || activeCompletion.input !== input) return;
        if (event.key === "ArrowDown") {
          stopAutocompleteKey(event);
          moveCodeSuggestSelection(1);
          return;
        }
        if (event.key === "ArrowUp") {
          stopAutocompleteKey(event);
          moveCodeSuggestSelection(-1);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          stopAutocompleteKey(event);
          acceptCodeSuggestion();
          return;
        }
        if (event.key === "Escape") {
          stopAutocompleteKey(event);
          hideCodeSuggest();
        }
      });
	      input.addEventListener("blur", () => window.setTimeout(() => {
	        if (activeCompletion?.input === input) hideCodeSuggest();
	      }, 160));
	      updateSqlInputHighlight(input);
	    }

	    function stopAutocompleteKey(event) {
	      event.preventDefault();
	      event.stopPropagation();
	      event.stopImmediatePropagation();
	    }

	    function getSqlHighlightElement(input) {
	      if (input === sqlInput) return sqlHighlight;
	      if (input === whereInput) return whereHighlight;
	      return null;
	    }

	    function updateSqlInputHighlight(input) {
	      const highlight = getSqlHighlightElement(input);
	      if (!highlight) return;
	      highlight.innerHTML = renderHighlightedEditorSql(input.value, input === whereInput ? "where" : "sql");
	      syncSqlHighlightScroll(input);
	    }

	    function updateAllSqlHighlights() {
	      updateSqlInputHighlight(sqlInput);
	      updateSqlInputHighlight(whereInput);
	    }

	    function syncSqlHighlightScroll(input) {
	      const highlight = getSqlHighlightElement(input);
	      if (!highlight) return;
	      highlight.scrollTop = input.scrollTop || 0;
	      highlight.scrollLeft = input.scrollLeft || 0;
	    }

	    function renderHighlightedEditorSql(value, mode) {
	      const text = String(value || "");
	      if (!text) return "";
	      if (state.connectionType === "redis" || state.connectionType === "elasticsearch") {
	        return escapeHtml(text);
	      }
	      return renderHighlightedConfirmSql(text, { seedCurrentTable: mode === "where" });
	    }

	    function showCodeSuggest(input, mode, force) {
      const completion = buildCodeCompletion(input, mode, force);
      if (!completion.items.length) {
        hideCodeSuggest();
        return;
      }
      activeCompletion = { ...completion, input, mode, selected: 0 };
      renderCodeSuggest();
      positionCodeSuggest(input);
    }

    function buildCodeCompletion(input, mode, force) {
      const cursor = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, cursor);
      const supportsAiTags = state.connectionType === "mysql" || state.connectionType === "postgres" || state.connectionType === "redis" || state.connectionType === "elasticsearch";
      const tableTag = (mode === "sql" || mode === "ai-prompt") && supportsAiTags ? findTableTagAtCursor(input.value, cursor) : null;
      if (tableTag) {
        const tagToken = getTableTagCompletionToken(input.value, tableTag.contentStart, cursor);
        if (!force && !tagToken.prefix) {
          return { items: [], replaceStart: tagToken.replaceStart, replaceEnd: cursor };
        }
        return {
          items: sortCompletionItemsByRecentUse(dedupeCompletionItems(filterCompletionItems(getTableCompletions({ quote: false }), tagToken.prefix, force))).slice(0, 80),
          replaceStart: tagToken.replaceStart,
          replaceEnd: cursor,
        };
      }
      const aiTag = (mode === "sql" || mode === "ai-prompt") && supportsAiTags ? findAiTagAtCursor(input.value, cursor) : null;
      const tokenMatch = before.split(String.fromCharCode(96)).join("").match(/([A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]*)?)$/);
      const token = tokenMatch ? tokenMatch[1] : "";
      const dotIndex = token.lastIndexOf(".");
      const owner = dotIndex >= 0 ? cleanSqlIdentifier(token.slice(0, dotIndex)) : "";
      const prefix = dotIndex >= 0 ? cleanSqlIdentifier(token.slice(dotIndex + 1)) : cleanSqlIdentifier(token);
      const replaceStart = dotIndex >= 0 ? cursor - cleanSqlIdentifier(token.slice(dotIndex + 1)).length : cursor - token.length;
      const tableContext = isSqlTableContext(before.slice(0, before.length - token.length));
      if (aiTag && !force && !prefix && dotIndex < 0) return { items: [], replaceStart, replaceEnd: cursor };
      if (!force && !prefix && dotIndex < 0 && !tableContext && !aiTag) return { items: [], replaceStart, replaceEnd: cursor };

      let items = [];
      if (mode === "ai-prompt") {
        if (tableTag) {
          items = getTableCompletions({ quote: false, kind: state.connectionType === "redis" ? "Redis Key" : state.connectionType === "elasticsearch" ? "ES Index" : "表" });
        } else if (aiTag) {
          items = state.connectionType === "redis"
            ? getTableCompletions({ quote: false, kind: "Redis Key" })
            : state.connectionType === "elasticsearch"
              ? [...getTableCompletions({ quote: false, kind: "ES Index" }), ...getFieldCompletions({ quote: false })]
              : [...getTableCompletions(), ...getFieldCompletions()];
        } else {
          items = force || prefix ? getAiPromptCompletions() : [];
        }
      } else if ((mode === "sql" || mode === "where") && state.connectionType === "redis") {
        items = aiTag ? getTableCompletions({ quote: false, kind: "Redis Key" }) : buildRedisCompletionItems(mode);
      } else if ((mode === "sql" || mode === "where") && state.connectionType === "elasticsearch") {
        items = aiTag
          ? [...getTableCompletions({ quote: false, kind: "ES Index" }), ...getCurrentColumnCompletions(input.value).map((item) => ({ ...item, kind: "ES 字段" }))]
          : buildElasticCompletionItems(input.value, mode);
      } else if (mode === "schema-type") {
        items = mysqlDataTypes.map((value) => completionItem(value, value, "类型"));
      } else if (mode === "schema-default") {
        items = [...mysqlDefaultValues, "JSON_OBJECT()", "JSON_ARRAY()", "UUID()"].map((value) => completionItem(value, value, "默认值"));
      } else if (mode === "schema-table") {
        items = getTableCompletions();
      } else if (aiTag && owner) {
        items = getColumnCompletionsForOwner(owner, input.value);
      } else if (aiTag) {
        items = [...getTableCompletions(), ...getAiTagColumnCompletions()];
      } else if (owner) {
        items = getColumnCompletionsForOwner(owner, input.value);
      } else if (tableContext) {
        items = [...getTableCompletions(), ...keywordCompletions(prefix)];
      } else {
        items = [
          ...(mode === "sql" ? getAiTagCompletions() : []),
          ...keywordCompletions(prefix),
          ...getFunctionCompletions(),
          ...getCurrentColumnCompletions(input.value),
          ...getTableCompletions(),
        ];
      }
      return {
        items: sortCompletionItemsByRecentUse(dedupeCompletionItems(filterCompletionItems(items, prefix, force))).slice(0, 80),
        replaceStart,
        replaceEnd: cursor,
      };
    }

    function buildRedisCompletionItems(mode) {
      const commandItems = redisCommands.map((command) => completionItem(command, command + " ", "Redis 命令"));
      const keyItems = getTableCompletions({ quote: false, kind: "Redis Key" });
      const helperItems = [
        completionItem("SCAN MATCH", "SCAN 0 MATCH * COUNT 100", "Redis 模板", "扫描 Key"),
        completionItem("HSCAN 当前 Key", "HSCAN " + (state.selectedTable || "key") + " 0 COUNT 100", "Redis 模板"),
        completionItem("LRANGE 当前 Key", "LRANGE " + (state.selectedTable || "key") + " 0 50", "Redis 模板"),
        completionItem("ZRANGE 当前 Key", "ZRANGE " + (state.selectedTable || "key") + " 0 50 WITHSCORES", "Redis 模板"),
      ];
      return [...(mode === "sql" ? getAiTagCompletions() : []), ...helperItems, ...commandItems, ...keyItems];
    }

    function buildElasticCompletionItems(sqlText, mode) {
      const requestItems = getElasticRequestCompletions();
      const indexItems = getTableCompletions({ quote: false, kind: "ES Index" });
      const fieldItems = getCurrentColumnCompletions(sqlText).map((item) => ({ ...item, kind: "ES 字段" }));
      const keywordItems = elasticKeywords.map((keyword) => completionItem(keyword, keyword + " ", "ES 关键字"));
      const jsonDslItems = [
        completionItem("query", '"query": ', "Query DSL"),
        completionItem("match_all", '"match_all": {}', "Query DSL"),
        completionItem("match", '"match": {}', "Query DSL"),
        completionItem("term", '"term": {}', "Query DSL"),
        completionItem("terms", '"terms": {}', "Query DSL"),
        completionItem("range", '"range": {}', "Query DSL"),
        completionItem("bool", '"bool": {}', "Query DSL"),
        completionItem("must", '"must": []', "Query DSL"),
        completionItem("filter", '"filter": []', "Query DSL"),
        completionItem("sort", '"sort": []', "Query DSL"),
      ];
      return [...(mode === "sql" ? getAiTagCompletions() : []), ...requestItems, ...keywordItems, ...indexItems, ...fieldItems, ...jsonDslItems];
    }

    function getElasticRequestCompletions() {
      const index = state.selectedTable || "index";
      return [
        completionItem("GET /_cluster/health", "GET /_cluster/health", "ES 请求"),
        completionItem("GET /_cat/indices?v", "GET /_cat/indices?v", "ES 请求"),
        completionItem("POST /_search", 'POST /_search\\n{\\n  "query": {\\n    "match_all": {}\\n  }\\n}', "ES 请求"),
        completionItem("POST /当前索引/_search", 'POST /' + index + '/_search\\n{\\n  "query": {\\n    "match_all": {}\\n  }\\n}', "ES 请求"),
        completionItem("GET /当前索引/_mapping", "GET /" + index + "/_mapping", "ES 请求"),
      ];
    }

    function completionItem(label, insert, kind, detail = "", cursorOffset = 0, currentTableField = false) {
      return { label, insert, kind, detail, cursorOffset, currentTableField };
    }

    function getAiTagCompletions() {
      return [
        completionItem("<ai></ai>", "<ai></ai>", "AI", "在标签内输入自然语言需求", -5),
        completionItem("@ai{}", "@ai{}", "AI", "在大括号内输入自然语言需求", -1),
        completionItem("<gen></gen>", "<gen></gen>", "生成数据", "在标签内描述需要生成的测试数据", -6),
        completionItem("@gen{}", "@gen{}", "生成数据", "在大括号内描述需要生成的测试数据", -1),
        completionItem("<table></table>", "<table></table>", "表结构", "指定本次 AI 额外读取的表结构", -8),
        completionItem("@table{}", "@table{}", "表结构", "指定本次 AI 额外读取的表结构", -1),
      ];
    }

    function getAiPromptCompletions() {
      if (state.connectionType === "redis") {
        return [...getAiTagCompletions(), ...getTableCompletions({ quote: false, kind: "Redis Key" })];
      }
      if (state.connectionType === "elasticsearch") {
        return [
          ...getAiTagCompletions(),
          ...getTableCompletions({ quote: false, kind: "ES Index" }),
          ...getFieldCompletions({ quote: false }),
        ];
      }
      return [...getAiTagCompletions(), ...getTableCompletions(), ...getFieldCompletions()];
    }

    function keywordCompletions() {
      const keywords = state.connectionType === "postgres" ? postgresKeywords : mysqlKeywords;
      return keywords.map((keyword) => completionItem(keyword, keyword + " ", "关键字"));
    }

    function getFunctionCompletions() {
      const functions = state.connectionType === "postgres"
        ? ["COUNT()", "SUM()", "AVG()", "MIN()", "MAX()", "COALESCE()", "NOW()", "TO_CHAR()", "JSONB_EXTRACT_PATH_TEXT()"]
        : ["COUNT()", "SUM()", "AVG()", "MIN()", "MAX()", "JSON_TYPE()", "JSON_EXTRACT()", "JSON_UNQUOTE()", "DATE_FORMAT()", "COALESCE()"];
      return functions
        .map((item) => completionItem(item, item, "函数"));
    }

    function getTableCompletions(options = {}) {
      const shouldQuote = options.quote !== false;
      const kind = options.kind || (state.connectionType === "redis" ? "Redis Key" : state.connectionType === "elasticsearch" ? "ES Index" : "表");
      return (state.tables || []).map((table) => completionItem(table.name, shouldQuote ? quoteCompletionIdentifier(table.name) : table.name, kind, table.comment || ""));
    }

    function getCurrentColumnCompletions(sqlText) {
      const aliases = parseSqlAliases(sqlText);
      const columns = [];
      const selectedTable = findSchemaTable(state.selectedTable);
      if (selectedTable) {
        columns.push(...(selectedTable.columns || []).map((column) => {
          const label = selectedTable.name + "." + column.name;
          return completionItem(label, quoteCompletionIdentifier(selectedTable.name) + "." + quoteCompletionIdentifier(column.name) + " ", "字段", column.comment || selectedTable.name, 0, true);
        }));
      }
      aliases.forEach((tableName, alias) => {
        const table = findSchemaTable(tableName);
        if (!table) return;
        columns.push(...(table.columns || []).map((column) => completionItem(alias + "." + column.name, quoteCompletionIdentifier(alias) + "." + quoteCompletionIdentifier(column.name) + " ", "字段", table.name, 0, isCurrentSchemaTable(table.name))));
      });
      return columns;
    }

    function getFieldCompletions(options = {}) {
      const shouldQuote = options.quote !== false;
      const fields = [];
      (state.tables || []).forEach((table) => {
        (table.columns || []).forEach((column) => {
          const label = table.name + "." + column.name;
          const insert = shouldQuote
            ? quoteCompletionIdentifier(table.name) + "." + quoteCompletionIdentifier(column.name) + " "
            : label + " ";
          fields.push(completionItem(label, insert, "字段", column.comment || table.name, 0, isCurrentSchemaTable(table.name)));
        });
      });
      return fields;
    }

    function getAiTagColumnCompletions() {
      const columns = [];
      const selectedTable = findSchemaTable(state.selectedTable);
      if (selectedTable) {
        columns.push(...(selectedTable.columns || []).map((column) => {
          const label = selectedTable.name + "." + column.name;
          return completionItem(label, quoteCompletionIdentifier(selectedTable.name) + "." + quoteCompletionIdentifier(column.name) + " ", "字段", column.comment || selectedTable.name, 0, true);
        }));
      }
      (state.tables || []).forEach((table) => {
        (table.columns || []).forEach((column) => {
          columns.push(completionItem(table.name + "." + column.name, quoteCompletionIdentifier(table.name) + "." + quoteCompletionIdentifier(column.name) + " ", "字段", column.comment || table.name, 0, isCurrentSchemaTable(table.name)));
        });
      });
      return columns;
    }

    function getColumnCompletionsForOwner(owner, sqlText) {
      const aliases = parseSqlAliases(sqlText);
      const tableName = aliases.get(owner) || owner;
      const table = findSchemaTable(tableName);
      if (!table) return [];
      return (table.columns || []).map((column) => {
        const label = table.name + "." + column.name;
        return completionItem(label, quoteCompletionIdentifier(column.name) + " ", "字段", column.comment || table.name, 0, isCurrentSchemaTable(table.name));
      });
    }

    function isCurrentSchemaTable(tableName) {
      return Boolean(state.selectedTable) && String(tableName) === String(state.selectedTable);
    }

    function filterCompletionItems(items, prefix, force) {
      const normalizedPrefix = String(prefix || "").toLowerCase();
      if (!normalizedPrefix && force) return items;
      if (!normalizedPrefix) return items.slice(0, 30);
      const startsWith = [];
      const contains = [];
      items.forEach((item) => {
        const label = item.label.toLowerCase();
        const insert = item.insert.toLowerCase();
        if (label.startsWith(normalizedPrefix) || insert.startsWith(normalizedPrefix)) {
          startsWith.push(item);
        } else if (label.includes(normalizedPrefix) || insert.includes(normalizedPrefix)) {
          contains.push(item);
        }
      });
      return [...startsWith, ...contains];
    }

    function dedupeCompletionItems(items) {
      const seen = new Set();
      return items.filter((item) => {
        const key = item.kind + ":" + item.label + ":" + item.insert;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function sortCompletionItemsByRecentUse(items) {
      return items.map((item, index) => ({
        item,
        index,
        usedAt: completionUsage[getCompletionUsageKey(item)] || 0,
        currentField: /字段/.test(item.kind) && item.currentTableField === true ? 1 : 0,
      }))
        .sort((left, right) => right.currentField - left.currentField || right.usedAt - left.usedAt || left.index - right.index)
        .map((entry) => entry.item);
    }

    function recordCompletionUsage(item) {
      completionUsage[getCompletionUsageKey(item)] = Date.now();
      const orderedKeys = Object.keys(completionUsage).sort((left, right) => completionUsage[right] - completionUsage[left]).slice(0, 100);
      completionUsage = orderedKeys.reduce((next, key) => {
        next[key] = completionUsage[key];
        return next;
      }, {});
      persistCompletionUsage();
    }

    function getCompletionUsageKey(item) {
      return [item.kind, item.label, item.insert].join("\\u0001");
    }

    function normalizeCompletionUsage(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.keys(value).reduce((next, key) => {
        const usedAt = Number(value[key]);
        if (Number.isFinite(usedAt) && usedAt > 0) next[key] = usedAt;
        return next;
      }, {});
    }

    function persistCompletionUsage() {
      webviewPersistedState = { ...webviewPersistedState, completionUsage };
      if (typeof vscode.setState === "function") vscode.setState(webviewPersistedState);
      vscode.postMessage({ type: "saveCompletionUsage", completionUsage });
    }

    function parseSqlAliases(sqlText) {
      const aliases = new Map();
      (state.tables || []).forEach((table) => aliases.set(table.name, table.name));
      if (state.selectedTable) aliases.set(state.selectedTable, state.selectedTable);
      const text = String(sqlText || "").split(String.fromCharCode(96)).join("");
      const pattern = /\\b(?:FROM|JOIN|UPDATE|INTO)\\s+([A-Za-z0-9_]+)(?:\\s+(?:AS\\s+)?([A-Za-z0-9_]+))?/gi;
      let match;
      while ((match = pattern.exec(text))) {
        const tableName = match[1];
        const alias = match[2] && !isSqlReservedWord(match[2]) ? match[2] : "";
        aliases.set(tableName, tableName);
        if (alias) aliases.set(alias, tableName);
      }
      return aliases;
    }

    function isSqlTableContext(before) {
      return /(?:^|\\s)(FROM|JOIN|UPDATE|INTO|TABLE|REFERENCES)\\s+$/i.test(String(before || ""));
    }

    function isSqlReservedWord(value) {
      const word = String(value || "").toUpperCase();
      const keywords = state.connectionType === "postgres" ? postgresKeywords : mysqlKeywords;
      return keywords.some((keyword) => keyword.split(" ")[0] === word) || ["ON", "WHERE", "LEFT", "RIGHT", "INNER", "GROUP", "ORDER", "LIMIT"].includes(word);
    }

    function cleanSqlIdentifier(value) {
      return String(value || "").split(String.fromCharCode(96)).join("").trim();
    }

    function quoteCompletionIdentifier(value) {
      const text = String(value || "");
      if (state.connectionType === "redis" || state.connectionType === "elasticsearch") {
        return text;
      }
      const quote = state.connectionType === "postgres" ? '"' : String.fromCharCode(96);
      const escapedQuote = state.connectionType === "postgres" ? '""' : quote + quote;
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : quote + text.split(quote).join(escapedQuote) + quote;
    }

    function findSchemaTable(name) {
      const target = String(name || "").toLowerCase();
      return (state.tables || []).find((table) => table.name.toLowerCase() === target) || null;
    }

    function findTableTagAtCursor(text, cursor) {
      const source = String(text || "");
      const lower = source.toLowerCase();
      const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, source.length));
      const htmlOpen = lower.lastIndexOf("<table>", safeCursor);
      const htmlCloseBefore = lower.lastIndexOf("</table>", safeCursor);
      if (htmlOpen >= 0 && htmlOpen > htmlCloseBefore) {
        const contentStart = htmlOpen + "<table>".length;
        const contentEnd = lower.indexOf("</table>", contentStart);
        if (safeCursor >= contentStart && (contentEnd < 0 || safeCursor <= contentEnd)) {
          return { type: "html", contentStart, contentEnd: contentEnd < 0 ? source.length : contentEnd };
        }
      }
      const braceOpen = lower.lastIndexOf("@table{", safeCursor);
      if (braceOpen >= 0) {
        const contentStart = braceOpen + "@table{".length;
        const closeBefore = source.lastIndexOf("}", safeCursor - 1);
        const contentEnd = source.indexOf("}", contentStart);
        if (closeBefore < braceOpen && safeCursor >= contentStart && (contentEnd < 0 || safeCursor <= contentEnd)) {
          return { type: "brace", contentStart, contentEnd: contentEnd < 0 ? source.length : contentEnd };
        }
      }
      return null;
    }

    function findAiTagAtCursor(text, cursor) {
      return findPromptTagAtCursor(text, cursor, ["ai", "gen"]);
    }

    function findPromptTagAtCursor(text, cursor, names) {
      const source = String(text || "");
      const lower = source.toLowerCase();
      const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, source.length));
      for (const name of names) {
        const openTag = "<" + name + ">";
        const closeTag = "</" + name + ">";
        const htmlOpen = lower.lastIndexOf(openTag, safeCursor);
        const htmlCloseBefore = lower.lastIndexOf(closeTag, safeCursor);
        if (htmlOpen >= 0 && htmlOpen > htmlCloseBefore) {
          const contentStart = htmlOpen + openTag.length;
          const contentEnd = lower.indexOf(closeTag, contentStart);
          if (safeCursor >= contentStart && (contentEnd < 0 || safeCursor <= contentEnd)) {
            return { type: "html", name, contentStart, contentEnd: contentEnd < 0 ? source.length : contentEnd };
          }
        }
        const braceOpenText = "@" + name + "{";
        const braceOpen = lower.lastIndexOf(braceOpenText, safeCursor);
        if (braceOpen >= 0) {
          const contentStart = braceOpen + braceOpenText.length;
          const closeBefore = source.lastIndexOf("}", safeCursor - 1);
          const contentEnd = source.indexOf("}", contentStart);
          if (closeBefore < braceOpen && safeCursor >= contentStart && (contentEnd < 0 || safeCursor <= contentEnd)) {
            return { type: "brace", name, contentStart, contentEnd: contentEnd < 0 ? source.length : contentEnd };
          }
        }
      }
      return null;
    }

    function getTableTagCompletionToken(text, contentStart, cursor) {
      const before = String(text || "").slice(contentStart, cursor);
      const match = before.match(/([A-Za-z0-9_]+)$/);
      const token = match ? match[1] : "";
      return {
        prefix: normalizeTableTagName(token),
        replaceStart: cursor - token.length,
      };
    }

    function updateAiTableTagValidation(force) {
      const input = aiPromptInput;
      const tagState = getAiTableTagState(input.value);
      const cursor = input.selectionStart ?? input.value.length;
      if (!force && findTableTagAtCursor(input.value, cursor)) {
        return tagState;
      }
      if (!tagState.invalid.length) {
        input.classList.remove("sql-tag-invalid");
        sqlTagValidation.classList.remove("visible");
        sqlTagValidation.innerHTML = "";
        return tagState;
      }
      input.classList.add("sql-tag-invalid");
      sqlTagValidation.innerHTML = "未知表：" + tagState.invalid.map((name) =>
        '<span class="sql-tag-error" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>'
      ).join("");
      sqlTagValidation.classList.add("visible");
      return tagState;
    }

    function getAiTableTagState(text) {
      const valid = [];
      const invalid = [];
      const seenValid = new Set();
      const seenInvalid = new Set();
      const selected = findSchemaTable(state.selectedTable);
      if (selected) {
        valid.push(selected.name);
        seenValid.add(selected.name.toLowerCase());
      }
      parseSqlTableTagNames(text).forEach((name) => {
        const table = findSchemaTable(name);
        if (table) {
          const key = table.name.toLowerCase();
          if (!seenValid.has(key)) {
            valid.push(table.name);
            seenValid.add(key);
          }
          return;
        }
        const invalidKey = name.toLowerCase();
        if (!seenInvalid.has(invalidKey)) {
          invalid.push(name);
          seenInvalid.add(invalidKey);
        }
      });
      return { valid, invalid };
    }

    function parseSqlTableTagNames(text) {
      const names = [];
      const source = String(text || "");
      source.replace(/<table>([\\s\\S]*?)<\\/table>/gi, (_match, content) => {
        names.push(...splitTableTagContent(content));
        return "";
      });
      source.replace(/@table\\{([\\s\\S]*?)\\}/gi, (_match, content) => {
        names.push(...splitTableTagContent(content));
        return "";
      });
      return names;
    }

    function splitTableTagContent(content) {
      return String(content || "")
        .split(/[\\s,，;；]+/)
        .map((name) => normalizeTableTagName(name))
        .filter(Boolean);
    }

    function normalizeTableTagName(value) {
      const tick = String.fromCharCode(96);
      let text = String(value || "").trim();
      while (text.startsWith(tick)) text = text.slice(1);
      while (text.endsWith(tick)) text = text.slice(0, -1);
      return text.replace(/^['"]+|['"]+$/g, "").trim();
    }

    function renderCodeSuggest() {
      if (!activeCompletion) return;
      if (!activeCompletion.items.length) {
        codeSuggest.innerHTML = '<div class="code-suggest-empty">没有可用提示</div>';
      } else {
        codeSuggest.innerHTML = activeCompletion.items.map((item, index) =>
          '<button class="code-suggest-item' + (index === activeCompletion.selected ? ' active' : '') + '" data-completion-index="' + index + '">'
	          + '<span class="code-suggest-label">' + renderCompletionLabel(item) + '</span>'
          + '<span class="code-suggest-kind">' + escapeHtml(item.kind) + (item.currentTableField ? ' · 当前表' : '') + '</span>'
          + '</button>'
        ).join("");
      }
      codeSuggest.classList.add("open");
      codeSuggest.querySelectorAll("[data-completion-index]").forEach((button) => {
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          activeCompletion.selected = Number(button.getAttribute("data-completion-index"));
          acceptCodeSuggestion();
        });
	      });
	    }

	    function renderCompletionLabel(item) {
	      const kind = String(item.kind || "");
	      const label = String(item.label || "");
	      if (kind.includes("关键字")) {
	        return wrapConfirmSqlToken(label, "sql-token-keyword");
	      }
	      if (kind.includes("字段")) {
	        const dotIndex = label.indexOf(".");
	        if (dotIndex > 0) {
	          return wrapConfirmSqlToken(label.slice(0, dotIndex), "sql-token-table sql-token-table-0")
	            + escapeHtml(".")
	            + wrapConfirmSqlToken(label.slice(dotIndex + 1), "sql-token-field sql-token-field-0");
	        }
	        return wrapConfirmSqlToken(label, "sql-token-field");
	      }
	      if (kind.includes("表") || kind.includes("Index") || kind.includes("Key")) {
	        return wrapConfirmSqlToken(label, "sql-token-table sql-token-table-0");
	      }
	      if (kind.includes("函数")) {
	        return renderHighlightedConfirmSql(label);
	      }
	      return escapeHtml(label);
	    }

	    function positionCodeSuggest(input) {
      const rect = input.getBoundingClientRect();
      const width = Math.max(260, Math.min(rect.width, 520));
      const left = Math.min(rect.left, window.innerWidth - width - 12);
      const below = rect.bottom + 6;
      const maxHeight = 280;
      const top = below + maxHeight > window.innerHeight ? Math.max(8, rect.top - maxHeight - 6) : below;
      codeSuggest.style.left = Math.max(8, left) + "px";
      codeSuggest.style.top = top + "px";
      codeSuggest.style.width = width + "px";
    }

    function moveCodeSuggestSelection(delta) {
      if (!activeCompletion?.items.length) return;
      const count = activeCompletion.items.length;
      activeCompletion.selected = (activeCompletion.selected + delta + count) % count;
      renderCodeSuggest();
      const active = codeSuggest.querySelector(".code-suggest-item.active");
      if (active) active.scrollIntoView({ block: "nearest" });
    }

    function acceptCodeSuggestion() {
      if (!activeCompletion?.items.length) return;
      const item = activeCompletion.items[activeCompletion.selected];
      const input = activeCompletion.input;
	      recordCompletionUsage(item);
	      input.setRangeText(item.insert, activeCompletion.replaceStart, activeCompletion.replaceEnd, "end");
	      updateSqlInputHighlight(input);
	      hideCodeSuggest();
      input.focus();
      if (typeof input.selectionStart === "number" && item.cursorOffset) {
        const position = Math.max(0, input.selectionStart + item.cursorOffset);
        input.setSelectionRange(position, position);
      } else if (typeof input.selectionStart === "number" && /\\(\\)$/.test(item.insert)) {
        const position = input.selectionStart - 1;
        input.setSelectionRange(position, position);
      }
    }

    function hideCodeSuggest() {
      activeCompletion = null;
      codeSuggest.classList.remove("open");
      codeSuggest.innerHTML = "";
    }

    function runQuickQuery() {
      state.lastQueryMode = "quick";
      state.sortColumn = "";
      state.sortDirection = "asc";
      vscode.postMessage({ type: "quickQuery", table: getQuickQueryTarget(), where: whereInput.value, limit: Number(limitInput.value || state.defaultLimit), page: 1 });
    }

    function refreshData(options = {}) {
      if (!state.selectedTable && state.connectionType !== "redis") {
        if (!options.silent) {
          setStatus("请先从左侧数据库树选择一张表。", true);
        }
        return;
      }
	      if (hasPendingEdits()) {
	        if (!options.silent) {
	          openDiscardRefreshDialog(options);
	        }
	        return;
	      }
	      const quickWhere = whereInput.value;
	      const hasQuickWhere = quickWhere.trim().length > 0;
	      if (hasQuickWhere && options.confirmQuickWhere && options.useQuickWhere === undefined) {
	        openQuickRefreshDialog();
	        return;
	      }
	      const useQuickWhere = hasQuickWhere && options.useQuickWhere !== false;
	      state.lastQueryMode = useQuickWhere ? "quick" : "preview";
	      state.sortColumn = "";
	      state.sortDirection = "asc";
	      if (options.auto) {
	        autoRefreshWaiting = true;
	      }
	      vscode.postMessage({
	        type: "quickQuery",
	        table: getQuickQueryTarget(),
	        where: useQuickWhere ? quickWhere : "",
	        limit: Number(limitInput.value || state.defaultLimit),
	        page: 1,
	      });
	    }

	    function openDiscardRefreshDialog(options = {}) {
	      pendingDiscardRefreshOptions = { ...options };
	      discardRefreshOverlay.classList.add("open");
	    }

	    function closeDiscardRefreshDialog() {
	      discardRefreshOverlay.classList.remove("open");
	      pendingDiscardRefreshOptions = null;
	    }

	    function confirmDiscardRefresh() {
	      const options = pendingDiscardRefreshOptions || {};
	      closeDiscardRefreshDialog();
	      clearPendingEdits();
	      refreshData({ ...options, force: true });
	    }

	    function openQuickRefreshDialog() {
	      quickRefreshOverlay.classList.add("open");
	    }

	    function closeQuickRefreshDialog() {
	      quickRefreshOverlay.classList.remove("open");
	    }

	    function confirmQuickRefresh(useQuickWhere) {
	      closeQuickRefreshDialog();
	      refreshData({ useQuickWhere, confirmQuickWhere: false });
	    }

    function sanitizeAutoRefreshValue(value) {
      const digits = String(value || "").replace(/\\D/g, "");
      if (!digits) return "";
      return String(Math.max(0, Number(digits)));
    }

    function updateAutoRefreshTimer() {
      if (autoRefreshTimer) {
        window.clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      autoRefreshWaiting = false;
      const seconds = Number(autoRefreshInput.value || 0);
      if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        autoRefreshInput.value = String(Math.max(0, Math.floor(Number(autoRefreshInput.value || 0) || 0)));
        return;
      }
      autoRefreshTimer = window.setInterval(() => {
        if (autoRefreshWaiting || hasPendingEdits()) return;
        refreshData({ auto: true, silent: true });
      }, seconds * 1000);
    }

    function getQuickQueryTarget() {
      return state.connectionType === "redis" && !state.selectedTable ? "__redis_keys__" : state.selectedTable;
    }

    function copyCurrentTableStructure() {
      if (!state.selectedTable) {
        setStatus("请先从左侧数据库树选择一张表。", true);
        return;
      }

      vscode.postMessage({ type: "copyTableDdl", table: state.selectedTable });
      setStatus(state.connectionType === "redis" ? "正在读取 Key 信息..." : state.connectionType === "elasticsearch" ? "正在读取索引结构..." : "正在读取建表 SQL...", false);
    }

    function applyConnectionMode() {
      const redis = state.connectionType === "redis";
      const es = state.connectionType === "elasticsearch";
      $("#copyStructureBtn").textContent = es ? "复制索引结构" : redis ? "复制 Key 信息" : "复制表结构";
      $("#copyStructureBtn").style.display = redis ? "none" : "";
      $("#editStructureBtn").style.display = redis || es ? "none" : "";
      $("#quickAddBtn").style.display = redis || es ? "none" : "";
      $("#operationLogBtn").style.display = redis || es ? "none" : "";
      fieldPicker.style.display = redis ? "none" : "";
      $("#fieldPickerBtn").textContent = es ? "选择显示字段" : redis ? "选择显示列" : "选择显示字段";
      $("#toggleSqlBtn").textContent = $("#sqlDrawer").classList.contains("open")
        ? (redis ? "收起命令 / AI" : es ? "收起查询 / AI" : "收起 SQL / AI")
        : (redis ? "打开命令 / AI" : es ? "打开查询 / AI" : "打开 SQL / AI");
      $("#runSqlBtn").textContent = redis ? "执行命令" : es ? "执行请求" : "执行 SQL";
      $("#formatBtn").textContent = es ? "格式化 JSON" : "格式化";
      const sqlLabel = document.querySelector('label[for="sqlInput"]');
      if (sqlLabel) sqlLabel.textContent = redis ? "Redis 命令" : es ? "Elasticsearch 查询" : "SQL 编辑器";
      whereInput.placeholder = redis
        ? "Key 过滤：留空显示全部，例如 user:*、session:*"
        : es
          ? "快速查询：Lucene 语法或 JSON Query DSL，例如 status:published"
          : "快速条件：例如 status = 'paid' AND id > 100";
      sqlInput.placeholder = redis
        ? "这里保持纯净，只放当前要执行的 Redis 命令。AI 提问请写到右侧时间线输入框。"
        : es
          ? "这里保持纯净，只放当前要执行的 Elasticsearch 查询。AI 提问请写到右侧时间线输入框。"
          : "这里保持纯净，只放当前要执行的 SQL。AI 提问请写到右侧时间线输入框。";
      aiPromptInput.placeholder = redis
        ? "例如：@ai{查询 user:* 相关 Key}，或 @gen{生成一个 hash 测试数据}，用 @table{key} 指定 Key。"
        : es
          ? "例如：@ai{查询最近 10 条日志}，或 @gen{生成测试文档}，用 @table{index} 指定索引。"
          : "例如：查询当前表 created_at 为空的数据；或 @ai{把当前 SQL 改成按 created_at 倒序}；用 @table{users} 添加额外表结构。";
      applyQueryConsoleMode();
    }

    function applyQueryConsoleMode() {
      if (!state.queryConsole) return;
      document.body.classList.add("query-console-mode");
      const topActions = document.querySelector(".top-actions");
      const quick = document.querySelector(".quick");
      if (topActions) topActions.style.display = "none";
      if (quick) quick.style.display = "none";
      $("#sqlDrawer").classList.add("open");
      $("#tableTitle").textContent = "查询控制台";
      $("#tableTitle").title = state.connectionName + " / " + state.database + " / 查询控制台";
      $("#summary").innerHTML = '<span class="pill">' + state.database + '</span><span class="pill">' + state.tables.length + ' 张表</span>';
    }

    function openSchemaEditor() {
      const table = getActiveTableForSchemaEditor();
      if (!table) {
        setStatus("请先从左侧数据库树选择一张表。", true);
        return;
      }

      state.schemaEditor = createSchemaEditorState(table);
      setSchemaSubmitError("");
      schemaOverlay.classList.add("open");
      renderSchemaEditor();
    }

    function openCreateTableSchemaEditor() {
      renderCreatingTable();
      state.schemaEditor = createNewTableSchemaEditorState();
      setSchemaSubmitError("");
      schemaOverlay.classList.add("open");
      renderSchemaEditor();
    }

    function openAiCreateTableDialog() {
      if (state.schemaEditor?.mode !== "createTable") return;
      setAiCreateTableLoading(false);
      aiCreateTableOverlay.classList.add("open");
      window.setTimeout(() => aiCreateTablePrompt.focus(), 0);
    }

    function closeAiCreateTableDialog() {
      if (confirmAiCreateTableBtn.disabled) return;
      setAiCreateTableLoading(false);
      aiCreateTableOverlay.classList.remove("open");
    }

    function submitAiCreateTablePrompt() {
      if (confirmAiCreateTableBtn.disabled) return;
      const prompt = aiCreateTablePrompt.value.trim();
      if (!prompt) {
        setSchemaSubmitError("请先输入新表的需求描述。");
        aiCreateTablePrompt.focus();
        return;
      }
      setSchemaSubmitError("");
      setAiCreateTableLoading(true);
      setStatus("正在调用 AI 执行...", false);
      vscode.postMessage({ type: "generateCreateTableDraft", prompt });
    }

    function setAiCreateTableLoading(loading) {
      if (aiCreateTableLoadingTimer) {
        window.clearInterval(aiCreateTableLoadingTimer);
        aiCreateTableLoadingTimer = null;
      }
      aiCreateTableLoading.classList.toggle("show", Boolean(loading));
      aiCreateTablePrompt.disabled = Boolean(loading);
      cancelAiCreateTableBtn.disabled = Boolean(loading);
      confirmAiCreateTableBtn.disabled = Boolean(loading);
      confirmAiCreateTableBtn.textContent = loading ? "生成中" : "确认生成";
      if (!loading) {
        aiCreateTableLoadingText.textContent = "正在调用 AI 执行.";
        return;
      }
      let dotCount = 1;
      const render = () => {
        aiCreateTableLoadingText.textContent = "正在调用 AI 执行" + ".".repeat(dotCount);
        dotCount = dotCount >= 3 ? 1 : dotCount + 1;
      };
      render();
      aiCreateTableLoadingTimer = window.setInterval(render, 450);
    }

    function applyGeneratedCreateTableSql(sql) {
      if (state.schemaEditor?.mode !== "createTable") return;
      try {
        const draft = parseCreateTableSqlToDraft(sql);
        state.schemaEditor = draft;
        closeAiCreateTableDialog();
        setSchemaSubmitError("");
        renderSchemaEditor();
        setStatus("AI 已生成建表草案，已映射到添加表页面。请检查字段描述、索引和约束后再创建。", false);
      } catch (error) {
        setSchemaSubmitError("AI 建表 SQL 解析失败：" + (error && error.message ? error.message : String(error)));
        setStatus("AI 建表 SQL 解析失败，请调整描述后重试。", true);
      }
    }

	    function openSchemaConfirmDialog(title, sql) {
	      if (!state.schemaEditor) return;
	      pendingSchemaConfirmDraft = clonePlain(state.schemaEditor);
	      pendingUpdateConfirmPayload = null;
	      pendingSqlConfirmAction = null;
	      pendingSqlConfirmCancelAction = null;
	      schemaConfirmTitle.textContent = title || "确认执行 SQL";
		      schemaConfirmSql.innerHTML = renderHighlightedConfirmSql(formatConfirmSqlPreview(sql));
	      schemaConfirmOverlay.classList.add("open");
	      schemaConfirmSql.scrollTop = 0;
	      schemaConfirmSql.scrollLeft = 0;
    }

	    function openUpdateCellsConfirmDialog(message) {
	      pendingSchemaConfirmDraft = null;
	      pendingSqlConfirmAction = null;
	      pendingSqlConfirmCancelAction = null;
	      pendingUpdateConfirmPayload = {
	        table: message.table,
	        primaryKeys: message.primaryKeys || [],
	        updates: message.updates || [],
	        refreshQuery: message.refreshQuery || null,
	      };
      schemaConfirmTitle.textContent = message.title || "确认执行下面的 UPDATE 语句吗？";
	      schemaConfirmSql.innerHTML = renderHighlightedConfirmSql(formatConfirmSqlPreview(message.sql));
      schemaConfirmOverlay.classList.add("open");
      schemaConfirmSql.scrollTop = 0;
	      schemaConfirmSql.scrollLeft = 0;
	    }

	    function openSqlActionConfirmDialog(message) {
	      pendingSchemaConfirmDraft = null;
	      pendingUpdateConfirmPayload = null;
	      pendingSqlConfirmAction = clonePlain(message.action || {});
	      pendingSqlConfirmCancelAction = message.cancelAction ? clonePlain(message.cancelAction) : null;
	      schemaConfirmTitle.textContent = message.title || "确认执行 SQL";
		      schemaConfirmSql.innerHTML = renderHighlightedConfirmSql(formatConfirmSqlPreview(message.sql || ""));
	      schemaConfirmOverlay.classList.add("open");
	      schemaConfirmSql.scrollTop = 0;
	      schemaConfirmSql.scrollLeft = 0;
	    }

	    function closeSchemaConfirmDialog(skipCancelAction) {
	      if (!skipCancelAction) {
	        handleSchemaConfirmCancelAction();
	      }
	      schemaConfirmOverlay.classList.remove("open");
	      schemaConfirmSql.innerHTML = "";
	      pendingSchemaConfirmDraft = null;
	      pendingUpdateConfirmPayload = null;
	      pendingSqlConfirmAction = null;
	      pendingSqlConfirmCancelAction = null;
	    }

	    function handleSchemaConfirmCancelAction() {
	      if (pendingSqlConfirmCancelAction?.type) {
	        vscode.postMessage(pendingSqlConfirmCancelAction);
	      }
	      const pendingType = pendingSqlConfirmAction?.type;
	      if (pendingType === "deleteRow" || pendingType === "deleteRows" || pendingType === "redisDeleteKeys") {
	        state.rowSelection.deleting = false;
	        renderRowSelection();
	      }
	      if (pendingType === "rollbackOperationLog") {
	        state.rollbackingLogId = "";
	        renderOperationLogs();
	      }
	      if (pendingType) {
	        setStatus("已取消执行。", false);
	      }
	    }

	    function confirmSchemaDraftApply() {
	      if (pendingSqlConfirmAction) {
	        const action = pendingSqlConfirmAction;
	        closeSchemaConfirmDialog(true);
	        vscode.postMessage(action);
	        setStatus("正在执行已确认的操作...", false);
	        return;
	      }

	      if (pendingUpdateConfirmPayload) {
	        const payload = pendingUpdateConfirmPayload;
	        closeSchemaConfirmDialog(true);
	        setSchemaSubmitError("");
	        vscode.postMessage({ type: "updateCells", ...payload, confirmed: true });
	        setStatus("正在提交单元格修改...", false);
	        return;
      }

      const draft = pendingSchemaConfirmDraft;
	      if (!draft) {
	        closeSchemaConfirmDialog(true);
	        return;
	      }
	      closeSchemaConfirmDialog(true);
      setSchemaSubmitError("");
      vscode.postMessage({ type: "applySchemaDraft", draft, confirmed: true });
      setStatus("正在提交表结构修改...", false);
    }

    function clonePlain(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function closeSchemaEditor() {
      const shouldClosePanel = state.schemaEditor?.mode === "createTable";
      closeSchemaConfirmDialog();
      schemaOverlay.classList.remove("open");
      if (shouldClosePanel) {
        state.schemaEditor = null;
        vscode.postMessage({ type: "closeCreateTablePanel" });
      }
    }

    function getActiveTableForSchemaEditor() {
      if (state.currentTable?.name === state.selectedTable) return state.currentTable;
      return state.tables.find((table) => table.name === state.selectedTable) || null;
    }

    function createSchemaEditorState(table) {
      const checks = (table.checks || []).map((check) => ({ ...check, originalName: check.name }));
      const columns = (table.columns || []).map((column) => ({
        name: column.name,
        originalName: column.name,
        comment: column.comment || "",
        type: column.type || "",
        notNull: !column.nullable,
        primaryKey: column.key === "PRI",
        notEmptyString: canUseNotEmptyStringCheck(column) && hasNotEmptyStringCheck(checks, column.name),
        jsonObjectOnly: canUseJsonObjectCheck(column) && hasJsonObjectCheck(checks, column.name),
        autoIncrement: /auto_increment/i.test(column.extra || ""),
        autoIncrementValue: "",
        defaultValue: formatDraftValue(column.defaultValue),
        onUpdate: parseOnUpdateValue(column.extra || ""),
        key: column.key || "",
      }));
      checks.forEach((check) => {
        const columnNames = columns.map((column) => column.name);
        const notEmptyColumnName = detectNotEmptyStringCheckColumn(check, columnNames);
        const notEmptyColumn = columns.find((item) => item.name === notEmptyColumnName);
        if (notEmptyColumnName && canUseNotEmptyStringCheck(notEmptyColumn)) {
          check.autoForColumn = notEmptyColumnName;
          check.autoCheckKind = "notEmptyString";
          return;
        }
        const jsonColumnName = detectJsonObjectCheckColumn(check, columnNames);
        const jsonColumn = columns.find((item) => item.name === jsonColumnName);
        if (jsonColumnName && canUseJsonObjectCheck(jsonColumn)) {
          check.autoForColumn = jsonColumnName;
          check.autoCheckKind = "jsonObject";
        }
      });
      const primaryColumns = columns.filter((column) => column.key === "PRI").map((column) => column.name);
      const primaryKeyName = state.connectionType === "postgres" ? (table.primaryKeyName || table.name + "_pkey") : "PRIMARY";
      const indexColumns = columns.filter((column) => column.key && column.key !== "PRI");
      const indexes = Array.isArray(table.indexes) && table.indexes.length
        ? table.indexes.map((index) => ({ name: index.name, originalName: index.name, unique: Boolean(index.unique), columns: index.columns || [] }))
        : indexColumns.map((column) => ({ name: "idx_" + table.name + "_" + column.name, originalName: "idx_" + table.name + "_" + column.name, unique: column.key === "UNI", columns: [column.name] }));
      return {
        table: { name: table.name, comment: table.comment || "" },
        columns,
        keys: primaryColumns.length ? [{ name: primaryKeyName, originalName: primaryKeyName, primary: true, columns: primaryColumns }] : [],
        foreignKeys: (table.foreignKeys || []).map((foreignKey) => ({ ...foreignKey, originalName: foreignKey.name })),
        indexes,
        checks,
        triggers: (table.triggers || []).map((trigger) => ({ ...trigger, originalName: trigger.name })),
        originalColumns: columns.map((column) => column.name),
        columnOrderMoves: [],
        deletedItems: { columns: [], keys: [], foreignKeys: [], indexes: [], checks: [], triggers: [] },
        active: { kind: "table" },
      };
    }

    function createNewTableSchemaEditorState() {
      return {
        mode: "createTable",
        table: { name: uniqueTableName("new_table"), comment: "" },
        columns: [
          {
            name: "id",
            originalName: "",
            isNew: true,
            comment: "主键 ID",
            type: state.connectionType === "postgres" ? "bigint" : "bigint unsigned",
            notNull: true,
            primaryKey: true,
            notEmptyString: false,
            jsonObjectOnly: false,
            autoIncrement: true,
            autoIncrementValue: "1",
            defaultValue: "",
            onUpdate: "",
            key: "PRI",
          },
          {
            name: "created_at",
            originalName: "",
            isNew: true,
            comment: "创建时间",
            type: state.connectionType === "postgres" ? "timestamp" : "datetime",
            notNull: true,
            primaryKey: false,
            notEmptyString: false,
            jsonObjectOnly: false,
            autoIncrement: false,
            autoIncrementValue: "",
            defaultValue: "CURRENT_TIMESTAMP",
            onUpdate: "",
            key: "",
          },
          {
            name: "updated_at",
            originalName: "",
            isNew: true,
            comment: "更新时间",
            type: state.connectionType === "postgres" ? "timestamp" : "datetime",
            notNull: true,
            primaryKey: false,
            notEmptyString: false,
            jsonObjectOnly: false,
            autoIncrement: false,
            autoIncrementValue: "",
            defaultValue: "CURRENT_TIMESTAMP",
            onUpdate: state.connectionType === "postgres" ? "" : "CURRENT_TIMESTAMP",
            key: "",
          },
          {
            name: "deleted_at",
            originalName: "",
            isNew: true,
            comment: "删除时间",
            type: state.connectionType === "postgres" ? "timestamp" : "datetime",
            notNull: false,
            primaryKey: false,
            notEmptyString: false,
            jsonObjectOnly: false,
            autoIncrement: false,
            autoIncrementValue: "",
            defaultValue: "",
            onUpdate: "",
            key: "",
          },
        ],
        keys: [{ name: state.connectionType === "postgres" ? "new_table_pkey" : "PRIMARY", originalName: "", isNew: true, primary: true, columns: ["id"] }],
        foreignKeys: [],
        indexes: [],
        checks: [],
        triggers: [],
        originalColumns: [],
        columnOrderMoves: [],
        deletedItems: { columns: [], keys: [], foreignKeys: [], indexes: [], checks: [], triggers: [] },
        active: { kind: "table" },
      };
    }

    function parseCreateTableSqlToDraft(sql) {
      const text = stripMarkdownSqlFenceText(sql);
      const createMatch = text.match(/create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?([\\s\\S]*?)\\(/i);
      if (!createMatch || createMatch.index === undefined) {
        throw new Error("没有找到 CREATE TABLE 语句。");
      }
      const openIndex = createMatch.index + createMatch[0].length - 1;
      const closeIndex = findMatchingParen(text, openIndex);
      if (closeIndex < 0) {
        throw new Error("CREATE TABLE 括号不完整。");
      }
      const rawTableName = createMatch[1].trim().split(/\\s+/).pop() || "";
      const tableName = normalizeSqlIdentifier(rawTableName);
      if (!tableName) {
        throw new Error("没有识别到表名。");
      }

      const body = text.slice(openIndex + 1, closeIndex);
      const tail = text.slice(closeIndex + 1);
      const commentMaps = parsePostgresCommentStatements(text);
      const table = {
        name: uniqueTableName(tableName),
        comment: extractCreateTableComment(tail) || commentMaps.tableComments.get(tableName) || "",
      };
      const columns = [];
      const keys = [];
      const indexes = [];
      const foreignKeys = [];
      const checks = [];
      const triggers = [];

      splitTopLevelComma(body).forEach((part) => {
        const item = part.trim().replace(/,$/, "");
        if (!item) return;
        if (/^(constraint\\s+.+\\s+)?primary\\s+key\\b/i.test(item)) {
          const name = extractConstraintName(item) || (state.connectionType === "postgres" ? table.name + "_pkey" : "PRIMARY");
          keys.push({ name, originalName: "", isNew: true, primary: true, columns: extractFirstColumnList(item) });
          return;
        }
        if (/^(unique\\s+)?(?:key|index)\\b/i.test(item) || /^constraint\\s+.+\\s+unique\\b/i.test(item)) {
          const unique = /^unique\\b/i.test(item) || /\\sunique\\s*\\(/i.test(item);
          const name = extractIndexName(item, unique);
          indexes.push({ name: name || uniqueSchemaName(indexes, unique ? "uk" : "idx"), originalName: "", isNew: true, unique, columns: extractFirstColumnList(item) });
          return;
        }
        if (/^(constraint\\s+.+\\s+)?foreign\\s+key\\b/i.test(item)) {
          const columnsForFk = extractFirstColumnList(item);
          const referenceMatch = item.match(/references\\s+([^\\s(]+)\\s*\\(([\\s\\S]+?)\\)/i);
          foreignKeys.push({
            name: extractConstraintName(item) || uniqueSchemaName(foreignKeys, "fk"),
            originalName: "",
            isNew: true,
            columns: columnsForFk,
            referenceTable: referenceMatch ? normalizeSqlIdentifier(referenceMatch[1]) : "",
            referenceColumns: referenceMatch ? splitTopLevelComma(referenceMatch[2]).map(normalizeSqlIdentifier).filter(Boolean) : [],
            onUpdate: extractClauseValue(item, "on update", ["on delete"]),
            onDelete: extractClauseValue(item, "on delete", []),
          });
          return;
        }
        if (/^(constraint\\s+.+\\s+)?check\\s*\\(/i.test(item)) {
          checks.push({
            name: extractConstraintName(item) || uniqueSchemaName(checks, "chk"),
            originalName: "",
            isNew: true,
            expression: extractCheckExpression(item),
          });
          return;
        }
        const column = parseCreateTableColumn(item);
        if (column) {
          columns.push(column);
          if (/\\bunique\\b/i.test(item)) {
            indexes.push({ name: uniqueSchemaName(indexes, "uk"), originalName: "", isNew: true, unique: true, columns: [column.name] });
          }
          const inlineReferenceMatch = item.match(/\\breferences\\s+([^\\s(]+)\\s*\\(([\\s\\S]+?)\\)/i);
          if (inlineReferenceMatch) {
            foreignKeys.push({
              name: uniqueSchemaName(foreignKeys, "fk"),
              originalName: "",
              isNew: true,
              columns: [column.name],
              referenceTable: normalizeSqlIdentifier(inlineReferenceMatch[1]),
              referenceColumns: splitTopLevelComma(inlineReferenceMatch[2]).map(normalizeSqlIdentifier).filter(Boolean),
              onUpdate: extractClauseValue(item, "on update", ["on delete"]),
              onDelete: extractClauseValue(item, "on delete", []),
            });
          }
        }
      });

      if (!columns.length) {
        throw new Error("没有识别到字段定义。");
      }
      parseStandaloneIndexStatements(text, tableName, indexes);
      commentMaps.columnComments.forEach((comment, key) => {
        const parts = key.split(".");
        const columnName = parts[parts.length - 1];
        const column = columns.find((item) => item.name === columnName);
        if (column && !column.comment) column.comment = comment;
      });
      const primaryKey = keys.find((item) => item.primary === true);
      if (primaryKey) {
        columns.forEach((column) => {
          if ((primaryKey.columns || []).includes(column.name)) {
            column.primaryKey = true;
            column.key = "PRI";
            column.notNull = true;
          }
        });
      }
      return {
        mode: "createTable",
        table,
        columns,
        keys,
        foreignKeys,
        indexes,
        checks,
        triggers,
        originalColumns: [],
        columnOrderMoves: [],
        deletedItems: { columns: [], keys: [], foreignKeys: [], indexes: [], checks: [], triggers: [] },
        active: { kind: "table" },
      };
    }

    function parseCreateTableColumn(item) {
      const leading = readLeadingSqlIdentifier(item);
      if (!leading.name) return null;
      const rest = leading.rest.trim();
      if (!rest) return null;
      const typeEnd = findFirstSqlKeyword(rest, ["character set", "collate", "not null", "null", "default", "comment", "auto_increment", "generated", "primary key", "unique", "references", "check", "on update"]);
      const type = (typeEnd >= 0 ? rest.slice(0, typeEnd) : rest).trim();
      const inlinePrimary = /\\bprimary\\s+key\\b/i.test(rest);
      const autoIncrement = /\\bauto_increment\\b/i.test(rest) || /\\bgenerated\\b[\\s\\S]*\\bidentity\\b/i.test(rest) || /\\bserial\\b/i.test(type);
      const comment = extractSqlComment(rest);
      return {
        name: leading.name,
        originalName: "",
        isNew: true,
        comment,
        type: type || (state.connectionType === "postgres" ? "text" : "varchar(255)"),
        notNull: inlinePrimary || /\\bnot\\s+null\\b/i.test(rest),
        primaryKey: inlinePrimary,
        notEmptyString: false,
        jsonObjectOnly: false,
        autoIncrement,
        autoIncrementValue: autoIncrement ? "1" : "",
        defaultValue: extractClauseValue(rest, "default", ["comment", "auto_increment", "generated", "primary key", "unique", "references", "check", "on update", "not null", "null"]),
        onUpdate: extractClauseValue(rest, "on update", ["comment", "primary key", "unique", "references", "check"]),
        key: inlinePrimary ? "PRI" : "",
      };
    }

    function stripMarkdownSqlFenceText(sql) {
      const fence = String.fromCharCode(96).repeat(3);
      return String(sql || "")
        .replace(new RegExp("^\\\\s*" + fence + "(?:sql)?\\\\s*", "i"), "")
        .replace(new RegExp("\\\\s*" + fence + "\\\\s*$", "i"), "")
        .trim();
    }

    function readLeadingSqlIdentifier(text) {
      const value = String(text || "").trim();
      const quote = value[0];
      if (quote === '"' || quote === String.fromCharCode(96)) {
        const end = value.indexOf(quote, 1);
        if (end > 0) {
          return { name: normalizeSqlIdentifier(value.slice(0, end + 1)), rest: value.slice(end + 1) };
        }
      }
      const match = value.match(/^([^\\s(,]+)\\s*([\\s\\S]*)$/);
      return match ? { name: normalizeSqlIdentifier(match[1]), rest: match[2] || "" } : { name: "", rest: value };
    }

    function normalizeSqlIdentifier(value) {
      let text = String(value || "").trim().replace(/,$/, "");
      const dotParts = splitSqlIdentifierPath(text);
      text = dotParts[dotParts.length - 1] || text;
      if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith(String.fromCharCode(96)) && text.endsWith(String.fromCharCode(96)))) {
        text = text.slice(1, -1);
      }
      return text.replace(/""/g, '"').replace(new RegExp(String.fromCharCode(96) + String.fromCharCode(96), "g"), String.fromCharCode(96)).trim();
    }

    function splitSqlIdentifierPath(value) {
      const parts = [];
      let current = "";
      let quote = "";
      const text = String(value || "");
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
          current += char;
          if (char === quote) quote = "";
          continue;
        }
        if (char === '"' || char === String.fromCharCode(96)) {
          quote = char;
          current += char;
          continue;
        }
        if (char === ".") {
          parts.push(current.trim());
          current = "";
          continue;
        }
        current += char;
      }
      if (current.trim()) parts.push(current.trim());
      return parts;
    }

    function splitTopLevelComma(value) {
      const result = [];
      let current = "";
      let depth = 0;
      let quote = "";
      const text = String(value || "");
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1] || "";
        if (quote) {
          current += char;
          if ((quote === "'" || quote === '"') && char === "\\\\" && next) {
            index += 1;
            current += next;
            continue;
          }
          if (char === quote) {
            if (next === quote && quote !== String.fromCharCode(96)) {
              index += 1;
              current += next;
              continue;
            }
            quote = "";
          }
          continue;
        }
        if (char === "'" || char === '"' || char === String.fromCharCode(96)) {
          quote = char;
          current += char;
          continue;
        }
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
        if (char === "," && depth === 0) {
          result.push(current.trim());
          current = "";
          continue;
        }
        current += char;
      }
      if (current.trim()) result.push(current.trim());
      return result;
    }

    function findMatchingParen(text, openIndex) {
      let depth = 0;
      let quote = "";
      for (let index = openIndex; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1] || "";
        if (quote) {
          if ((quote === "'" || quote === '"') && char === "\\\\" && next) {
            index += 1;
            continue;
          }
          if (char === quote) {
            if (next === quote && quote !== String.fromCharCode(96)) {
              index += 1;
              continue;
            }
            quote = "";
          }
          continue;
        }
        if (char === "'" || char === '"' || char === String.fromCharCode(96)) {
          quote = char;
          continue;
        }
        if (char === "(") depth += 1;
        if (char === ")") {
          depth -= 1;
          if (depth === 0) return index;
        }
      }
      return -1;
    }

    function findFirstSqlKeyword(text, keywords) {
      let best = -1;
      for (const keyword of keywords) {
        const index = findSqlKeyword(text, keyword);
        if (index >= 0 && (best < 0 || index < best)) best = index;
      }
      return best;
    }

    function findSqlKeyword(text, keyword) {
      const pattern = new RegExp("(^|\\\\s)" + keyword.replace(/\\s+/g, "\\\\s+") + "(?=\\\\s|$)", "i");
      const match = String(text || "").match(pattern);
      return match && match.index !== undefined ? match.index + match[1].length : -1;
    }

    function extractClauseValue(text, clause, stopClauses) {
      const start = findSqlKeyword(text, clause);
      if (start < 0) return "";
      let value = String(text || "").slice(start + clause.length).trim();
      const stop = findFirstSqlKeyword(value, stopClauses || []);
      if (stop >= 0) value = value.slice(0, stop).trim();
      return unquoteSqlLiteral(value.replace(/,$/, "").trim());
    }

    function extractSqlComment(text) {
      return extractClauseValue(text, "comment", ["auto_increment", "generated", "primary key", "unique", "references", "check", "on update", "not null", "null", "default"]);
    }

    function extractCreateTableComment(tail) {
      const match = String(tail || "").match(/\\bcomment\\s*=\\s*((?:'[^']*(?:''[^']*)*')|(?:"[^"]*")|[^\\s;]+)/i);
      return match ? unquoteSqlLiteral(match[1]) : "";
    }

    function unquoteSqlLiteral(value) {
      let text = String(value || "").trim();
      if (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1).trim();
      if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
        text = text.slice(1, -1);
      }
      return text.replace(/''/g, "'").replace(/\\"/g, '"').trim();
    }

    function extractConstraintName(item) {
      const match = String(item || "").match(/^constraint\\s+([^\\s]+)\\s+/i);
      return match ? normalizeSqlIdentifier(match[1]) : "";
    }

    function extractIndexName(item, unique) {
      const text = String(item || "").trim();
      const constraintName = extractConstraintName(text);
      if (constraintName) return constraintName;
      const pattern = unique ? /^unique\\s+(?:key|index)\\s+([^\\s(]+)/i : /^(?:key|index)\\s+([^\\s(]+)/i;
      const match = text.match(pattern);
      return match ? normalizeSqlIdentifier(match[1]) : "";
    }

    function extractFirstColumnList(item) {
      const text = String(item || "");
      const open = text.indexOf("(");
      if (open < 0) return [];
      const close = findMatchingParen(text, open);
      if (close < 0) return [];
      return splitTopLevelComma(text.slice(open + 1, close)).map(normalizeSqlIdentifier).filter(Boolean);
    }

    function extractCheckExpression(item) {
      const open = String(item || "").indexOf("(");
      if (open < 0) return "";
      const close = findMatchingParen(String(item || ""), open);
      return close > open ? String(item || "").slice(open + 1, close).trim() : "";
    }

    function parseStandaloneIndexStatements(sql, tableName, indexes) {
      const regex = /create\\s+(unique\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?([^\\s(]+)\\s+on\\s+([^\\s(]+)(?:\\s+using\\s+\\w+)?\\s*\\(/gi;
      let match;
      while ((match = regex.exec(sql)) !== null) {
        const targetTable = normalizeSqlIdentifier(match[3]);
        if (targetTable !== tableName) continue;
        const open = match.index + match[0].length - 1;
        const close = findMatchingParen(sql, open);
        if (close < 0) continue;
        const name = normalizeSqlIdentifier(match[2]) || uniqueSchemaName(indexes, match[1] ? "uk" : "idx");
        if (indexes.some((item) => item.name === name)) continue;
        indexes.push({
          name,
          originalName: "",
          isNew: true,
          unique: Boolean(match[1]),
          columns: splitTopLevelComma(sql.slice(open + 1, close)).map(normalizeSqlIdentifier).filter(Boolean),
        });
      }
    }

    function parsePostgresCommentStatements(sql) {
      const tableComments = new Map();
      const columnComments = new Map();
      const regex = /comment\\s+on\\s+(table|column)\\s+([^\\s]+(?:\\.[^\\s]+){0,2})\\s+is\\s+('(?:[^']|'')*'|null)/gi;
      let match;
      while ((match = regex.exec(sql)) !== null) {
        const value = /^null$/i.test(match[3]) ? "" : unquoteSqlLiteral(match[3]);
        if (match[1].toLowerCase() === "table") {
          tableComments.set(normalizeSqlIdentifier(match[2]), value);
        } else {
          const parts = splitSqlIdentifierPath(match[2]).map(normalizeSqlIdentifier);
          columnComments.set(parts.slice(-2).join("."), value);
        }
      }
      return { tableComments, columnComments };
    }

    function uniqueTableName(base) {
      const existing = new Set((state.tables || []).map((table) => table.name));
      let name = base;
      let index = 1;
      while (existing.has(name)) {
        index += 1;
        name = base + "_" + index;
      }
      return name;
    }

    function formatDraftValue(value) {
      if (value === undefined || value === null) return "";
      return String(value);
    }

    function hasNotEmptyStringCheck(checks, columnName) {
      return checks.some((check) => detectNotEmptyStringCheckColumn(check, [columnName]) === columnName);
    }

    function hasJsonObjectCheck(checks, columnName) {
      return checks.some((check) => detectJsonObjectCheckColumn(check, [columnName]) === columnName);
    }

    function canUseNotEmptyStringCheck(column) {
      return state.schemaCapabilities.supportsNotEmptyStringCheck === true && isVarcharColumnType(column?.type);
    }

    function canUseJsonObjectCheck(column) {
      return state.schemaCapabilities.supportsNotEmptyStringCheck === true && isJsonColumnType(column?.type);
    }

    function isVarcharColumnType(type) {
      return /^varchar\\s*(?:\\(|$)/i.test(String(type || "").trim());
    }

    function isJsonColumnType(type) {
      return /^jsonb?$/i.test(String(type || "").trim());
    }

    function detectNotEmptyStringCheckColumn(check, columnNames) {
      const expression = compactCheckExpression(check?.expression || "");
      return (columnNames || []).find((columnName) => {
        const column = compactCheckIdentifier(columnName);
        return expression === "trim" + column + "isnotnullandtrim" + column + "<>''"
          || expression === "trim" + column + "isnotnullandtrim" + column + "!=''";
      }) || "";
    }

    function detectJsonObjectCheckColumn(check, columnNames) {
      const expression = compactCheckExpression(check?.expression || "");
      return (columnNames || []).find((columnName) => {
        const column = compactCheckIdentifier(columnName);
        return expression === "json_type" + column + "='object'"
          || expression === "jsonb_typeof" + column + "='object'"
          || expression === "jsonb_typeof" + column + "::jsonb='object'"
          || expression === "json_typeof" + column + "='object'";
      }) || "";
    }

    function compactCheckExpression(expression) {
      const tick = String.fromCharCode(96);
      return normalizeCheckExpression(expression)
        .split(tick).join("")
        .replace(/\\\\'/g, "'")
        .replace(/_[a-z0-9]+'/gi, "'")
        .replace(/[\\s()]/g, "")
        .toLowerCase();
    }

    function compactCheckIdentifier(value) {
      const tick = String.fromCharCode(96);
      return String(value || "").split(tick).join("").replace(/\\s+/g, "").toLowerCase();
    }

    function normalizeCheckExpression(expression) {
      let text = String(expression || "").trim();
      while (isWrappedBySingleOuterPair(text)) {
        text = text.slice(1, -1).trim();
      }
      return text;
    }

    function isWrappedBySingleOuterPair(text) {
      if (!text.startsWith("(") || !text.endsWith(")")) return false;
      let depth = 0;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
        if (depth === 0 && index < text.length - 1) return false;
      }
      return depth === 0;
    }

    function parseOnUpdateValue(extra) {
      const match = String(extra).match(/on update\\s+(.+)$/i);
      return match ? match[1] : "";
    }

    function renderSchemaEditor() {
      if (!state.schemaEditor) return;
      normalizeSchemaEditorDerivedConstraints();
      const createMode = state.schemaEditor.mode === "createTable";
      $("#schemaDialogTitle").textContent = createMode ? "添加表" : "修改表结构";
      $("#schemaDialogMeta").textContent = state.connectionName + " / " + state.database + " / " + state.schemaEditor.table.name;
      $("#applySchemaDraftBtn").textContent = createMode ? "创建表" : "提交修改";
      $("#aiCreateTableBtn").classList.toggle("hidden", !createMode);
      renderSchemaTree();
      renderSchemaDetail();
    }

    function renderSchemaTree() {
      const editor = state.schemaEditor;
      const active = editor.active;
      const sections = [
        ["columns", "列", editor.columns],
        ["keys", "键", editor.keys],
        ["foreignKeys", "外键", editor.foreignKeys],
        ["indexes", "索引", editor.indexes],
        ["checks", "检查", editor.checks],
        ["triggers", "触发器", editor.triggers],
      ];
      const html = [
        schemaNodeHtml("table", "", editor.table.name, "", active.kind === "table", "root"),
        ...sections.flatMap(([kind, label, items]) => [
          schemaNodeHtml(kind, "", label, String(items.length), active.kind === kind && active.index === undefined, "section"),
          ...items.map((item, index) => schemaNodeHtml(kind, String(index), getSchemaItemLabel(kind, item), "", active.kind === kind && active.index === index, "child", item)),
        ]),
      ].join("");
      schemaTree.innerHTML = html;
      schemaTree.querySelectorAll(".schema-node").forEach((node) => {
        node.addEventListener("click", () => {
          const kind = node.getAttribute("data-kind");
          const indexValue = node.getAttribute("data-index");
          state.schemaEditor.active = { kind, index: indexValue === "" ? undefined : Number(indexValue) };
          renderSchemaEditor();
        });
      });
      schemaTree.querySelectorAll(".schema-add").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          addSchemaItem(button.getAttribute("data-add-kind"));
        });
      });
      schemaTree.querySelectorAll(".schema-delete").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleSchemaItemDelete(button.getAttribute("data-delete-kind"), Number(button.getAttribute("data-delete-index")));
        });
      });
      bindColumnDragNodes();
    }

    function schemaNodeHtml(kind, index, label, count, active, extraClass, item = null) {
      const pendingDelete = Boolean(item?.pendingDelete);
      const add = extraClass === "section" ? '<span class="schema-action schema-add" data-add-kind="' + kind + '" title="新增' + escapeHtml(label) + '">+</span>' : "";
      const deleteTitle = pendingDelete ? "撤回删除：" : "删除";
      const deleteSymbol = pendingDelete ? "↩" : "-";
      const remove = extraClass === "child" ? '<span class="schema-action schema-delete" data-delete-kind="' + kind + '" data-delete-index="' + index + '" title="' + deleteTitle + escapeHtml(label) + '">' + deleteSymbol + '</span>' : "";
      const titlePrefix = pendingDelete ? "待删除 · " : "";
      const title = kind === "columns" && extraClass === "child" ? titlePrefix + label + " · 拖拽调整列顺序" : titlePrefix + label;
      const drag = kind === "columns" && extraClass === "child" ? ' draggable="true"' : "";
      return '<button class="schema-node ' + extraClass + (active ? ' active' : '') + (pendingDelete ? ' pending-delete' : '') + '" data-kind="' + kind + '" data-index="' + index + '" title="' + escapeHtml(title) + '"' + drag + '><span class="schema-label">' + escapeHtml(truncateSchemaLabel(label)) + '</span>' + (count ? '<span class="schema-count">' + count + '</span>' : '') + add + remove + '</button>';
    }

    function truncateSchemaLabel(label) {
      const text = String(label || "");
      const maxLength = 24;
      return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
    }

    function getSchemaItemLabel(kind, item) {
      if (kind === "columns") return getColumnSchemaLabel(item);
      if (kind === "keys") return item.name || "未命名键";
      if (kind === "indexes") return item.name || "未命名索引";
      return item.name || "未命名";
    }

    function getColumnSchemaLabel(column) {
      const name = column?.name || "未命名列";
      const comment = truncateColumnComment(column?.comment || "");
      return comment ? name + " · " + comment : name;
    }

    function truncateColumnComment(comment) {
      const text = String(comment || "").trim();
      const maxLength = 16;
      return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
    }

    function addSchemaItem(kind) {
      if (!state.schemaEditor) return;
      const editor = state.schemaEditor;
      const firstColumn = editor.columns[0]?.name;
      const factories = {
        columns: () => ({ name: uniqueSchemaName(editor.columns, "new_column"), originalName: "", isNew: true, comment: "", type: "varchar(255)", notNull: false, primaryKey: false, notEmptyString: false, jsonObjectOnly: false, autoIncrement: false, autoIncrementValue: "", defaultValue: "", onUpdate: "", key: "" }),
        keys: () => ({ name: uniqueSchemaName(editor.keys, "key"), originalName: "", isNew: true, primary: false, columns: firstColumn ? [firstColumn] : [] }),
        foreignKeys: () => ({ name: uniqueSchemaName(editor.foreignKeys, "fk"), originalName: "", isNew: true, columns: firstColumn ? [firstColumn] : [], referenceTable: "", referenceColumns: [], onUpdate: "", onDelete: "" }),
        indexes: () => ({ name: uniqueSchemaName(editor.indexes, "idx"), originalName: "", isNew: true, unique: false, columns: firstColumn ? [firstColumn] : [] }),
        checks: () => ({ name: uniqueSchemaName(editor.checks, "chk"), originalName: "", isNew: true, expression: "" }),
        triggers: () => ({ name: uniqueSchemaName(editor.triggers, "trg"), originalName: "", isNew: true, timing: "BEFORE", event: "INSERT", statement: "" }),
      };
      const create = factories[kind];
      if (!create || !Array.isArray(editor[kind])) return;
      const item = create();
      editor[kind].push(item);
      editor.active = { kind, index: editor[kind].length - 1 };
      renderSchemaEditor();
    }

    function toggleSchemaItemDelete(kind, index) {
      if (!state.schemaEditor || !Array.isArray(state.schemaEditor[kind]) || !Number.isInteger(index)) return;
      const editor = state.schemaEditor;
      const item = editor[kind][index];
      if (!item) return;
      if (item.isNew === true && !item.pendingDelete) {
        if (kind === "checks") setColumnConstraintFlagsForCheck(item, false);
        editor[kind].splice(index, 1);
        if (kind === "columns") markDeletedColumnReferences(item);
        editor.active = { kind };
        renderSchemaEditor();
        return;
      }
      if (item.pendingDelete) {
        item.pendingDeleteManual = false;
        if (kind === "columns") {
          item.pendingDelete = false;
          removeDeletedSchemaItem(kind, item);
          restoreDeletedColumnReferences(item);
        } else if (!isSchemaItemAffectedByDeletedColumns(item)) {
          item.pendingDelete = false;
          removeDeletedSchemaItem(kind, item);
          if (kind === "checks") setColumnConstraintFlagsForCheck(item, true);
        }
      } else {
        item.pendingDelete = true;
        item.pendingDeleteManual = true;
        recordDeletedSchemaItem(kind, item);
        if (kind === "columns") markDeletedColumnReferences(item);
        if (kind === "checks") setColumnConstraintFlagsForCheck(item, false);
      }
      editor.active = { kind, index };
      renderSchemaEditor();
    }

    function recordDeletedSchemaItem(kind, item) {
      if (!state.schemaEditor || !item || item.isNew === true) return;
      const originalName = item.originalName || item.name;
      state.schemaEditor.deletedItems = state.schemaEditor.deletedItems || {};
      state.schemaEditor.deletedItems[kind] = state.schemaEditor.deletedItems[kind] || [];
      const alreadyDeleted = state.schemaEditor.deletedItems[kind].some((deleted) => (deleted.originalName || deleted.name) === originalName);
      if (!alreadyDeleted) {
        state.schemaEditor.deletedItems[kind].push({ ...item, originalName });
      }
    }

    function removeDeletedSchemaItem(kind, item) {
      if (!state.schemaEditor?.deletedItems?.[kind] || !item) return;
      const originalName = item.originalName || item.name;
      state.schemaEditor.deletedItems[kind] = state.schemaEditor.deletedItems[kind].filter((deleted) => (deleted.originalName || deleted.name) !== originalName);
    }

    function markDeletedColumnReferences(column) {
      const editor = state.schemaEditor;
      const columnName = column.name;
      const originalName = column.originalName || column.name;
      editor.columnOrderMoves = (editor.columnOrderMoves || []).filter((move) => (move.originalName || move.name) !== originalName && move.after !== columnName);
      ["foreignKeys", "indexes", "keys", "checks"].forEach((kind) => {
        (editor[kind] || []).forEach((item) => {
          if (!isSchemaItemAffectedByColumn(kind, item, columnName, originalName)) return;
          if (item.isNew === true) {
            if (kind === "checks") setColumnConstraintFlagsForCheck(item, false);
            editor[kind] = (editor[kind] || []).filter((candidate) => candidate !== item);
            removeDeletedSchemaItem(kind, item);
            return;
          }
          item.pendingDelete = true;
          addPendingDeleteColumn(item, columnName);
          recordDeletedSchemaItem(kind, item);
        });
      });
    }

    function isSchemaItemAffectedByColumn(kind, item, columnName, originalName) {
      if (kind === "checks") return isCheckAffectedByColumn(item, columnName, originalName);
      return (item.columns || []).includes(columnName);
    }

    function restoreDeletedColumnReferences(column) {
      ["foreignKeys", "indexes", "keys", "checks"].forEach((kind) => {
        (state.schemaEditor[kind] || []).forEach((item) => {
          removePendingDeleteColumn(item, column.name);
          removePendingDeleteColumn(item, column.originalName || column.name);
          if (!item.pendingDeleteManual && !isSchemaItemAffectedByDeletedColumns(item)) {
            item.pendingDelete = false;
            removeDeletedSchemaItem(kind, item);
          }
        });
      });
    }

    function addPendingDeleteColumn(item, columnName) {
      item.pendingDeleteColumns = item.pendingDeleteColumns || [];
      if (!item.pendingDeleteColumns.includes(columnName)) {
        item.pendingDeleteColumns.push(columnName);
      }
    }

    function removePendingDeleteColumn(item, columnName) {
      if (!item.pendingDeleteColumns || !columnName) return;
      item.pendingDeleteColumns = item.pendingDeleteColumns.filter((name) => name !== columnName);
    }

    function isSchemaItemAffectedByDeletedColumns(item) {
      const deletedColumnNames = new Set((state.schemaEditor.columns || [])
        .filter((column) => column.pendingDelete)
        .flatMap((column) => [column.name, column.originalName || column.name]));
      if (item.autoForColumn && deletedColumnNames.has(item.autoForColumn)) return true;
      if (item.expression && [...deletedColumnNames].some((name) => isCheckAffectedByColumn(item, name, name))) return true;
      return (item.columns || []).some((name) => deletedColumnNames.has(name));
    }

    function isCheckAffectedByColumn(check, columnName, originalName) {
      return [columnName, originalName].filter(Boolean).some((name) =>
        check.autoForColumn === name
        || detectNotEmptyStringCheckColumn(check, [name]) === name
        || detectJsonObjectCheckColumn(check, [name]) === name
      );
    }

    function uniqueSchemaName(items, prefix) {
      const names = new Set((items || []).map((item) => item.name));
      let index = (items || []).length + 1;
      let name = prefix + "_" + index;
      while (names.has(name)) {
        index += 1;
        name = prefix + "_" + index;
      }
      return name;
    }

    function bindColumnDragNodes() {
      schemaTree.querySelectorAll('.schema-node.child[data-kind="columns"]').forEach((node) => {
        node.addEventListener("dragstart", (event) => {
          node.classList.add("dragging");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", node.getAttribute("data-index") || "");
        });
        node.addEventListener("dragend", () => {
          schemaTree.querySelectorAll(".schema-node").forEach((item) => item.classList.remove("dragging", "drop-before", "drop-after"));
        });
        node.addEventListener("dragover", (event) => {
          event.preventDefault();
          const placement = getDropPlacement(node, event);
          node.classList.toggle("drop-before", placement === "before");
          node.classList.toggle("drop-after", placement === "after");
        });
        node.addEventListener("dragleave", () => node.classList.remove("drop-before", "drop-after"));
        node.addEventListener("drop", (event) => {
          event.preventDefault();
          const fromIndex = Number(event.dataTransfer.getData("text/plain"));
          const toIndex = Number(node.getAttribute("data-index"));
          const placement = getDropPlacement(node, event);
          reorderSchemaColumn(fromIndex, toIndex, placement);
        });
      });
    }

    function getDropPlacement(node, event) {
      const rect = node.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }

    function reorderSchemaColumn(fromIndex, toIndex, placement) {
      if (!state.schemaEditor || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return;
      const columns = state.schemaEditor.columns;
      const [moved] = columns.splice(fromIndex, 1);
      const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
      const insertIndex = placement === "after" ? adjustedToIndex + 1 : adjustedToIndex;
      columns.splice(Math.max(0, Math.min(insertIndex, columns.length)), 0, moved);
      recordColumnOrderMove(moved);
      state.schemaEditor.active = { kind: "columns", index: columns.indexOf(moved) };
      renderSchemaEditor();
    }

    function recordColumnOrderMove(moved) {
      const editor = state.schemaEditor;
      const originalName = moved.originalName || moved.name;
      const after = getPreviousVisibleColumnName(editor.columns, originalName);
      editor.columnOrderMoves = (editor.columnOrderMoves || []).filter((item) => (item.originalName || item.name) !== originalName);
      editor.columnOrderMoves.push({ name: moved.name, originalName, after });
    }

    function getPreviousVisibleColumnName(columns, originalName) {
      const visibleColumns = (columns || []).filter((column) => !column.pendingDelete);
      const index = visibleColumns.findIndex((column) => (column.originalName || column.name) === originalName);
      return index > 0 ? visibleColumns[index - 1].name : "";
    }

    function bindColumnDragRows() {
      schemaDetail.querySelectorAll("tr[data-column-index]").forEach((row) => {
        row.addEventListener("dragstart", (event) => {
          row.classList.add("dragging");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.getAttribute("data-column-index") || "");
        });
        row.addEventListener("dragend", () => {
          schemaDetail.querySelectorAll("tr").forEach((item) => item.classList.remove("dragging", "drop-before", "drop-after"));
        });
        row.addEventListener("dragover", (event) => {
          event.preventDefault();
          const placement = getDropPlacement(row, event);
          row.classList.toggle("drop-before", placement === "before");
          row.classList.toggle("drop-after", placement === "after");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          const fromIndex = Number(event.dataTransfer.getData("text/plain"));
          const toIndex = Number(row.getAttribute("data-column-index"));
          const placement = getDropPlacement(row, event);
          reorderSchemaColumn(fromIndex, toIndex, placement);
        });
      });
    }

    function renderSchemaDetail() {
      const editor = state.schemaEditor;
      const active = editor.active;
      if (active.kind === "table") return renderTableSchemaDetail(editor);
      if (active.kind === "columns" && active.index === undefined) return renderColumnsOverview(editor);
      if (active.kind === "columns") return renderColumnSchemaDetail(editor, active.index);
      if (active.kind === "keys" && active.index === undefined) return renderCollectionOverview("键", editor.keys, ["名称", "主键", "列"]);
      if (active.kind === "keys") return renderKeySchemaDetail(editor, active.index, false);
      if (active.kind === "indexes" && active.index === undefined) return renderCollectionOverview("索引", editor.indexes, ["名称", "是否唯一索引", "列"]);
      if (active.kind === "indexes") return renderKeySchemaDetail(editor, active.index, true);
      if (active.kind === "foreignKeys" && active.index === undefined) return renderForeignKeysOverview(editor);
      if (active.kind === "foreignKeys") return renderForeignKeyDetail(editor, active.index);
      if (active.kind === "checks" && active.index === undefined) return renderChecksOverview(editor);
      if (active.kind === "checks") return renderExpressionDetail(editor, active.index, "checks", "检查", "expression", "表达式");
      if (active.kind === "triggers" && active.index === undefined) return renderTriggersOverview(editor);
      if (active.kind === "triggers") return renderTriggerDetail(editor, active.index);
      return renderEmptySchemaSection(active.kind);
    }

    function renderTableSchemaDetail(editor) {
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>表信息</h3><span>root 节点</span></div>'
        + '<div class="schema-form">'
        + schemaInputRow("名称", "table.name", editor.table.name)
        + schemaInputRow("描述", "table.comment", editor.table.comment)
        + '</div>';
      bindSchemaInputs();
    }

    function renderColumnsOverview(editor) {
      const rows = editor.columns.map((column, index) => '<tr draggable="true" data-column-index="' + index + '"><td title="' + escapeHtml(column.name + (column.comment ? " · " + column.comment : "")) + '">' + escapeHtml(getColumnSchemaLabel(column)) + '</td><td>' + escapeHtml(column.comment || "") + '</td><td>' + escapeHtml(column.type) + '</td></tr>').join("");
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>列</h3><span>点击某一列可编辑详细属性</span></div>'
        + '<table class="schema-table"><thead><tr><th>字段名称</th><th>描述</th><th>类型</th></tr></thead><tbody>' + rows + '</tbody></table>';
      schemaDetail.querySelectorAll("tr[data-column-index]").forEach((row) => {
        row.addEventListener("click", () => {
          state.schemaEditor.active = { kind: "columns", index: Number(row.getAttribute("data-column-index")) };
          renderSchemaEditor();
        });
      });
      bindColumnDragRows();
    }

    function renderColumnSchemaDetail(editor, index) {
      const column = editor.columns[index];
      if (!column) return renderColumnsOverview(editor);
      const notEmptyStringOption = canUseNotEmptyStringCheck(column)
        ? schemaCheckbox("非空字符串", "columns." + index + ".notEmptyString", column.notEmptyString, 'data-schema-not-empty-column-index="' + index + '"')
        : "";
      const jsonObjectOption = canUseJsonObjectCheck(column)
        ? schemaCheckbox("只允许对象", "columns." + index + ".jsonObjectOnly", column.jsonObjectOnly, 'data-schema-json-object-column-index="' + index + '"')
        : "";
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>列：' + escapeHtml(getColumnSchemaLabel(column)) + '</h3><span>字段属性草案</span></div>'
        + '<div class="schema-form">'
        + schemaInputRow("名称", "columns." + index + ".name", column.name)
        + schemaInputRow("注释", "columns." + index + ".comment", column.comment)
        + schemaInputRow("数据类型", "columns." + index + ".type", column.type)
        + '<div class="schema-form-row"><label>约束</label><div class="schema-checks">'
        + schemaCheckbox("非 NULL", "columns." + index + ".notNull", column.notNull)
        + schemaCheckbox("主键", "columns." + index + ".primaryKey", isColumnPrimary(column))
        + notEmptyStringOption
        + jsonObjectOption
        + schemaCheckbox("自增", "columns." + index + ".autoIncrement", column.autoIncrement)
        + '<input class="field" data-schema-path="columns.' + index + '.autoIncrementValue" placeholder="自增值" value="' + escapeHtml(column.autoIncrementValue) + '" />'
        + '</div></div>'
        + schemaInputRow("默认值", "columns." + index + ".defaultValue", column.defaultValue, "例如 CURRENT_TIMESTAMP")
        + schemaInputRow("更新时", "columns." + index + ".onUpdate", column.onUpdate, "例如 CURRENT_TIMESTAMP")
        + '</div>';
      bindSchemaInputs();
    }

    function renderCollectionOverview(title, items, headers) {
      const rows = items.length ? items.map((item) => '<tr><td>' + escapeHtml(item.name || "") + '</td><td>' + escapeHtml(item.primary || item.unique ? "是" : "否") + '</td><td>' + escapeHtml((item.columns || []).join(", ")) + '</td></tr>').join("") : '<tr><td colspan="3" class="schema-muted">当前没有读取到' + title + '信息。</td></tr>';
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>' + title + '</h3><span>结构草案</span></div>'
        + '<table class="schema-table"><thead><tr><th>' + headers.map(escapeHtml).join('</th><th>') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderKeySchemaDetail(editor, index, isIndex) {
      const list = isIndex ? editor.indexes : editor.keys;
      const item = list[index];
      if (!item) return renderCollectionOverview(isIndex ? "索引" : "键", list, isIndex ? ["名称", "是否唯一索引", "列"] : ["名称", "主键", "列"]);
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>' + (isIndex ? "索引" : "键") + '：' + escapeHtml(item.name) + '</h3><span>可选择参与列</span></div>'
        + '<div class="schema-form">'
        + schemaInputRow("名称", (isIndex ? "indexes." : "keys.") + index + ".name", item.name)
        + '<div class="schema-form-row"><label>' + (isIndex ? "是否唯一索引" : "主键") + '</label><div class="schema-checks">' + schemaCheckbox(isIndex ? "唯一索引" : "主键", (isIndex ? "indexes." : "keys.") + index + (isIndex ? ".unique" : ".primary"), Boolean(isIndex ? item.unique : item.primary)) + '</div></div>'
        + '<div class="schema-form-row"><label>列</label><div class="schema-checks">' + editor.columns.map((column) => schemaCheckbox(column.name, (isIndex ? "indexes." : "keys.") + index + ".columns." + column.name, (item.columns || []).includes(column.name), "data-schema-column-list='" + (isIndex ? "indexes" : "keys") + "' data-schema-list-index='" + index + "' data-schema-column='" + escapeHtml(column.name) + "'")).join("") + '</div></div>'
        + '</div>';
      bindSchemaInputs();
    }

    function renderForeignKeysOverview(editor) {
      const rows = editor.foreignKeys.length
        ? editor.foreignKeys.map((item, index) => '<tr data-schema-kind="foreignKeys" data-schema-index="' + index + '"><td>' + escapeHtml(item.name || "") + '</td><td>' + escapeHtml((item.columns || []).join(", ")) + '</td><td>' + escapeHtml(item.referenceTable || "") + '</td></tr>').join("")
        : '<tr><td colspan="3" class="schema-muted">当前没有外键信息，点击左侧“外键”右侧的 + 可以新增。</td></tr>';
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>外键</h3><span>点击某个外键可编辑</span></div>'
        + '<table class="schema-table"><thead><tr><th>名称</th><th>列</th><th>引用表</th></tr></thead><tbody>' + rows + '</tbody></table>';
      bindSchemaRowNavigation();
    }

    function renderForeignKeyDetail(editor, index) {
      const item = editor.foreignKeys[index];
      if (!item) return renderForeignKeysOverview(editor);
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>外键：' + escapeHtml(item.name) + '</h3><span>外键结构草案</span></div>'
        + '<div class="schema-form">'
        + schemaInputRow("名称", "foreignKeys." + index + ".name", item.name)
        + '<div class="schema-form-row"><label>列</label><div class="schema-checks">' + editor.columns.map((column) => schemaCheckbox(column.name, "foreignKeys." + index + ".columns." + column.name, (item.columns || []).includes(column.name), "data-schema-column-list='foreignKeys' data-schema-list-index='" + index + "' data-schema-column='" + escapeHtml(column.name) + "'")).join("") + '</div></div>'
        + schemaInputRow("引用表", "foreignKeys." + index + ".referenceTable", item.referenceTable)
        + schemaInputRow("引用列", "foreignKeys." + index + ".referenceColumns", (item.referenceColumns || []).join(", "), "例如 id, user_id")
        + schemaInputRow("更新时", "foreignKeys." + index + ".onUpdate", item.onUpdate, "例如 CASCADE")
        + schemaInputRow("删除时", "foreignKeys." + index + ".onDelete", item.onDelete, "例如 SET NULL")
        + '</div>';
      bindSchemaInputs();
    }

    function renderChecksOverview(editor) {
      const rows = editor.checks.length
        ? editor.checks.map((item, index) => '<tr data-schema-kind="checks" data-schema-index="' + index + '"><td>' + escapeHtml(item.name || "") + '</td><td>' + escapeHtml(item.expression || "") + '</td></tr>').join("")
        : '<tr><td colspan="2" class="schema-muted">当前没有检查约束，点击左侧“检查”右侧的 + 可以新增。</td></tr>';
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>检查</h3><span>点击某个检查可编辑</span></div>'
        + '<table class="schema-table"><thead><tr><th>名称</th><th>表达式</th></tr></thead><tbody>' + rows + '</tbody></table>';
      bindSchemaRowNavigation();
    }

    function renderExpressionDetail(editor, index, listName, title, fieldName, fieldLabel) {
      const item = editor[listName][index];
      if (!item) return renderChecksOverview(editor);
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>' + title + '：' + escapeHtml(item.name) + '</h3><span>结构草案</span></div>'
        + '<div class="schema-form">'
        + schemaInputRow("名称", listName + "." + index + ".name", item.name)
        + schemaInputRow(fieldLabel, listName + "." + index + "." + fieldName, item[fieldName], "例如 status in ('draft','published')")
        + '</div>';
      bindSchemaInputs();
    }

    function renderTriggersOverview(editor) {
      const rows = editor.triggers.length
        ? editor.triggers.map((item, index) => '<tr data-schema-kind="triggers" data-schema-index="' + index + '"><td>' + escapeHtml(item.name || "") + '</td><td>' + escapeHtml(item.timing || "") + '</td><td>' + escapeHtml(item.event || "") + '</td></tr>').join("")
        : '<tr><td colspan="3" class="schema-muted">当前没有触发器，点击左侧“触发器”右侧的 + 可以新增。</td></tr>';
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>触发器</h3><span>点击某个触发器可编辑</span></div>'
        + '<table class="schema-table"><thead><tr><th>名称</th><th>时机</th><th>事件</th></tr></thead><tbody>' + rows + '</tbody></table>';
      bindSchemaRowNavigation();
    }

    function renderTriggerDetail(editor, index) {
      const item = editor.triggers[index];
      if (!item) return renderTriggersOverview(editor);
      const statementPlaceholder = state.connectionType === "postgres" ? "例如 EXECUTE FUNCTION update_updated_at()" : "例如 SET NEW.updated_at = CURRENT_TIMESTAMP";
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>触发器：' + escapeHtml(item.name) + '</h3><span>触发器草案</span></div>'
        + '<div class="schema-form">'
        + schemaInputRow("名称", "triggers." + index + ".name", item.name)
        + schemaInputRow("时机", "triggers." + index + ".timing", item.timing, "BEFORE / AFTER")
        + schemaInputRow("事件", "triggers." + index + ".event", item.event, "INSERT / UPDATE / DELETE")
        + schemaInputRow("语句", "triggers." + index + ".statement", item.statement, statementPlaceholder)
        + '</div>';
      bindSchemaInputs();
    }

    function bindSchemaRowNavigation() {
      schemaDetail.querySelectorAll("[data-schema-kind][data-schema-index]").forEach((row) => {
        row.addEventListener("click", () => {
          state.schemaEditor.active = { kind: row.getAttribute("data-schema-kind"), index: Number(row.getAttribute("data-schema-index")) };
          renderSchemaEditor();
        });
      });
    }

    function renderEmptySchemaSection(kind) {
      const labels = { foreignKeys: "外键", checks: "检查", triggers: "触发器" };
      schemaDetail.innerHTML = '<div class="schema-detail-title"><h3>' + escapeHtml(labels[kind] || kind) + '</h3><span>结构草案</span></div><p class="schema-muted">当前 schema 读取结果里没有该类型对象。后续可以在这里继续扩展新增和修改能力。</p>';
    }

    function schemaInputRow(label, path, value, placeholder = "") {
      return '<div class="schema-form-row"><label>' + escapeHtml(label) + '</label><input class="field" data-schema-path="' + path + '" value="' + escapeHtml(value || "") + '" placeholder="' + escapeHtml(placeholder) + '" /></div>';
    }

    function schemaCheckbox(label, path, checked, extra = "") {
      return '<label><input type="checkbox" data-schema-path="' + path + '"' + (checked ? " checked" : "") + (extra ? " " + extra : "") + ' />' + escapeHtml(label) + '</label>';
    }

    function bindSchemaInputs() {
      schemaDetail.querySelectorAll("[data-schema-path]").forEach((input) => {
        if (input.hasAttribute("data-schema-not-empty-column-index")) {
          input.addEventListener("click", () => window.setTimeout(() => toggleNotEmptyStringColumn(input), 0));
          return;
        }
        if (input.hasAttribute("data-schema-json-object-column-index")) {
          input.addEventListener("click", () => window.setTimeout(() => toggleJsonObjectColumn(input), 0));
          return;
        }
        if (input.type !== "checkbox") {
          input.addEventListener("input", () => updateSchemaDraftInput(input, !/^columns\.\d+\.type$/.test(input.getAttribute("data-schema-path") || "")));
          attachSchemaAutocomplete(input);
        }
        input.addEventListener("change", () => updateSchemaDraftInput(input, true));
      });
    }

    function toggleNotEmptyStringColumn(input) {
      if (!state.schemaEditor) return;
      const index = Number(input.getAttribute("data-schema-not-empty-column-index"));
      const column = state.schemaEditor.columns?.[index];
      if (!column) return;
      column.notEmptyString = Boolean(input.checked);
      syncNotEmptyStringCheck(column, column.notEmptyString);
      renderSchemaTree();
    }

    function toggleJsonObjectColumn(input) {
      if (!state.schemaEditor) return;
      const index = Number(input.getAttribute("data-schema-json-object-column-index"));
      const column = state.schemaEditor.columns?.[index];
      if (!column) return;
      column.jsonObjectOnly = Boolean(input.checked);
      syncJsonObjectCheck(column, column.jsonObjectOnly);
      renderSchemaTree();
    }

    function updateSchemaDraftInput(input, runSideEffects = true) {
      if (!state.schemaEditor) return;
      const path = input.getAttribute("data-schema-path");
      if (input.hasAttribute("data-schema-column-list")) {
        const listName = input.getAttribute("data-schema-column-list");
        const index = Number(input.getAttribute("data-schema-list-index"));
        const column = input.getAttribute("data-schema-column");
        const item = state.schemaEditor[listName]?.[index];
        if (!item || !column) return;
        const nextColumns = new Set(item.columns || []);
        if (input.checked) nextColumns.add(column); else nextColumns.delete(column);
        item.columns = [...nextColumns];
        return;
      }
      const columnNameMatch = String(path || "").match(/^columns\.(\d+)\.name$/);
      const oldColumnName = columnNameMatch ? state.schemaEditor.columns?.[Number(columnNameMatch[1])]?.name : "";
      const typeMatch = String(path || "").match(/^columns\.(\d+)\.type$/);
      const previousSupportValue = input.getAttribute("data-schema-previous-not-empty-supported");
      const currentSupportValue = typeMatch ? canUseNotEmptyStringCheck(state.schemaEditor.columns?.[Number(typeMatch[1])]) : false;
      const wasNotEmptyStringSupported = previousSupportValue === null ? currentSupportValue : previousSupportValue === "true";
      const previousJsonObjectSupportValue = input.getAttribute("data-schema-previous-json-object-supported");
      const currentJsonObjectSupportValue = typeMatch ? canUseJsonObjectCheck(state.schemaEditor.columns?.[Number(typeMatch[1])]) : false;
      const wasJsonObjectSupported = previousJsonObjectSupportValue === null ? currentJsonObjectSupportValue : previousJsonObjectSupportValue === "true";
      if (typeMatch && !runSideEffects && previousSupportValue === null) {
        input.setAttribute("data-schema-previous-not-empty-supported", String(currentSupportValue));
      }
      if (typeMatch && !runSideEffects && previousJsonObjectSupportValue === null) {
        input.setAttribute("data-schema-previous-json-object-supported", String(currentJsonObjectSupportValue));
      }
      const value = input.type === "checkbox" ? input.checked : input.value;
      setSchemaPathValue(path, value);
      if (!runSideEffects) return;
      if (typeMatch) input.removeAttribute("data-schema-previous-not-empty-supported");
      if (typeMatch) input.removeAttribute("data-schema-previous-json-object-supported");
      handleSchemaPathSideEffects(path, value, oldColumnName, wasNotEmptyStringSupported, wasJsonObjectSupported);
    }

    function setSchemaPathValue(path, value) {
      const parts = String(path || "").split(".");
      let target = state.schemaEditor;
      for (let index = 0; index < parts.length - 1; index += 1) {
        target = target?.[parts[index]];
      }
      if (target) target[parts[parts.length - 1]] = value;
    }

    function handleSchemaPathSideEffects(path, value, oldColumnName, wasNotEmptyStringSupported = false, wasJsonObjectSupported = false) {
      const match = String(path || "").match(/^columns\.(\d+)\.(name|type|primaryKey|notEmptyString|jsonObjectOnly)$/);
      if (!match || !state.schemaEditor) return;
      const columnIndex = Number(match[1]);
      const field = match[2];
      const column = state.schemaEditor.columns?.[columnIndex];
      if (!column) return;
      if (field === "type") {
        if (column.notEmptyString && !canUseNotEmptyStringCheck(column)) {
          syncNotEmptyStringCheck(column, false);
        }
        if (column.jsonObjectOnly && !canUseJsonObjectCheck(column)) {
          syncJsonObjectCheck(column, false);
        }
        if (wasNotEmptyStringSupported !== canUseNotEmptyStringCheck(column) || wasJsonObjectSupported !== canUseJsonObjectCheck(column)) {
          renderSchemaEditor();
        }
        return;
      }
      if (field === "name" && oldColumnName && oldColumnName !== column.name) {
        renameColumnReferences(oldColumnName, column.name);
        if (column.notEmptyString) syncNotEmptyStringCheck(column, true, oldColumnName);
        if (column.jsonObjectOnly) syncJsonObjectCheck(column, true, oldColumnName);
        return;
      }
      if (field === "primaryKey") {
        setColumnPrimary(column, Boolean(value));
        renderSchemaEditor();
        return;
      }
      if (field === "notEmptyString") {
        syncNotEmptyStringCheck(column, Boolean(value));
        showChecksAfterConstraintChange();
      }
      if (field === "jsonObjectOnly") {
        syncJsonObjectCheck(column, Boolean(value));
        showChecksAfterConstraintChange();
      }
    }

    function showChecksAfterConstraintChange() {
      state.schemaEditor.active = { kind: "checks" };
      renderSchemaTree();
      renderChecksOverview(state.schemaEditor);
    }

    function isColumnPrimary(column) {
      const primaryKey = getPrimaryKeyDraft(false);
      return Boolean(column?.primaryKey || column?.key === "PRI" || primaryKey?.columns?.includes(column?.name));
    }

    function setColumnPrimary(column, enabled) {
      column.primaryKey = enabled;
      column.key = enabled ? "PRI" : "";
      const primaryKey = getPrimaryKeyDraft(enabled);
      if (!primaryKey) return;
      const columns = new Set(primaryKey.columns || []);
      if (enabled) columns.add(column.name); else columns.delete(column.name);
      primaryKey.columns = [...columns].filter(Boolean);
      if (!primaryKey.columns.length && primaryKey.isNew === true) {
        state.schemaEditor.keys = (state.schemaEditor.keys || []).filter((key) => key !== primaryKey);
      }
    }

    function getPrimaryKeyDraft(createWhenMissing) {
      let primaryKey = (state.schemaEditor.keys || []).find((key) => key.primary === true || key.name === "PRIMARY");
      if (!primaryKey && createWhenMissing) {
        primaryKey = { name: "PRIMARY", originalName: "", isNew: true, primary: true, columns: [] };
        state.schemaEditor.keys = state.schemaEditor.keys || [];
        state.schemaEditor.keys.push(primaryKey);
      }
      return primaryKey;
    }

    function normalizeSchemaEditorDerivedConstraints() {
      if (!state.schemaEditor) return;
      (state.schemaEditor.columns || []).forEach((column) => {
        if (column.primaryKey === true || column.key === "PRI") {
          setColumnPrimary(column, true);
        }
        if (column.notEmptyString === true && !canUseNotEmptyStringCheck(column)) {
          syncNotEmptyStringCheck(column, false);
        }
        if (column.notEmptyString === true && !column.pendingDelete && canUseNotEmptyStringCheck(column)) {
          syncNotEmptyStringCheck(column, true);
        }
        if (column.jsonObjectOnly === true && !canUseJsonObjectCheck(column)) {
          syncJsonObjectCheck(column, false);
        }
        if (column.jsonObjectOnly === true && !column.pendingDelete && canUseJsonObjectCheck(column)) {
          syncJsonObjectCheck(column, true);
        }
      });
    }

    function setColumnConstraintFlagsForCheck(check, enabled) {
      setNotEmptyStringFlagForCheck(check, enabled);
      setJsonObjectFlagForCheck(check, enabled);
    }

    function setNotEmptyStringFlagForCheck(check, enabled) {
      const columns = state.schemaEditor?.columns || [];
      const names = columns.flatMap((column) => [column.name, column.originalName || column.name]).filter(Boolean);
      const columnName = check.autoCheckKind === "notEmptyString"
        ? check.autoForColumn
        : detectNotEmptyStringCheckColumn(check, names);
      const column = columns.find((item) => item.name === columnName || item.originalName === columnName);
      if (column) column.notEmptyString = enabled;
    }

    function setJsonObjectFlagForCheck(check, enabled) {
      const columns = state.schemaEditor?.columns || [];
      const names = columns.flatMap((column) => [column.name, column.originalName || column.name]).filter(Boolean);
      const columnName = check.autoCheckKind === "jsonObject"
        ? check.autoForColumn
        : detectJsonObjectCheckColumn(check, names);
      const column = columns.find((item) => item.name === columnName || item.originalName === columnName);
      if (column) column.jsonObjectOnly = enabled;
    }

    function renameColumnReferences(oldName, newName) {
      ["keys", "indexes", "foreignKeys"].forEach((kind) => {
        (state.schemaEditor[kind] || []).forEach((item) => {
          item.columns = (item.columns || []).map((column) => column === oldName ? newName : column);
        });
      });
      (state.schemaEditor.checks || []).forEach((check) => {
        if (check.autoForColumn !== oldName) return;
        check.autoForColumn = newName;
        if (check.autoCheckKind === "jsonObject") {
          check.name = buildJsonObjectCheckName(newName);
          check.expression = buildJsonObjectCheckExpression(newName);
        } else {
          check.name = buildNotEmptyCheckName(newName);
          check.expression = buildNotEmptyCheckExpression(newName);
        }
      });
    }

    function syncNotEmptyStringCheck(column, enabled, oldColumnName = "") {
      if (enabled && !canUseNotEmptyStringCheck(column)) {
        column.notEmptyString = false;
        return undefined;
      }
      column.notEmptyString = enabled;
      const check = findNotEmptyStringCheck(column, oldColumnName);
      if (enabled) {
        if (check) {
          check.pendingDelete = false;
          check.pendingDeleteManual = false;
          check.autoForColumn = column.name;
          check.autoCheckKind = "notEmptyString";
          if (check.isNew === true) {
            check.name = buildNotEmptyCheckName(column.name);
            check.expression = buildNotEmptyCheckExpression(column.name);
          }
          removeDeletedSchemaItem("checks", check);
          return check;
        }
        state.schemaEditor.checks = state.schemaEditor.checks || [];
        const createdCheck = {
          name: buildNotEmptyCheckName(column.name),
          originalName: "",
          isNew: true,
          expression: buildNotEmptyCheckExpression(column.name),
          autoForColumn: column.name,
          autoCheckKind: "notEmptyString",
        };
        state.schemaEditor.checks.push(createdCheck);
        return createdCheck;
      }
      if (!check) return undefined;
      if (check.isNew === true) {
        state.schemaEditor.checks = (state.schemaEditor.checks || []).filter((item) => item !== check);
      } else {
        check.pendingDelete = true;
        check.pendingDeleteManual = true;
        recordDeletedSchemaItem("checks", check);
      }
      return undefined;
    }

    function findNotEmptyStringCheck(column, oldColumnName = "") {
      const names = [column.name, column.originalName, oldColumnName].filter(Boolean);
      return (state.schemaEditor.checks || []).find((check) => {
        if (check.autoCheckKind === "jsonObject") return false;
        if (check.autoCheckKind === "notEmptyString" && names.includes(check.autoForColumn)) return true;
        return names.some((name) => detectNotEmptyStringCheckColumn(check, [name]) === name);
      });
    }

    function syncJsonObjectCheck(column, enabled, oldColumnName = "") {
      if (enabled && !canUseJsonObjectCheck(column)) {
        column.jsonObjectOnly = false;
        return undefined;
      }
      column.jsonObjectOnly = enabled;
      const check = findJsonObjectCheck(column, oldColumnName);
      if (enabled) {
        if (check) {
          check.pendingDelete = false;
          check.pendingDeleteManual = false;
          check.autoForColumn = column.name;
          check.autoCheckKind = "jsonObject";
          if (check.isNew === true) {
            check.name = buildJsonObjectCheckName(column.name);
            check.expression = buildJsonObjectCheckExpression(column.name);
          }
          removeDeletedSchemaItem("checks", check);
          return check;
        }
        state.schemaEditor.checks = state.schemaEditor.checks || [];
        const createdCheck = {
          name: buildJsonObjectCheckName(column.name),
          originalName: "",
          isNew: true,
          expression: buildJsonObjectCheckExpression(column.name),
          autoForColumn: column.name,
          autoCheckKind: "jsonObject",
        };
        state.schemaEditor.checks.push(createdCheck);
        return createdCheck;
      }
      if (!check) return undefined;
      if (check.isNew === true) {
        state.schemaEditor.checks = (state.schemaEditor.checks || []).filter((item) => item !== check);
      } else {
        check.pendingDelete = true;
        check.pendingDeleteManual = true;
        recordDeletedSchemaItem("checks", check);
      }
      return undefined;
    }

    function findJsonObjectCheck(column, oldColumnName = "") {
      const names = [column.name, column.originalName, oldColumnName].filter(Boolean);
      return (state.schemaEditor.checks || []).find((check) => {
        if (check.autoCheckKind === "notEmptyString") return false;
        if (check.autoCheckKind === "jsonObject" && names.includes(check.autoForColumn)) return true;
        return names.some((name) => detectJsonObjectCheckColumn(check, [name]) === name);
      });
    }

    function buildNotEmptyCheckName(columnName) {
      const safeName = String(columnName || "column").replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "column";
      return "chk_" + safeName + "_valid";
    }

    function buildNotEmptyCheckExpression(columnName) {
      const name = String(columnName || "column");
      return "TRIM(" + name + ") IS NOT NULL AND TRIM(" + name + ") <> ''";
    }

    function buildJsonObjectCheckName(columnName) {
      const safeName = String(columnName || "column").replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "column";
      return "chk_" + safeName + "_json_object";
    }

    function buildJsonObjectCheckExpression(columnName) {
      const name = String(columnName || "column");
      return state.connectionType === "postgres" ? "jsonb_typeof(" + name + "::jsonb) = 'object'" : "JSON_TYPE(" + name + ") = 'OBJECT'";
    }

    function copySchemaChangeSql() {
      if (!state.schemaEditor) return;
      normalizeSchemaEditorDerivedConstraints();
      setSchemaSubmitError("");
      vscode.postMessage({ type: "copySchemaDraftSql", draft: state.schemaEditor });
      setStatus("正在生成并复制表结构修改 SQL...", false);
    }

    function applySchemaDraft() {
      if (!state.schemaEditor) return;
      normalizeSchemaEditorDerivedConstraints();
      setSchemaSubmitError("");
      vscode.postMessage({ type: "previewSchemaDraftSql", draft: state.schemaEditor });
      setStatus("正在生成结构修改 SQL 预览...", false);
    }

    function setSchemaSubmitError(message) {
      const element = $("#schemaSubmitError");
      if (!element) return;
      const text = String(message || "");
      stopSchemaErrorLoading();
      if (text === "提交失败，正在使用 AI 翻译错误...") {
        startSchemaErrorLoading(element);
        return;
      }
      element.textContent = text;
      element.title = text;
    }

    function startSchemaErrorLoading(element) {
      const baseText = "提交失败，正在使用 AI 翻译错误";
      let dotCount = 1;
      const render = () => {
        const text = baseText + ".".repeat(dotCount);
        element.textContent = text;
        element.title = text;
        dotCount = dotCount >= 3 ? 1 : dotCount + 1;
      };
      render();
      schemaErrorTimer = window.setInterval(render, 450);
    }

    function stopSchemaErrorLoading() {
      if (!schemaErrorTimer) return;
      window.clearInterval(schemaErrorTimer);
      schemaErrorTimer = null;
    }

    function startStatusLoading(message, isError) {
      status.classList.toggle("error", Boolean(isError));
      updateExportButton();
      const baseText = getStatusLoadingBaseText(message);
      let dotCount = 1;
      const render = () => {
        statusText.textContent = baseText + ".".repeat(dotCount);
        dotCount = dotCount >= 3 ? 1 : dotCount + 1;
      };
      stopStatusLoading();
      render();
      statusLoadingTimer = window.setInterval(render, 450);
    }

    function stopStatusLoading() {
      if (!statusLoadingTimer) return;
      window.clearInterval(statusLoadingTimer);
      statusLoadingTimer = null;
    }

    function isStatusLoadingMessage(message) {
      return /正在/.test(String(message || ""));
    }

    function getStatusLoadingBaseText(message) {
      return String(message || "").replace(/[.。…]+$/g, "").trim();
    }

    function restoreResultStatus() {
      if (state.currentResult) {
        setStatus(buildResultStatus(state.currentResult), false, true);
        return;
      }
      setStatus("等待操作。", false);
    }

    function renderQueryConsoleIntro() {
      state.currentTable = null;
      state.currentResult = null;
      state.selectedTable = "";
      state.lastQueryMode = "sql";
      state.primaryKeys = [];
      state.columnTypes = {};
      state.columnComments = {};
      state.columnMeta = {};
      state.pendingEdits = {};
      state.quickInsert = { active: false, values: {} };
      clearRowSelection();
      state.fieldColumns = [];
      state.selectedColumns = [];
      state.fieldSelectionInitialized = false;
      renderFieldOptions();
      updateExportButton();
      renderPagination(null);
      applyQueryConsoleMode();
      setStatus("查询控制台已就绪：输入 SQL 或让 AI 生成后执行。", false);
      result.innerHTML = '<div class="empty"><strong>查询控制台</strong>这里只有 SQL / AI 编辑器和执行结果预览。你可以直接写 SQL，也可以在右侧“继续告诉 AI”里描述需求。</div>';
    }

    function renderEmptyTable() {
      state.currentTable = null;
      state.currentResult = null;
      state.fieldSelectionInitialized = false;
      state.columnComments = {};
      state.columnMeta = {};
      state.quickInsert = { active: false, values: {} };
      clearRowSelection();
      updateQuickButton();
      updateExportButton();
      renderPagination(null);
      $("#tableTitle").textContent = "选择一张表";
      $("#summary").innerHTML = '<span class="pill">' + state.tables.length + ' 张表</span>';
      if (state.queryConsole) {
        renderQueryConsoleIntro();
      }
    }

    function renderCreatingTable() {
      state.currentTable = null;
      state.currentResult = null;
      state.selectedTable = "";
      state.lastQueryMode = "create";
      state.primaryKeys = [];
      state.columnTypes = {};
      state.columnComments = {};
      state.columnMeta = {};
      state.pendingEdits = {};
      state.quickInsert = { active: false, values: {} };
      clearRowSelection();
      state.fieldColumns = [];
      state.selectedColumns = [];
      state.fieldSelectionInitialized = false;
      renderFieldOptions();
      updateQuickButton();
      updateExportButton();
      $("#tableTitle").textContent = "正在创建";
      $("#summary").innerHTML = '<span class="pill">' + state.database + '</span><span class="pill">' + state.tables.length + ' 张表</span>';
      setStatus("正在创建新表，请在弹窗中配置表结构后提交。", false);
      result.innerHTML = '<div class="empty"><strong>正在创建表</strong>请在“添加表”弹窗里配置列、键、索引、外键等信息，确认后提交创建。</div>';
      renderPagination(null);
    }

    function renderRedisDatabaseOverview() {
      state.currentResult = null;
      state.currentTable = {
        name: state.database,
        comment: "Redis DB Key 列表",
        columns: [
          { name: "key", type: "redis-key", nullable: false, key: "PRI", comment: "Redis Key" },
          { name: "type", type: "redis-type", nullable: false, comment: "数据类型" },
          { name: "ttl", type: "seconds", nullable: true, comment: "剩余过期时间" },
          { name: "memory", type: "bytes", nullable: true, comment: "内存占用" },
          { name: "value", type: "redis-value", nullable: true, comment: "字符串值预览" },
        ],
      };
      state.selectedTable = "";
      state.lastQueryMode = "preview";
      state.primaryKeys = ["key"];
      state.columnTypes = { key: "redis-key", type: "redis-type", ttl: "seconds", memory: "bytes", value: "redis-value" };
      state.columnComments = { key: "Redis Key", type: "数据类型", ttl: "剩余过期时间", memory: "内存占用", value: "字符串值预览" };
      state.columnMeta = Object.fromEntries(state.currentTable.columns.map((column) => [column.name, column]));
      state.pendingEdits = {};
      state.quickInsert = { active: false, values: {} };
      clearRowSelection();
      updateQuickButton();
      updateExportButton();
      $("#tableTitle").textContent = state.database + " Key 列表";
      $("#tableTitle").title = state.database + " · Redis Key 列表";
      $("#summary").innerHTML = '<span class="pill">Redis</span><span class="pill">按 Key 分页浏览</span>';
      setStatus("正在读取 Redis Key 列表...", false);
    }

    function renderTableInfo(table, defaultLimit) {
      const isSameTable = state.selectedTable === table.name;
      const previousFieldColumns = isSameTable ? [...state.fieldColumns] : [];
      const previousSelectedColumns = isSameTable ? [...state.selectedColumns] : [];
      const previousFieldSelectionInitialized = isSameTable ? state.fieldSelectionInitialized : false;
      state.currentTable = table;
      state.currentResult = null;
      state.selectedTable = table.name;
      state.defaultLimit = defaultLimit || state.defaultLimit;
	      limitInput.value = String(state.defaultLimit);
	      whereInput.value = "";
	      updateSqlInputHighlight(whereInput);
      state.lastQueryMode = "preview";
      state.fieldColumns = previousFieldColumns;
      state.selectedColumns = previousSelectedColumns;
      state.fieldSelectionInitialized = previousFieldSelectionInitialized;
      state.pendingEdits = {};
      state.quickInsert = { active: false, values: {} };
      clearRowSelection();
      state.primaryKeys = (table.columns || []).filter((column) => column.key === "PRI").map((column) => column.name);
      state.columnTypes = Object.fromEntries((table.columns || []).map((column) => [column.name, column.type || ""]));
      state.columnComments = Object.fromEntries((table.columns || []).map((column) => [column.name, column.comment || ""]));
      state.columnMeta = Object.fromEntries((table.columns || []).map((column) => [column.name, column]));
      renderFieldOptions();
      updateQuickButton();
      updateExportButton();
      $("#tableTitle").textContent = table.name;
      $("#tableTitle").title = table.comment ? table.name + " · " + table.comment : table.name;
      $("#summary").innerHTML = table.comment
        ? '<span class="pill table-comment" title="' + escapeHtml(table.comment) + '">' + escapeHtml(table.comment) + '</span>'
        : "";
      const noun = state.connectionType === "redis" ? "Key" : state.connectionType === "elasticsearch" ? "索引" : "表";
      result.innerHTML = '<div class="empty"><strong>正在读取预览数据</strong>已选择' + escapeHtml(noun) + ' ' + escapeHtml(table.name) + '，请稍候。</div>';
      renderPagination(null);
      setStatus("已选择" + noun + " " + table.name + "，正在读取预览数据...", false);
    }

    function normalizeTableDisplayConfig(config) {
      const fontSize = Number(config?.dataGridFontSize);
      const sqlConfirmFontSize = Number(config?.sqlConfirmFontSize);
      return {
        showColumnComments: config?.showColumnComments !== false,
        hiddenColumnCommentNames: Array.isArray(config?.hiddenColumnCommentNames)
          ? config.hiddenColumnCommentNames.map((name) => String(name).toLowerCase())
          : ["id", "created_at", "updated_at", "deleted_at"],
        dataGridFontSize: Number.isFinite(fontSize) ? Math.min(24, Math.max(9, Math.round(fontSize))) : 12,
        sqlConfirmFontSize: Number.isFinite(sqlConfirmFontSize) ? Math.min(32, Math.max(10, Math.round(sqlConfirmFontSize))) : 15,
      };
    }

    function applyTableDisplayConfig() {
      document.documentElement.style.setProperty("--data-table-font-size", state.tableDisplay.dataGridFontSize + "px");
      document.documentElement.style.setProperty("--sql-confirm-font-size", state.tableDisplay.sqlConfirmFontSize + "px");
    }

    function normalizeSchemaCapabilities(capabilities) {
      return {
        supportsNotEmptyStringCheck: capabilities?.supportsNotEmptyStringCheck === true,
        mysqlVersion: capabilities?.mysqlVersion || "",
      };
    }

    function getVisibleColumnComment(column) {
      if (!state.tableDisplay.showColumnComments) return "";
      const hiddenNames = new Set(state.tableDisplay.hiddenColumnCommentNames || []);
      if (hiddenNames.has(String(column).toLowerCase())) return "";
      return String(state.columnComments[column] || "").trim();
    }

    function getColumnComment(column) {
      return String(state.columnComments[column] || "").trim();
    }

    function renderResult(queryResult) {
      state.currentResult = queryResult;
      state.sortColumn = queryResult.pagination?.sortColumn || "";
      state.sortDirection = queryResult.pagination?.sortDirection || "asc";
      clearRowSelection();
      syncFieldOptions(queryResult.columns || [], state.lastQueryMode === "sql");
      renderResultTable(queryResult, (queryResult.rows || []).map((row, index) => ({ row, index })));
      renderPagination(queryResult.pagination);
    }

    function renderResultTable(queryResult, rowsToRender) {
      hideRowContextMenu();
      teardownResultHorizontalScrollbar();
      const allColumns = mergeColumns(state.quickInsert.active ? getSchemaColumnNames() : [], queryResult.columns || []);
      const columns = getVisibleColumns(allColumns);
      setStatus(buildResultStatus(queryResult), false, true);
      if (!allColumns.length) {
        result.innerHTML = '<div class="empty"><strong>执行完成</strong>没有返回列。</div>';
        return;
      }
      if (!columns.length) {
        result.innerHTML = '<div class="empty"><strong>没有选择展示字段</strong>点击右上角“选择显示字段”勾选要展示的列。</div>';
        return;
      }
      const sortableHeaders = canSortResultHeaders(queryResult);
      const head = columns.map((column, index) => {
        const active = state.sortColumn === column;
        const mark = active ? (state.sortDirection === "desc" ? "↓" : "↑") : "↕";
        const ariaSort = active ? (state.sortDirection === "desc" ? "descending" : "ascending") : "none";
        const comment = getVisibleColumnComment(column);
        const title = comment ? '点击按 ' + column + ' 排序\\n' + comment : '点击按 ' + column + ' 排序';
        const label = '<span class="sort-label"><span class="sort-name">' + escapeHtml(column) + '</span>' + (comment ? '<span class="sort-comment">' + escapeHtml(comment) + '</span>' : '') + '</span>';
        if (!sortableHeaders) {
          const plainTitle = comment ? column + "\\n" + comment : column;
          return '<th aria-sort="none" title="' + escapeHtml(plainTitle) + '"><span class="plain-header">' + label + '</span></th>';
        }
        return '<th aria-sort="' + ariaSort + '"><button class="sort-header' + (active ? ' active' : '') + '" data-column-index="' + index + '" title="' + escapeHtml(title) + '">' + label + '<span class="sort-mark">' + mark + '</span></button></th>';
      }).join("");
      const insertBody = state.quickInsert.active ? renderQuickInsertRow(columns) : "";
      const selectedRows = new Set(state.rowSelection.selected);
      const rowClass = (entry) => selectedRows.has(entry.index) ? (state.rowSelection.deleting ? " deleting-row" : " selected-row") : "";
      const body = insertBody + rowsToRender.map((entry, renderIndex) => '<tr class="data-row' + rowClass(entry) + '" data-row-index="' + entry.index + '" data-row-order="' + renderIndex + '">' + columns.map((column) => {
        const value = entry.row[column];
        const editKey = buildEditKey(entry.index, column);
        const pending = state.pendingEdits[editKey];
        const displayValue = pending ? formatValue(pending.newValue) : formatValue(value);
        const editable = canEditColumn(column, entry.row);
        const inspectable = canInspectRedisValue(column, entry.row);
        const copyable = canCopyReadonlyColumn(column, entry.row);
        const title = copyable ? displayValue + "\\n双击复制到剪贴板" : displayValue;
        return '<td class="data-cell ' + (editable ? 'editable-cell' : '') + (inspectable ? ' inspectable-cell' : '') + (copyable ? ' copyable-cell' : '') + (pending ? ' pending-cell' : '') + '" data-row-index="' + entry.index + '" data-column="' + escapeHtml(column) + '" title="' + escapeHtml(title) + '"><span class="cell-value">' + renderCellDisplayValue(displayValue) + '</span></td>';
      }).join("") + '</tr>').join("");
      result.innerHTML = '<table class="data-table" style="--column-count: ' + columns.length + '"><thead><tr class="data-header-row">' + head + '</tr><tr class="table-x-scroll-row"><th colspan="' + columns.length + '"><div class="table-x-scroll" aria-label="横向滚动查看更多字段"><div class="table-x-scroll-inner"></div></div></th></tr></thead><tbody>' + body + '</tbody></table>';
      setupResultHorizontalScrollbar();
      if (sortableHeaders) {
        result.querySelectorAll(".sort-header").forEach((button) => {
          button.addEventListener("click", () => {
            const index = Number(button.getAttribute("data-column-index"));
            sortResultByColumn(columns[index]);
          });
        });
      }
      result.querySelectorAll(".editable-cell:not(.insert-cell)").forEach((cell) => {
        cell.addEventListener("dblclick", () => startCellEdit(cell));
      });
      result.querySelectorAll(".inspectable-cell").forEach((cell) => {
        cell.addEventListener("dblclick", () => openRedisKeyDetailFromCell(cell));
      });
      result.querySelectorAll(".copyable-cell").forEach((cell) => {
        cell.addEventListener("dblclick", () => copyReadonlyCellValue(cell));
      });
      result.querySelectorAll(".insert-cell").forEach((cell) => {
        cell.addEventListener("dblclick", () => startInsertCellEdit(cell.getAttribute("data-column")));
      });
      result.querySelectorAll(".data-cell").forEach((cell) => {
        cell.addEventListener("contextmenu", (event) => openRowContextMenu(event, cell));
        cell.addEventListener("mousedown", (event) => startRowSelection(event, cell));
        cell.addEventListener("mouseenter", () => extendRowSelection(cell));
      });
    }

    function teardownResultHorizontalScrollbar() {
      if (resultHorizontalResizeObserver) {
        resultHorizontalResizeObserver.disconnect();
        resultHorizontalResizeObserver = null;
      }
      result.classList.remove("wide-table");
      result.onscroll = null;
      result.style.removeProperty("--result-header-height");
    }

    function setupResultHorizontalScrollbar() {
      const table = result.querySelector(".data-table");
      const scrollbar = result.querySelector(".table-x-scroll");
      const scrollbarInner = result.querySelector(".table-x-scroll-inner");
      if (!table || !scrollbar || !scrollbarInner) {
        teardownResultHorizontalScrollbar();
        return;
      }

      const syncScrollbarSize = () => {
        const headerHeight = table.querySelector(".data-header-row")?.getBoundingClientRect().height || 33;
        const tableWidth = table.scrollWidth;
        const viewportWidth = result.clientWidth;
        result.style.setProperty("--result-header-height", headerHeight + "px");
        scrollbar.style.width = Math.max(0, viewportWidth) + "px";
        scrollbarInner.style.width = tableWidth + "px";
        result.classList.toggle("wide-table", tableWidth > viewportWidth + 1);
        if (scrollbar.scrollLeft !== result.scrollLeft) {
          scrollbar.scrollLeft = result.scrollLeft;
        }
      };

      syncScrollbarSize();
      requestAnimationFrame(syncScrollbarSize);
      if (typeof ResizeObserver !== "undefined") {
        resultHorizontalResizeObserver = new ResizeObserver(syncScrollbarSize);
        resultHorizontalResizeObserver.observe(result);
        resultHorizontalResizeObserver.observe(table);
      }
      scrollbar.addEventListener("scroll", () => {
        if (syncingTableHorizontalScroll) return;
        syncingTableHorizontalScroll = true;
        result.scrollLeft = scrollbar.scrollLeft;
        syncingTableHorizontalScroll = false;
      });
      result.onscroll = () => {
        if (syncingTableHorizontalScroll) return;
        syncingTableHorizontalScroll = true;
        scrollbar.scrollLeft = result.scrollLeft;
        syncingTableHorizontalScroll = false;
      };
    }

    function renderQuickInsertRow(columns) {
      return '<tr class="insert-row">' + columns.map((column) => {
        if (!state.columnMeta[column]) {
          return '<td title="新增行不包含该查询列"></td>';
        }
        const displayValue = getInsertCellDisplayValue(column);
        const auto = !Object.prototype.hasOwnProperty.call(state.quickInsert.values, column) && isAutoManagedColumn(column);
        return '<td class="editable-cell insert-cell' + (auto ? ' auto-cell' : '') + '" data-column="' + escapeHtml(column) + '" title="' + escapeHtml(displayValue || '双击填写') + '"><span class="cell-value">' + renderCellDisplayValue(displayValue) + '</span></td>';
      }).join("") + '</tr>';
    }

    function getInsertCellDisplayValue(column) {
      if (Object.prototype.hasOwnProperty.call(state.quickInsert.values, column)) {
        return formatValue(state.quickInsert.values[column]);
      }
      return isAutoManagedColumn(column) ? "auto" : "";
    }

    function getSchemaColumnNames() {
      return (state.currentTable?.columns || []).map((column) => column.name);
    }

    function mergeColumns(left, right) {
      return [...new Set([...(left || []), ...(right || [])])];
    }

    function renderPagination(pagination) {
      if (!pagination || pagination.pageSize < 0 || pagination.totalRows <= pagination.pageSize) {
        pager.classList.remove("visible");
        result.classList.remove("has-pager");
        pager.innerHTML = "";
        return;
      }
      const page = Math.max(1, Math.min(pagination.page, pagination.totalPages));
      const totalPages = Math.max(1, pagination.totalPages);
      const pageButtons = buildPageButtons(page, totalPages);
      const disabledFirst = page <= 1 ? " disabled" : "";
      const disabledLast = page >= totalPages ? " disabled" : "";
      pager.innerHTML =
        '<button data-page="1"' + disabledFirst + '>首页</button>'
        + '<button data-page="' + Math.max(1, page - 1) + '"' + disabledFirst + '>上一页</button>'
        + pageButtons.map((item) => item === "..."
          ? '<span class="pager-ellipsis">...</span>'
          : '<button class="' + (item === page ? "active" : "") + '" data-page="' + item + '">' + item + '</button>'
        ).join("")
        + '<button data-page="' + Math.min(totalPages, page + 1) + '"' + disabledLast + '>下一页</button>'
        + '<button data-page="' + totalPages + '"' + disabledLast + '>最后</button>';
      pager.classList.add("visible");
      result.classList.add("has-pager");
      pager.querySelectorAll("button[data-page]").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.disabled) return;
          const nextPage = Number(button.getAttribute("data-page"));
          if (pagination.mode === "sql") {
            state.lastQueryMode = "sql";
            preserveSqlInputOnNextResult = true;
            vscode.postMessage({ type: "runSql", sql: pagination.sql || getExecutableSqlFromEditor(), limit: pagination.pageSize, page: nextPage, sortColumn: pagination.sortColumn, sortDirection: pagination.sortDirection });
          } else {
            state.lastQueryMode = "quick";
            vscode.postMessage({ type: "quickQuery", table: pagination.table || getQuickQueryTarget(), where: pagination.where || "", limit: pagination.pageSize, page: nextPage, sortColumn: pagination.sortColumn, sortDirection: pagination.sortDirection });
          }
        });
      });
    }

    function buildPageButtons(page, totalPages) {
      if (totalPages <= 4) {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
      }
      if (page <= 2) return [1, 2, "...", totalPages - 1, totalPages];
      if (page >= totalPages - 1) return [1, 2, "...", totalPages - 1, totalPages];
      if (page === 3) return [1, 2, 3, "...", totalPages];
      if (page === totalPages - 2) return [1, "...", totalPages - 2, totalPages - 1, totalPages];
      const nextPage = Math.min(page + 1, totalPages - 1);
      return [1, "...", page, nextPage, "...", totalPages];
    }

    function buildResultStatus(queryResult) {
      const pageInfo = queryResult.pagination
        ? ' · 第 ' + queryResult.pagination.page + ' / ' + queryResult.pagination.totalPages + ' 页 · 共 ' + queryResult.pagination.totalRows + ' 行'
        : '';
      return '<strong>' + queryResult.rowCount + '</strong> 行' + pageInfo + ' · ' + queryResult.elapsedMs + ' ms' + (queryResult.affectedRows !== undefined ? ' · 影响 ' + queryResult.affectedRows + ' 行' : '');
    }

	    function updateExportButton() {
	      $("#exportPreviewBtn").classList.toggle("hidden", !canExportPreview());
	      $("#importPreviewBtn").classList.toggle("hidden", !canImportPreview());
	    }

	    function canExportPreview() {
      return state.connectionType === "mysql"
        && Boolean(state.selectedTable)
        && Boolean(state.currentResult)
        && state.currentResult?.affectedRows === undefined
        && Array.isArray(state.currentResult?.columns)
        && state.currentResult.columns.length > 0
        && Array.isArray(state.currentResult?.rows);
	    }

	    function canImportPreview() {
	      return state.connectionType === "mysql"
	        && Boolean(state.selectedTable)
	        && Boolean(state.currentTable)
	        && !state.queryConsole;
	    }

	    function openImportDialog() {
	      if (!canImportPreview()) {
	        setStatus("当前只有 MySQL 表页面支持导入。", true);
	        return;
	      }
	      const mysqlConnections = (state.connections || []).filter((connection) => connection.type === "mysql");
	      if (!mysqlConnections.length) {
	        setStatus("没有可用的 MySQL 来源连接。", true);
	        return;
	      }
	      fillImportSelect(importSourceConnection, mysqlConnections, (item) => item.id, (item) => item.name + " · " + item.host + ":" + item.port);
	      const currentConnection = mysqlConnections.find((item) => item.id === state.connectionId) || mysqlConnections.find((item) => item.name === state.connectionName);
	      if (currentConnection) importSourceConnection.value = currentConnection.id;
	      importRowLimitInput.value = String(Math.max(1, Number(state.currentResult?.pagination?.pageSize || state.defaultLimit || 30)));
	      importBatchSizeInput.value = "500";
	      state.importSource = { databases: [], tables: [], columns: [], mappings: [] };
	      importSourceDatabase.innerHTML = "";
	      importSourceTable.innerHTML = "";
	      importFieldMap.innerHTML = '<div class="field-empty">请选择来源连接、数据库和表。</div>';
	      updateImportSummary();
	      importOverlay.classList.add("open");
	      loadImportSourceDatabases();
	    }

	    function closeImportDialog() {
	      importOverlay.classList.remove("open");
	    }

	    function fillImportSelect(select, items, getValue, getLabel) {
	      select.innerHTML = "";
	      (items || []).forEach((item) => {
	        const option = document.createElement("option");
	        option.value = getValue(item);
	        option.textContent = getLabel(item);
	        select.appendChild(option);
	      });
	    }

	    function loadImportSourceDatabases() {
	      const connectionId = importSourceConnection.value;
	      if (!connectionId) return;
	      setStatus("正在读取来源数据库列表...", false);
	      vscode.postMessage({ type: "loadImportSourceDatabases", connectionId });
	    }

	    function loadImportSourceTables() {
	      const connectionId = importSourceConnection.value;
	      const database = importSourceDatabase.value;
	      importSourceTable.innerHTML = "";
	      state.importSource.tables = [];
	      state.importSource.columns = [];
	      state.importSource.mappings = [];
	      renderImportMappings();
	      updateImportSummary();
	      if (!connectionId || !database) return;
	      setStatus("正在读取来源表列表...", false);
	      vscode.postMessage({ type: "loadImportSourceTables", connectionId, database });
	    }

	    function loadImportSourceSchema() {
	      const connectionId = importSourceConnection.value;
	      const database = importSourceDatabase.value;
	      const table = importSourceTable.value;
	      state.importSource.columns = [];
	      state.importSource.mappings = [];
	      renderImportMappings();
	      updateImportSummary();
	      if (!connectionId || !database || !table) return;
	      setStatus("正在读取来源表字段...", false);
	      vscode.postMessage({ type: "loadImportSourceSchema", connectionId, database, table });
	    }

	    function targetImportColumns() {
	      return (state.currentTable?.columns || []).map((column) => column.name);
	    }

	    function autoBuildImportMappings() {
	      const sourceColumns = state.importSource.columns || [];
	      const targetColumns = targetImportColumns();
	      const targetSet = new Set(targetColumns);
	      const lowerTarget = new Map(targetColumns.map((column) => [column.toLowerCase(), column]));
	      state.importSource.mappings = sourceColumns
	        .map((column) => {
	          const exact = targetSet.has(column.name) ? column.name : lowerTarget.get(String(column.name).toLowerCase());
	          return exact ? { source: column.name, target: exact } : null;
	        })
	        .filter(Boolean);
	    }

	    function renderImportMappings() {
	      const sourceColumns = state.importSource.columns || [];
	      const targetColumns = targetImportColumns();
	      if (!sourceColumns.length || !targetColumns.length) {
	        importFieldMap.innerHTML = '<div class="field-empty">选择来源表后会在这里配置字段映射。</div>';
	        return;
	      }
	      if (!state.importSource.mappings.length) {
	        importFieldMap.innerHTML = '<div class="field-empty">暂无字段映射，点击“自动匹配”或“添加映射”。</div>';
	        return;
	      }
	      importFieldMap.innerHTML = state.importSource.mappings.map((mapping, index) => {
	        return '<div class="import-map-row" data-import-map-index="' + index + '">'
	          + renderImportColumnSelect("source", index, mapping.source, sourceColumns.map((column) => column.name))
	          + '<span class="arrow">→</span>'
	          + renderImportColumnSelect("target", index, mapping.target, targetColumns)
	          + '<button class="secondary" data-remove-import-map="' + index + '">移除</button>'
	          + '</div>';
	      }).join("");
	      importFieldMap.querySelectorAll("select[data-import-map-kind]").forEach((select) => {
	        select.addEventListener("change", () => {
	          const index = Number(select.getAttribute("data-import-map-index"));
	          const kind = select.getAttribute("data-import-map-kind");
	          if (!state.importSource.mappings[index]) return;
	          state.importSource.mappings[index][kind] = select.value;
	          updateImportSummary();
	        });
	      });
	      importFieldMap.querySelectorAll("[data-remove-import-map]").forEach((button) => {
	        button.addEventListener("click", () => {
	          const index = Number(button.getAttribute("data-remove-import-map"));
	          state.importSource.mappings.splice(index, 1);
	          renderImportMappings();
	          updateImportSummary();
	        });
	      });
	    }

	    function renderImportColumnSelect(kind, index, value, columns) {
	      return '<select class="field" data-import-map-kind="' + kind + '" data-import-map-index="' + index + '">'
	        + '<option value="">不导入</option>'
	        + columns.map((column) => '<option value="' + escapeHtml(column) + '"' + (column === value ? ' selected' : '') + '>' + escapeHtml(column) + '</option>').join("")
	        + '</select>';
	    }

	    function updateImportSummary() {
	      const mapped = (state.importSource.mappings || []).filter((mapping) => mapping.source && mapping.target).length;
	      $("#importSummary").textContent = '目标表：' + (state.selectedTable || "-") + ' · 已映射 ' + mapped + ' 个字段';
	    }

	    function collectImportMappings() {
	      return (state.importSource.mappings || [])
	        .map((mapping) => ({ source: String(mapping.source || "").trim(), target: String(mapping.target || "").trim() }))
	        .filter((mapping) => mapping.source && mapping.target);
	    }

	    function submitImportDialog() {
	      const mappings = collectImportMappings();
	      if (!mappings.length) {
	        setStatus("请至少配置一个字段映射。", true);
	        return;
	      }
	      if (new Set(mappings.map((mapping) => mapping.target)).size !== mappings.length) {
	        setStatus("目标字段不能重复映射。", true);
	        return;
	      }
	      const rowLimit = Math.max(1, Math.floor(Number(importRowLimitInput.value || "0")));
	      const batchSize = Math.max(1, Math.min(5000, Math.floor(Number(importBatchSizeInput.value || "0"))));
	      if (!Number.isFinite(rowLimit) || rowLimit < 1) {
	        setStatus("导入数量必须是大于 0 的整数。", true);
	        return;
	      }
	      if (!Number.isFinite(batchSize) || batchSize < 1) {
	        setStatus("批大小必须是大于 0 的整数。", true);
	        return;
	      }
	      vscode.postMessage({
	        type: "importTableData",
	        sourceConnectionId: importSourceConnection.value,
	        sourceDatabase: importSourceDatabase.value,
	        sourceTable: importSourceTable.value,
	        targetTable: state.selectedTable,
	        mappings,
	        rowLimit,
	        batchSize,
	      });
	    }

	    function openExportDialog() {
      if (!canExportPreview()) {
        setStatus("当前只有 MySQL 表数据预览支持导出。", true);
        return;
      }
      const totalRows = getExportTotalRows();
      $("#exportTotalRows").textContent = String(totalRows);
      exportRowLimitInput.value = String(Math.max(1, totalRows || state.currentResult.rowCount || state.defaultLimit));
      exportRowLimitInput.disabled = isCurrentSqlExport();
      exportRowLimitInput.title = exportRowLimitInput.disabled ? "自定义 SQL 导出使用当前已查询结果，不会重新执行 SQL。" : "";
      exportFormatSelect.value = "xlsx";
      renderExportFields();
      syncExportFormatMode();
      exportOverlay.classList.add("open");
      if (!exportRowLimitInput.disabled) {
        exportRowLimitInput.focus();
        exportRowLimitInput.select();
      }
    }

    function closeExportDialog() {
      exportOverlay.classList.remove("open");
      exportRowLimitInput.disabled = false;
      exportRowLimitInput.title = "";
    }

    function getExportTotalRows() {
      if (isCurrentSqlExport()) {
        return Number(state.currentResult?.rowCount ?? state.currentResult?.rows?.length ?? 0);
      }
      return Number(state.currentResult?.pagination?.totalRows ?? state.currentResult?.rowCount ?? 0);
    }

    function isCurrentSqlExport() {
      return state.currentResult?.pagination?.mode === "sql" || state.lastQueryMode === "sql";
    }

    function submitExportDialog() {
      const rowLimit = isCurrentSqlExport()
        ? Math.max(1, Number(state.currentResult?.rows?.length || state.currentResult?.rowCount || 0))
        : Math.max(1, Math.floor(Number(exportRowLimitInput.value || "0")));
      if (!Number.isFinite(rowLimit) || rowLimit < 1) {
        setStatus("导出行数必须是大于 0 的整数。", true);
        return;
      }
      const exportFields = collectExportFields();
      if (!exportFields.columns.length) {
        setStatus("请至少选择一个需要导出的字段。", true);
        return;
      }
      const source = buildExportSource();
      if (!source) {
        setStatus("当前预览没有可导出的查询来源。", true);
        return;
      }
      closeExportDialog();
      vscode.postMessage({ type: "exportPreview", format: exportFormatSelect.value, rowLimit, ...source, ...exportFields });
    }

    function renderExportFields() {
      const columns = Array.isArray(state.currentResult?.columns) ? state.currentResult.columns : [];
      if (!columns.length) {
        exportFieldList.innerHTML = '<div class="field-empty">当前结果没有可导出的字段</div>';
        return;
      }
      exportFieldList.innerHTML = columns.map((column, index) => {
        const safeColumn = escapeHtml(column);
        return '<div class="export-field-item">'
          + '<span class="export-drag-handle" draggable="true" data-export-drag-index="' + index + '" title="拖拽调整导出列顺序">↕</span>'
          + '<label class="export-field-check" title="' + safeColumn + '"><input type="checkbox" data-export-column-index="' + index + '" checked /><span>' + safeColumn + '</span></label>'
          + '<input class="field export-alias" data-export-alias-index="' + index + '" placeholder="Excel 表头别名" value="' + safeColumn + '" />'
          + '</div>';
      }).join("");
      bindExportFieldDrag();
    }

    function syncExportFormatMode() {
      exportDialog.classList.toggle("sql-mode", exportFormatSelect.value === "sql");
    }

    function setExportFieldsChecked(checked) {
      exportFieldList.querySelectorAll('input[data-export-column-index]').forEach((input) => {
        input.checked = checked;
      });
    }

    function collectExportFields() {
      const columns = Array.isArray(state.currentResult?.columns) ? state.currentResult.columns : [];
      const selectedColumns = [];
      const aliases = {};
      exportFieldList.querySelectorAll(".export-field-item").forEach((item) => {
        const checkbox = item.querySelector('input[data-export-column-index]');
        const index = Number(checkbox?.getAttribute("data-export-column-index"));
        const column = columns[index];
        if (!column) return;
        if (!checkbox?.checked) return;
        selectedColumns.push(column);
        const aliasInput = item.querySelector('input[data-export-alias-index]');
        const alias = String(aliasInput?.value || "").trim();
        if (alias && alias !== column) aliases[column] = alias;
      });
      return { columns: selectedColumns, columnAliases: aliases };
    }

    function bindExportFieldDrag() {
      let draggedItem = null;
      exportFieldList.querySelectorAll(".export-drag-handle").forEach((handle) => {
        handle.addEventListener("dragstart", (event) => {
          draggedItem = handle.closest(".export-field-item");
          if (!draggedItem) return;
          draggedItem.classList.add("dragging");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", handle.getAttribute("data-export-drag-index") || "");
        });
        handle.addEventListener("dragend", () => {
          draggedItem?.classList.remove("dragging");
          draggedItem = null;
        });
      });
      exportFieldList.querySelectorAll(".export-field-item").forEach((item) => {
        item.addEventListener("dragover", (event) => {
          if (!draggedItem || draggedItem === item) return;
          event.preventDefault();
          const rect = item.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          exportFieldList.insertBefore(draggedItem, after ? item.nextSibling : item);
        });
      });
    }

    function buildExportSource() {
      const pagination = state.currentResult?.pagination;
      if (pagination?.mode === "quick") {
        return {
          mode: "quick",
          table: pagination.table || getQuickQueryTarget(),
          where: pagination.where || "",
          sortColumn: pagination.sortColumn,
          sortDirection: pagination.sortDirection,
        };
      }
      if (pagination?.mode === "sql") {
        return {
          mode: "sql",
          table: state.selectedTable,
          sql: pagination.sql || state.lastSql || getExecutableSqlFromEditor(),
          sortColumn: pagination.sortColumn,
          sortDirection: pagination.sortDirection,
          resultColumns: state.currentResult?.columns || [],
          resultRows: state.currentResult?.rows || [],
        };
      }
      if (state.lastQueryMode === "quick" || state.lastQueryMode === "preview") {
        return { mode: "quick", table: getQuickQueryTarget(), where: state.lastQueryMode === "preview" ? "" : whereInput.value, sortColumn: state.sortColumn, sortDirection: state.sortDirection };
      }
      return { mode: "sql", table: state.selectedTable, sql: state.lastSql || getExecutableSqlFromEditor(), sortColumn: state.sortColumn, sortDirection: state.sortDirection, resultColumns: state.currentResult?.columns || [], resultRows: state.currentResult?.rows || [] };
    }

    function syncFieldOptions(columns, forceSelectAll) {
      const nextColumns = [...columns];
      const hadAllSelected = state.fieldSelectionInitialized
        && state.fieldColumns.length > 0
        && state.fieldColumns.every((column) => state.selectedColumns.includes(column));
      state.fieldColumns = nextColumns;
      if (forceSelectAll || !state.fieldSelectionInitialized || hadAllSelected) {
        state.selectedColumns = [...nextColumns];
      } else {
        state.selectedColumns = state.selectedColumns.filter((column) => nextColumns.includes(column));
      }
      state.fieldSelectionInitialized = true;
      renderFieldOptions();
    }

    function renderFieldOptions() {
      if (!state.fieldColumns.length) {
        fieldOptions.innerHTML = '<div class="field-empty">查询后可选择展示字段</div>';
        return;
      }
      fieldOptions.innerHTML = state.fieldColumns.map((column, index) => {
        const checked = state.selectedColumns.includes(column) ? " checked" : "";
        return '<label class="field-option"><input type="checkbox" data-column-index="' + index + '"' + checked + ' /><span>' + escapeHtml(column) + '</span></label>';
      }).join("");
      fieldOptions.querySelectorAll("input[type='checkbox']").forEach((input) => {
        input.addEventListener("change", () => {
          const index = Number(input.getAttribute("data-column-index"));
          const column = state.fieldColumns[index];
          if (!column) return;
          if (input.checked && !state.selectedColumns.includes(column)) {
            state.selectedColumns.push(column);
          }
          if (!input.checked) {
            state.selectedColumns = state.selectedColumns.filter((item) => item !== column);
          }
          state.fieldSelectionInitialized = true;
          rerenderCurrentResult();
        });
      });
    }

    function openOperationLogs() {
      if (!state.selectedTable) {
        setStatus("请先选择一张表后再查看操作日志。", true);
        return;
      }
      logOverlay.classList.add("open");
      logList.innerHTML = '<div class="log-empty">正在读取操作日志...</div>';
      logDetail.innerHTML = '<div class="log-empty">读取后可查看 SQL 与数据对比。</div>';
      $("#logDialogMeta").textContent = state.connectionName + " / " + state.database + " / " + state.selectedTable;
      renderLogTagFilterColors();
      vscode.postMessage({ type: "loadOperationLogs", table: state.selectedTable });
    }

    function closeOperationLogs() {
      logOverlay.classList.remove("open");
    }

    function renderOperationLogs() {
      if (!logOverlay.classList.contains("open")) {
        return;
      }
      renderLogTagFilterColors();
      if (!state.operationLogs.length) {
        logList.innerHTML = '<div class="log-empty">当前表还没有操作日志。</div>';
        logDetail.innerHTML = '<div class="log-empty">通过插件执行添加、修改、删除或表结构变更后，会在这里显示记录。</div>';
        return;
      }
      const visibleLogs = getVisibleOperationLogs();
      if (!state.selectedLogId || !visibleLogs.some((log) => log.id === state.selectedLogId)) {
        state.selectedLogId = visibleLogs[0]?.id || "";
      }
      if (!visibleLogs.length) {
        logList.innerHTML = '<div class="log-empty">没有这个颜色的标记日志。</div>';
        logDetail.innerHTML = '<div class="log-empty">再次点击上方颜色可取消筛选。</div>';
        return;
      }
      logList.innerHTML = visibleLogs.map((log) => {
        const active = log.id === state.selectedLogId ? " active" : "";
        const statusClass = log.status === "failed" ? " failed" : "";
        const rollbackMark = log.isRollback ? '<span class="rollback-badge">回滚</span>' : '';
        const tagHtml = log.tagLabel && !log.isRollback ? '<span class="log-tag-line"><span class="log-tag-pill tag-' + escapeHtml(getLogTagColor(log.tagColor)) + '" title="' + escapeHtml(log.tagLabel) + '">' + escapeHtml(log.tagLabel) + '</span></span>' : '';
        const title = getLogSqlTitle(log);
        return '<button class="log-item' + active + '" data-log-id="' + escapeHtml(log.id) + '">'
          + '<span class="log-item-main"><span class="log-title-left"><span class="log-op">' + escapeHtml(title) + '</span>' + rollbackMark + tagHtml + '</span><span class="log-status' + statusClass + '">' + escapeHtml(formatLogStatus(log.status)) + '</span></span>'
          + '<span class="log-item-time">' + escapeHtml(formatLogTime(log.createdAt)) + '</span>'
          + '</button>';
      }).join("");
      logList.querySelectorAll(".log-item").forEach((button) => {
        button.addEventListener("click", () => {
          selectOperationLog(button.getAttribute("data-log-id") || "");
        });
        button.addEventListener("contextmenu", (event) => {
          openLogContextMenu(event, button.getAttribute("data-log-id") || "");
        });
      });
      renderOperationLogDetail(visibleLogs.find((log) => log.id === state.selectedLogId) || visibleLogs[0]);
    }

    function renderOperationLogDetail(log) {
      if (!log) {
        logDetail.innerHTML = '<div class="log-empty">请选择一条日志。</div>';
        return;
      }
      const errorHtml = log.errorMessage
        ? '<div class="log-section-title">错误信息</div><pre class="log-sql">' + escapeHtml(log.errorMessage) + '</pre>'
        : '';
      const aiAnalysisHtml = log.errorMessage
        ? log.aiAnalysis
          ? '<div class="log-section-title">AI 记录</div><pre class="log-sql">' + escapeHtml(log.aiAnalysis) + '</pre>'
          : '<div class="log-ai-actions"><button class="secondary" id="analyzeLogErrorBtn">AI 分析</button></div>'
        : '';
      const snapshots = log.snapshots || [];
      const compareHtml = snapshots.length
        ? snapshots.map((snapshot) => renderLogSnapshot(snapshot)).join("")
        : '<div class="log-empty">这条日志只记录 SQL，没有可对比的数据快照。</div>';
      const rollback = getRollbackAvailability(log);
      const rollbackDisabled = rollback.enabled ? "" : " disabled";
      const rollbackCount = (log.rollbackLogs || []).length;
      const rollbackBadge = rollbackCount > 0 ? '<span class="rollback-badge">已回滚 ' + rollbackCount + '</span>' : '';
      const relationHtml = renderRollbackRelation(log);
      const rollbackErrorHtml = state.rollbackError?.logId === log.id
        ? '<span class="log-inline-error">' + escapeHtml(state.rollbackError.message) + '</span>'
        : '';
      logDetail.innerHTML = '<div class="log-detail-head">'
        + '<div class="log-section-title-row"><div class="log-section-title">SQL</div>' + rollbackErrorHtml + '</div>'
        + '<div class="log-detail-actions">' + rollbackBadge + '<button class="log-rollback" id="rollbackLogBtn"' + rollbackDisabled + ' title="' + escapeHtml(rollback.reason) + '">回滚</button></div>'
        + '</div>'
        + '<pre class="log-sql">' + escapeHtml(log.sql || "") + '</pre>'
        + relationHtml.beforeData
        + errorHtml
        + aiAnalysisHtml
        + '<div class="log-section-title">修改前 / 修改后 / 当前数据</div>'
        + compareHtml
        + relationHtml.afterData;
      const rollbackButton = $("#rollbackLogBtn");
      if (rollbackButton && rollback.enabled) {
        rollbackButton.addEventListener("click", () => rollbackOperationLog(log.id));
      }
      const analyzeButton = $("#analyzeLogErrorBtn");
      if (analyzeButton) {
        analyzeButton.addEventListener("click", () => analyzeOperationLogError(log.id));
      }
      logDetail.querySelectorAll("[data-log-jump]").forEach((button) => {
        button.addEventListener("click", () => selectOperationLog(button.getAttribute("data-log-jump") || ""));
      });
    }

    function renderRollbackRelation(log) {
      if (log.isRollback && log.rollbackOfLogId) {
        const source = findOperationLog(log.rollbackOfLogId);
        return {
          beforeData: '<div class="log-relation">'
            + '<div class="log-relation-title"><strong>这是一条回滚执行日志</strong><button class="log-jump" data-log-jump="' + escapeHtml(log.rollbackOfLogId) + '">跳转原日志</button></div>'
            + '<pre class="log-relation-sql">' + escapeHtml(source ? source.sql : "原日志不在当前列表中") + '</pre>'
            + '</div>',
          afterData: "",
        };
      }
      const rollbackLogs = log.rollbackLogs || [];
      if (!rollbackLogs.length) {
        return { beforeData: "", afterData: "" };
      }
      return {
        beforeData: "",
        afterData: '<div class="log-section-title">回滚记录</div>' + rollbackLogs.map((rollbackLog) => {
          return '<div class="log-relation">'
            + '<div class="log-relation-title"><strong>' + escapeHtml(formatLogTime(rollbackLog.completedAt || rollbackLog.createdAt)) + ' 回滚</strong><button class="log-jump" data-log-jump="' + escapeHtml(rollbackLog.id) + '">跳转回滚日志</button></div>'
            + '<pre class="log-relation-sql">' + escapeHtml(rollbackLog.sql || "") + '</pre>'
            + '</div>';
        }).join(""),
      };
    }

    function selectOperationLog(logId) {
      if (!logId) return;
      if (!findOperationLog(logId)) {
        setStatus("目标日志不在当前列表中。", true);
        return;
      }
      state.selectedLogId = logId;
      renderOperationLogs();
    }

    function findOperationLog(logId) {
      return state.operationLogs.find((log) => log.id === logId);
    }

    function getVisibleOperationLogs() {
      const activeColor = getLogTagColor(state.activeLogTagColor);
      if (!state.activeLogTagColor) {
        return state.operationLogs;
      }
      return state.operationLogs.filter((log) => !log.isRollback && log.tagLabel && getLogTagColor(log.tagColor) === activeColor);
    }

    function renderLogTagFilterColors() {
      logTagFilterColors.innerHTML = logTagColorOptions.map((item) => {
        const active = state.activeLogTagColor === item.key ? " active" : "";
        return '<button class="log-filter-dot tag-' + item.key + active + '" data-log-filter-color="' + item.key + '" title="筛选' + item.label + '标签" aria-label="筛选' + item.label + '标签"></button>';
      }).join("");
      logTagFilterColors.querySelectorAll("[data-log-filter-color]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const color = getLogTagColor(button.getAttribute("data-log-filter-color"));
          state.activeLogTagColor = state.activeLogTagColor === color ? "" : color;
          renderOperationLogs();
        });
      });
    }

    function openLogContextMenu(event, logId) {
      event.preventDefault();
      event.stopPropagation();
      if (!logId || !findOperationLog(logId)) return;
      selectOperationLog(logId);
      state.logContextLogId = logId;
      const left = Math.min(event.clientX, window.innerWidth - 124);
      const top = Math.min(event.clientY, window.innerHeight - 48);
      logContextMenu.style.left = Math.max(8, left) + "px";
      logContextMenu.style.top = Math.max(8, top) + "px";
      logContextMenu.classList.add("open");
    }

    function hideLogContextMenu() {
      if (!logContextMenu) return;
      logContextMenu.classList.remove("open");
    }

    function openLogTagDialog(logId) {
      const log = findOperationLog(logId);
      if (!log) return;
      hideLogContextMenu();
      if (log.isRollback) {
        setStatus("该记录为回滚记录不支持标记", true);
        return;
      }
      state.logTagDraft = { logId: log.id, color: getLogTagColor(log.tagColor) };
      $("#logTagMeta").textContent = getLogSqlTitle(log) + " / " + formatLogTime(log.createdAt);
      logTagInput.value = log.tagLabel || "";
      renderLogTagColorOptions();
      logTagOverlay.classList.add("open");
      setTimeout(() => {
        logTagInput.focus();
        logTagInput.setSelectionRange(logTagInput.value.length, logTagInput.value.length);
      }, 0);
    }

    function closeLogTagDialog() {
      if (!logTagOverlay) return;
      logTagOverlay.classList.remove("open");
    }

    function renderLogTagColorOptions() {
      logTagColors.innerHTML = logTagColorOptions.map((item) => {
        const active = item.key === getLogTagColor(state.logTagDraft.color) ? " active" : "";
        return '<button class="tag-color-button tag-' + item.key + active + '" data-log-tag-color="' + item.key + '" title="' + item.label + '" aria-label="' + item.label + '"></button>';
      }).join("");
      logTagColors.querySelectorAll("[data-log-tag-color]").forEach((button) => {
        button.addEventListener("click", () => {
          state.logTagDraft.color = getLogTagColor(button.getAttribute("data-log-tag-color"));
          renderLogTagColorOptions();
        });
      });
    }

    function saveOperationLogTag() {
      const logId = state.logTagDraft.logId;
      if (!logId || !findOperationLog(logId)) return;
      const label = logTagInput.value.trim();
      vscode.postMessage({ type: "markOperationLog", logId, label, color: getLogTagColor(state.logTagDraft.color) });
      closeLogTagDialog();
      setStatus(label ? "正在保存日志标记..." : "正在清除日志标记...", false);
    }

    function getLogTagColor(color) {
      return logTagColorOptions.some((item) => item.key === color) ? color : "blue";
    }

    function rollbackOperationLog(logId) {
      if (!logId) return;
      state.rollbackingLogId = logId;
      state.rollbackError = null;
      const button = $("#rollbackLogBtn");
      if (button) {
        button.disabled = true;
        button.textContent = "回滚中...";
      }
      vscode.postMessage({ type: "rollbackOperationLog", logId });
    }

    function analyzeOperationLogError(logId) {
      if (!logId) return;
      const button = $("#analyzeLogErrorBtn");
      if (button) {
        button.disabled = true;
        button.textContent = "分析中...";
      }
      vscode.postMessage({ type: "analyzeOperationLogError", logId });
    }

    function getRollbackAvailability(log) {
      if (!log || log.status !== "success") {
        return { enabled: false, reason: "只有执行成功的日志可以回滚" };
      }
      const snapshots = log.snapshots || [];
      if (!snapshots.length) {
        return { enabled: false, reason: "这条日志没有数据快照，无法直接回滚" };
      }
      if (log.operationType === "delete") {
        return snapshots.every((snapshot) => snapshot.beforeData && Object.keys(snapshot.beforeData).length > 0)
          ? { enabled: true, reason: "执行 INSERT 恢复删除前数据" }
          : { enabled: false, reason: "删除日志缺少修改前数据，无法回滚" };
      }
      if (log.operationType === "insert") {
        return snapshots.every((snapshot) => snapshot.rowKey && Object.keys(snapshot.rowKey).length > 0)
          ? { enabled: true, reason: "执行 DELETE 删除这次新增的数据" }
          : { enabled: false, reason: "新增日志缺少主键，无法回滚" };
      }
      if (log.operationType === "update") {
        const deletedSnapshot = snapshots.find((snapshot) => snapshot.currentData === null);
        if (deletedSnapshot) {
          return { enabled: false, reason: "当前主键对应的数据已删除，无法回滚 UPDATE" };
        }
        return snapshots.every((snapshot) => snapshot.rowKey && Object.keys(snapshot.rowKey).length > 0 && snapshot.beforeData)
          ? { enabled: true, reason: "执行 UPDATE 恢复修改前字段值" }
          : { enabled: false, reason: "修改日志缺少主键或修改前数据，无法回滚" };
      }
      return { enabled: false, reason: "表结构或自定义 SQL 日志暂不支持直接回滚" };
    }

    function renderLogSnapshot(snapshot) {
      const beforeData = snapshot.beforeData || null;
      const afterData = snapshot.afterData || null;
      const currentData = snapshot.currentData;
      const columns = collectLogColumns(beforeData, afterData, currentData);
      const keyText = JSON.stringify(snapshot.rowKey || {});
      if (!columns.length) {
        return '<div class="log-row-card"><div class="log-row-key">' + escapeHtml(keyText) + '</div><div class="log-empty">没有可展示的数据快照。</div></div>';
      }
      const rows = columns.map((column) => {
        const beforeValue = beforeData ? beforeData[column] : undefined;
        const afterValue = afterData ? afterData[column] : undefined;
        const currentValue = currentData ? currentData[column] : undefined;
        const changed = normalizeCompareValue(beforeValue) !== normalizeCompareValue(afterValue) ? ' class="changed"' : "";
        return '<tr>'
          + '<td>' + escapeHtml(column) + '</td>'
          + '<td' + changed + '>' + escapeHtml(formatSnapshotValue(beforeData, beforeValue)) + '</td>'
          + '<td' + changed + '>' + escapeHtml(formatSnapshotValue(afterData, afterValue)) + '</td>'
          + '<td>' + escapeHtml(formatSnapshotValue(currentData, currentValue, true)) + '</td>'
          + '</tr>';
      }).join("");
      return '<div class="log-row-card">'
        + '<div class="log-row-key">主键：' + escapeHtml(keyText) + '</div>'
        + '<table class="log-compare"><thead><tr><th>字段</th><th>修改前</th><th>修改后</th><th>当前数据</th></tr></thead><tbody>' + rows + '</tbody></table>'
        + '</div>';
    }

    function collectLogColumns(...items) {
      const columns = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        for (const key of Object.keys(item)) {
          if (!columns.includes(key)) columns.push(key);
        }
      }
      return columns;
    }

    function formatSnapshotValue(container, value, current = false) {
      if (container === undefined && current) return "未查询";
      if (container === null && current) return "已删除";
      if (!container) return "";
      return formatValue(value);
    }

    function normalizeCompareValue(value) {
      return value === undefined ? "" : JSON.stringify(value);
    }

    function formatLogStatus(status) {
      if (status === "success") return "成功";
      if (status === "failed") return "失败";
      return "待执行";
    }

    function getLogSqlTitle(log) {
      const sql = stripSqlLeadingComments(log.sql || "");
      const match = sql.match(/^([a-zA-Z]+)/);
      return (match ? match[1] : log.operationType || "SQL").toUpperCase();
    }

    function stripSqlLeadingComments(sql) {
      let text = String(sql || "").trim();
      while (true) {
        if (text.startsWith("--")) {
          const lineEnd = text.indexOf("\\n");
          text = lineEnd >= 0 ? text.slice(lineEnd + 1).trim() : "";
          continue;
        }
        if (text.startsWith("/*")) {
          const blockEnd = text.indexOf("*/");
          if (blockEnd < 0) return text;
          text = text.slice(blockEnd + 2).trim();
          continue;
        }
        return text;
      }
    }

    function formatLogTime(value) {
      if (!value) return "";
      return formatBeijingDateTime(value);
    }

    function getVisibleColumns(columns) {
      if (!columns.length) return [];
      const selected = new Set(state.selectedColumns);
      return columns.filter((column) => selected.has(column) || !state.fieldColumns.includes(column));
    }

    function rerenderCurrentResult() {
      if (!state.currentResult) return;
      state.sortColumn = getVisibleColumns(state.currentResult.columns || []).includes(state.sortColumn) ? state.sortColumn : "";
      state.sortDirection = state.sortColumn ? state.sortDirection : "asc";
      const rows = [...(state.currentResult.rows || [])];
      const entries = rows.map((row, index) => ({ row, index }));
      if (state.sortColumn) {
        entries.sort((left, right) => {
          const compared = compareValues(left.row[state.sortColumn], right.row[state.sortColumn]);
          return state.sortDirection === "desc" ? -compared : compared;
        });
      }
      renderResultTable(state.currentResult, entries);
    }

    function sortResultByColumn(column) {
      if (!state.currentResult || !column) return;
      if (!canSortResultHeaders(state.currentResult)) return;
      const nextDirection = state.sortColumn === column && state.sortDirection === "desc" ? "asc" : "desc";
      if (state.currentResult.pagination && hasPendingEdits()) {
        setStatus("请先提交当前修改后再排序。", true);
        return;
      }
      state.sortColumn = column;
      state.sortDirection = nextDirection;
      if (state.currentResult.pagination) {
        requestSortedResult(column, nextDirection);
        return;
      }
      const sortedRows = [...(state.currentResult.rows || [])].map((row, index) => ({ row, index })).sort((left, right) => {
        const compared = compareValues(left.row[column], right.row[column]);
        return nextDirection === "desc" ? -compared : compared;
      });
      renderResultTable(state.currentResult, sortedRows);
    }

    function canSortResultHeaders(queryResult) {
      return state.connectionType !== "redis" && queryResult?.command !== "KEYS_PAGE";
    }

    function requestSortedResult(column, direction) {
      const pagination = state.currentResult?.pagination;
      if (!pagination) return;
      if (pagination.mode === "sql") {
        state.lastQueryMode = "sql";
        preserveSqlInputOnNextResult = true;
        vscode.postMessage({ type: "runSql", sql: pagination.sql || getExecutableSqlFromEditor(), limit: pagination.pageSize, page: 1, sortColumn: column, sortDirection: direction });
        return;
      }
      state.lastQueryMode = "quick";
      vscode.postMessage({ type: "quickQuery", table: pagination.table || getQuickQueryTarget(), where: pagination.where || "", limit: pagination.pageSize, page: 1, sortColumn: column, sortDirection: direction });
    }

    function compareValues(left, right) {
      const leftEmpty = left === null || left === undefined;
      const rightEmpty = right === null || right === undefined;
      if (leftEmpty && rightEmpty) return 0;
      if (leftEmpty) return 1;
      if (rightEmpty) return -1;

      const leftNumber = typeof left === "number" ? left : Number(left);
      const rightNumber = typeof right === "number" ? right : Number(right);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
      }

      return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    }

    function startRowSelection(event, cell) {
      if (event.button !== 0 || cell.classList.contains("insert-cell") || hasPendingEdits()) return;
      const row = cell.closest(".data-row");
      if (!row) return;
      const rowIndex = Number(row.getAttribute("data-row-index"));
      const rowOrder = Number(row.getAttribute("data-row-order"));
      if (!Number.isInteger(rowIndex) || !Number.isInteger(rowOrder)) return;
      event.preventDefault();
      const alreadySelected = state.rowSelection.selected.length === 1
        && state.rowSelection.selected[0] === rowIndex
        && !state.rowSelection.deleting;
      if (alreadySelected) {
        clearRowSelection();
        activeContextRowIndex = null;
        renderRowSelection();
        return;
      }
      state.rowSelection = { selected: [rowIndex], dragging: true, anchor: rowOrder, deleting: false };
      activeContextRowIndex = rowIndex;
      renderRowSelection();
    }

    function extendRowSelection(cell) {
      if (!state.rowSelection.dragging) return;
      const row = cell.closest(".data-row");
      if (!row) return;
      const rowOrder = Number(row.getAttribute("data-row-order"));
      if (!Number.isInteger(rowOrder)) return;
      selectRowsByRenderRange(state.rowSelection.anchor, rowOrder);
    }

    function selectRowsByRenderRange(startOrder, endOrder) {
      const start = Math.min(startOrder, endOrder);
      const end = Math.max(startOrder, endOrder);
      const selected = [];
      result.querySelectorAll(".data-row").forEach((row) => {
        const order = Number(row.getAttribute("data-row-order"));
        const rowIndex = Number(row.getAttribute("data-row-index"));
        if (Number.isInteger(order) && Number.isInteger(rowIndex) && order >= start && order <= end) {
          selected.push(rowIndex);
        }
      });
      state.rowSelection.selected = selected;
      state.rowSelection.deleting = false;
      renderRowSelection();
    }

    function setRowSelection(rowIndexes) {
      state.rowSelection.selected = [...new Set(rowIndexes.filter(Number.isInteger))];
      state.rowSelection.dragging = false;
      state.rowSelection.deleting = false;
      renderRowSelection();
    }

    function clearRowSelection() {
      state.rowSelection = { selected: [], dragging: false, anchor: null, deleting: false };
    }

    function renderRowSelection() {
      const selected = new Set(state.rowSelection.selected);
      result.querySelectorAll(".data-row").forEach((row) => {
        const rowIndex = Number(row.getAttribute("data-row-index"));
        const isSelected = selected.has(rowIndex);
        row.classList.toggle("selected-row", isSelected && !state.rowSelection.deleting);
        row.classList.toggle("deleting-row", isSelected && state.rowSelection.deleting);
      });
      updateDeleteRowButtonText();
    }

    function updateDeleteRowButtonText() {
      const count = state.rowSelection.selected.length;
      $("#deleteRowBtn").textContent = count > 1 ? "删除选中 " + count + " 行" : "删除该行";
    }

    function openRowContextMenu(event, cell) {
      event.preventDefault();
      event.stopPropagation();
      if (hasPendingEdits()) {
        setStatus("请先提交当前修改后再删除。", true);
        return;
      }
      if (state.connectionType !== "redis" && !state.primaryKeys.length) {
        setStatus("当前表没有读取到主键，无法按行删除。", true);
        return;
      }
      const rowIndex = Number(cell.getAttribute("data-row-index"));
      const row = state.currentResult?.rows?.[rowIndex];
      if (state.connectionType === "redis") {
        if (!row?.key) {
          setStatus("无法删除：当前行没有 Redis Key。", true);
          return;
        }
      } else if (!getPrimaryValuesForRow(row)) {
        return;
      }
      if (!state.rowSelection.selected.includes(rowIndex)) {
        setRowSelection([rowIndex]);
      } else {
        renderRowSelection();
      }
      activeContextRowIndex = rowIndex;
      const left = Math.min(event.clientX, window.innerWidth - 132);
      const top = Math.min(event.clientY, window.innerHeight - 48);
      rowContextMenu.style.left = Math.max(8, left) + "px";
      rowContextMenu.style.top = Math.max(8, top) + "px";
      rowContextMenu.classList.add("open");
    }

    function hideRowContextMenu() {
      if (!rowContextMenu) return;
      rowContextMenu.classList.remove("open");
      activeContextRowIndex = null;
      updateDeleteRowButtonText();
    }

    function deleteContextRow() {
      const selectedRows = state.rowSelection.selected.length ? [...state.rowSelection.selected] : [activeContextRowIndex];
      hideRowContextMenu();
      if (!selectedRows.some(Number.isInteger)) return;
      if (state.connectionType === "redis") {
        const keys = selectedRows
          .map((rowIndex) => state.currentResult?.rows?.[rowIndex]?.key)
          .map((key) => String(key || "").trim())
          .filter(Boolean);
        if (!keys.length) {
          setStatus("无法删除：未找到 Redis Key。", true);
          return;
        }
        state.rowSelection.deleting = true;
        renderRowSelection();
        vscode.postMessage({ type: "redisDeleteKeys", keys });
        return;
      }
      if (!state.selectedTable) {
        setStatus("无法删除：未选择表。", true);
        return;
      }
      const primaryValuesList = [];
      for (const rowIndex of selectedRows) {
        const row = state.currentResult?.rows?.[rowIndex];
        const primaryValues = getPrimaryValuesForRow(row);
        if (!primaryValues) return;
        primaryValuesList.push(primaryValues);
      }
      if (!primaryValuesList.length) return;
      state.rowSelection.deleting = true;
      renderRowSelection();
      vscode.postMessage({ type: "deleteRows", table: state.selectedTable, primaryKeys: state.primaryKeys, primaryValuesList });
    }

    function getPrimaryValuesForRow(row) {
      if (!row) {
        setStatus("无法删除：未找到当前行数据。", true);
        return null;
      }
      const primaryValues = {};
      for (const primaryKey of state.primaryKeys) {
        if (row[primaryKey] === undefined || row[primaryKey] === null) {
          setStatus("无法删除：结果中缺少主键字段 " + primaryKey + "。", true);
          return null;
        }
        primaryValues[primaryKey] = row[primaryKey];
      }
      return primaryValues;
    }

    function toggleQuickInsert() {
      if (state.quickInsert.active) {
        cancelQuickInsert();
        return;
      }
      startQuickInsert();
    }

    function startQuickInsert() {
      if (!state.selectedTable || !state.currentTable) {
        setStatus("请先从左侧数据库树选择一张表。", true);
        return;
      }
      state.quickInsert = { active: true, values: { ...(state.quickInsert?.values || {}) } };
      if (!state.currentResult) {
        const columns = getSchemaColumnNames();
        state.currentResult = { columns, rows: [], rowCount: 0, elapsedMs: 0 };
        syncFieldOptions(columns, false);
      }
      updateQuickButton();
      renderResultPreservingState();
    }

    function cancelQuickInsert() {
      state.quickInsert = { active: false, values: {} };
      updateQuickButton();
      renderResultPreservingState();
      restoreResultStatus();
    }

    function startCellEdit(cell) {
      const rowIndex = Number(cell.getAttribute("data-row-index"));
      const column = cell.getAttribute("data-column");
      if (!state.currentResult || !column || !Number.isInteger(rowIndex)) return;
      const row = state.currentResult.rows[rowIndex];
      if (!canEditColumn(column, row)) return;

      const editKey = buildEditKey(rowIndex, column);
      const temporalKind = getTemporalKind(column);
      const columnType = state.columnTypes[column] || "";
      const nullable = isNullableColumn(column);
      const enumValues = getEnumValues(column);
      const enumLike = enumValues.length > 0;
      const pendingValue = state.pendingEdits[editKey]?.newValue;
      const sourceValue = pendingValue !== undefined ? pendingValue : row[column];
      if (state.connectionType === "redis" && column === "value" && isTruncatedRedisPreview(sourceValue)) {
        setStatus("当前 Redis 值只是安全预览，已截断；请使用 GETRANGE 查看片段，避免误覆盖完整大值。", true);
        return;
      }
      const redisTtlEdit = state.connectionType === "redis" && column === "ttl";
      const redisJsonLike = isRedisJsonValueColumn(column, sourceValue);
      const jsonLike = isJsonColumn(column) || redisJsonLike;
      const initialValue = redisTtlEdit ? getRedisTtlEditableValue(sourceValue) : toEditableValue(sourceValue, temporalKind, jsonLike);
      activeEdit = { rowIndex, column, temporalKind, jsonLike, redisTtlEdit, enumLike, enumValues, enumSelected: initialValue, nullable, nullSelected: false };
      $("#editDialogTitle").textContent = redisTtlEdit ? "设置过期时间" : state.connectionType === "redis" ? "编辑" : "编辑字段值";
      $("#editDialogMeta").textContent = buildEditFieldMeta(column, row);
      editShortcuts.classList.toggle("visible", Boolean(temporalKind || jsonLike || nullable || redisTtlEdit));
      $("#fillNowBtn").classList.toggle("hidden", !temporalKind);
      $("#formatJsonBtn").classList.toggle("hidden", !jsonLike);
      $("#setNullBtn").classList.toggle("hidden", !nullable);
      if (redisTtlEdit) {
        editShortcutLabel.textContent = "支持 10、1s、1m、1h、1d；不带单位默认秒。输入 persist 或 -1 可取消过期时间。";
      } else if (temporalKind) {
        $("#fillNowBtn").textContent = getNowButtonText(temporalKind);
        editShortcutLabel.textContent = "检测到时间类型 " + columnType + "，将按北京时间填入。" + (nullable ? " 也可以设为 NULL。" : "");
      } else if (jsonLike) {
        editShortcutLabel.textContent = state.connectionType === "redis"
          ? "检测到当前 Redis 字符串值是 JSON，可格式化并校验当前内容。"
          : "检测到 JSON 类型 " + columnType + "，可格式化并校验当前内容。" + (nullable ? " 也可以设为 NULL。" : "");
      } else if (nullable) {
        editShortcutLabel.textContent = "当前字段允许为空，可快捷设置为数据库 NULL。";
      }
      cellEditor.classList.toggle("json-editor", jsonLike);
      cellEditor.classList.toggle("hidden", enumLike);
      jsonEditorWrap.classList.toggle("hidden", enumLike);
      jsonEditorWrap.classList.toggle("json-active", jsonLike && !enumLike);
      enumEditor.classList.toggle("visible", enumLike);
      clearEditError();
      if (enumLike) {
        clearJsonHighlight();
        renderEnumEditor(enumValues, toEditableValue(row[column]), initialValue);
      } else {
        cellEditor.value = initialValue;
        cellEditor.placeholder = redisTtlEdit ? "例如 10、1s、1m、1h、1d" : "";
        updateJsonHighlight();
      }
      editOverlay.classList.add("open");
      setTimeout(() => {
        if (enumLike) {
          enumOptions.querySelector(".enum-option.selected")?.focus();
        } else {
          cellEditor.focus();
          moveCursorToEnd(cellEditor);
        }
      }, 0);
    }

    function startInsertCellEdit(column) {
      if (!column || !state.quickInsert.active) return;
      const temporalKind = getTemporalKind(column);
      const columnType = state.columnTypes[column] || "";
      const jsonLike = isJsonColumn(column);
      const nullable = isNullableColumn(column);
      const enumValues = getEnumValues(column);
      const enumLike = enumValues.length > 0;
      const hasValue = Object.prototype.hasOwnProperty.call(state.quickInsert.values, column);
      const initialValue = hasValue ? toEditableValue(state.quickInsert.values[column], temporalKind, jsonLike) : "";
      activeEdit = { mode: "insert", rowIndex: -1, column, temporalKind, jsonLike, enumLike, enumValues, enumSelected: initialValue, nullable, nullSelected: false };
      $("#editDialogTitle").textContent = "填写新增字段";
      $("#editDialogMeta").textContent = buildEditFieldMeta(column, null, { insert: true });
      editShortcuts.classList.toggle("visible", Boolean(temporalKind || jsonLike || nullable));
      $("#fillNowBtn").classList.toggle("hidden", !temporalKind);
      $("#formatJsonBtn").classList.toggle("hidden", !jsonLike);
      $("#setNullBtn").classList.toggle("hidden", !nullable);
      if (temporalKind) {
        $("#fillNowBtn").textContent = getNowButtonText(temporalKind);
        editShortcutLabel.textContent = "检测到时间类型 " + columnType + "，将按北京时间填入。" + (nullable ? " 也可以设为 NULL。" : "");
      } else if (jsonLike) {
        editShortcutLabel.textContent = "检测到 JSON 类型 " + columnType + "，可格式化并校验当前内容。" + (nullable ? " 也可以设为 NULL。" : "");
      } else if (nullable) {
        editShortcutLabel.textContent = "当前字段允许为空，可快捷设置为数据库 NULL。";
      }
      cellEditor.classList.toggle("json-editor", jsonLike);
      cellEditor.classList.toggle("hidden", enumLike);
      jsonEditorWrap.classList.toggle("hidden", enumLike);
      jsonEditorWrap.classList.toggle("json-active", jsonLike && !enumLike);
      enumEditor.classList.toggle("visible", enumLike);
      clearEditError();
      if (enumLike) {
        clearJsonHighlight();
        renderEnumEditor(enumValues, hasValue ? toEditableValue(state.quickInsert.values[column]) : "auto", initialValue);
      } else {
        cellEditor.value = initialValue;
        updateJsonHighlight();
      }
      editOverlay.classList.add("open");
      setTimeout(() => {
        if (enumLike) {
          enumOptions.querySelector(".enum-option.selected")?.focus();
        } else {
          cellEditor.focus();
          moveCursorToEnd(cellEditor);
        }
      }, 0);
    }

    function commitDialogEdit(shouldSubmit) {
      if (!activeEdit || !state.currentResult) return;
      const { rowIndex, column, temporalKind, jsonLike, enumLike, redisTtlEdit } = activeEdit;
      if (activeEdit.mode === "insert") {
        commitInsertDialogEdit(column, temporalKind, jsonLike, enumLike, shouldSubmit);
        return;
      }
      const row = state.currentResult.rows[rowIndex];
      const oldValue = toEditableValue(row[column], temporalKind, jsonLike);
      let newValue = activeEdit.nullSelected ? null : (enumLike ? activeEdit.enumSelected : cellEditor.value);
      let comparableOldValue = row[column] === null || row[column] === undefined ? null : oldValue;
      let comparableNewValue = newValue;
      const editKey = buildEditKey(rowIndex, column);
      if (redisTtlEdit) {
        newValue = String(newValue ?? "").trim();
        if (!newValue) {
          delete state.pendingEdits[editKey];
          closeCellEditDialog();
          updateQuickButton();
          renderResultPreservingState();
          return;
        }
        comparableNewValue = newValue;
      }
      if (jsonLike && newValue !== null) {
        const compactNewValue = compactJsonText(newValue);
        if (compactNewValue === undefined) return;
        const compactOldValue = compactJsonText(oldValue, false);
        newValue = compactNewValue;
        comparableNewValue = compactNewValue;
        comparableOldValue = compactOldValue ?? oldValue;
      }
      if (comparableNewValue === comparableOldValue) {
        delete state.pendingEdits[editKey];
      } else {
        state.pendingEdits[editKey] = { rowIndex, column, oldValue, newValue };
      }
      closeCellEditDialog();
      updateQuickButton();
      renderResultPreservingState();
      if (shouldSubmit && hasPendingEdits()) {
        submitPendingEdits();
      }
    }

    function commitInsertDialogEdit(column, temporalKind, jsonLike, enumLike, shouldSubmit) {
      let newValue = activeEdit.nullSelected ? null : (enumLike ? activeEdit.enumSelected : cellEditor.value);
      if (jsonLike && newValue !== null) {
        const compactNewValue = compactJsonText(newValue);
        if (compactNewValue === undefined) return;
        newValue = compactNewValue;
      }
      if (newValue === "" && isAutoManagedColumn(column)) {
        delete state.quickInsert.values[column];
      } else {
        state.quickInsert.values[column] = newValue;
      }
      closeCellEditDialog();
      updateQuickButton();
      renderResultPreservingState();
      if (shouldSubmit && hasPendingEdits()) {
        submitPendingEdits();
      }
    }

    function closeCellEditDialog() {
      activeEdit = null;
      editShortcuts.classList.remove("visible");
      $("#fillNowBtn").classList.remove("hidden");
      $("#formatJsonBtn").classList.add("hidden");
      $("#setNullBtn").classList.add("hidden");
      cellEditor.classList.remove("json-editor");
      cellEditor.classList.remove("hidden");
      jsonEditorWrap.classList.remove("json-active");
      jsonEditorWrap.classList.remove("hidden");
      clearJsonHighlight();
      cellEditor.placeholder = "";
      enumEditor.classList.remove("visible");
      enumOptions.innerHTML = "";
      clearEditError();
      editOverlay.classList.remove("open");
    }

    function submitPendingEdits() {
      if (!hasPendingEdits()) return;
      if (state.connectionType === "redis") {
        submitRedisPendingEdits();
        return;
      }
      if (!state.selectedTable) {
        setStatus("无法提交：未选择表。", true);
        return;
      }
      if (state.quickInsert.active) {
        vscode.postMessage({ type: "insertRow", table: state.selectedTable, values: state.quickInsert.values });
        return;
      }
      if (!state.primaryKeys.length) {
        setStatus("无法提交：当前表没有读取到主键。", true);
        return;
      }
      const byRow = new Map();
      for (const edit of Object.values(state.pendingEdits)) {
        const row = state.currentResult?.rows?.[edit.rowIndex];
        if (!row) continue;
        const primaryValues = {};
        for (const primaryKey of state.primaryKeys) {
          if (row[primaryKey] === undefined || row[primaryKey] === null) {
            setStatus("无法提交：结果中缺少主键字段 " + primaryKey + "。", true);
            return;
          }
          primaryValues[primaryKey] = row[primaryKey];
        }
        const existing = byRow.get(edit.rowIndex) || { primaryValues, changes: {} };
        existing.changes[edit.column] = edit.newValue;
        byRow.set(edit.rowIndex, existing);
      }
	      const updates = [...byRow.values()].filter((item) => Object.keys(item.changes).length > 0);
	      if (!updates.length) return;
	      vscode.postMessage({ type: "updateCells", table: state.selectedTable, primaryKeys: state.primaryKeys, updates, refreshQuery: getQuickRefreshQueryForEdits() });
	    }

	    function getQuickRefreshQueryForEdits() {
	      const pagination = state.currentResult?.pagination;
	      if (pagination?.mode === "quick") {
	        return {
	          table: pagination.table || getQuickQueryTarget(),
	          where: pagination.where || "",
	          limit: pagination.pageSize || Number(limitInput.value || state.defaultLimit),
	          page: pagination.page || 1,
	          sortColumn: pagination.sortColumn || state.sortColumn,
	          sortDirection: pagination.sortDirection || state.sortDirection,
	        };
	      }
	      if (state.lastQueryMode === "quick") {
	        return {
	          table: getQuickQueryTarget(),
	          where: whereInput.value,
	          limit: Number(limitInput.value || state.defaultLimit),
	          page: 1,
	          sortColumn: state.sortColumn,
	          sortDirection: state.sortDirection,
	        };
	      }
	      if (state.lastQueryMode === "preview") {
	        return {
	          table: getQuickQueryTarget(),
	          where: "",
	          limit: Number(limitInput.value || state.defaultLimit),
	          page: 1,
	          sortColumn: state.sortColumn,
	          sortDirection: state.sortDirection,
	        };
	      }
	      return null;
	    }

	    function submitRedisPendingEdits() {
      const updates = [];
      const ttlUpdates = [];
      for (const edit of Object.values(state.pendingEdits)) {
        const row = state.currentResult?.rows?.[edit.rowIndex];
        const key = String(row?.key || "").trim();
        if (!key) continue;
        if (edit.column === "value") {
          updates.push({ key, value: String(edit.newValue ?? "") });
        }
        if (edit.column === "ttl") {
          ttlUpdates.push({ key, ttl: String(edit.newValue ?? "") });
        }
      }
      if (!updates.length && !ttlUpdates.length) {
        setStatus("没有可提交的 Redis 修改。", true);
        return;
      }
      if (updates.length) {
        vscode.postMessage({ type: "redisUpdateKeys", updates });
      }
      if (ttlUpdates.length) {
        vscode.postMessage({ type: "redisUpdateTtls", updates: ttlUpdates });
      }
    }

    function renderResultPreservingState() {
      if (!state.currentResult) return;
      rerenderCurrentResult();
    }

    function clearPendingEdits() {
      state.pendingEdits = {};
      state.quickInsert = { active: false, values: {} };
      updateQuickButton();
    }

    function updateQuickButton() {
      const quickBtn = $("#quickBtn");
      const quickAddBtn = $("#quickAddBtn");
      quickBtn.textContent = hasPendingEdits() ? "提交" : "查询";
      quickAddBtn.textContent = state.quickInsert.active ? "取消添加" : "快速添加";
      quickAddBtn.classList.toggle("danger", state.quickInsert.active);
    }

    function hasPendingEdits() {
      return state.quickInsert.active || Object.keys(state.pendingEdits).length > 0;
    }

    function canEditColumn(column, row) {
      if (state.connectionType === "redis") {
        return Boolean(row?.key) && (column === "ttl" || (column === "value" && row?.type === "string"));
      }
      if (state.connectionType === "elasticsearch") {
        return Boolean(row?._id) && !["_index", "_id", "_score"].includes(column);
      }
      return state.connectionType !== "redis"
        && state.connectionType !== "elasticsearch"
        && state.primaryKeys.length > 0
        && !state.primaryKeys.includes(column)
        && state.primaryKeys.every((primaryKey) => row && row[primaryKey] !== undefined && row[primaryKey] !== null);
    }

    function canCopyReadonlyColumn(column, row) {
      if (state.connectionType === "redis") {
        return column === "key" && row?.key !== undefined && row?.key !== null;
      }
      if (state.connectionType === "elasticsearch") {
        return column === "_index" && row?._index !== undefined && row?._index !== null;
      }
      return false;
    }

    function copyReadonlyCellValue(cell) {
      const rowIndex = Number(cell.getAttribute("data-row-index"));
      const column = cell.getAttribute("data-column");
      if (!state.currentResult || !column || !Number.isInteger(rowIndex)) return;
      const row = state.currentResult.rows[rowIndex];
      if (!canCopyReadonlyColumn(column, row)) return;
      const value = row[column];
      const label = state.connectionType === "redis" ? "Redis Key" : "ES _index";
      vscode.postMessage({ type: "copyText", text: String(value ?? ""), successMessage: label + " 已复制" });
      setStatus(label + " 已复制到剪贴板。", false);
    }

    function canInspectRedisValue(column, row) {
      return state.connectionType === "redis"
        && column === "value"
        && Boolean(row?.key)
        && isRedisComplexType(row?.type);
    }

    function isRedisComplexType(type) {
      return ["hash", "list", "set", "zset", "stream"].includes(String(type || "").toLowerCase());
    }

    function openRedisKeyDetailFromCell(cell) {
      const rowIndex = Number(cell.getAttribute("data-row-index"));
      if (!state.currentResult || !Number.isInteger(rowIndex)) return;
      const row = state.currentResult.rows[rowIndex];
      if (!canInspectRedisValue(cell.getAttribute("data-column"), row)) return;
      openRedisKeyDetail(row.key, row.type, 1, { search: "", fuzzySearch: false, sortDirection: "asc" });
    }

    function openRedisKeyDetail(key, keyType, page, options = {}) {
      const safeKey = String(key || "").trim();
      if (!safeKey) return;
      const pageSize = Math.max(1, Math.min(500, Number(limitInput.value) > 0 ? Number(limitInput.value) : state.defaultLimit));
      const search = options.search !== undefined ? String(options.search || "") : state.redisDetail.search || "";
      const fuzzySearch = options.fuzzySearch !== undefined ? options.fuzzySearch === true : state.redisDetail.fuzzySearch === true;
      const sortDirection = options.sortDirection || state.redisDetail.sortDirection || "asc";
      state.redisDetail = {
        key: safeKey,
        keyType: String(keyType || ""),
        page: Math.max(1, Number(page) || 1),
        pageSize,
        totalRows: state.redisDetail.key === safeKey ? state.redisDetail.totalRows : 0,
        totalPages: state.redisDetail.key === safeKey ? state.redisDetail.totalPages : 1,
        columns: [],
        rows: [],
        search,
        fuzzySearch,
        sortDirection,
        memoryUsage: state.redisDetail.key === safeKey ? state.redisDetail.memoryUsage : null,
        contextRowIndex: -1,
      };
      redisDetailOverlay.classList.add("open");
      $("#redisDetailTitle").textContent = "Redis " + (state.redisDetail.keyType || "Key") + " 详情";
      redisDetailSearchInput.value = search;
      redisDetailFuzzySearch.checked = fuzzySearch;
      updateRedisDetailSearchPlaceholder();
      $("#redisDetailMeta").textContent = buildRedisDetailMeta(state.redisDetail, true);
      redisDetailBody.innerHTML = '<div class="redis-detail-empty">正在分页读取数据...</div>';
      redisDetailPager.innerHTML = "";
      hideRedisDetailContextMenu();
      vscode.postMessage({ type: "redisInspectKey", key: safeKey, page: state.redisDetail.page, pageSize, search, fuzzySearch, sortDirection });
    }

    function renderRedisKeyDetail() {
      const detail = state.redisDetail;
      if (detail.totalRows > 0 && detail.page > detail.totalPages) {
        openRedisKeyDetail(detail.key, detail.keyType, detail.totalPages, { search: detail.search, fuzzySearch: detail.fuzzySearch, sortDirection: detail.sortDirection });
        return;
      }
      redisDetailOverlay.classList.add("open");
      $("#redisDetailTitle").textContent = "Redis " + (detail.keyType || "Key") + " 详情";
      redisDetailSearchInput.value = detail.search || "";
      redisDetailFuzzySearch.checked = detail.fuzzySearch === true;
      updateRedisDetailSearchPlaceholder();
      $("#redisDetailMeta").textContent = buildRedisDetailMeta(detail, false);
      if (!detail.columns.length) {
        redisDetailBody.innerHTML = '<div class="redis-detail-empty">没有可展示的字段。</div>';
      } else if (!detail.rows.length) {
        redisDetailBody.innerHTML = '<div class="redis-detail-empty">当前页没有数据。</div>';
      } else {
        const head = detail.columns.map((column) => {
          if (String(detail.keyType).toLowerCase() === "zset" && column === "score") {
            const mark = detail.sortDirection === "desc" ? "↓" : "↑";
            return '<th><button class="redis-score-sort" title="按 score 对整个 ZSet 排序" data-score-sort="1"><span>score</span><span class="sort-mark">' + mark + '</span></button></th>';
          }
          return '<th>' + escapeHtml(column) + '</th>';
        }).join("");
        const body = detail.rows.map((row, index) => '<tr data-detail-row-index="' + index + '">' + detail.columns.map((column) => {
          const value = formatValue(row[column]);
          return '<td title="' + escapeHtml(value) + '">' + renderCellDisplayValue(value) + '</td>';
        }).join("") + '</tr>').join("");
        redisDetailBody.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
        redisDetailBody.querySelector("[data-score-sort]")?.addEventListener("click", () => {
          const nextDirection = detail.sortDirection === "desc" ? "asc" : "desc";
          openRedisKeyDetail(detail.key, detail.keyType, 1, { search: detail.search, fuzzySearch: detail.fuzzySearch, sortDirection: nextDirection });
        });
        redisDetailBody.querySelectorAll("tbody tr[data-detail-row-index]").forEach((row) => {
          row.addEventListener("contextmenu", (event) => openRedisDetailContextMenu(event, Number(row.getAttribute("data-detail-row-index"))));
        });
      }
      renderRedisDetailPager();
    }

    function buildRedisDetailMeta(detail, loading) {
      const parts = [detail.key];
      if (typeof detail.memoryUsage === "number") {
        parts.push("内存 " + formatMemoryUsage(detail.memoryUsage));
      }
      if (loading) {
        parts.push("正在读取第 " + detail.page + " 页");
      } else {
        parts.push("第 " + detail.page + " / " + detail.totalPages + " 页");
        parts.push("共 " + detail.totalRows + " 个元素");
      }
      if (detail.search) {
        parts.push((detail.fuzzySearch ? "模糊搜索 " : "原生搜索 ") + detail.search);
      }
      return parts.join(" · ");
    }

    function searchRedisKeyDetail() {
      const detail = state.redisDetail;
      if (!detail.key) return;
      openRedisKeyDetail(detail.key, detail.keyType, 1, { search: redisDetailSearchInput.value, fuzzySearch: redisDetailFuzzySearch.checked, sortDirection: detail.sortDirection });
    }

    function updateRedisDetailSearchPlaceholder() {
      redisDetailSearchInput.placeholder = redisDetailFuzzySearch.checked
        ? "模糊搜索：插件侧包含匹配，会遍历元素，适合小 Key"
        : "原生搜索：Hash/Set/ZSet 使用 SCAN 精确匹配；List 使用精确值";
    }

    function openRedisDetailContextMenu(event, rowIndex) {
      event.preventDefault();
      event.stopPropagation();
      if (!Number.isInteger(rowIndex) || !state.redisDetail.rows[rowIndex]) return;
      state.redisDetail.contextRowIndex = rowIndex;
      const left = Math.min(event.clientX, window.innerWidth - 152);
      const top = Math.min(event.clientY, window.innerHeight - 48);
      redisDetailContextMenu.style.left = Math.max(8, left) + "px";
      redisDetailContextMenu.style.top = Math.max(8, top) + "px";
      redisDetailContextMenu.classList.add("open");
    }

    function hideRedisDetailContextMenu() {
      redisDetailContextMenu.classList.remove("open");
      state.redisDetail.contextRowIndex = -1;
    }

    function deleteRedisDetailItem() {
      const detail = state.redisDetail;
      const row = detail.rows[detail.contextRowIndex];
      hideRedisDetailContextMenu();
      if (!detail.key || !row) return;
      vscode.postMessage({
        type: "redisDeleteMember",
        key: detail.key,
        keyType: detail.keyType,
        row,
        page: detail.page,
        pageSize: detail.pageSize,
        search: detail.search,
        fuzzySearch: detail.fuzzySearch,
        sortDirection: detail.sortDirection,
      });
    }

    function renderRedisDetailPager() {
      const detail = state.redisDetail;
      if (!detail.totalRows || detail.totalRows <= detail.pageSize) {
        redisDetailPager.innerHTML = "";
        return;
      }
      const page = Math.max(1, Math.min(detail.page, detail.totalPages));
      const totalPages = Math.max(1, detail.totalPages);
      const pageButtons = buildPageButtons(page, totalPages);
      const disabledFirst = page <= 1 ? " disabled" : "";
      const disabledLast = page >= totalPages ? " disabled" : "";
      redisDetailPager.innerHTML =
        '<button data-page="1"' + disabledFirst + '>首页</button>'
        + '<button data-page="' + Math.max(1, page - 1) + '"' + disabledFirst + '>上一页</button>'
        + pageButtons.map((item) => item === "..."
          ? '<span class="pager-ellipsis">...</span>'
          : '<button class="' + (item === page ? "active" : "") + '" data-page="' + item + '">' + item + '</button>'
        ).join("")
        + '<button data-page="' + Math.min(totalPages, page + 1) + '"' + disabledLast + '>下一页</button>'
        + '<button data-page="' + totalPages + '"' + disabledLast + '>最后</button>';
      redisDetailPager.querySelectorAll("button[data-page]").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.disabled) return;
          openRedisKeyDetail(detail.key, detail.keyType, Number(button.getAttribute("data-page")), { search: detail.search, fuzzySearch: detail.fuzzySearch, sortDirection: detail.sortDirection });
        });
      });
    }

    function closeRedisKeyDetail() {
      redisDetailOverlay.classList.remove("open");
      hideRedisDetailContextMenu();
    }

    function buildPrimaryKeyMeta(row) {
      return state.primaryKeys.map((primaryKey) => primaryKey + " = " + formatValue(row[primaryKey])).join("，");
    }

    function buildEditFieldMeta(column, row, options = {}) {
      const fieldName = state.connectionType === "redis" ? column : (state.selectedTable ? state.selectedTable + "." + column : column);
      const comment = getColumnComment(column);
      const parts = ["字段：" + fieldName];
      if (comment) parts.push("注释：" + comment);
      if (options.insert) {
        parts.push(isAutoManagedColumn(column) ? "留空使用 auto" : "新增行");
      } else if (state.connectionType === "redis" && row) {
        parts.push("key = " + row.key);
      } else if (row) {
        const primaryKeyMeta = buildPrimaryKeyMeta(row);
        if (primaryKeyMeta) parts.push(primaryKeyMeta);
      }
      return parts.join(" · ");
    }

    function buildEditKey(rowIndex, column) {
      return rowIndex + ":" + column;
    }

    function toEditableValue(value, temporalKind = "", formatJson = false) {
      if (value === null || value === undefined) return "";
      if (temporalKind) return formatTemporalEditableValue(value, temporalKind);
      if (formatJson) return formatJsonEditableValue(value);
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }

    function getRedisTtlEditableValue(value) {
      const text = String(value ?? "").trim();
      return /^\\d+$/.test(text) ? text : "";
    }

    function formatJsonEditableValue(value) {
      if (typeof value === "object") {
        return JSON.stringify(value, null, 2);
      }

      const text = String(value);
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }

    function tryFormatJsonText(text) {
      const parsed = parseJsonText(text);
      return parsed === undefined ? undefined : JSON.stringify(parsed, null, 2);
    }

    function compactJsonText(text, reportError = true) {
      const parsed = parseJsonText(text, reportError);
      return parsed === undefined ? undefined : JSON.stringify(parsed);
    }

    function updateJsonHighlight() {
      if (!jsonEditorWrap.classList.contains("json-active")) {
        clearJsonHighlight();
        return;
      }
      jsonEditorHighlight.innerHTML = renderJsonHighlightedText(cellEditor.value);
      syncJsonHighlightScroll();
    }

    function clearJsonHighlight() {
      jsonEditorHighlight.innerHTML = "";
    }

    function syncJsonHighlightScroll() {
      if (!jsonEditorWrap.classList.contains("json-active")) return;
      jsonEditorHighlight.scrollTop = cellEditor.scrollTop;
      jsonEditorHighlight.scrollLeft = cellEditor.scrollLeft;
    }

    function renderJsonHighlightedText(text) {
      const value = String(text ?? "");
      let html = "";
      let index = 0;
      while (index < value.length) {
        const char = value[index];
        if (char === '"') {
          const end = scanJsonStringEnd(value, index);
          const token = value.slice(index, end);
          const tokenType = isJsonObjectKey(value, end) ? "key" : "string";
          html += wrapJsonToken(tokenType, token);
          index = end;
          continue;
        }

        const numberMatch = value.slice(index).match(/^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/);
        if (numberMatch) {
          html += wrapJsonToken("number", numberMatch[0]);
          index += numberMatch[0].length;
          continue;
        }

        if (matchJsonWord(value, index, "true") || matchJsonWord(value, index, "false")) {
          const word = value.startsWith("true", index) ? "true" : "false";
          html += wrapJsonToken("boolean", word);
          index += word.length;
          continue;
        }

        if (matchJsonWord(value, index, "null")) {
          html += wrapJsonToken("null", "null");
          index += 4;
          continue;
        }

        if ("{}[]:,".includes(char)) {
          html += wrapJsonToken("punctuation", char);
          index += 1;
          continue;
        }

        html += escapeHtmlText(char);
        index += 1;
      }
      return html || escapeHtmlText(" ");
    }

    function scanJsonStringEnd(value, start) {
      let index = start + 1;
      let escaped = false;
      while (index < value.length) {
        const char = value[index];
        index += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          break;
        }
      }
      return index;
    }

    function isJsonObjectKey(value, tokenEnd) {
      let index = tokenEnd;
      while (index < value.length && /\\s/.test(value[index])) {
        index += 1;
      }
      return value[index] === ":";
    }

    function matchJsonWord(value, index, word) {
      if (!value.startsWith(word, index)) return false;
      const before = index > 0 ? value[index - 1] : "";
      const after = value[index + word.length] || "";
      return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
    }

    function wrapJsonToken(type, text) {
      return '<span class="json-token ' + type + '">' + escapeHtmlText(text) + "</span>";
    }

    function escapeHtmlText(text) {
      return String(text).replace(/[&<>"']/g, (char) => {
        if (char === "&") return "&amp;";
        if (char === "<") return "&lt;";
        if (char === ">") return "&gt;";
        if (char === '"') return "&quot;";
        return "&#39;";
      });
    }

    function parseJsonText(text, reportError = true) {
      try {
        const parsed = JSON.parse(text);
        if (reportError) clearEditError();
        return parsed;
      } catch (error) {
        if (reportError) {
          showEditError("JSON 格式错误：" + getErrorMessage(error));
          cellEditor.focus();
        }
        return undefined;
      }
    }

    function showEditError(message) {
      cellEditor.classList.add("invalid");
      editError.textContent = message;
      editError.classList.add("visible");
    }

    function clearEditError() {
      cellEditor.classList.remove("invalid");
      editError.textContent = "";
      editError.classList.remove("visible");
    }

    function getErrorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function insertEditorIndent(reverse) {
      const indent = "  ";
      const start = cellEditor.selectionStart;
      const end = cellEditor.selectionEnd;
      if (start === end) {
        cellEditor.setRangeText(indent, start, end, "end");
        updateJsonHighlight();
        return;
      }

      const value = cellEditor.value;
      const lineStart = value.lastIndexOf("\\n", start - 1) + 1;
      const selectedText = value.slice(lineStart, end);
      const nextText = reverse
        ? selectedText.replace(new RegExp("(^|\\n)" + indent, "g"), "$1")
        : selectedText.replace(/^/gm, indent);
      cellEditor.setRangeText(nextText, lineStart, end, "select");
      updateJsonHighlight();
    }

    function insertJsonBlock(open, close) {
      const indent = "  ";
      const value = cellEditor.value;
      const start = cellEditor.selectionStart;
      const end = cellEditor.selectionEnd;
      const lineStart = value.lastIndexOf("\\n", start - 1) + 1;
      const lineEndIndex = value.indexOf("\\n", end);
      const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
      const beforeCursor = value.slice(lineStart, start);
      const afterCursor = value.slice(end, lineEnd);
      const selectedText = value.slice(start, end);
      const innerText = selectedText ? selectedText : "";
      const currentIndent = beforeCursor.match(/^\\s*/)?.[0] || "";
      const closingMatch = afterCursor.match(/^(\\s*)[\\]}]/);
      const closingIndent = closingMatch ? beforeCursor + closingMatch[1] : currentIndent;
      const previousIndent = getPreviousNonEmptyIndent(value, lineStart);
      const shouldOwnLineIndent = /^\\s*$/.test(beforeCursor);
      const nestedIndent = longerIndent(closingIndent + indent, previousIndent + indent);
      const baseIndent = shouldOwnLineIndent && Boolean(closingMatch) ? nestedIndent : currentIndent;
      const openPrefix = shouldOwnLineIndent ? baseIndent : "";
      const replaceStart = shouldOwnLineIndent ? lineStart : start;
      const block = openPrefix + open + "\\n" + baseIndent + indent + innerText + "\\n" + baseIndent + close + (shouldOwnLineIndent && closingMatch ? "\\n" : "");
      cellEditor.setRangeText(block, replaceStart, end, "end");
      const cursor = replaceStart + openPrefix.length + open.length + "\\n".length + baseIndent.length + indent.length;
      cellEditor.setSelectionRange(cursor, cursor + innerText.length);
      clearEditError();
      updateJsonHighlight();
    }

    function insertJsonPair(open, close) {
      const start = cellEditor.selectionStart;
      const end = cellEditor.selectionEnd;
      const value = cellEditor.value;
      if (start === end && value[start] === close) {
        cellEditor.setSelectionRange(start + close.length, start + close.length);
        updateJsonHighlight();
        return;
      }

      const selectedText = value.slice(start, end);
      cellEditor.setRangeText(open + selectedText + close, start, end, "end");
      const cursor = start + open.length;
      cellEditor.setSelectionRange(cursor, cursor + selectedText.length);
      clearEditError();
      updateJsonHighlight();
    }

    function getPreviousNonEmptyIndent(value, lineStart) {
      const before = value.slice(0, Math.max(0, lineStart - 1));
      const lines = before.split("\\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].trim()) {
          return lines[index].match(/^\\s*/)?.[0] || "";
        }
      }
      return "";
    }

    function longerIndent(left, right) {
      return left.length >= right.length ? left : right;
    }

    function moveCursorToEnd(element) {
      const end = element.value.length;
      element.setSelectionRange(end, end);
    }

    function formatTemporalEditableValue(value, kind) {
      if (value instanceof Date) return formatDateObjectForTemporalKind(value, kind);
      const text = String(value);
      if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(text)) return text;
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return text;
      if (kind === "date") return formatBeijingDateTime(text).slice(0, 10);
      if (kind === "time") return formatBeijingDateTime(text).slice(11);
      return formatBeijingDateTime(text);
    }

    function formatDateObjectForTemporalKind(value, kind) {
      const isoText = value.toISOString();
      if (kind === "date") return formatBeijingDateTime(isoText).slice(0, 10);
      if (kind === "time") return formatBeijingDateTime(isoText).slice(11);
      return formatBeijingDateTime(isoText);
    }

    function getTemporalKind(column) {
      const type = String(state.columnTypes[column] || "").toLowerCase();
      if (/\\b(timestamp|datetime)\\b/.test(type)) return "datetime";
      if (/\\bdate\\b/.test(type) && !/\\btime\\b/.test(type)) return "date";
      if (/\\btime\\b/.test(type) && !/\\bdate\\b/.test(type) && !/\\btimestamp\\b/.test(type)) return "time";
      return "";
    }

    function isJsonColumn(column) {
      const type = String(state.columnTypes[column] || "").toLowerCase();
      return /\\bjsonb?\\b/.test(type) || (state.connectionType === "elasticsearch" && /\\b(object|nested|flattened)\\b/.test(type));
    }

    function isRedisJsonValueColumn(column, value) {
      return state.connectionType === "redis" && column === "value" && isJsonText(value);
    }

    function isTruncatedRedisPreview(value) {
      return typeof value === "string" && / \.\.\.（已截断，长度 \d+ 字节）$/.test(value);
    }

    function isJsonText(value) {
      if (typeof value !== "string") return false;
      const text = value.trim();
      if (!text || !/^[\\[{]/.test(text)) return false;
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    }

    function isAutoManagedColumn(column) {
      const meta = state.columnMeta[column] || {};
      const extra = String(meta.extra || "").toLowerCase();
      const hasDefault = meta.defaultValue !== undefined && meta.defaultValue !== null;
      return /auto_increment|identity/.test(extra) || hasDefault;
    }

    function isNullableColumn(column) {
      return state.columnMeta[column]?.nullable === true;
    }

    function getEnumValues(column) {
      const values = state.columnMeta[column]?.enumValues;
      if (Array.isArray(values) && values.length) {
        return values.map((value) => String(value));
      }
      const type = String(state.columnTypes[column] || "");
      const match = type.match(/^enum\\((.*)\\)$/i);
      return match ? parseSqlStringList(match[1]) : [];
    }

    function parseSqlStringList(text) {
      const values = [];
      let index = 0;
      while (index < text.length) {
        while (/\\s|,/.test(text[index] || "")) index += 1;
        if (text[index] !== "'") break;
        index += 1;
        let value = "";
        while (index < text.length) {
          const char = text[index];
          const next = text[index + 1];
          if (char === "'" && next === "'") {
            value += "'";
            index += 2;
            continue;
          }
          if (char === "\\\\" && next !== undefined) {
            value += next;
            index += 2;
            continue;
          }
          if (char === "'") {
            index += 1;
            break;
          }
          value += char;
          index += 1;
        }
        values.push(value);
      }
      return values;
    }

    function renderEnumEditor(values, currentValue, selectedValue) {
      enumCurrentValue.textContent = currentValue || "空值";
      enumOptions.innerHTML = values.map((value, index) => {
        const current = value === currentValue;
        const selected = value === selectedValue;
        const className = "enum-option" + (current ? " current" : "") + (selected ? " selected" : "");
        const titleParts = [];
        if (current) titleParts.push("当前值");
        if (selected) titleParts.push("已选中");
        return '<button class="' + className + '" data-enum-index="' + index + '" title="' + escapeHtml(titleParts.join(" / ") || value) + '">' + escapeHtml(value) + '</button>';
      }).join("");
      enumOptions.querySelectorAll(".enum-option").forEach((button) => {
        button.addEventListener("click", () => {
          const index = Number(button.getAttribute("data-enum-index"));
          const value = values[index];
          if (value === undefined || !activeEdit?.enumLike) return;
          activeEdit.nullSelected = false;
          activeEdit.enumSelected = value;
          renderEnumEditor(values, currentValue, value);
        });
      });
    }

    function getNowButtonText(kind) {
      if (kind === "date") return "填入今天";
      if (kind === "time") return "填入当前时间";
      return "填入当前日期时间";
    }

    function formatNowForTemporalKind(kind) {
      const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const date = now.getUTCFullYear() + "-" + pad2(now.getUTCMonth() + 1) + "-" + pad2(now.getUTCDate());
      const time = pad2(now.getUTCHours()) + ":" + pad2(now.getUTCMinutes()) + ":" + pad2(now.getUTCSeconds());
      if (kind === "date") return date;
      if (kind === "time") return time;
      return date + " " + time;
    }

    function pad2(value) {
      return String(value).padStart(2, "0");
    }

    function toggleDrawer() {
      $("#sqlDrawer").classList.toggle("open");
      applyConnectionMode();
    }

    function openDrawer() {
      $("#sqlDrawer").classList.add("open");
      applyConnectionMode();
    }

    function sendAiTimelinePrompt() {
      const tableTagState = updateAiTableTagValidation(true);
      if (tableTagState.invalid.length) {
        setStatus("Table 标签包含不存在的表：" + tableTagState.invalid.join(", "), true);
        return;
      }
      const aiRequest = buildAiGenerationRequest(aiPromptInput.value);
      if (!aiRequest.prompt) {
        setStatus("请先在“继续告诉 AI”输入框里描述需求，例如：查询最近 10 条数据。", true);
        return;
      }
      const parentId = resolveAiContinueParentId();
      const item = createAiTimelineItem(aiRequest, tableTagState.valid, parentId);
      state.aiTimeline.push(item);
      state.aiContinueParentId = "";
      state.aiContinueSourceId = "";
      pendingAiTimelineId = item.id;
      renderAiTimeline();
      vscode.postMessage({ type: "generateSql", prompt: aiRequest.prompt, tableNames: tableTagState.valid });
    }

    function createAiTimelineItem(aiRequest, tableNames, parentId) {
      const id = "ai_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
      return {
        id,
        parentId: parentId || "",
        createdAt: Date.now(),
        kind: aiRequest.kind,
        userPrompt: aiRequest.userPrompt,
        requestPrompt: aiRequest.prompt,
        generatedText: "",
        relatedTables: tableNames || [],
        status: "running",
        errorMessage: "",
        applied: false,
      };
    }

    function resolveAiContinueParentId() {
      if (!state.aiContinueParentId) return "";
      const parent = state.aiTimeline.find((entry) => entry.id === state.aiContinueParentId);
      if (!parent) return "";
      return parent.id;
    }

    function buildAiGenerationRequest(text) {
      const source = String(text || "");
      const tags = getAiPromptTags(source);
      const tag = findActiveAiPromptTag(tags, aiPromptInput.selectionStart ?? source.length);
      const rawPrompt = tag?.content.trim() || stripAiHelperTags(source).trim();
      if (!rawPrompt) {
        return { prompt: "", userPrompt: "", kind: "ai" };
      }
      const kind = tag?.name === "gen" ? "gen" : "ai";
      const prompt = [
        buildAiTimelineContext(),
        buildCurrentEditorContext(),
        buildAiContinuationContext(),
        kind === "gen" ? "本次测试数据生成需求：\\n" + rawPrompt : "本次需求：\\n" + rawPrompt,
        kind === "gen" ? getGenerateDataPromptInstruction() : getAiQueryPromptInstruction(),
      ].filter(Boolean).join("\\n\\n");
      return { prompt, userPrompt: rawPrompt, kind };
    }

    function buildCurrentEditorContext() {
      const currentSql = getExecutableSqlFromEditor();
      return currentSql ? "当前编辑器内容：\\n" + truncateForTimeline(currentSql, 3000) : "";
    }

    function buildAiTimelineContext() {
      const items = state.aiTimeline
        .filter((item) => item.status === "success" && item.generatedText)
        .slice(-6);
      if (!items.length) return "";
      return "历史 AI 时间线摘要：\\n" + items.map((item, index) => {
        return (index + 1) + ". 用户需求：" + truncateForTimeline(item.userPrompt, 500) + "\\nAI 结果：\\n" + truncateForTimeline(item.generatedText, 1200);
      }).join("\\n\\n");
    }

    function buildAiContinuationContext() {
      if (!state.aiContinueSourceId) return "";
      const chain = collectAiAncestorChain(state.aiContinueSourceId)
        .filter((item) => item.status === "success" && item.generatedText);
      if (!chain.length) return "";
      return "本次是对下面这条 AI 时间线分支的继续改进。请把最后一个节点的 AI 结果作为直接修改对象，同时完整遵守它上方所有父节点的需求约束；除非本次新需求明确覆盖，否则不要丢失父节点已经要求过的条件。\\n"
        + chain.map((item, index) => {
          return "节点 " + (index + 1) + " 用户需求："
            + truncateForTimeline(item.userPrompt, 500)
            + "\\n节点 " + (index + 1) + " AI 结果：\\n"
            + truncateForTimeline(item.generatedText, 1800);
        }).join("\\n\\n");
    }

    function renderAiTimeline() {
      if (!aiTimeline) return;
      if (!state.aiTimeline.length) {
        aiTimeline.innerHTML = '<div class="ai-timeline-empty"><div><strong>还没有 AI 记录</strong><br />在上方输入需求后发送，生成、改写和后续追问都会在这里形成时间线。</div></div>';
        return;
      }
      aiTimeline.innerHTML = getAiTimelineRoots()
        .map((root, rootIndex) => renderAiTimelineBranch(root, String(rootIndex + 1), 0, new Set()))
        .join("");
      aiTimeline.querySelectorAll("[data-ai-action]").forEach((button) => {
        button.addEventListener("click", () => handleAiTimelineAction(button.getAttribute("data-ai-action"), button.getAttribute("data-ai-id")));
      });
      aiTimeline.scrollTop = aiTimeline.scrollHeight;
    }

    function getAiTimelineRoots() {
      return state.aiTimeline.filter((item) => !item.parentId || !state.aiTimeline.some((entry) => entry.id === item.parentId));
    }

    function getAiTimelineChildren(parentId) {
      return state.aiTimeline.filter((item) => item.parentId === parentId);
    }

    function collectAiAncestorChain(id) {
      const chain = [];
      const seen = new Set();
      let current = state.aiTimeline.find((item) => item.id === id);
      while (current && !seen.has(current.id)) {
        chain.unshift(current);
        seen.add(current.id);
        current = current.parentId ? state.aiTimeline.find((item) => item.id === current.parentId) : null;
      }
      return chain;
    }

    function renderAiTimelineBranch(item, orderLabel, depth, seen) {
      if (!item || seen.has(item.id)) return "";
      const nextSeen = new Set(seen);
      nextSeen.add(item.id);
      const children = getAiTimelineChildren(item.id);
      return renderAiTimelineItem(item, orderLabel, depth)
        + children.map((child, index) => renderAiTimelineBranch(child, orderLabel + "." + (index + 1), depth + 1, nextSeen)).join("");
    }

    function renderAiTimelineItem(item, orderLabel, depth) {
      const isChild = depth > 0;
      const className = "ai-timeline-item " + item.status + (item.applied ? " applied" : "") + (isChild ? " child" : "");
      const depthStyle = isChild ? ' style="--ai-depth:' + Math.min(depth, 8) + '"' : "";
      const title = item.kind === "gen" ? "AI 生成测试数据" : item.status === "failed" ? "AI 生成失败" : isChild ? "继续改进" : "AI 生成 / 改写";
      const badge = item.applied ? '<span class="ai-applied-badge">当前使用中</span>' : "";
      const resultHtml = item.status === "running"
        ? '<pre class="ai-sql-preview">正在根据上下文生成内容...</pre>'
        : item.status === "failed"
          ? '<pre class="ai-sql-preview">' + escapeHtml(item.errorMessage || "AI 请求失败") + '</pre>'
          : '<pre class="ai-sql-preview">' + escapeHtml(item.generatedText) + '</pre>';
      const actions = item.status === "success"
        ? '<div class="ai-timeline-actions">'
          + '<button class="secondary" data-ai-action="apply" data-ai-id="' + item.id + '">应用到编辑器</button>'
          + '<button class="secondary" data-ai-action="continue" data-ai-id="' + item.id + '">继续改进</button>'
          + '<button class="secondary" data-ai-action="copy" data-ai-id="' + item.id + '">复制结果</button>'
          + '</div>'
        : item.status === "failed"
          ? '<div class="ai-timeline-actions"><button class="secondary" data-ai-action="retry" data-ai-id="' + item.id + '">重试</button></div>'
          : "";
      return '<div class="' + className + '"' + depthStyle + '>'
        + '<span class="ai-timeline-dot"></span>'
        + '<div class="ai-timeline-box">'
        + '<div class="ai-timeline-head"><div class="ai-timeline-title"><span>#' + orderLabel + '</span><span>' + title + '</span>' + badge + '</div><span class="ai-timeline-time">' + formatTimelineTime(item.createdAt) + '</span></div>'
        + '<div class="ai-timeline-body">'
        + '<div class="ai-prompt-preview">' + escapeHtml(item.userPrompt) + '</div>'
        + resultHtml
        + actions
        + '</div></div></div>';
    }

    function handleAiTimelineAction(action, id) {
      const item = state.aiTimeline.find((entry) => entry.id === id);
      if (!item) return;
      if (action === "apply") {
        applyTimelineSql(item);
        return;
      }
      if (action === "continue") {
        state.aiContinueParentId = item.id;
        state.aiContinueSourceId = item.id;
        aiPromptInput.value = "";
        aiPromptInput.placeholder = "基于这条 AI 结果继续描述你的修改需求，发送后会挂在它的下方...";
        aiPromptInput.focus();
        setStatus("已定位到“继续告诉 AI”，请输入新的修改需求后发送。", false);
        return;
      }
      if (action === "copy") {
        vscode.postMessage({ type: "copyText", text: item.generatedText || "", successMessage: "AI 结果已复制" });
        return;
      }
      if (action === "retry") {
        state.aiContinueParentId = item.parentId || "";
        state.aiContinueSourceId = item.parentId || "";
        aiPromptInput.value = item.userPrompt;
        aiPromptInput.focus();
        sendAiTimelinePrompt();
      }
    }

    function applyTimelineSql(item) {
      if (!item.generatedText) return;
	      const editorSql = formatEditorText(item.generatedText);
	      sqlInput.value = editorSql;
	      updateSqlInputHighlight(sqlInput);
	      moveCursorToEnd(sqlInput);
      state.lastSql = editorSql;
      state.aiActiveTimelineId = item.id;
      state.aiTimeline.forEach((entry) => entry.applied = entry.id === item.id);
      renderAiTimeline();
    }

    function markPendingAiTimelineFailed(message) {
      if (!pendingAiTimelineId) return;
      const item = state.aiTimeline.find((entry) => entry.id === pendingAiTimelineId);
      if (!item) return;
      item.status = "failed";
      item.errorMessage = message;
      pendingAiTimelineId = "";
      renderAiTimeline();
    }

    function formatTimelineTime(value) {
      const date = new Date(value || Date.now());
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
    }

    function truncateForTimeline(value, max) {
      const text = String(value || "");
      return text.length > max ? text.slice(0, max - 1) + "..." : text;
    }

    function getAiQueryPromptInstruction() {
      if (state.connectionType === "redis") {
        return "请结合当前 Redis Key 信息生成或改写 Redis 命令，只返回一条最终可执行命令，不要解释，不要使用 Markdown 代码块。默认生成只读命令；搜索 Key 时使用 SCAN，不要使用 KEYS；查看集合类 Key 使用 HSCAN/SSCAN/ZSCAN 或带小范围的 LRANGE/ZRANGE/XRANGE COUNT，避免 HGETALL、SMEMBERS 和无界范围。";
      }
      if (state.connectionType === "elasticsearch") {
        return "请结合当前索引结构生成或改写 Elasticsearch 查询，只返回最终可执行内容，不要解释，不要使用 Markdown 代码块。优先返回 METHOD /path 换行 JSON body 的 HTTP 请求格式。默认生成只读查询。";
      }
      return "请结合当前数据库表结构生成或改写 SQL，只返回最终可执行 SQL，不要解释，不要使用 Markdown 代码块。";
    }

    function getAiRewriteFallback() {
      if (state.connectionType === "redis") return "请根据当前 Redis Key 信息生成或优化这条 Redis 命令";
      if (state.connectionType === "elasticsearch") return "请根据当前索引结构生成或优化这段 Elasticsearch 查询";
      return "请根据当前表结构生成或优化这段 SQL";
    }


    function getGenerateDataPromptInstruction() {
      if (state.connectionType === "redis") {
        return "请根据当前 Redis Key 信息生成用于写入测试数据的一条 Redis 命令，只返回一条最终可执行命令，不要解释，不要使用 Markdown 代码块。如果需要写入多个字段或元素，优先使用 HSET、SADD、ZADD、LPUSH/RPUSH 这类单条命令携带多个值。";
      }
      if (state.connectionType === "elasticsearch") {
        return "请根据当前索引结构生成用于写入测试数据的一条 Elasticsearch HTTP 请求，只返回一条最终可执行请求，不要解释，不要使用 Markdown 代码块。如果需要写入多条测试数据，必须使用一条 POST /_bulk 请求并返回 NDJSON 请求体，不要返回多条独立请求。";
      }
      return "请根据当前数据库表结构生成用于插入测试数据的 SQL，只返回一条最终可执行 SQL，不要解释，不要使用 Markdown 代码块。即使需求要求生成多条测试数据，也必须合并成一条 INSERT 语句，使用多组 VALUES，例如 INSERT INTO table (col) VALUES (...), (...), (...); 不要返回多条 INSERT。默认情况下，生成 INSERT 语句时应省略主键字段、带默认值字段、自动生成字段和自动更新时间字段，让数据库自动生成；例如 id 是主键、created_at 有 DEFAULT CURRENT_TIMESTAMP 时，默认不要写入 INSERT 字段列表。但如果本次需求中明确点名或强调某个字段必须有指定数据，即使它是主键、带默认值或自动生成字段，也必须在 INSERT 字段列表中显式写入并给出符合需求的值。";
    }

    function applyGeneratedSql(generatedSql) {
      const sql = normalizeGeneratedSql(generatedSql);
      const item = state.aiTimeline.find((entry) => entry.id === pendingAiTimelineId);
      if (item) {
        item.status = "success";
        item.generatedText = sql;
        item.errorMessage = "";
      }
      pendingAiTimelineId = "";
	      const editorSql = formatEditorText(sql);
	      sqlInput.value = editorSql;
	      updateSqlInputHighlight(sqlInput);
	      moveCursorToEnd(sqlInput);
      state.lastSql = editorSql;
      if (item) {
        state.aiActiveTimelineId = item.id;
        state.aiTimeline.forEach((entry) => entry.applied = entry.id === item.id);
      }
      aiPromptInput.value = "";
      aiPromptInput.placeholder = "继续描述你想如何修改当前结果...";
      renderAiTimeline();
    }

    function getExecutableSqlFromEditor() {
      const executableText = getLatestExecutableText(sqlInput.value);
      return executableText.trim();
    }

    function getLatestExecutableText(text) {
      const source = String(text || "");
      const lastPromptEnd = getLastPromptTagEnd(source);
      const candidate = lastPromptEnd >= 0 ? source.slice(lastPromptEnd) : source;
      return stripAiHelperTags(candidate);
    }

    function getLastPromptTagEnd(text) {
      const tags = getAiPromptTags(text);
      return tags.length ? Math.max(...tags.map((tag) => tag.end)) : -1;
    }

    function getAiPromptTags(text) {
      const tags = [];
      const source = String(text || "");
      ["ai", "gen"].forEach((name) => {
        const htmlPattern = new RegExp("<+" + name + ">([\\\\s\\\\S]*?)<\\\\/" + name + ">", "gi");
        source.replace(htmlPattern, (match, content, offset) => {
          tags.push({ type: "html", name, start: offset, end: offset + match.length, content });
          return "";
        });
        const inlinePattern = new RegExp("@" + name + "\\\\{([\\\\s\\\\S]*?)\\\\}", "gi");
        source.replace(inlinePattern, (match, content, offset) => {
          tags.push({ type: "brace", name, start: offset, end: offset + match.length, content });
          return "";
        });
      });
      return tags.sort((left, right) => left.start - right.start);
    }

    function findActiveAiPromptTag(tags, cursor) {
      if (!tags.length) return null;
      const safeCursor = Number(cursor) || 0;
      const atCursor = tags.find((tag) => safeCursor >= tag.start && safeCursor <= tag.end);
      if (atCursor) return atCursor;
      for (let index = tags.length - 1; index >= 0; index -= 1) {
        if (tags[index].end <= safeCursor) return tags[index];
      }
      return tags[tags.length - 1];
    }

    function getInsertPositionAfterTagLine(text, tagEnd) {
      const source = String(text || "");
      const lineEnd = source.indexOf("\\n", tagEnd);
      return lineEnd >= 0 ? lineEnd + 1 : source.length;
    }

    function normalizeGeneratedSql(value) {
      const fence = String.fromCharCode(96).repeat(3);
      let text = String(value || "").trim();
      const fenceMatch = text.match(new RegExp("^" + fence + "[A-Za-z0-9_-]*\\\\s*"));
      if (fenceMatch) text = text.slice(fenceMatch[0].length).trimStart();
      if (text.endsWith(fence)) {
        text = text.slice(0, -fence.length).trimEnd();
      }
      return text.trim();
    }

    function stripAiHelperTags(text) {
      return String(text || "")
        .replace(/<+(?:ai|gen)>[\\s\\S]*?<\\/(?:ai|gen)>/gi, "")
        .replace(/@(ai|gen)\\{[\\s\\S]*?\\}/gi, "")
        .replace(/<+table>[\\s\\S]*?<\\/table>/gi, "")
        .replace(/@table\\{[\\s\\S]*?\\}/gi, "")
        .trim();
    }

    function buildRewritePrompt(sql, fallback) {
      return sql.trim() ? fallback + "。当前 SQL:\\n" + sql : "";
    }

    function setStatus(message, isError, isHtml = false) {
      stopStatusLoading();
      if (!isHtml && isStatusLoadingMessage(message)) {
        startStatusLoading(message, isError);
        return;
      }
      status.classList.toggle("error", Boolean(isError));
      if (isHtml) statusText.innerHTML = message; else statusText.textContent = message;
      updateExportButton();
    }

    function formatValue(value) {
      if (value === null) return "NULL";
      if (value === undefined) return "";
      if (typeof value === "string" && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(value)) {
        return formatBeijingDateTime(value);
      }
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }

    function formatMemoryUsage(bytes) {
      if (!Number.isFinite(bytes)) return "未知";
      if (bytes < 1024) return bytes + " B";
      const units = ["KB", "MB", "GB", "TB"];
      let value = bytes / 1024;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }
      return (value >= 10 ? value.toFixed(1) : value.toFixed(2)) + " " + units[unitIndex];
    }

    function renderCellDisplayValue(value) {
      return escapeHtml(value).replace(/\\r\\n|\\r|\\n/g, '<span class="cell-newline-mark" title="换行">↵</span>');
    }

    function formatBeijingDateTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(date);
      const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return byType.year + "-" + byType.month + "-" + byType.day + " " + byType.hour + ":" + byType.minute + ":" + byType.second;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

  </script>
</body>
</html>`;
  }
}

function buildQuickQuerySql(
  type: DbConnectionConfig["type"],
  table: string,
  where: string,
  limit: number,
  page = 1,
  sortColumn?: string,
  sortDirection?: "asc" | "desc"
): string {
  const condition = where.trim();
  if (/;|--|\/\*/.test(condition)) {
    throw new Error("快速条件不支持分号或 SQL 注释；复杂语句请打开 SQL 编辑器执行。");
  }

  const quotedTable = quoteIdentifier(type, table);
  const whereClause = condition ? ` WHERE ${condition}` : "";
  const orderClause = buildOrderClause(type, sortColumn, sortDirection);
  const offset = Math.max(0, Math.floor(page - 1) * limit);
  const limitClause = limit < 0 ? "" : ` LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ""}`;
  return `SELECT * FROM ${quotedTable}${whereClause}${orderClause}${limitClause}`;
}

function buildQuickCountSql(type: DbConnectionConfig["type"], table: string, where: string): string {
  const condition = where.trim();
  if (/;|--|\/\*/.test(condition)) {
    throw new Error("快速条件不支持分号或 SQL 注释；复杂语句请打开 SQL 编辑器执行。");
  }

  const quotedTable = quoteIdentifier(type, table);
  const whereClause = condition ? ` WHERE ${condition}` : "";
  return `SELECT COUNT(*) AS totalRows FROM ${quotedTable}${whereClause}`;
}

function buildExportPreviewSql(
  type: DbConnectionConfig["type"],
  table: string,
  message: Extract<PanelMessage, { type: "exportPreview" }>,
  rowLimit: number,
  defaultSortColumns: string[] = []
): string {
  if (message.mode === "quick") {
    if (message.sortColumn) {
      return buildQuickQuerySql(type, table, message.where || "", rowLimit, 1, message.sortColumn, message.sortDirection);
    }
    const condition = String(message.where || "").trim();
    if (/;|--|\/\*/.test(condition)) {
      throw new Error("快速条件不支持分号或 SQL 注释；复杂语句请打开 SQL 编辑器执行。");
    }
    const whereClause = condition ? ` WHERE ${condition}` : "";
    const orderClause = buildOrderColumnsClause(type, defaultSortColumns);
    return `SELECT * FROM ${quoteIdentifier(type, table)}${whereClause}${orderClause} LIMIT ${rowLimit}`;
  }

  const sql = String(message.sql || "").trim();
  if (!sql) {
    throw new Error("当前预览没有可导出的 SQL 来源。");
  }
  const plan = buildSqlPaginationPlan(type, sql, rowLimit, 1, message.sortColumn, message.sortDirection);
  if (!plan.isSelect) {
    throw new Error("只有 SELECT 查询结果支持导出。");
  }
  return plan.executableSql;
}

function buildOrderColumnsClause(type: DbConnectionConfig["type"], columns: string[]): string {
  const safeColumns = columns.map((column) => String(column || "").trim()).filter(Boolean);
  if (!safeColumns.length) {
    return "";
  }
  return ` ORDER BY ${safeColumns.map((column) => `${quoteIdentifier(type, column)} ASC`).join(", ")}`;
}

function buildElasticQuickSearchBody(
  queryText: string,
  size: number,
  from: number,
  sortColumn?: string,
  sortDirection?: "asc" | "desc"
): Record<string, unknown> {
  const body = buildElasticQueryBody(queryText);
  body.from = Math.max(0, from);
  body.size = Math.max(1, size);
  if (sortColumn) {
    body.sort = [{ [sortColumn]: { order: normalizeSortDirection(sortDirection) } }];
  }
  return body;
}

function buildElasticQuickCountBody(queryText: string): Record<string, unknown> {
  const searchBody = buildElasticQueryBody(queryText);
  return { query: searchBody.query ?? { match_all: {} } };
}

function buildElasticQueryBody(queryText: string): Record<string, unknown> {
  const text = queryText.trim();
  if (!text) {
    return { query: { match_all: {} } };
  }
  if (text.startsWith("{")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return { query: { query_string: { query: text } } };
}

function buildSqlPaginationPlan(
  type: DbConnectionConfig["type"],
  sql: string,
  fallbackLimit: number,
  page?: number,
  sortColumn?: string,
  sortDirection?: "asc" | "desc"
): SqlPaginationPlan {
  const trimmed = stripTrailingSemicolon(sql);
  if (!isSelectLikeSql(trimmed)) {
    return { executableSql: sql, isSelect: false };
  }

  const limitInfo = parseTrailingLimit(trimmed);
  const pageSize = limitInfo?.limit ?? fallbackLimit;
  const baseSql = limitInfo?.baseSql ?? trimmed;
  const orderClause = buildOrderClause(type, sortColumn, sortDirection);
  const sortedSql = orderClause ? `SELECT * FROM (${baseSql}) AS ${quoteIdentifier(type, "__dbw_sorted")}${orderClause}` : baseSql;
  if (pageSize < 0) {
    return {
      executableSql: sortedSql,
      baseSql,
      page: 1,
      pageSize,
      isSelect: true,
      sortColumn,
      sortDirection: normalizeSortDirection(sortDirection),
    };
  }

  const initialPage = limitInfo && limitInfo.limit > 0
    ? Math.floor(limitInfo.offset / limitInfo.limit) + 1
    : 1;
  const currentPage = Math.max(1, Math.floor(page ?? initialPage));
  const offset = Math.max(0, (currentPage - 1) * pageSize);
  const executableSql = `${sortedSql} LIMIT ${pageSize}${offset > 0 ? ` OFFSET ${offset}` : ""}`;
  return {
    executableSql,
    baseSql,
    countSql: `SELECT COUNT(*) AS totalRows FROM (${baseSql}) AS ${quoteIdentifier(type, "__dbw_count")}`,
    page: currentPage,
    pageSize,
    isSelect: true,
    sortColumn,
    sortDirection: normalizeSortDirection(sortDirection),
  };
}

function buildOrderClause(type: DbConnectionConfig["type"], sortColumn?: string, sortDirection?: "asc" | "desc"): string {
  const column = String(sortColumn || "").trim();
  if (!column) return "";
  return ` ORDER BY ${quoteIdentifier(type, column)} ${normalizeSortDirection(sortDirection).toUpperCase()}`;
}

function normalizeSortDirection(direction?: "asc" | "desc"): "asc" | "desc" {
  return direction === "desc" ? "desc" : "asc";
}

function parseTrailingLimit(sql: string): { baseSql: string; limit: number; offset: number } | undefined {
  const offsetMatch = sql.match(/\s+limit\s+(\d+)\s+offset\s+(\d+)\s*$/i);
  if (offsetMatch && offsetMatch.index !== undefined) {
    return {
      baseSql: sql.slice(0, offsetMatch.index).trim(),
      limit: Number(offsetMatch[1]),
      offset: Number(offsetMatch[2]),
    };
  }

  const commaMatch = sql.match(/\s+limit\s+(\d+)\s*,\s*(\d+)\s*$/i);
  if (commaMatch && commaMatch.index !== undefined) {
    return {
      baseSql: sql.slice(0, commaMatch.index).trim(),
      limit: Number(commaMatch[2]),
      offset: Number(commaMatch[1]),
    };
  }

  const limitMatch = sql.match(/\s+limit\s+(\d+)\s*$/i);
  if (limitMatch && limitMatch.index !== undefined) {
    return {
      baseSql: sql.slice(0, limitMatch.index).trim(),
      limit: Number(limitMatch[1]),
      offset: 0,
    };
  }

  return undefined;
}

function readTotalRows(result: QueryResult): number {
  const first = result.rows[0] ?? {};
  const knownValue = first.totalRows ?? first.totalrows ?? first.count ?? first["COUNT(*)"] ?? first["count(*)"];
  return Number(knownValue ?? Object.values(first)[0] ?? 0);
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "");
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
      if (char === "\n") {
        lineComment = false;
      }
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
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }
  return statements;
}

function getSqlStatementTitle(sql: string): string {
  const text = sql.trimStart();
  const lineComment = text.match(/^--[ \t]?([^\r\n]+)/);
  if (lineComment?.[1]?.trim()) {
    return lineComment[1].trim();
  }
  const hashComment = text.match(/^#[ \t]?([^\r\n]+)/);
  if (hashComment?.[1]?.trim()) {
    return hashComment[1].trim();
  }
  const blockComment = text.match(/^\/\*\s*([\s\S]*?)\s*\*\//);
  if (blockComment?.[1]?.trim()) {
    return blockComment[1].trim().split(/\r?\n/)[0]?.trim() || "";
  }
  return "";
}

function stripSqlLeadingComments(sql: string): string {
  let text = sql.trimStart();
  let changed = true;
  while (changed) {
    changed = false;
    const lineComment = text.match(/^--[^\r\n]*(?:\r?\n|$)/);
    if (lineComment) {
      text = text.slice(lineComment[0].length).trimStart();
      changed = true;
      continue;
    }
    const hashComment = text.match(/^#[^\r\n]*(?:\r?\n|$)/);
    if (hashComment) {
      text = text.slice(hashComment[0].length).trimStart();
      changed = true;
      continue;
    }
    const blockComment = text.match(/^\/\*[\s\S]*?\*\//);
    if (blockComment) {
      text = text.slice(blockComment[0].length).trimStart();
      changed = true;
    }
  }
  return text || sql;
}

function createSqlPreview(sql: string, maxLength: number): string {
  const preview = sql.replace(/\s+/g, " ").trim();
  return preview.length > maxLength ? `${preview.slice(0, maxLength - 1)}...` : preview;
}

function isSelectLikeSql(sql: string): boolean {
  return /^(select|with)\b/i.test(sql.trim());
}

function buildUpdateSql(
  type: DbConnectionConfig["type"],
  table: string,
  primaryKeys: string[],
  primaryValues: Record<string, unknown>,
  changes: Record<string, unknown>
): string {
  if (type === "elasticsearch") {
    return buildElasticUpdateSql(table, primaryKeys, primaryValues, changes);
  }

  const assignments = Object.entries(changes)
    .filter(([column]) => !primaryKeys.includes(column))
    .map(([column, value]) => `${quoteIdentifier(type, column)} = ${toSqlLiteral(value)}`);
  if (assignments.length === 0) {
    throw new Error("没有可更新的非主键字段。");
  }

  const conditions = primaryKeys.map((primaryKey) => {
    const value = primaryValues[primaryKey];
    if (value === undefined || value === null) {
      throw new Error(`主键 ${primaryKey} 缺少值，无法构造 UPDATE。`);
    }
    return `${quoteIdentifier(type, primaryKey)} = ${toSqlLiteral(value)}`;
  });

  const limitClause = type === "mysql" ? " LIMIT 1" : "";
  return `UPDATE ${quoteIdentifier(type, table)} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")}${limitClause};`;
}

function buildElasticUpdateSql(
  table: string,
  primaryKeys: string[],
  primaryValues: Record<string, unknown>,
  changes: Record<string, unknown>
): string {
  const id = collectElasticIds(primaryKeys, [primaryValues], "UPDATE")[0];
  const doc = Object.fromEntries(Object.entries(changes)
    .filter(([column]) => !["_index", "_id", "_score"].includes(column))
    .map(([column, value]) => [column, toElasticDocumentValue(value)]));
  if (!Object.keys(doc).length) {
    throw new Error("没有可更新的 ES 文档字段。");
  }
  return `POST /${encodePathPart(table)}/_update/${encodePathPart(id)}?refresh=true\n${JSON.stringify({ doc }, null, 2)}`;
}

function buildElasticDeleteRowsSql(table: string, ids: string[]): string {
  return `POST /${encodePathPart(table)}/_delete_by_query?refresh=true\n${JSON.stringify({ query: { ids: { values: ids } } }, null, 2)}`;
}

function buildElasticIndexDocumentSql(table: string, row: Record<string, unknown>): string {
  const id = row._id;
  if (id === undefined || id === null || String(id).trim() === "") {
    throw new Error("ES 回滚数据缺少 _id，无法恢复文档。");
  }
  const doc = Object.fromEntries(Object.entries(row)
    .filter(([column]) => !["_index", "_id", "_score"].includes(column))
    .map(([column, value]) => [column, toElasticDocumentValue(value)]));
  return `PUT /${encodePathPart(String(row._index || table))}/_doc/${encodePathPart(String(id))}?refresh=true\n${JSON.stringify(doc, null, 2)}`;
}

function collectElasticIds(primaryKeys: string[], primaryValuesList: Array<Record<string, unknown>>, action: string): string[] {
  if (primaryKeys.length !== 1 || primaryKeys[0] !== "_id") {
    throw new Error(`ES ${action} 只能使用 _id 作为主键。`);
  }
  const ids = primaryValuesList.map((primaryValues) => primaryValues._id).map((value) => String(value ?? "").trim());
  if (ids.some((id) => !id)) {
    throw new Error(`ES ${action} 缺少 _id，无法执行。`);
  }
  return ids;
}

function toElasticDocumentValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!/^[\[{]/.test(text)) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

function buildDeleteRowsSql(
  type: DbConnectionConfig["type"],
  table: string,
  primaryKeys: string[],
  primaryValuesList: Array<Record<string, unknown>>
): string {
  if (!primaryKeys.length || !primaryValuesList.length) {
    throw new Error("缺少主键或待删除行，无法构造 DELETE。");
  }
  if (type === "elasticsearch") {
    const ids = collectElasticIds(primaryKeys, primaryValuesList, "DELETE");
    return buildElasticDeleteRowsSql(table, ids);
  }

  const rows = primaryValuesList.map((primaryValues) => primaryKeys.map((primaryKey) => {
    const value = primaryValues[primaryKey];
    if (value === undefined || value === null) {
      throw new Error(`主键 ${primaryKey} 缺少值，无法构造 DELETE。`);
    }
    return value;
  }));

  const where = primaryKeys.length === 1
    ? `${quoteIdentifier(type, primaryKeys[0])} IN (${rows.map((row) => toSqlLiteral(row[0])).join(", ")})`
    : `(${primaryKeys.map((primaryKey) => quoteIdentifier(type, primaryKey)).join(", ")}) IN (${rows.map((row) => `(${row.map(toSqlLiteral).join(", ")})`).join(", ")})`;
  return `DELETE FROM ${quoteIdentifier(type, table)} WHERE ${where};`;
}

function buildRollbackSql(type: DbConnectionConfig["type"], log: OperationLogEntry): RollbackPlan {
  if (log.status !== "success") {
    throw new Error("只有执行成功的日志可以回滚。");
  }
  if (!log.tableName.trim()) {
    throw new Error("日志缺少表名，无法回滚。");
  }
  if (log.operationType === "delete") {
    const rows = log.snapshots.map((snapshot) => snapshot.beforeData).filter(isRecord);
    if (!rows.length) {
      throw new Error("删除日志缺少修改前数据，无法回滚。");
    }
    const primaryKeys = getPrimaryKeysFromSnapshots(log);
    return {
      table: log.tableName,
      statements: type === "elasticsearch"
        ? rows.map((row) => buildElasticIndexDocumentSql(log.tableName, row))
        : [buildInsertRowsSql(type, log.tableName, rows)],
      primaryKeys,
      primaryValuesList: log.snapshots.map((snapshot) => snapshot.rowKey).filter((rowKey) => Object.keys(rowKey).length > 0),
    };
  }
  if (log.operationType === "insert") {
    const primaryKeys = getPrimaryKeysFromSnapshots(log);
    const primaryValuesList = log.snapshots.map((snapshot) => snapshot.rowKey).filter((rowKey) => Object.keys(rowKey).length > 0);
    if (!primaryKeys.length || !primaryValuesList.length) {
      throw new Error("新增日志缺少主键信息，无法回滚。");
    }
    return {
      table: log.tableName,
      statements: [buildDeleteRowsSql(type, log.tableName, primaryKeys, primaryValuesList)],
      primaryKeys,
      primaryValuesList,
    };
  }
  if (log.operationType === "update") {
    const statements: string[] = [];
    const primaryKeys = getPrimaryKeysFromSnapshots(log);
    const primaryValuesList: Array<Record<string, unknown>> = [];
    for (const snapshot of log.snapshots) {
      if (!isRecord(snapshot.beforeData) || !Object.keys(snapshot.rowKey).length) {
        continue;
      }
      const changedValues = getChangedRollbackValues(snapshot.beforeData, snapshot.afterData, snapshot.rowKey);
      if (Object.keys(changedValues).length) {
        statements.push(buildUpdateSql(type, log.tableName, Object.keys(snapshot.rowKey), snapshot.rowKey, changedValues));
        primaryValuesList.push(snapshot.rowKey);
      }
    }
    if (!statements.length) {
      throw new Error("修改日志没有可恢复的字段。");
    }
    return { table: log.tableName, statements, primaryKeys, primaryValuesList };
  }
  throw new Error("当前日志类型暂不支持直接回滚。");
}

function buildSelectRowsByPrimaryKeysSql(
  type: DbConnectionConfig["type"],
  table: string,
  primaryKeys: string[],
  primaryValuesList: Array<Record<string, unknown>>
): string {
  if (!primaryKeys.length || !primaryValuesList.length) {
    throw new Error("缺少主键或目标行，无法查询修改前数据。");
  }
  if (type === "elasticsearch") {
    const ids = collectElasticIds(primaryKeys, primaryValuesList, "查询");
    return `POST /${encodePathPart(table)}/_search\n${JSON.stringify({ query: { ids: { values: ids } }, size: Math.max(ids.length, 1) }, null, 2)}`;
  }
  const rows = primaryValuesList.map((primaryValues) => primaryKeys.map((primaryKey) => {
    const value = primaryValues[primaryKey];
    if (value === undefined || value === null) {
      throw new Error(`主键 ${primaryKey} 缺少值，无法查询修改前数据。`);
    }
    return value;
  }));
  const where = primaryKeys.length === 1
    ? `${quoteIdentifier(type, primaryKeys[0])} IN (${rows.map((row) => toSqlLiteral(row[0])).join(", ")})`
    : `(${primaryKeys.map((primaryKey) => quoteIdentifier(type, primaryKey)).join(", ")}) IN (${rows.map((row) => `(${row.map(toSqlLiteral).join(", ")})`).join(", ")})`;
  return `SELECT * FROM ${quoteIdentifier(type, table)} WHERE ${where};`;
}

function buildInsertSql(type: DbConnectionConfig["type"], table: string, values: Record<string, unknown>): string {
  const entries = Object.entries(values);
  const quotedTable = quoteIdentifier(type, table);
  if (entries.length === 0) {
    return type === "postgres"
      ? `INSERT INTO ${quotedTable} DEFAULT VALUES;`
      : `INSERT INTO ${quotedTable} () VALUES ();`;
  }

  const columns = entries.map(([column]) => quoteIdentifier(type, column)).join(", ");
  const literals = entries.map(([, value]) => toSqlLiteral(value)).join(", ");
  return `INSERT INTO ${quotedTable} (${columns}) VALUES (${literals});`;
}

function buildInsertRowsSql(type: DbConnectionConfig["type"], table: string, rows: Record<string, unknown>[]): string {
  if (!rows.length) {
    throw new Error("缺少待恢复数据，无法构造 INSERT。");
  }
  const columns = collectRowColumns(rows);
  if (!columns.length) {
    throw new Error("待恢复数据没有字段，无法构造 INSERT。");
  }
  const quotedColumns = columns.map((column) => quoteIdentifier(type, column)).join(", ");
  const values = rows.map((row) => `(${columns.map((column) => toSqlLiteral(row[column] ?? null)).join(", ")})`).join(", ");
  return `INSERT INTO ${quoteIdentifier(type, table)} (${quotedColumns}) VALUES ${values};`;
}

function buildImportPreviewSql(
  sourceConnection: DbConnectionConfig,
  sourceDatabase: string,
  sourceTable: string,
  targetDatabase: string,
  targetTable: string,
  mappings: Array<{ source: string; target: string }>,
  rowLimit: number,
  batchSize: number
): string {
  const sourceColumns = mappings.map((mapping) => quoteIdentifier("mysql", mapping.source)).join(", ");
  const targetColumns = mappings.map((mapping) => quoteIdentifier("mysql", mapping.target)).join(", ");
  return [
    `-- 来源：${sourceConnection.name} / ${sourceDatabase} / ${sourceTable}`,
    `-- 目标：${targetDatabase} / ${targetTable}`,
    `-- 导入行数：最多 ${rowLimit} 行；批大小：${batchSize} 行；执行时会开启事务，失败自动回滚。`,
    `INSERT INTO ${quoteIdentifier("mysql", targetTable)} (${targetColumns})`,
    `SELECT ${sourceColumns}`,
    `FROM ${quoteIdentifier("mysql", sourceTable)}`,
    `LIMIT ${rowLimit};`,
  ].join("\n");
}

function pickExportRows(resultColumns: string[], rows: Record<string, unknown>[], requestedColumns: string[]): { columns: string[]; rows: Record<string, unknown>[] } {
  const availableColumns = resultColumns.length ? resultColumns : collectRowColumns(rows);
  const availableSet = new Set(availableColumns);
  const columns = requestedColumns.length
    ? requestedColumns.filter((column) => availableSet.has(column))
    : availableColumns;
  return {
    columns,
    rows: rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))),
  };
}

function buildPreviewInsertSql(table: string, rows: Record<string, unknown>[], columns: string[]): string {
  if (!rows.length) {
    return `-- ${table} 当前没有可导出的数据。\n`;
  }
  const quotedColumns = columns.map((column) => quoteIdentifier("mysql", column)).join(", ");
  const values = rows.map((row) => `(${columns.map((column) => toSqlLiteral(row[column] ?? null)).join(", ")})`).join(", ");
  return `INSERT INTO ${quoteIdentifier("mysql", table)} (${quotedColumns}) VALUES ${values};\n`;
}

function buildXlsxBuffer(sheetName: string, columns: string[], rows: Record<string, unknown>[], aliases: Record<string, string> = {}): Buffer {
  const safeColumns = columns.length ? columns : collectRowColumns(rows);
  const headers = safeColumns.map((column) => String(aliases[column] || column));
  const sheetRows = [
    headers,
    ...rows.map((row) => safeColumns.map((column) => row[column])),
  ];
  const sheetXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetData>',
    ...sheetRows.map((values, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = values.map((value, columnIndex) => buildXlsxCell(value, columnIndex, rowNumber)).join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    }),
    '</sheetData>',
    '</worksheet>',
  ].join("");
  const workbookXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets><sheet name="${escapeXmlAttribute(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>`,
    '</workbook>',
  ].join("");
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '</Types>',
  ].join("");
  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '</Relationships>',
  ].join("");
  const workbookRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '</Relationships>',
  ].join("");
  const stylesXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
    '<borders count="1"><border/></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>',
    '</styleSheet>',
  ].join("");
  return createZipBuffer([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(stylesXml, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml, "utf8") },
  ]);
}

function buildXlsxCell(value: unknown, columnIndex: number, rowNumber: number): string {
  const ref = `${xlsxColumnName(columnIndex + 1)}${rowNumber}`;
  if (value === null || value === undefined) {
    return `<c r="${ref}"/>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXmlText(formatExportCellValue(value))}</t></is></c>`;
}

function xlsxColumnName(index: number): string {
  let value = index;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function formatExportCellValue(value: unknown): string {
  if (value instanceof Date) return formatDateForSql(value);
  if (typeof value === "string") return formatStringForSqlLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function sanitizeSheetName(value: string): string {
  const name = String(value || "Sheet1").replace(/[\\/?*\[\]:]/g, " ").trim() || "Sheet1";
  return name.slice(0, 31);
}

function sanitizeFileName(value: string): string {
  return String(value || "export").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "export";
}

function escapeXmlText(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function createZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = Array.from({ length: 256 }, (_unused, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function collectRowColumns(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!columns.includes(column)) {
        columns.push(column);
      }
    }
  }
  return columns;
}

function getPrimaryKeysFromSnapshots(log: OperationLogEntry): string[] {
  return Object.keys(log.snapshots.find((snapshot) => Object.keys(snapshot.rowKey).length > 0)?.rowKey ?? {});
}

function getChangedRollbackValues(
  beforeData: Record<string, unknown>,
  afterData: Record<string, unknown> | null | undefined,
  rowKey: Record<string, unknown>
): Record<string, unknown> {
  const primaryKeys = new Set(Object.keys(rowKey));
  const changes: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(beforeData)) {
    if (primaryKeys.has(column)) {
      continue;
    }
    const afterValue = isRecord(afterData) ? afterData[column] : undefined;
    if (normalizeComparableValue(value) !== normalizeComparableValue(afterValue)) {
      changes[column] = value;
    }
  }
  return changes;
}

function findRowByPrimaryValues(rows: Record<string, unknown>[], primaryValues: Record<string, unknown>): Record<string, unknown> | null {
  const entries = Object.entries(primaryValues);
  if (!entries.length) {
    return null;
  }
  return rows.find((row) => entries.every(([key, value]) => String(row[key]) === String(value))) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRecordSubsetEqual(current: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => normalizeComparableValue(current[key]) === normalizeComparableValue(value));
}

function normalizeComparableValue(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Buffer.isBuffer(value)) {
    return JSON.stringify(value.toString("base64"));
  }
  if (value === undefined) {
    return "__undefined__";
  }
  return JSON.stringify(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSchemaDraftSql(originalTable: TableInfo, draft: Record<string, unknown>, type: DbConnectionConfig["type"] = "mysql"): string[] {
  if (type === "postgres") {
    return buildPostgresSchemaDraftSql(originalTable, draft);
  }
  const draftTable = asRecord(draft.table);
  const draftColumns = asArray(draft.columns).map(asRecord).filter((column) => !isDraftPendingDelete(column));
  const columnOrderMoves = asArray(draft.columnOrderMoves).map(asRecord);
  const deletedItems = asRecord(draft.deletedItems);
  const statements: string[] = [];
  const originalName = originalTable.name;
  const nextName = getDraftTableName(draft) || originalName;
  let workingTable = originalName;

  if (nextName !== originalName) {
    statements.push(`RENAME TABLE ${quoteIdentifier("mysql", originalName)} TO ${quoteIdentifier("mysql", nextName)};`);
    workingTable = nextName;
  }

  const originalComment = originalTable.comment ?? "";
  const nextComment = asString(draftTable.comment);
  if (nextComment !== originalComment) {
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} COMMENT = ${toSqlLiteral(nextComment)};`);
  }

  const originalColumns = originalTable.columns;
  const originalByName = new Map(originalColumns.map((column) => [column.name, column]));
  const moveByOriginalName = new Map(columnOrderMoves.map((move) => [asString(move.originalName) || asString(move.name), move]));
  const deletedColumns = asArray(deletedItems.columns).map(asRecord);
  const deletedKeys = asArray(deletedItems.keys).map(asRecord);
  const deletedColumnNames = new Set(deletedColumns.map((column) => asString(column.originalName) || asString(column.name)).filter(Boolean));
  const originalPrimaryKeys = originalColumns.filter((column) => column.key === "PRI").map((column) => column.name);
  const primaryDraft = asArray(draft.keys).map(asRecord).filter((key) => !isDraftPendingDelete(key)).find((key) => key.primary === true);
  const nextPrimaryKeys = primaryDraft ? asArray(primaryDraft.columns).map(String).filter((column) => column && !deletedColumnNames.has(column)) : [];
  const primaryDeleted = deletedKeys.some((key) => key.primary === true || asString(key.originalName) === "PRIMARY" || asString(key.name) === "PRIMARY")
    || originalPrimaryKeys.some((column) => deletedColumnNames.has(column));
  const primaryChanged = primaryDeleted || nextPrimaryKeys.join("\n") !== originalPrimaryKeys.join("\n");

  const droppedTriggers = new Set<string>();
  for (const triggerDraft of asArray(deletedItems.triggers).map(asRecord)) {
    const name = asString(triggerDraft.originalName) || asString(triggerDraft.name);
    if (name && !droppedTriggers.has(name)) {
      droppedTriggers.add(name);
      statements.push(`DROP TRIGGER ${quoteIdentifier("mysql", name)};`);
    }
  }

  const droppedForeignKeys = new Set<string>();
  const foreignKeysToDrop = [
    ...asArray(deletedItems.foreignKeys).map(asRecord),
    ...(originalTable.foreignKeys || []).filter((foreignKey) => foreignKey.columns.some((column) => deletedColumnNames.has(column))),
  ];
  for (const fkDraftValue of foreignKeysToDrop) {
    const fkDraft = asRecord(fkDraftValue);
    const name = asString(fkDraft.originalName) || asString(fkDraft.name);
    if (name && !droppedForeignKeys.has(name)) {
      droppedForeignKeys.add(name);
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} DROP FOREIGN KEY ${quoteIdentifier("mysql", name)};`);
    }
  }

  const droppedChecks = new Set<string>();
  for (const checkDraft of asArray(deletedItems.checks).map(asRecord)) {
    const name = asString(checkDraft.originalName) || asString(checkDraft.name);
    if (name && !droppedChecks.has(name)) {
      droppedChecks.add(name);
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} DROP CHECK ${quoteIdentifier("mysql", name)};`);
    }
  }

  const droppedIndexes = new Set<string>();
  const indexesToDrop = [
    ...asArray(deletedItems.indexes).map(asRecord),
    ...deletedKeys.filter((key) => key.primary !== true),
    ...(originalTable.indexes || []).filter((index) => index.columns.some((column) => deletedColumnNames.has(column))),
  ];
  for (const indexDraftValue of indexesToDrop) {
    const indexDraft = asRecord(indexDraftValue);
    const name = asString(indexDraft.originalName) || asString(indexDraft.name);
    if (name && name !== "PRIMARY" && !droppedIndexes.has(name)) {
      droppedIndexes.add(name);
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} DROP INDEX ${quoteIdentifier("mysql", name)};`);
    }
  }

  if (primaryChanged && originalPrimaryKeys.length) {
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} DROP PRIMARY KEY;`);
  }

  for (const columnDraft of deletedColumns) {
    const name = asString(columnDraft.originalName) || asString(columnDraft.name);
    if (name) statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} DROP COLUMN ${quoteIdentifier("mysql", name)};`);
  }

  for (let index = 0; index < draftColumns.length; index += 1) {
    const column = draftColumns[index];
    const originalColumnName = asString(column.originalName) || asString(column.name);
    const originalColumn = originalByName.get(originalColumnName);
    const move = moveByOriginalName.get(originalColumnName);
    const moveAfter = getPreviousDraftColumnName(draftColumns, originalColumnName);
    const movedPositionSql = move
      ? moveAfter
        ? ` AFTER ${quoteIdentifier("mysql", moveAfter)}`
        : " FIRST"
      : "";
    const newColumnPositionSql = index === 0 ? " FIRST" : ` AFTER ${quoteIdentifier("mysql", asString(draftColumns[index - 1].name))}`;
    const definition = buildMysqlColumnDefinitionFromDraft(column);

    if (!originalColumn || column.isNew === true) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} ADD COLUMN ${definition}${newColumnPositionSql};`);
      continue;
    }

    const needsChange = columnNeedsChange(originalColumn, column);
    if (needsChange || move) {
      const action = asString(column.name) === originalColumnName ? "MODIFY COLUMN" : `CHANGE COLUMN ${quoteIdentifier("mysql", originalColumnName)}`;
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} ${action} ${definition}${movedPositionSql};`);
    }
  }

  if (primaryChanged && nextPrimaryKeys.length) {
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} ADD PRIMARY KEY (${nextPrimaryKeys.map((column) => quoteIdentifier("mysql", column)).join(", ")});`);
  }

  for (const keyDraft of asArray(draft.keys).map(asRecord).filter((item) => item.isNew === true && item.primary !== true && !isDraftPendingDelete(item))) {
    const columns = asArray(keyDraft.columns).map(String).filter(Boolean);
    if (!columns.length) continue;
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} ADD KEY ${quoteIdentifier("mysql", asString(keyDraft.name) || "key_new")} (${columns.map((column) => quoteIdentifier("mysql", column)).join(", ")});`);
  }

  for (const indexDraft of asArray(draft.indexes).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const columns = asArray(indexDraft.columns).map(String).filter(Boolean);
    if (!columns.length) continue;
    const unique = indexDraft.unique === true ? "UNIQUE " : "";
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} ADD ${unique}INDEX ${quoteIdentifier("mysql", asString(indexDraft.name) || "idx_new")} (${columns.map((column) => quoteIdentifier("mysql", column)).join(", ")});`);
  }

  for (const fkDraft of asArray(draft.foreignKeys).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const columns = asArray(fkDraft.columns).map(String).filter(Boolean);
    const referenceColumns = parseColumnList(fkDraft.referenceColumns);
    const referenceTable = asString(fkDraft.referenceTable);
    if (!columns.length || !referenceTable || !referenceColumns.length) continue;
    const onUpdate = asString(fkDraft.onUpdate);
    const onDelete = asString(fkDraft.onDelete);
    statements.push(
      `ALTER TABLE ${quoteIdentifier("mysql", workingTable)} ADD CONSTRAINT ${quoteIdentifier("mysql", asString(fkDraft.name) || "fk_new")} FOREIGN KEY (${columns.map((column) => quoteIdentifier("mysql", column)).join(", ")}) REFERENCES ${quoteIdentifier("mysql", referenceTable)} (${referenceColumns.map((column) => quoteIdentifier("mysql", column)).join(", ")})${onUpdate ? ` ON UPDATE ${onUpdate}` : ""}${onDelete ? ` ON DELETE ${onDelete}` : ""};`
    );
  }

  for (const checkDraft of asArray(draft.checks).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const expression = asString(checkDraft.expression);
    if (!expression) continue;
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} ADD CONSTRAINT ${quoteIdentifier("mysql", asString(checkDraft.name) || "chk_new")} CHECK (${expression});`);
  }

  for (const triggerDraft of asArray(draft.triggers).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const statement = asString(triggerDraft.statement);
    if (!statement) continue;
    statements.push(`CREATE TRIGGER ${quoteIdentifier("mysql", asString(triggerDraft.name) || "trg_new")} ${asString(triggerDraft.timing) || "BEFORE"} ${asString(triggerDraft.event) || "INSERT"} ON ${quoteIdentifier("mysql", workingTable)} FOR EACH ROW ${statement};`);
  }

  const autoIncrementValue = draftColumns
    .filter((column) => column.autoIncrement === true)
    .map((column) => asString(column.autoIncrementValue))
    .find(Boolean);
  if (autoIncrementValue) {
    const nextAutoIncrementValue = Number(autoIncrementValue);
    if (!Number.isSafeInteger(nextAutoIncrementValue) || nextAutoIncrementValue < 1) {
      throw new Error("自增值必须是大于 0 的整数。");
    }
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", workingTable)} AUTO_INCREMENT = ${nextAutoIncrementValue};`);
  }

  return statements;
}

function buildCreateTableDraftSql(draft: Record<string, unknown>, type: DbConnectionConfig["type"] = "mysql"): string[] {
  if (type === "postgres") {
    return buildPostgresCreateTableDraftSql(draft);
  }
  const draftTable = asRecord(draft.table);
  const tableName = getDraftTableName(draft);
  if (!tableName) {
    throw new Error("表名称不能为空。");
  }

  const columns = asArray(draft.columns).map(asRecord).filter((column) => !isDraftPendingDelete(column));
  if (!columns.length) {
    throw new Error("新建表至少需要一个列。");
  }

  const lines = columns.map((column) => `  ${buildMysqlColumnDefinitionFromDraft(column)}`);
  const deletedColumnNames = new Set(
    asArray(asRecord(draft.deletedItems).columns)
      .map(asRecord)
      .map((column) => asString(column.originalName) || asString(column.name))
      .filter(Boolean)
  );

  const validColumns = new Set(columns.map((column) => asString(column.name)).filter(Boolean));
  const normalizeColumns = (value: unknown) => asArray(value)
    .map(String)
    .filter((column) => column && validColumns.has(column) && !deletedColumnNames.has(column));

  for (const keyDraft of asArray(draft.keys).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const keyColumns = normalizeColumns(keyDraft.columns);
    if (!keyColumns.length) continue;
    if (keyDraft.primary === true || asString(keyDraft.name).toUpperCase() === "PRIMARY") {
      lines.push(`  PRIMARY KEY (${keyColumns.map((column) => quoteIdentifier("mysql", column)).join(", ")})`);
      continue;
    }
    lines.push(`  KEY ${quoteIdentifier("mysql", asString(keyDraft.name) || "key_new")} (${keyColumns.map((column) => quoteIdentifier("mysql", column)).join(", ")})`);
  }

  for (const indexDraft of asArray(draft.indexes).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const indexColumns = normalizeColumns(indexDraft.columns);
    if (!indexColumns.length) continue;
    const unique = indexDraft.unique === true ? "UNIQUE " : "";
    lines.push(`  ${unique}INDEX ${quoteIdentifier("mysql", asString(indexDraft.name) || "idx_new")} (${indexColumns.map((column) => quoteIdentifier("mysql", column)).join(", ")})`);
  }

  for (const fkDraft of asArray(draft.foreignKeys).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const columns = normalizeColumns(fkDraft.columns);
    const referenceColumns = parseColumnList(fkDraft.referenceColumns);
    const referenceTable = asString(fkDraft.referenceTable);
    if (!columns.length || !referenceTable || !referenceColumns.length) continue;
    const onUpdate = asString(fkDraft.onUpdate);
    const onDelete = asString(fkDraft.onDelete);
    lines.push(
      `  CONSTRAINT ${quoteIdentifier("mysql", asString(fkDraft.name) || "fk_new")} FOREIGN KEY (${columns.map((column) => quoteIdentifier("mysql", column)).join(", ")}) REFERENCES ${quoteIdentifier("mysql", referenceTable)} (${referenceColumns.map((column) => quoteIdentifier("mysql", column)).join(", ")})${onUpdate ? ` ON UPDATE ${onUpdate}` : ""}${onDelete ? ` ON DELETE ${onDelete}` : ""}`
    );
  }

  for (const checkDraft of asArray(draft.checks).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const expression = asString(checkDraft.expression);
    if (!expression) continue;
    lines.push(`  CONSTRAINT ${quoteIdentifier("mysql", asString(checkDraft.name) || "chk_new")} CHECK (${expression})`);
  }

  const tableComment = asString(draftTable.comment);
  const tableOptions = [
    "ENGINE=InnoDB",
    "DEFAULT CHARSET=utf8mb4",
    tableComment ? `COMMENT=${toSqlLiteral(tableComment)}` : "",
  ].filter(Boolean).join(" ");
  const statements = [`CREATE TABLE ${quoteIdentifier("mysql", tableName)} (\n${lines.join(",\n")}\n) ${tableOptions};`];

  const autoIncrementValue = columns
    .filter((column) => column.autoIncrement === true)
    .map((column) => asString(column.autoIncrementValue))
    .find(Boolean);
  if (autoIncrementValue) {
    const nextAutoIncrementValue = Number(autoIncrementValue);
    if (!Number.isSafeInteger(nextAutoIncrementValue) || nextAutoIncrementValue < 1) {
      throw new Error("自增值必须是大于 0 的整数。");
    }
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", tableName)} AUTO_INCREMENT = ${nextAutoIncrementValue};`);
  }

  for (const triggerDraft of asArray(draft.triggers).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const statement = asString(triggerDraft.statement);
    if (!statement) continue;
    statements.push(`CREATE TRIGGER ${quoteIdentifier("mysql", asString(triggerDraft.name) || "trg_new")} ${asString(triggerDraft.timing) || "BEFORE"} ${asString(triggerDraft.event) || "INSERT"} ON ${quoteIdentifier("mysql", tableName)} FOR EACH ROW ${statement};`);
  }

  return statements;
}

function buildPostgresSchemaDraftSql(originalTable: TableInfo, draft: Record<string, unknown>): string[] {
  const draftTable = asRecord(draft.table);
  const draftColumns = asArray(draft.columns).map(asRecord).filter((column) => !isDraftPendingDelete(column));
  if (asArray(draft.columnOrderMoves).length > 0) {
    throw new Error("PostgreSQL 不支持通过 ALTER TABLE 直接调整已有列顺序；如需改变物理列顺序，请重建表或使用新表迁移数据。");
  }
  const deletedItems = asRecord(draft.deletedItems);
  const statements: string[] = [];
  const originalName = originalTable.name;
  const nextName = getDraftTableName(draft) || originalName;
  let workingTable = originalName;

  if (nextName !== originalName) {
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", originalName)} RENAME TO ${quoteIdentifier("postgres", nextName)};`);
    workingTable = nextName;
  }

  const originalComment = originalTable.comment ?? "";
  const nextComment = asString(draftTable.comment);
  if (nextComment !== originalComment) {
    statements.push(`COMMENT ON TABLE ${quoteIdentifier("postgres", workingTable)} IS ${nextComment ? toSqlLiteral(nextComment) : "NULL"};`);
  }

  const originalColumns = originalTable.columns;
  const originalByName = new Map(originalColumns.map((column) => [column.name, column]));
  const deletedColumns = asArray(deletedItems.columns).map(asRecord);
  const deletedKeys = asArray(deletedItems.keys).map(asRecord);
  const deletedColumnNames = new Set(deletedColumns.map((column) => asString(column.originalName) || asString(column.name)).filter(Boolean));
  const originalPrimaryKeys = originalColumns.filter((column) => column.key === "PRI").map((column) => column.name);
  const primaryDraft = asArray(draft.keys).map(asRecord).filter((key) => !isDraftPendingDelete(key)).find((key) => key.primary === true);
  const nextPrimaryKeys = primaryDraft ? asArray(primaryDraft.columns).map(String).filter((column) => column && !deletedColumnNames.has(column)) : [];
  const primaryDeleted = deletedKeys.some((key) => key.primary === true || asString(key.originalName) === originalTable.primaryKeyName)
    || originalPrimaryKeys.some((column) => deletedColumnNames.has(column));
  const primaryChanged = primaryDeleted || nextPrimaryKeys.join("\n") !== originalPrimaryKeys.join("\n") || (primaryDraft && asString(primaryDraft.name) !== (originalTable.primaryKeyName || `${workingTable}_pkey`));

  const droppedTriggers = new Set<string>();
  for (const triggerDraft of asArray(deletedItems.triggers).map(asRecord)) {
    const name = asString(triggerDraft.originalName) || asString(triggerDraft.name);
    if (name && !droppedTriggers.has(name)) {
      droppedTriggers.add(name);
      statements.push(`DROP TRIGGER ${quoteIdentifier("postgres", name)} ON ${quoteIdentifier("postgres", workingTable)};`);
    }
  }

  const droppedConstraints = new Set<string>();
  const dropConstraint = (name: string) => {
    if (!name || droppedConstraints.has(name)) return;
    droppedConstraints.add(name);
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} DROP CONSTRAINT ${quoteIdentifier("postgres", name)};`);
  };
  for (const fkDraft of asArray(deletedItems.foreignKeys).map(asRecord)) {
    dropConstraint(asString(fkDraft.originalName) || asString(fkDraft.name));
  }
  for (const checkDraft of asArray(deletedItems.checks).map(asRecord)) {
    dropConstraint(asString(checkDraft.originalName) || asString(checkDraft.name));
  }
  for (const foreignKey of originalTable.foreignKeys || []) {
    if (foreignKey.columns.some((column) => deletedColumnNames.has(column))) dropConstraint(foreignKey.name);
  }
  for (const check of originalTable.checks || []) {
    if ([...deletedColumnNames].some((column) => isCheckExpressionReferencingColumn(check.expression, column))) dropConstraint(check.name);
  }
  if (primaryChanged && originalPrimaryKeys.length) {
    dropConstraint(originalTable.primaryKeyName || `${originalName}_pkey`);
  }

  const droppedIndexes = new Set<string>();
  const indexesToDrop = [
    ...asArray(deletedItems.indexes).map(asRecord),
    ...deletedKeys.filter((key) => key.primary !== true),
    ...(originalTable.indexes || []).filter((index) => index.columns.some((column) => deletedColumnNames.has(column))),
  ];
  for (const indexDraftValue of indexesToDrop) {
    const indexDraft = asRecord(indexDraftValue);
    const name = asString(indexDraft.originalName) || asString(indexDraft.name);
    if (name && !droppedIndexes.has(name)) {
      droppedIndexes.add(name);
      statements.push(`DROP INDEX ${quoteIdentifier("postgres", name)};`);
    }
  }

  for (const columnDraft of deletedColumns) {
    const name = asString(columnDraft.originalName) || asString(columnDraft.name);
    if (name) statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} DROP COLUMN ${quoteIdentifier("postgres", name)};`);
  }

  for (const column of draftColumns) {
    const originalColumnName = asString(column.originalName) || asString(column.name);
    const originalColumn = originalByName.get(originalColumnName);
    if (!originalColumn || column.isNew === true) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ADD COLUMN ${buildPostgresColumnDefinitionFromDraft(column)};`);
      const comment = asString(column.comment);
      if (comment) {
        statements.push(`COMMENT ON COLUMN ${quoteIdentifier("postgres", workingTable)}.${quoteIdentifier("postgres", asString(column.name))} IS ${toSqlLiteral(comment)};`);
      }
      continue;
    }

    let currentColumnName = originalColumnName;
    const nextColumnName = asString(column.name);
    if (nextColumnName !== originalColumnName) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} RENAME COLUMN ${quoteIdentifier("postgres", originalColumnName)} TO ${quoteIdentifier("postgres", nextColumnName)};`);
      currentColumnName = nextColumnName;
    }
    if (asString(column.type) !== originalColumn.type) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} TYPE ${asString(column.type) || "text"};`);
    }
    if ((column.notNull === true) !== !originalColumn.nullable) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} ${column.notNull === true ? "SET" : "DROP"} NOT NULL;`);
    }
    const originalAutoIncrement = /auto_increment/i.test(originalColumn.extra || "") || isPostgresGeneratedDefault(originalColumn.defaultValue);
    const nextAutoIncrement = column.autoIncrement === true;
    const originalDefault = originalColumn.defaultValue === null || originalColumn.defaultValue === undefined ? "" : String(originalColumn.defaultValue);
    const nextDefault = asString(column.defaultValue);
    const originalDefaultIsSerial = isPostgresGeneratedDefault(originalDefault);
    if (originalAutoIncrement && !nextAutoIncrement) {
      if (originalDefaultIsSerial && nextDefault === originalDefault) {
        statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} DROP DEFAULT;`);
      } else if (nextDefault !== originalDefault) {
        statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} ${nextDefault ? `SET DEFAULT ${formatPostgresDefault(nextDefault)}` : "DROP DEFAULT"};`);
      }
      if (!originalDefaultIsSerial) {
        statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} DROP IDENTITY IF EXISTS;`);
      }
    } else if (!originalAutoIncrement && nextAutoIncrement) {
      if (originalDefault) {
        statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} DROP DEFAULT;`);
      }
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} ADD GENERATED BY DEFAULT AS IDENTITY;`);
    } else if (!nextAutoIncrement && nextDefault !== originalDefault) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} ${nextDefault ? `SET DEFAULT ${formatPostgresDefault(nextDefault)}` : "DROP DEFAULT"};`);
    }
    if (asString(column.comment) !== (originalColumn.comment ?? "")) {
      const comment = asString(column.comment);
      statements.push(`COMMENT ON COLUMN ${quoteIdentifier("postgres", workingTable)}.${quoteIdentifier("postgres", currentColumnName)} IS ${comment ? toSqlLiteral(comment) : "NULL"};`);
    }
  }

  if (primaryChanged && nextPrimaryKeys.length) {
    const primaryName = asString(primaryDraft?.name) || `${workingTable}_pkey`;
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ADD CONSTRAINT ${quoteIdentifier("postgres", primaryName)} PRIMARY KEY (${nextPrimaryKeys.map((column) => quoteIdentifier("postgres", column)).join(", ")});`);
  }

  for (const keyDraft of asArray(draft.keys).map(asRecord).filter((item) => item.isNew === true && item.primary !== true && !isDraftPendingDelete(item))) {
    const columns = asArray(keyDraft.columns).map(String).filter(Boolean);
    if (!columns.length) continue;
    statements.push(`CREATE INDEX ${quoteIdentifier("postgres", asString(keyDraft.name) || "key_new")} ON ${quoteIdentifier("postgres", workingTable)} (${columns.map((column) => quoteIdentifier("postgres", column)).join(", ")});`);
  }

  for (const indexDraft of asArray(draft.indexes).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const columns = asArray(indexDraft.columns).map(String).filter(Boolean);
    if (!columns.length) continue;
    const unique = indexDraft.unique === true ? "UNIQUE " : "";
    statements.push(`CREATE ${unique}INDEX ${quoteIdentifier("postgres", asString(indexDraft.name) || "idx_new")} ON ${quoteIdentifier("postgres", workingTable)} (${columns.map((column) => quoteIdentifier("postgres", column)).join(", ")});`);
  }

  for (const fkDraft of asArray(draft.foreignKeys).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const sql = buildPostgresForeignKeySql(workingTable, fkDraft);
    if (sql) statements.push(sql);
  }
  for (const checkDraft of asArray(draft.checks).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const expression = asString(checkDraft.expression);
    if (!expression) continue;
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ADD CONSTRAINT ${quoteIdentifier("postgres", asString(checkDraft.name) || "chk_new")} CHECK (${expression});`);
  }
  for (const triggerDraft of asArray(draft.triggers).map(asRecord).filter((item) => item.isNew === true && !isDraftPendingDelete(item))) {
    const statement = asString(triggerDraft.statement);
    if (!statement) continue;
    statements.push(`CREATE TRIGGER ${quoteIdentifier("postgres", asString(triggerDraft.name) || "trg_new")} ${asString(triggerDraft.timing) || "BEFORE"} ${asString(triggerDraft.event) || "INSERT"} ON ${quoteIdentifier("postgres", workingTable)} FOR EACH ROW ${statement};`);
  }

  return statements;
}

function buildPostgresCreateTableDraftSql(draft: Record<string, unknown>): string[] {
  const draftTable = asRecord(draft.table);
  const tableName = getDraftTableName(draft);
  if (!tableName) {
    throw new Error("表名称不能为空。");
  }
  const columns = asArray(draft.columns).map(asRecord).filter((column) => !isDraftPendingDelete(column));
  if (!columns.length) {
    throw new Error("新建表至少需要一个列。");
  }
  const lines = columns.map((column) => `  ${buildPostgresColumnDefinitionFromDraft(column)}`);
  const validColumns = new Set(columns.map((column) => asString(column.name)).filter(Boolean));
  const normalizeColumns = (value: unknown) => asArray(value).map(String).filter((column) => column && validColumns.has(column));

  for (const keyDraft of asArray(draft.keys).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const keyColumns = normalizeColumns(keyDraft.columns);
    if (!keyColumns.length) continue;
    if (keyDraft.primary === true) {
      lines.push(`  CONSTRAINT ${quoteIdentifier("postgres", asString(keyDraft.name) || `${tableName}_pkey`)} PRIMARY KEY (${keyColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")})`);
    }
  }
  for (const fkDraft of asArray(draft.foreignKeys).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const columns = normalizeColumns(fkDraft.columns);
    const referenceColumns = parseColumnList(fkDraft.referenceColumns);
    const referenceTable = asString(fkDraft.referenceTable);
    if (!columns.length || !referenceTable || !referenceColumns.length) continue;
    const onUpdate = asString(fkDraft.onUpdate);
    const onDelete = asString(fkDraft.onDelete);
    lines.push(`  CONSTRAINT ${quoteIdentifier("postgres", asString(fkDraft.name) || "fk_new")} FOREIGN KEY (${columns.map((column) => quoteIdentifier("postgres", column)).join(", ")}) REFERENCES ${quoteIdentifier("postgres", referenceTable)} (${referenceColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")})${onUpdate ? ` ON UPDATE ${onUpdate}` : ""}${onDelete ? ` ON DELETE ${onDelete}` : ""}`);
  }
  for (const checkDraft of asArray(draft.checks).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const expression = asString(checkDraft.expression);
    if (!expression) continue;
    lines.push(`  CONSTRAINT ${quoteIdentifier("postgres", asString(checkDraft.name) || "chk_new")} CHECK (${expression})`);
  }

  const statements = [`CREATE TABLE ${quoteIdentifier("postgres", tableName)} (\n${lines.join(",\n")}\n);`];
  const tableComment = asString(draftTable.comment);
  if (tableComment) {
    statements.push(`COMMENT ON TABLE ${quoteIdentifier("postgres", tableName)} IS ${toSqlLiteral(tableComment)};`);
  }
  for (const column of columns) {
    const comment = asString(column.comment);
    if (comment) {
      statements.push(`COMMENT ON COLUMN ${quoteIdentifier("postgres", tableName)}.${quoteIdentifier("postgres", asString(column.name))} IS ${toSqlLiteral(comment)};`);
    }
  }
  for (const keyDraft of asArray(draft.keys).map(asRecord).filter((item) => !isDraftPendingDelete(item) && item.primary !== true)) {
    const keyColumns = normalizeColumns(keyDraft.columns);
    if (!keyColumns.length) continue;
    statements.push(`CREATE INDEX ${quoteIdentifier("postgres", asString(keyDraft.name) || "key_new")} ON ${quoteIdentifier("postgres", tableName)} (${keyColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")});`);
  }
  for (const indexDraft of asArray(draft.indexes).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const indexColumns = normalizeColumns(indexDraft.columns);
    if (!indexColumns.length) continue;
    const unique = indexDraft.unique === true ? "UNIQUE " : "";
    statements.push(`CREATE ${unique}INDEX ${quoteIdentifier("postgres", asString(indexDraft.name) || "idx_new")} ON ${quoteIdentifier("postgres", tableName)} (${indexColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")});`);
  }
  for (const triggerDraft of asArray(draft.triggers).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const statement = asString(triggerDraft.statement);
    if (!statement) continue;
    statements.push(`CREATE TRIGGER ${quoteIdentifier("postgres", asString(triggerDraft.name) || "trg_new")} ${asString(triggerDraft.timing) || "BEFORE"} ${asString(triggerDraft.event) || "INSERT"} ON ${quoteIdentifier("postgres", tableName)} FOR EACH ROW ${statement};`);
  }
  return statements;
}

function buildPostgresColumnDefinitionFromDraft(column: Record<string, unknown>): string {
  const name = asString(column.name);
  if (!name) {
    throw new Error("列名称不能为空。");
  }
  const type = asString(column.type) || "text";
  let sql = `${quoteIdentifier("postgres", name)} ${type}`;
  if (column.autoIncrement === true) {
    sql += " GENERATED BY DEFAULT AS IDENTITY";
  }
  sql += column.notNull === true ? " NOT NULL" : "";
  const defaultValue = asString(column.defaultValue);
  if (defaultValue && column.autoIncrement !== true) {
    sql += ` DEFAULT ${formatPostgresDefault(defaultValue)}`;
  }
  return sql;
}

function buildPostgresForeignKeySql(table: string, fkDraft: Record<string, unknown>): string {
  const columns = asArray(fkDraft.columns).map(String).filter(Boolean);
  const referenceColumns = parseColumnList(fkDraft.referenceColumns);
  const referenceTable = asString(fkDraft.referenceTable);
  if (!columns.length || !referenceTable || !referenceColumns.length) return "";
  const onUpdate = asString(fkDraft.onUpdate);
  const onDelete = asString(fkDraft.onDelete);
  return `ALTER TABLE ${quoteIdentifier("postgres", table)} ADD CONSTRAINT ${quoteIdentifier("postgres", asString(fkDraft.name) || "fk_new")} FOREIGN KEY (${columns.map((column) => quoteIdentifier("postgres", column)).join(", ")}) REFERENCES ${quoteIdentifier("postgres", referenceTable)} (${referenceColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")})${onUpdate ? ` ON UPDATE ${onUpdate}` : ""}${onDelete ? ` ON DELETE ${onDelete}` : ""};`;
}

function formatPostgresDefault(value: string): string {
  const text = value.trim();
  if (/^(NULL|CURRENT_TIMESTAMP(?:\(\))?|CURRENT_DATE(?:\(\))?|CURRENT_TIME(?:\(\))?|NOW\(\))$/i.test(text)) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^'.*'$/.test(text)) return text;
  if (/^nextval\(/i.test(text)) return text;
  return toSqlLiteral(text);
}

function isCheckExpressionReferencingColumn(expression: string, columnName: string): boolean {
  const compactExpression = String(expression || "").replace(/"/g, "").toLowerCase();
  const compactColumn = String(columnName || "").replace(/"/g, "").toLowerCase();
  return Boolean(compactColumn) && new RegExp(`(^|[^a-z0-9_])${escapeRegExp(compactColumn)}([^a-z0-9_]|$)`, "i").test(compactExpression);
}

function isPostgresGeneratedDefault(defaultValue: unknown): boolean {
  return /nextval\(/i.test(String(defaultValue || ""));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCreateTableDraft(draft: Record<string, unknown>): boolean {
  return asString(draft.mode) === "createTable";
}

function isDraftPendingDelete(value: Record<string, unknown>): boolean {
  return value.pendingDelete === true;
}

function getPreviousDraftColumnName(columns: Array<Record<string, unknown>>, originalName: string): string {
  const index = columns.findIndex((column) => (asString(column.originalName) || asString(column.name)) === originalName);
  return index > 0 ? asString(columns[index - 1].name) : "";
}

function getDraftTableName(draft: Record<string, unknown>): string {
  return asString(asRecord(draft.table).name);
}

function buildMysqlColumnDefinitionFromDraft(column: Record<string, unknown>): string {
  const name = asString(column.name);
  if (!name) {
    throw new Error("列名称不能为空。");
  }
  const type = asString(column.type) || "varchar(255)";
  let sql = `${quoteIdentifier("mysql", name)} ${type}`;
  sql += column.notNull === true ? " NOT NULL" : " NULL";
  const defaultValue = asString(column.defaultValue);
  if (defaultValue) {
    sql += ` DEFAULT ${formatMysqlDefault(defaultValue)}`;
  }
  if (column.autoIncrement === true) {
    sql += " AUTO_INCREMENT";
  }
  const onUpdate = asString(column.onUpdate);
  if (onUpdate) {
    sql += ` ON UPDATE ${onUpdate}`;
  }
  const comment = asString(column.comment);
  if (comment) {
    sql += ` COMMENT ${toSqlLiteral(comment)}`;
  }
  return sql;
}

function columnNeedsChange(original: TableInfo["columns"][number], draft: Record<string, unknown>): boolean {
  const originalDefault = original.defaultValue === null || original.defaultValue === undefined ? "" : String(original.defaultValue);
  const originalOnUpdate = parseMysqlOnUpdate(original.extra || "");
  return asString(draft.name) !== original.name
    || asString(draft.type) !== original.type
    || (draft.notNull === true) !== !original.nullable
    || asString(draft.defaultValue) !== originalDefault
    || (draft.autoIncrement === true) !== /auto_increment/i.test(original.extra || "")
    || asString(draft.onUpdate) !== originalOnUpdate
    || asString(draft.comment) !== (original.comment ?? "");
}

function formatMysqlDefault(value: string): string {
  const text = value.trim();
  if (/^(NULL|CURRENT_TIMESTAMP(?:\(\))?|CURRENT_DATE(?:\(\))?|CURRENT_TIME(?:\(\))?)$/i.test(text)) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^'.*'$/.test(text)) return text;
  return toSqlLiteral(text);
}

function parseMysqlOnUpdate(extra: string): string {
  const match = extra.match(/on update\s+(.+)$/i);
  return match ? match[1] : "";
}

function parseColumnList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function quoteIdentifier(type: DbConnectionConfig["type"], identifier: string): string {
  if (type === "mysql") {
    return `\`${identifier.replace(/`/g, "``")}\``;
  }
  if (type !== "postgres") {
    return identifier;
  }

  return identifier
    .split(".")
    .map((part) => `"${part.replace(/"/g, "\"\"")}"`)
    .join(".");
}

function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (value instanceof Date) {
    return `'${formatDateForSql(value)}'`;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  const text = typeof value === "object" ? JSON.stringify(value) : formatStringForSqlLiteral(String(value));
  return `'${text.replace(/'/g, "''")}'`;
}

function formatStringForSqlLiteral(value: string): string {
  const date = parseIsoUtcDate(value);
  return date ? formatDateForSql(date) : value;
}

function parseIsoUtcDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDateForSql(value: Date): string {
  const beijing = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}

function clampLimit(limit: number): number {
  const maxRows = getQueryConfig().maxRows;
  if (!Number.isFinite(limit)) {
    return getQueryConfig().defaultLimit;
  }
  if (limit < 0) {
    return Math.floor(limit);
  }

  return Math.max(1, Math.min(Math.floor(limit), maxRows));
}

function getAiLoadingMessage(type: DbConnectionConfig["type"]): string {
  if (type === "redis") return "正在根据 Redis Key 信息生成命令...";
  if (type === "elasticsearch") return "正在根据索引结构生成 Elasticsearch 查询...";
  return "正在根据表结构生成 SQL...";
}

function parseRedisTtlInput(input: string): { seconds: number | null } {
  const text = input.trim().toLowerCase();
  if (["-1", "persist", "permanent", "forever", "永久"].includes(text)) {
    return { seconds: null };
  }

  const match = text.match(/^(\d+)\s*([smhd])?$/);
  if (!match) {
    throw new Error("Redis TTL 格式错误，请输入 10、1s、1m、1h、1d，或输入 persist / -1 取消过期时间。");
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error("Redis TTL 必须大于 0。");
  }
  const unit = match[2] || "s";
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = amount * multipliers[unit];
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("Redis TTL 超出可支持范围。");
  }
  return { seconds };
}

function sanitizeCompletionUsage(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>)
    .map(([key, usedAt]) => [key, Number(usedAt)] as const)
    .filter(([key, usedAt]) => key.length > 0 && Number.isFinite(usedAt) && usedAt > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 100)
    .reduce<Record<string, number>>((next, [key, usedAt]) => {
      next[key] = usedAt;
      return next;
    }, {});
}

function isMySqlCheckConstraintEnforcedVersion(version: string): boolean {
  const text = String(version || "");
  if (/mariadb/i.test(text)) {
    return false;
  }

  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > 8) return true;
  if (major < 8) return false;
  if (minor > 0) return true;
  if (minor < 0) return false;
  return patch >= 16;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
