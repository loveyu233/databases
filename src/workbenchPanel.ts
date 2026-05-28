import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { generateCreateTableSqlByPrompt, generateSqlByPrompt, translateDatabaseErrorToChinese } from "./ai";
import { DatabaseService } from "./database/service";
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
import type { RollbackPlan } from "./workbench/logic";
import { renderWorkbenchHtml } from "./workbench/webviewHtml";
import {
  buildQuickQuerySql,
  buildQuickCountSql,
  buildExportPreviewSql,
  buildElasticQuickSearchBody,
  buildElasticQuickCountBody,
  buildMongoQuickFindCommand,
  buildMongoQuickCountCommand,
  buildSqlPaginationPlan,
  normalizeSortDirection,
  readTotalRows,
  splitSqlStatements,
  getSqlStatementTitle,
  stripSqlLeadingComments,
  createSqlPreview,
  buildUpdateSql,
  buildDeleteRowsSql,
  buildRelationQuerySql,
  buildFieldValueConditionSql,
  buildRollbackSql,
  buildSelectRowsByPrimaryKeysSql,
  buildInsertSql,
  buildImportPreviewSql,
  pickExportRows,
  buildPreviewInsertSql,
  buildXlsxBuffer,
  sanitizeFileName,
  findRowByPrimaryValues,
  isRecordSubsetEqual,
  getErrorMessage,
  getStatementErrorIndex,
  getStatementPartialResults,
  buildSchemaDraftSql,
  buildCreateTableDraftSql,
  getPostgresQualifiedNameBase,
  getPostgresTableSchemaName,
  parseSqlStringList,
  isCreateTableDraft,
  getDraftTableName,
  asString,
  clampLimit,
  getAiLoadingMessage,
  parseRedisTtlInput,
  sanitizeCompletionUsage,
  sanitizeStringList,
  isMySqlCheckConstraintEnforcedVersion
} from "./workbench/logic";

type SchemaEditorMode = "editTable" | "createTable";
type WorkbenchPanelOptions = {
  schemaEditorMode?: SchemaEditorMode;
  queryConsole?: boolean;
  queryConsoleKeySuffix?: string;
  queryConsoleTitle?: string;
  initialSql?: string;
  autoRunInitialSql?: boolean;
  defaultSchema?: string;
};
export type ActiveWorkbenchTreeSelection =
  | { kind: "database"; connectionId: string; database: string }
  | { kind: "table"; connectionId: string; database: string; table: string };
type SqlStatementSelection = {
  statements: string[];
  mode: "single" | "all";
};

export class DatabaseWorkbenchPanel {
  private static readonly panels = new Map<string, DatabaseWorkbenchPanel>();
  private static readonly completionUsageStateKey = "databaseWorkbench.completionUsage";
  private static readonly postgresDdlRolesStateKey = "databaseWorkbench.postgresDdlRoles";
  private static readonly activeTreeSelectionChangedEmitter = new vscode.EventEmitter<ActiveWorkbenchTreeSelection | undefined>();
  static readonly onDidChangeActiveTreeSelection = DatabaseWorkbenchPanel.activeTreeSelectionChangedEmitter.event;
  private static activePanelKey = "";

