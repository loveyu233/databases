import * as vscode from "vscode";
import { AiConfig, DatabaseType, getAiConfigurationMessage, isAiConfigured, TableInfo } from "./types";

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
};

type ChatCompletionStreamChunk = {
  choices?: Array<{
    delta?: { content?: string | Array<{ type?: string; text?: string }> };
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
};

export async function generateSqlByPrompt(
  prompt: string,
  tables: TableInfo[],
  config: AiConfig,
  database: string,
  dialect: DatabaseType
): Promise<string> {
  assertAiConfigured(config);

  const schema = truncateText(formatSchema(tables), config.maxSchemaChars);
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const payload = {
    model: config.modelName,
    temperature: 0.1,
    stream: config.useStream,
    messages: buildMessages(prompt, schema, database, dialect),
  };
  await copyAiDebugPayload(config, url, payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`AI 接口请求失败，状态码 ${response.status}：${body || "无响应内容"}`);
  }

  const sql = normalizeSql(parseCompletionBody(body));
  if (!sql) {
    throw new Error("AI 未返回有效查询内容。");
  }

  return sql;
}

export async function translateDatabaseErrorToChinese(
  errorText: string,
  sql: string,
  config: AiConfig
): Promise<string> {
  assertAiConfigured(config);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.errorTranslationTimeoutMs);
  let body = "";
  try {
    const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const payload = {
      model: config.modelName,
      temperature: 0.1,
      stream: config.useStream,
      messages: [
        {
          role: "system",
          content: "你是资深数据库工程师。请根据 SQL 语句和数据库原始错误，用简体中文输出错误描述、常见原因和修改建议。总字数控制在 230 字以内，不要 Markdown，不要代码块。",
        },
        {
          role: "user",
          content: `请分析下面这次数据库 SQL 执行失败的原因，并给出简短修改建议。\n\n执行 SQL：\n${truncateText(sql, 2500)}\n\n原始错误：\n${truncateText(errorText, 1500)}`,
        },
      ],
    };
    await copyAiDebugPayload(config, url, payload);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    body = await readResponseBody(response, (nextBody) => {
      body = nextBody;
    });
    if (!response.ok) {
      throw new Error(body || `AI 接口请求失败，状态码 ${response.status}`);
    }
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = normalizeSql(parseCompletionBody(body));
  if (!text) {
    throw new Error("AI 未返回有效错误说明。");
  }
  return truncateText(text, 230);
}

export async function testAiConnection(config: AiConfig): Promise<string> {
  assertAiConfigured(config);
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const payload = {
    model: config.modelName,
    temperature: 0,
    stream: config.useStream,
    messages: [
      { role: "user", content: "hello" },
    ],
  };
  await copyAiDebugPayload(config, url, payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`AI 测试失败，状态码 ${response.status}：${body || "无响应内容"}`);
  }
  const content = normalizeSql(parseCompletionBody(body));
  if (!content) {
    throw new Error("AI 测试失败：模型没有返回有效内容。");
  }
  return content;
}

export async function generateSchemaSyncSql(
  params: {
    dialect: Extract<DatabaseType, "mysql" | "postgres">;
    sourceLabel: string;
    targetLabel: string;
    sourceDdl: string;
    targetDdl: string;
    scope?: "table" | "database";
  },
  config: AiConfig
): Promise<string> {
  assertAiConfigured(config);

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const quoteRule = params.dialect === "mysql" ? "MySQL 标识符使用反引号。" : "PostgreSQL 标识符使用双引号。";
  const isDatabaseScope = params.scope === "database";
  const payload = {
    model: config.modelName,
    temperature: 0.05,
    stream: config.useStream,
    messages: [
      {
        role: "system",
        content: [
          "你是资深数据库架构迁移工程师。",
          isDatabaseScope
            ? "请根据源库和目标库的全部表结构 DDL，生成让目标库结构变成源库结构的可执行 DDL。"
            : "请根据源表和目标表的 CREATE TABLE / DDL，生成让目标表结构变成源表结构的可执行 DDL。",
          "只返回 SQL，不要解释，不要 Markdown 代码块。",
          "优先使用 ALTER TABLE、CREATE INDEX、DROP INDEX、COMMENT 等增量语句，尽量保留目标表已有数据。",
          isDatabaseScope
            ? "如果目标库有源库不存在的多余表，为了结构完全一致可以生成 DROP TABLE，但必须在每条 DROP TABLE 前加入中文 SQL 注释提醒会删除该表及其数据；不要生成 TRUNCATE、DELETE 或迁移数据语句。"
            : "不要生成 DROP TABLE、TRUNCATE、DELETE 或迁移数据语句。",
          "如果某个变更无法安全自动完成，请用 SQL 注释说明原因，但其它可执行变更仍要输出。",
          "必须同时处理列、类型、默认值、非空、自增、主键、索引、外键、检查约束、触发器和表/列注释。",
          quoteRule,
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `SQL 方言：${params.dialect}`,
          `${isDatabaseScope ? "源库" : "源表"}：${params.sourceLabel}`,
          `${isDatabaseScope ? "目标库" : "目标表"}：${params.targetLabel}`,
          "",
          `${isDatabaseScope ? "源库全部表结构 DDL" : "源表 DDL"}：`,
          truncateText(params.sourceDdl, Math.floor(config.maxSchemaChars / 2)),
          "",
          `${isDatabaseScope ? "目标库全部表结构 DDL" : "目标表 DDL"}：`,
          truncateText(params.targetDdl, Math.floor(config.maxSchemaChars / 2)),
          "",
          `请生成把${isDatabaseScope ? "目标库结构同步成源库结构" : "目标表结构同步成源表结构"}的 SQL。`,
        ].join("\n"),
      },
    ],
  };
  await copyAiDebugPayload(config, url, payload);
  const timeoutMs = getSchemaSyncTimeoutMs(config, params.scope);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`AI 接口请求失败，状态码 ${response.status}：${body || "无响应内容"}`);
  }

  const sql = normalizeSql(parseCompletionBody(body));
  if (!sql) {
    throw new Error("AI 未返回有效同步 SQL。");
  }
  return sql;
}

