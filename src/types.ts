import * as vscode from "vscode";

export type DatabaseType = "mysql" | "postgres" | "redis" | "elasticsearch";

export type DbConnectionConfig = {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  username: string;
  database?: string;
  groupId?: string;
  ssl?: boolean;
  allowInsecureTls?: boolean;
};

export type ConnectionGroupColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export type ConnectionGroup = {
  id: string;
  name: string;
  color: ConnectionGroupColor;
};

export type DbConnectionSecret = {
  password: string;
};

export type DbConnectionWithSecret = DbConnectionConfig & DbConnectionSecret;

export type DatabaseNode = {
  connectionId: string;
  database: string;
};

export type TableNode = {
  connectionId: string;
  database: string;
  table: string;
};

export type TableColumn = {
  name: string;
  type: string;
  nullable: boolean;
  key?: string;
  defaultValue?: string | null;
  comment?: string;
  extra?: string;
  charset?: string;
  collation?: string;
  enumValues?: string[];
  enumTypeName?: string;
};

export type TableSummary = {
  name: string;
  comment?: string;
};

export type TableInfo = {
  name: string;
  columns: TableColumn[];
  comment?: string;
  engine?: string;
  charset?: string;
  collation?: string;
  primaryKeyName?: string;
  indexes?: Array<{
    name: string;
    unique: boolean;
    columns: string[];
  }>;
  foreignKeys?: Array<{
    name: string;
    columns: string[];
    referenceTable: string;
    referenceColumns: string[];
    onUpdate?: string;
    onDelete?: string;
  }>;
  checks?: Array<{
    name: string;
    expression: string;
  }>;
  triggers?: Array<{
    name: string;
    timing: string;
    event: string;
    statement: string;
  }>;
};

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  affectedRows?: number;
  command?: string;
  metadata?: Record<string, unknown>;
  pagination?: {
    mode: "quick" | "sql";
    table?: string;
    where?: string;
    sql?: string;
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
    sortColumn?: string;
    sortDirection?: "asc" | "desc";
  };
};

export type AiProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "qwen"
  | "doubao"
  | "zhipu"
  | "moonshot"
  | "baichuan"
  | "minimax"
  | "hunyuan"
  | "xai"
  | "perplexity"
  | "cohere"
  | "nvidia"
  | "mistral"
  | "openrouter"
  | "siliconflow"
  | "groq"
  | "together"
  | "ollama"
  | "lmstudio"
  | "custom";