  private readonly disposables: vscode.Disposable[] = [];
  private schema: TableInfo[] = [];
  private selectedTable: string | undefined;
  private schemaLoaded = false;
  private pendingSchemaEditorMode: SchemaEditorMode | undefined;
  private readonly queryConsole: boolean;
  private pendingInitialSql = "";
  private readonly autoRunInitialSql: boolean;
  private readonly defaultSchema: string;
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
    this.pendingInitialSql = String(options?.initialSql || "");
    this.autoRunInitialSql = options?.autoRunInitialSql === true;
    this.defaultSchema = String(options?.defaultSchema || (connection.type === "postgres" ? "public" : ""));
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
    const key = DatabaseWorkbenchPanel.buildPanelKey(connection, database, table, isCreateTablePanel, options?.queryConsole === true, options?.queryConsoleKeySuffix, options?.defaultSchema);
    const existing = DatabaseWorkbenchPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      if (options?.queryConsole && options.initialSql) {
        void existing.applySqlToQueryConsole(options.initialSql, options.autoRunInitialSql === true);
      }
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
      ? options.queryConsoleTitle || `查询控制台 · ${database}`
      : isCreateTablePanel
      ? `正在创建 · ${options?.defaultSchema ? `${options.defaultSchema} · ` : ""}${database}`
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
    isQueryConsole: boolean,
    queryConsoleKeySuffix = "",
    defaultSchema = ""
  ): string {
    if (isQueryConsole) {
      return JSON.stringify([connection.id, database, "query_console", queryConsoleKeySuffix]);
    }
    if (isCreateTablePanel) {
      return JSON.stringify([connection.id, database, "__create_table__", defaultSchema || ""]);
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

  private async applySqlToQueryConsole(sql: string, autoRun: boolean): Promise<void> {
    if (!this.queryConsole) {
      return;
    }
    const normalizedSql = String(sql || "").trim();
    if (!normalizedSql) {
      return;
    }
    this.panel.webview.postMessage({
      type: "setSqlEditor",
      sql: normalizedSql,
      status: autoRun ? "已生成关联查询 SQL，正在执行..." : "已生成关联查询 SQL。",
    });
    if (autoRun) {
      this.lastQueryErrorSql = normalizedSql;
      await this.runSql(normalizedSql, getQueryConfig().defaultLimit, 1);
    }
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
        case "openRelationQuery":
          await this.openRelationQuery(message.sourceTable, message.sourceColumn, message.targetTable, message.targetColumn, message.values);
          return;
        case "quickFieldValueQuery":
          await this.runQuickFieldValueQuery(message.table, message.column, message.values, message.limit);
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
      defaultSchema: this.defaultSchema,
      ddlRoleOptions: this.connection.type === "postgres" ? this.getPostgresDdlRoleOptions() : undefined,
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
    if (this.queryConsole && this.pendingInitialSql) {
      const initialSql = this.pendingInitialSql;
      this.pendingInitialSql = "";
      await this.applySqlToQueryConsole(initialSql, this.autoRunInitialSql);
    }
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
    if (this.connection.type === "mongodb") {
      let totalRows = 0;
      let totalPages = 1;
      let currentPage = safePage;
      if (safeLimit > 0) {
        const countCommand = buildMongoQuickCountCommand(table, where);
        this.lastQueryErrorSql = countCommand;
        const countResult = await this.databaseService.query(connection, this.database, countCommand, 1);
        totalRows = readTotalRows(countResult);
        totalPages = Math.max(1, Math.ceil(totalRows / safeLimit));
        currentPage = Math.min(safePage, totalPages);
      }
      const command = buildMongoQuickFindCommand(table, where, safeLimit, currentPage, sortColumn, sortDirection);
      this.lastQueryErrorSql = command;
      const result = await this.databaseService.query(connection, this.database, command, safeLimit < 0 ? -1 : queryConfig.maxRows);
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
      this.panel.webview.postMessage({ type: "result", sql: command, result });
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
      throw new Error(this.connection.type === "redis" ? "请先输入 Redis 命令。" : this.connection.type === "elasticsearch" ? "请先输入 Elasticsearch 查询。" : this.connection.type === "mongodb" ? "请先输入 MongoDB 命令。" : "请先输入 SQL。");
    }

    let executableSql = sql.trim();
    let executeAllStatements: string[] | undefined;
    if (this.connection.type !== "redis" && this.connection.type !== "elasticsearch" && this.connection.type !== "mongodb") {
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
    this.panel.webview.postMessage({ type: "loading", area: "query", message: this.connection.type === "redis" ? "正在执行 Redis 命令..." : this.connection.type === "elasticsearch" ? "正在执行 Elasticsearch 查询..." : this.connection.type === "mongodb" ? "正在执行 MongoDB 命令..." : "正在执行 SQL..." });
    if (this.connection.type === "redis" || this.connection.type === "elasticsearch" || this.connection.type === "mongodb") {
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
    const plans = statements.map((statement) => buildSqlPaginationPlan(this.connection.type, statement, safeLimit));
    const rows: Record<string, unknown>[] = [];
    const executableSqlList = plans.map((plan) => plan.executableSql);
    const logIds: Array<string | undefined> = [];

    for (const plan of plans) {
      if (!plan.isSelect) {
        logIds.push(await this.createPendingOperationLog({
          connection: this.connection,
          database: this.database,
          table: this.selectedTable ?? "",
          operationType: "sql",
          sql: plan.executableSql,
        }));
      } else {
        logIds.push(undefined);
      }
    }

    let activeIndex = 0;
    try {
      const results = await this.databaseService.queryStatements(connection, this.database, executableSqlList, -1, (statement, index) => {
        activeIndex = index;
        this.lastQueryErrorSql = statement;
        this.panel.webview.postMessage({ type: "loading", area: "query", message: `正在事务中执行第 ${index + 1} / ${plans.length} 条 SQL...` });
      });

      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        const result = results[index];
        await this.operationLogService.completeLog(logIds[index], "success");
        rows.push({
          index: index + 1,
          title: getSqlStatementTitle(statements[index]) || `SQL ${index + 1}`,
          type: plan.isSelect ? "查询" : "修改",
          affectedRows: result?.affectedRows ?? result?.rowCount ?? 0,
          status: "成功",
        });
      }
    } catch (error) {
      const failedIndex = getStatementErrorIndex(error, activeIndex);
      const partialResults = getStatementPartialResults(error);
      const errorMessage = `事务执行失败，已请求回滚：${getErrorMessage(error)}`;
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        const result = partialResults[index];
        if (logIds[index]) {
          await this.operationLogService.completeLog(logIds[index], "failed", { errorMessage });
        }
        rows.push({
          index: index + 1,
          title: getSqlStatementTitle(statements[index]) || `SQL ${index + 1}`,
          type: plan.isSelect ? "查询" : "修改",
          affectedRows: result?.affectedRows ?? result?.rowCount ?? 0,
          status: index < failedIndex ? "已请求回滚" : index === failedIndex ? `失败：${getErrorMessage(error)}` : "未执行",
        });
      }
      const summary: QueryResult = {
        columns: ["index", "title", "type", "affectedRows", "status"],
        rows,
        rowCount: rows.length,
        elapsedMs: 0,
      };
      this.panel.webview.postMessage({ type: "result", sql: executableSqlList.join("\n"), result: summary });
      throw error;
    }

    const summary: QueryResult = {
      columns: ["index", "title", "type", "affectedRows", "status"],
      rows,
      rowCount: rows.length,
      elapsedMs: 0,
    };
    this.panel.webview.postMessage({ type: "result", sql: executableSqlList.join("\n"), result: summary });
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
          description: `${statements.length} 条 SQL 将在同一事务中按顺序执行`,
          detail: "适合执行一组建表、改表或批量初始化 SQL。执行中遇到错误会请求回滚整组 SQL。",
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
      const logTableName = getDraftTableName(draft, this.connection.type) || originalTableName || "";
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
      await this.databaseService.queryStatements(connection, this.database, statements, queryConfig.maxRows, (statement) => {
        this.lastQueryErrorSql = statement;
      });
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

    const nextTableName = getDraftTableName(draft, this.connection.type) || originalTableName;
    const ddlRoleOptions = this.connection.type === "postgres"
      ? await this.savePostgresDdlRoleOption(asString(draft.ddlRole))
      : undefined;
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
    this.panel.webview.postMessage({ type: "schemaDraftApplied", ddlRoleOptions });
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
      await this.databaseService.queryStatements(connection, this.database, statements, queryConfig.maxRows, (statement) => {
        this.lastQueryErrorSql = statement;
      });
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

  private async openRelationQuery(
    sourceTable: string,
    sourceColumn: string,
    targetTable: string,
    targetColumn: string,
    values: unknown[]
  ): Promise<void> {
    if (this.connection.type !== "mysql" && this.connection.type !== "postgres" && this.connection.type !== "mongodb") {
      throw new Error("关联查询暂时只支持 MySQL、PostgreSQL 和 MongoDB。");
    }
    const sql = buildRelationQuerySql(this.connection.type, sourceTable, sourceColumn, targetTable, targetColumn, values);
    const suffix = `relation:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    DatabaseWorkbenchPanel.open(this.context, this.store, this.databaseService, this.connection, this.database, undefined, {
      queryConsole: true,
      queryConsoleKeySuffix: suffix,
      queryConsoleTitle: `关联查询 · ${targetTable}`,
      initialSql: sql,
      autoRunInitialSql: true,
    });
    this.panel.webview.postMessage({ type: "loading", area: "query", message: "已打开新的关联查询控制台。" });
  }

  private async runQuickFieldValueQuery(table: string, column: string, values: unknown[], limit?: number): Promise<void> {
    if (this.connection.type !== "mysql" && this.connection.type !== "postgres" && this.connection.type !== "mongodb") {
      throw new Error("字段快速条件查询暂时只支持 MySQL、PostgreSQL 和 MongoDB。");
    }
    const safeTable = String(table || "").trim();
    if (!safeTable) {
      throw new Error("请先从左侧数据库树选择一张表。");
    }
    const where = buildFieldValueConditionSql(this.connection.type, column, values);
    this.panel.webview.postMessage({
      type: "quickConditionApplied",
      where,
      status: "已把选中字段值写入快速条件，正在查询结果...",
    });
    await this.runQuickQuery(safeTable, where, Number(limit || getQueryConfig().defaultLimit), 1, undefined, undefined);
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
      await this.databaseService.queryStatements(connection, this.database, rollback.statements, queryConfig.maxRows, (statement) => {
        this.lastQueryErrorSql = statement;
      });
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
    const exact = this.schema.find((item) => item.name === table);
    if (exact || this.connection.type !== "postgres") {
      return exact;
    }
    return this.schema.find((item) => {
      const schema = getPostgresTableSchemaName(item);
      const displayName = item.displayName || getPostgresQualifiedNameBase(item.name);
      return (schema === "public" && displayName === table) || `${schema}.${displayName}` === table;
    });
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
      const failedLabel = this.connection.type === "redis" ? "Redis命令执行失败" : this.connection.type === "elasticsearch" ? "Elasticsearch查询执行失败" : this.connection.type === "mongodb" ? "MongoDB命令执行失败" : "SQL执行失败";
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

  private getPostgresDdlRoleOptions(): string[] {
    return sanitizeStringList(this.context.globalState.get<string[]>(DatabaseWorkbenchPanel.postgresDdlRolesStateKey, []), 20);
  }

  private async savePostgresDdlRoleOption(role: string): Promise<string[]> {
    const normalized = role.trim();
    const current = this.getPostgresDdlRoleOptions();
    if (!normalized) {
      return current;
    }
    const next = sanitizeStringList([normalized, ...current.filter((item) => item !== normalized)], 20);
    await this.context.globalState.update(DatabaseWorkbenchPanel.postgresDdlRolesStateKey, next);
    return next;
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
    return renderWorkbenchHtml(webview);
  }
}

export { buildFieldValueConditionSql, buildRelationQuerySql } from "./workbench/logic";