export async function generateCreateTableSqlByPrompt(
  params: {
    dialect: Extract<DatabaseType, "mysql" | "postgres">;
    database: string;
    prompt: string;
    existingTables: TableInfo[];
  },
  config: AiConfig
): Promise<string> {
  assertAiConfigured(config);

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const quoteRule = params.dialect === "mysql"
    ? "MySQL 标识符使用反引号；表注释使用表选项 COMMENT='...'，字段注释使用列定义中的 COMMENT '...'。"
    : "PostgreSQL 标识符使用双引号；表和字段说明使用 COMMENT ON TABLE / COMMENT ON COLUMN 语句。";
  const baseFieldsRule = params.dialect === "mysql"
    ? "必须包含且必须按顺序作为前四个字段：id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID'、created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'、updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'、deleted_at datetime DEFAULT NULL COMMENT '删除时间'；主键约束必须包含 id。"
    : "必须包含且必须按顺序作为前四个字段：id bigint GENERATED BY DEFAULT AS IDENTITY、created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP、updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP、deleted_at timestamp DEFAULT NULL；主键约束必须包含 id，并且必须用 COMMENT ON COLUMN 分别补充这四个字段的说明：主键 ID、创建时间、更新时间、删除时间。";
  const payload = {
    model: config.modelName,
    temperature: 0.1,
    stream: config.useStream,
    messages: [
      {
        role: "system",
        content: [
          "你是资深数据库建模工程师，请根据需求生成一张新表的建表 DDL。",
          "只返回 SQL，不要解释，不要 Markdown 代码块。",
          "必须返回完整 CREATE TABLE 语句，可以附带必要的索引、外键、检查约束、表注释和字段注释语句。",
          "非常重要：表说明和每个字段的说明必须写清楚，使用简体中文描述真实业务含义；每个描述都要让开发者一眼知道业务用途、取值含义或数据来源，不要写“字段”“信息”“数据”等空泛描述。",
          "如果需求没有明确字段，也要结合业务语义补齐合理字段，并为每个字段写清晰注释；如果某个字段枚举值或状态值有业务含义，也要在字段描述中说明。",
          "不管用户需求如何，最终 CREATE TABLE 的字段顺序都必须以 id、created_at、updated_at、deleted_at 开头，然后再追加业务字段。",
          "主键、索引、外键、检查约束尽量写成表级约束，便于工具解析成可视化建表草案。",
          "优先使用清晰、稳定、可维护的字段名；不要生成测试数据 INSERT。",
          baseFieldsRule,
          quoteRule,
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `数据库：${params.database}`,
          `SQL 方言：${params.dialect}`,
          "",
          "当前库已有表结构摘要：",
          truncateText(formatSchema(params.existingTables), config.maxSchemaChars),
          "",
          "新表需求描述：",
          params.prompt,
          "",
          "请生成新表 CREATE TABLE SQL。再次强调：表注释和每个字段注释必须清楚说明业务含义，不能省略字段描述，不能使用空泛描述。",
        ].join("\n"),
      },
    ],
  };
  await copyAiDebugPayload(config, url, payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Math.max(config.timeoutMs, 60000)),
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`AI 接口请求失败，状态码 ${response.status}：${body || "无响应内容"}`);
  }

  const sql = normalizeSql(parseCompletionBody(body));
  if (!sql) {
    throw new Error("AI 未返回有效建表 SQL。");
  }
  return sql;
}