export type AiProviderPreset = {
  value: AiProvider;
  label: string;
  description: string;
  baseUrl: string;
  modelName: string;
  useStream: boolean;
};

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { value: "openai", label: "OpenAI", description: "OpenAI 官方 API", baseUrl: "https://api.openai.com/v1", modelName: "gpt-4o-mini", useStream: true },
  { value: "anthropic", label: "Anthropic Claude", description: "Anthropic OpenAI 兼容接口", baseUrl: "https://api.anthropic.com/v1", modelName: "claude-sonnet-4-5", useStream: true },
  { value: "gemini", label: "Google Gemini", description: "Gemini OpenAI 兼容接口", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", modelName: "gemini-2.5-flash", useStream: true },
  { value: "deepseek", label: "DeepSeek", description: "DeepSeek OpenAI 兼容接口", baseUrl: "https://api.deepseek.com", modelName: "deepseek-chat", useStream: true },
  { value: "qwen", label: "阿里云百炼 / 通义千问", description: "DashScope OpenAI 兼容接口", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelName: "qwen-plus", useStream: true },
  { value: "doubao", label: "火山方舟 / 豆包", description: "Volcengine Ark OpenAI 兼容接口", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", modelName: "doubao-seed-1-6", useStream: true },
  { value: "zhipu", label: "智谱 GLM", description: "智谱 OpenAI 兼容接口", baseUrl: "https://open.bigmodel.cn/api/paas/v4", modelName: "glm-4-flash", useStream: true },
  { value: "moonshot", label: "Moonshot / Kimi", description: "Moonshot OpenAI 兼容接口", baseUrl: "https://api.moonshot.cn/v1", modelName: "moonshot-v1-8k", useStream: true },
  { value: "baichuan", label: "百川智能", description: "百川 OpenAI 兼容接口", baseUrl: "https://api.baichuan-ai.com/v1", modelName: "Baichuan4", useStream: true },
  { value: "minimax", label: "MiniMax", description: "MiniMax OpenAI 兼容接口", baseUrl: "https://api.minimax.chat/v1", modelName: "MiniMax-Text-01", useStream: true },
  { value: "hunyuan", label: "腾讯混元", description: "腾讯混元 OpenAI 兼容接口", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", modelName: "hunyuan-turbos-latest", useStream: true },
  { value: "xai", label: "xAI Grok", description: "xAI OpenAI 兼容接口", baseUrl: "https://api.x.ai/v1", modelName: "grok-4-latest", useStream: true },
  { value: "perplexity", label: "Perplexity", description: "Perplexity OpenAI 兼容接口", baseUrl: "https://api.perplexity.ai", modelName: "sonar", useStream: true },
  { value: "cohere", label: "Cohere", description: "Cohere OpenAI 兼容接口", baseUrl: "https://api.cohere.com/compatibility/v1", modelName: "command-a-03-2025", useStream: true },
  { value: "nvidia", label: "NVIDIA NIM", description: "NVIDIA NIM OpenAI 兼容接口", baseUrl: "https://integrate.api.nvidia.com/v1", modelName: "meta/llama-3.3-70b-instruct", useStream: true },
  { value: "mistral", label: "Mistral AI", description: "Mistral OpenAI 兼容接口", baseUrl: "https://api.mistral.ai/v1", modelName: "mistral-small-latest", useStream: true },
  { value: "openrouter", label: "OpenRouter", description: "多模型聚合 OpenAI 兼容接口", baseUrl: "https://openrouter.ai/api/v1", modelName: "openai/gpt-4o-mini", useStream: true },
  { value: "siliconflow", label: "硅基流动 SiliconFlow", description: "SiliconFlow OpenAI 兼容接口", baseUrl: "https://api.siliconflow.cn/v1", modelName: "Qwen/Qwen2.5-72B-Instruct", useStream: true },
  { value: "groq", label: "Groq", description: "Groq OpenAI 兼容接口", baseUrl: "https://api.groq.com/openai/v1", modelName: "llama-3.3-70b-versatile", useStream: true },
  { value: "together", label: "Together AI", description: "Together OpenAI 兼容接口", baseUrl: "https://api.together.xyz/v1", modelName: "meta-llama/Llama-3.3-70B-Instruct-Turbo", useStream: true },
  { value: "ollama", label: "Ollama 本地模型", description: "Ollama OpenAI 兼容接口", baseUrl: "http://127.0.0.1:11434/v1", modelName: "qwen2.5-coder", useStream: true },
  { value: "lmstudio", label: "LM Studio 本地模型", description: "LM Studio OpenAI 兼容接口", baseUrl: "http://127.0.0.1:1234/v1", modelName: "local-model", useStream: true },
  { value: "custom", label: "自定义 OpenAI 兼容", description: "自定义网关、代理或企业内部模型服务", baseUrl: "", modelName: "", useStream: true },
];

export type AiConfig = {
  provider: AiProvider;
  useStream: boolean;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  debugMode: boolean;
  timeoutMs: number;
  errorTranslationTimeoutMs: number;
  maxSchemaChars: number;
};

export function normalizeAiProvider(value: unknown): AiProvider {
  if (value === "gpt") {
    return "openai";
  }
  return AI_PROVIDER_PRESETS.some((item) => item.value === value)
    ? value as AiProvider
    : "custom";
}

export function getAiProviderPreset(provider: AiProvider): AiProviderPreset {
  return AI_PROVIDER_PRESETS.find((item) => item.value === provider)
    ?? AI_PROVIDER_PRESETS[AI_PROVIDER_PRESETS.length - 1];
}

export type QueryConfig = {
  defaultLimit: number;
  maxRows: number;
};

export type ExportConfig = {
  transactionThreshold: number;
  pageSize: number;
  maxRows: number;
};

export type ElasticsearchConfig = {
  requestTimeoutMs: number;
  maxResponseBytes: number;
  allowInsecureTls: boolean;
};

export type TableDisplayConfig = {
  showColumnComments: boolean;
  hiddenColumnCommentNames: string[];
  dataGridFontSize: number;
  sqlConfirmFontSize: number;
};

export type LogConfig = {
  enabled: boolean;
  directory: string;
  maxEntriesPerTable: number;
};

export type OperationLogSnapshot = {
  id: string;
  rowKey: Record<string, unknown>;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  currentData?: Record<string, unknown> | null;
};

export type OperationLogEntry = {
  id: string;
  operationType: "insert" | "update" | "delete" | "schema" | "sql";
  sql: string;
  status: "pending" | "success" | "failed";
  isRollback?: boolean;
  rollbackOfLogId?: string;
  connectionName: string;
  databaseName: string;
  tableName: string;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
  aiAnalysis?: string;
  tagLabel?: string;
  tagColor?: string;
  rollbackLogs?: OperationLogEntry[];
  snapshots: OperationLogSnapshot[];
};

export type SchemaCapabilities = {
  supportsNotEmptyStringCheck: boolean;
  mysqlVersion?: string;
};

export type QuickRefreshQuery = {
  table: string;
  where: string;
  limit: number;
  page?: number;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
};

export type PanelMessage =
  | { type: "ready" }
  | { type: "previewTable"; table: string }
  | { type: "quickQuery"; table: string; where: string; limit: number; page?: number; sortColumn?: string; sortDirection?: "asc" | "desc" }
  | { type: "runSql"; sql: string; limit?: number; page?: number; sortColumn?: string; sortDirection?: "asc" | "desc" }
  | { type: "copyTableDdl"; table: string }
  | { type: "copyText"; text: string; successMessage: string }
  | { type: "exportPreview"; format: "xlsx" | "sql"; rowLimit: number; mode: "quick" | "sql"; table?: string; where?: string; sql?: string; sortColumn?: string; sortDirection?: "asc" | "desc"; columns?: string[]; columnAliases?: Record<string, string>; resultColumns?: string[]; resultRows?: Record<string, unknown>[] }
  | { type: "loadImportSourceDatabases"; connectionId: string }
  | { type: "loadImportSourceTables"; connectionId: string; database: string }
  | { type: "loadImportSourceSchema"; connectionId: string; database: string; table: string }
  | { type: "importTableData"; sourceConnectionId: string; sourceDatabase: string; sourceTable: string; targetTable: string; mappings: Array<{ source: string; target: string }>; rowLimit: number; batchSize: number; confirmed?: boolean }
  | { type: "copySchemaDraftSql"; draft: Record<string, unknown> }
  | { type: "previewSchemaDraftSql"; draft: Record<string, unknown> }
  | { type: "applySchemaDraft"; draft: Record<string, unknown>; confirmed?: boolean }
  | { type: "generateCreateTableDraft"; prompt: string }
  | { type: "closeCreateTablePanel" }
  | { type: "insertRow"; table: string; values: Record<string, unknown>; confirmed?: boolean }
  | { type: "deleteRow"; table: string; primaryKeys: string[]; primaryValues: Record<string, unknown>; confirmed?: boolean }
  | { type: "deleteRows"; table: string; primaryKeys: string[]; primaryValuesList: Array<Record<string, unknown>>; confirmed?: boolean }
  | { type: "redisDeleteKeys"; keys: string[]; confirmed?: boolean }
  | { type: "redisUpdateKeys"; updates: Array<{ key: string; value: string }>; confirmed?: boolean }
  | { type: "redisUpdateTtls"; updates: Array<{ key: string; ttl: string }>; confirmed?: boolean }
  | { type: "redisInspectKey"; key: string; page: number; pageSize: number; search?: string; fuzzySearch?: boolean; sortDirection?: "asc" | "desc" }
  | { type: "redisDeleteMember"; key: string; keyType: string; row: Record<string, unknown>; page: number; pageSize: number; search?: string; fuzzySearch?: boolean; sortDirection?: "asc" | "desc"; confirmed?: boolean }
  | { type: "loadOperationLogs"; table: string }
  | { type: "rollbackOperationLog"; logId: string; confirmed?: boolean }
  | { type: "analyzeOperationLogError"; logId: string }
  | { type: "markOperationLog"; logId: string; label: string; color: string }
  | {
      type: "updateCells";
      table: string;
      primaryKeys: string[];
      updates: Array<{
        primaryValues: Record<string, unknown>;
        changes: Record<string, unknown>;
      }>;
      confirmed?: boolean;
      refreshQuery?: QuickRefreshQuery;
    }
  | { type: "generateSql"; prompt: string; tableNames?: string[] }
  | { type: "saveCompletionUsage"; completionUsage: Record<string, number> }
  | { type: "refreshSchema" };

export type PanelToWebviewMessage =
  | { type: "init"; database: string; connectionId?: string; connectionName: string; connectionType?: DatabaseType; tables: TableInfo[]; selectedTable?: string; defaultLimit: number; tableDisplay: TableDisplayConfig; schemaCapabilities?: SchemaCapabilities; completionUsage?: Record<string, number>; queryConsole?: boolean; connections?: Array<Pick<DbConnectionConfig, "id" | "name" | "type" | "host" | "port" | "username">> }
  | { type: "tableSelected"; table: TableInfo; connectionType?: DatabaseType; defaultLimit: number; tableDisplay: TableDisplayConfig; schemaCapabilities?: SchemaCapabilities }
  | { type: "importSourceDatabases"; connectionId: string; databases: string[] }
  | { type: "importSourceTables"; connectionId: string; database: string; tables: TableInfo[] }
  | { type: "importSourceSchema"; connectionId: string; database: string; table: string; columns: Array<{ name: string; type: string; nullable: boolean; comment?: string }> }
  | { type: "importCompleted"; insertedRows: number; message: string }
  | { type: "loading"; area: "schema" | "query" | "ai"; message: string }
  | { type: "result"; sql: string; result: QueryResult }
  | { type: "editsApplied" }
  | { type: "rowDeleteCanceled" }
  | { type: "redisKeyDetail"; key: string; keyType: string; page: number; pageSize: number; totalRows: number; totalPages: number; columns: string[]; rows: Record<string, unknown>[]; search?: string; fuzzySearch?: boolean; sortDirection?: "asc" | "desc"; memoryUsage?: number | null }
  | { type: "operationLogs"; logs: OperationLogEntry[] }
  | { type: "tableDisplayConfig"; tableDisplay: TableDisplayConfig }
  | { type: "schemaDraftApplied" }
  | { type: "schemaDraftError"; message: string }
  | { type: "schemaDraftPreview"; title: string; sql: string }
  | { type: "updateCellsPreview"; title: string; sql: string; table: string; primaryKeys: string[]; updates: Array<{ primaryValues: Record<string, unknown>; changes: Record<string, unknown> }>; refreshQuery?: QuickRefreshQuery }
  | { type: "sqlConfirmPreview"; title: string; sql: string; action: PanelMessage; status?: string; cancelAction?: PanelMessage }
  | { type: "openSchemaEditor"; mode: "editTable" | "createTable" }
  | { type: "generatedSql"; sql: string }
  | { type: "generatedCreateTableSql"; sql: string }
  | { type: "schema"; tables: TableInfo[] }
  | { type: "error"; area: "schema" | "query" | "ai"; message: string };

export class MessageError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

export function getAiConfig(): AiConfig {
  const config = vscode.workspace.getConfiguration("databaseWorkbench.ai");
  const provider = normalizeAiProvider(config.get("provider", "openai"));
  const preset = getAiProviderPreset(provider);
  const baseUrl = config.get("baseUrl", "");
  const apiKey = config.get("apiKey", "");
  const modelName = config.get("modelName", "");
  return {
    provider,
    useStream: config.get("useStream", preset.useStream),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    modelName: modelName.trim(),
    debugMode: config.get("debugMode", false),
    timeoutMs: config.get("timeoutMs", 30000),
    errorTranslationTimeoutMs: config.get("errorTranslationTimeoutMs", 5000),
    maxSchemaChars: config.get("maxSchemaChars", 16000),
  };
}

export function isAiConfigured(config = getAiConfig()): boolean {
  return Boolean(config.baseUrl.trim() && config.apiKey.trim() && config.modelName.trim());
}

export function getAiConfigurationMessage(): string {
  return "请先在 Database Workbench 设置中配置 AI 信息（供应商、Base URL、API Key、模型名称），或运行命令“Database Workbench: 配置 AI”。";
}

export function getQueryConfig(): QueryConfig {
  const config = vscode.workspace.getConfiguration("databaseWorkbench.query");
  return {
    defaultLimit: config.get("defaultLimit", 30),
    maxRows: config.get("maxRows", 500),
  };
}

export function getExportConfig(): ExportConfig {
  const config = vscode.workspace.getConfiguration("databaseWorkbench.export");
  return {
    transactionThreshold: config.get("transactionThreshold", 100),
    pageSize: config.get("pageSize", 100),
    maxRows: config.get("maxRows", 10000),
  };
}

export function getElasticsearchConfig(): ElasticsearchConfig {
  const config = vscode.workspace.getConfiguration("databaseWorkbench.elasticsearch");
  return {
    requestTimeoutMs: config.get("requestTimeoutMs", 30000),
    maxResponseBytes: config.get("maxResponseBytes", 10 * 1024 * 1024),
    allowInsecureTls: config.get("allowInsecureTls", false),
  };
}

export function getTableDisplayConfig(): TableDisplayConfig {
  const config = vscode.workspace.getConfiguration("databaseWorkbench.table");
  return {
    showColumnComments: config.get("showColumnComments", true),
    hiddenColumnCommentNames: config.get("hiddenColumnCommentNames", ["id", "created_at", "updated_at", "deleted_at"]),
    dataGridFontSize: clampFontSize(config.get("dataGridFontSize", 12), 9, 24, 12),
    sqlConfirmFontSize: getSqlConfirmFontSize(),
  };
}

export function getSqlConfirmFontSize(): number {
  const config = vscode.workspace.getConfiguration("databaseWorkbench.table");
  return clampFontSize(config.get("sqlConfirmFontSize", 15), 10, 32, 15);
}

function clampFontSize(value: unknown, min: number, max: number, fallback: number): number {
  const size = Number(value);
  if (!Number.isFinite(size)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(size)));
}

export function getLogConfig(): LogConfig {
  const config = vscode.workspace.getConfiguration("databaseWorkbench.log");
  return {
    enabled: config.get("enabled", true),
    directory: config.get("directory", ""),
    maxEntriesPerTable: config.get("maxEntriesPerTable", 1000),
  };
}