function getSchemaSyncTimeoutMs(config: AiConfig, scope: "table" | "database" | undefined): number {
  const baseTimeout = Math.max(config.timeoutMs, 1000);
  return scope === "database"
    ? Math.max(baseTimeout * 3, 120000)
    : Math.max(baseTimeout, 60000);
}

function assertAiConfigured(config: AiConfig): void {
  if (!isAiConfigured(config)) {
    throw new Error(getAiConfigurationMessage());
  }
}

async function copyAiDebugPayload(config: AiConfig, url: string, payload: unknown): Promise<void> {
  if (!config.debugMode) {
    return;
  }
  const debugContent = JSON.stringify({
    url,
    method: "POST",
    body: payload,
  }, null, 2);
  await vscode.env.clipboard.writeText(debugContent);
}

async function readResponseBody(response: Response, onProgress?: (body: string) => void): Promise<string> {
  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    body += decoder.decode(value, { stream: true });
    onProgress?.(body);
  }
  body += decoder.decode();
  onProgress?.(body);
  return body;
}

function buildMessages(prompt: string, schema: string, database: string, dialect: DatabaseType) {
  if (dialect === "redis") {
    return [
      {
        role: "system",
        content: [
          "你是资深 Redis 工程师，擅长把自然语言需求转换为 Database Workbench 可执行的 Redis 命令。",
          "只返回一条最终可执行命令，不要解释，不要 Markdown 代码块。",
          "默认生成只读查询命令；除非用户明确要求，不要生成 DEL、FLUSHDB、FLUSHALL、SET、HSET、LPUSH、SADD、ZADD、EXPIRE 等变更命令。",
          "搜索 Key 时优先使用 SCAN，不要使用 KEYS。",
          "查看不同类型 Key 时优先使用 TYPE、TTL、MEMORY USAGE、GETRANGE/STRLEN、HSCAN、SSCAN、ZRANGE 小范围 WITHSCORES、LRANGE 小范围、XRANGE 携带 COUNT 等分页/限量命令。",
          "优先使用已提供的真实 Key 名称。",
        ].join(" "),
      },
      {
        role: "user",
        content: `Redis DB：${database}\n\nKey 信息：\n${schema}\n\n需求描述：\n${prompt}`,
      },
    ];
  }

  if (dialect === "elasticsearch") {
    return [
      {
        role: "system",
        content: [
          "你是资深 Elasticsearch 工程师，擅长把自然语言需求转换为 Database Workbench 可执行的 Elasticsearch 查询。",
          "只返回最终可执行内容，不要解释，不要 Markdown 代码块。",
          "优先返回 HTTP 请求格式：METHOD /path 换行 JSON body，例如 POST /index/_search 后跟 Query DSL。",
          "也可以在用户明确要求 SQL 时返回 Elasticsearch SQL SELECT。",
          "默认生成只读查询；除非用户明确要求，不要生成 DELETE、UPDATE、PUT、POST 写入类请求。",
          "优先使用索引结构中真实存在的 index 和字段名。",
          "如需分页，使用 from 和 size；如需排序，使用 sort。",
        ].join(" "),
      },
      {
        role: "user",
        content: `Elasticsearch 连接空间：${database}\n\n索引结构：\n${schema}\n\n需求描述：\n${prompt}`,
      },
    ];
  }

  if (dialect === "mongodb") {
    return [
      {
        role: "system",
        content: [
          "你是资深 MongoDB 工程师，擅长把自然语言需求转换为 Database Workbench 可执行的 MongoDB Shell 风格命令。",
          "只返回最终可执行命令，不要解释，不要 Markdown 代码块。",
          "优先返回 db.getCollection(\"collection\").find({}).sort({}).limit(n)、countDocuments({}) 或 aggregate([...])。",
          "默认生成只读查询；除非用户明确要求，不要生成 insert、update、delete、dropDatabase、drop 等变更命令。",
          "优先使用集合结构中真实存在的集合名和字段名。",
          "ObjectId 查询请使用 ObjectId(\"...\")，时间查询可使用 ISODate(\"...\")。",
        ].join(" "),
      },
      {
        role: "user",
        content: `MongoDB 数据库：${database}\n\n集合结构：\n${schema}\n\n需求描述：\n${prompt}`,
      },
    ];
  }

  if (dialect === "tdengine") {
    return [
      {
        role: "system",
        content: [
          "你是资深 TDengine 时序数据库工程师，擅长把自然语言需求转换为 Database Workbench 可执行的 TDengine SQL。",
          "只返回 SQL 本身，不要解释，不要 Markdown 代码块。",
          "默认生成只读 SELECT / SHOW / DESCRIBE 查询；除非用户明确要求，不要生成 INSERT、CREATE、ALTER、DROP 等变更语句。",
          "优先使用结构中真实存在的超级表、子表、普通表和字段名。",
          "时序查询优先围绕时间列 ts 添加时间范围，例如 ts >= now - 1h；聚合查询可使用 INTERVAL、SLIDING、FILL、PARTITION BY。",
          "如需引用标识符，使用反引号。",
        ].join(" "),
      },
      {
        role: "user",
        content: `TDengine 数据库：${database}\n\n时序表结构：\n${schema}\n\n需求描述：\n${prompt}`,
      },
    ];
  }

  if (dialect === "etcd") {
    return [
      {
        role: "system",
        content: [
          "你是资深 ETCD 工程师，擅长把自然语言需求转换为 Database Workbench 可执行的 ETCD 命令。",
          "只返回一条最终可执行命令，不要解释，不要 Markdown 代码块。",
          "默认生成只读命令；除非用户明确要求，不要生成 PUT、SET、DELETE、DEL、DELETE_PREFIX 等变更命令。",
          "浏览 Key 时使用 SHOW KEYS PREFIX prefix LIMIT n 或 PREFIX prefix LIMIT n，查看单个 Key 使用 GET key。",
          "写入配置时使用 PUT key VALUE value；删除前缀时必须确认用户明确要求且前缀非空。",
          "优先使用已提供的真实 Key 名称。",
        ].join(" "),
      },
      {
        role: "user",
        content: `ETCD Key 空间：${database}\n\nKey 信息：\n${schema}\n\n需求描述：\n${prompt}`,
      },
    ];
  }

  const quoteRule = dialect === "mysql" ? "如需引用标识符，使用反引号。" : "如需引用标识符，使用双引号。";
  return [
    {
      role: "system",
      content: [
        "你是资深数据库工程师，擅长把业务描述转换成安全、可读、可执行的 SQL。",
        "只返回 SQL 本身，不要解释，不要 Markdown 代码块。",
        "默认生成 SELECT 查询；除非用户明确要求，不要生成 INSERT、UPDATE、DELETE、DROP、TRUNCATE 等变更语句。",
        "优先使用库表结构中真实存在的表名和字段名。",
        quoteRule,
      ].join(" "),
    },
    {
      role: "user",
      content: `数据库：${database}\nSQL 方言：${dialect}\n\n表结构：\n${schema}\n\n需求描述：\n${prompt}`,
    },
  ];
}

function formatSchema(tables: TableInfo[]): string {
  return tables
    .map((table) => {
      const columns = table.columns
        .map((column) => {
          const nullable = column.nullable ? "可空" : "非空";
          const key = column.key ? `, ${column.key}` : "";
          const defaultValue = column.defaultValue !== undefined && column.defaultValue !== null ? `, 默认 ${column.defaultValue}` : "";
          return `  - ${column.name}: ${column.type}, ${nullable}${key}${defaultValue}`;
        })
        .join("\n");
      return `${table.comment ? `对象 ${table.name}（${table.comment}）` : `对象 ${table.name}`}:\n${columns || "  - 暂无字段信息"}`;
    })
    .join("\n\n");
}

function parseCompletionBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }

  if (!trimmed.startsWith("data:")) {
    try {
      return extractMessageContent(JSON.parse(trimmed) as ChatCompletionResponse);
    } catch {
      return trimmed;
    }
  }

  let result = "";
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    try {
      const chunk = JSON.parse(payload) as ChatCompletionStreamChunk;
      result += readContentText(chunk.choices?.[0]?.delta?.content)
        || readContentText(chunk.choices?.[0]?.message?.content);
    } catch {
      // 部分兼容服务会把非 JSON 文本混在 SSE 里；忽略坏块，保留其它有效片段。
    }
  }

  return result.trim();
}

function extractMessageContent(data: ChatCompletionResponse): string {
  return readContentText(data.choices?.[0]?.message?.content).trim();
}

function readContentText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item) => item.text || "").join("").trim();
  }

  return "";
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/^```[A-Za-z0-9_-]*\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[表结构已截断，总长度超出限制]`;
}
