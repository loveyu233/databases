import * as http from "http";
import * as https from "https";
import { DbConnectionWithSecret, getElasticsearchConfig, QueryResult, TableColumn, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";

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

export class ElasticsearchWorkbenchClient implements DbClient {
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
    const columns = await this.resolveResultColumns(request.path, rows);
    return {
      columns,
      rows,
      rowCount: rows.length,
      command: request.method,
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async resolveResultColumns(path: string, rows: Record<string, unknown>[]): Promise<string[]> {
    const rowColumns = collectElasticColumns(rows);
    if (rowColumns.length) {
      return rowColumns;
    }
    const index = extractElasticSearchIndexFromPath(path) ?? this.indexPattern;
    if (!index) {
      return ["result"];
    }
    try {
      const mappings = await this.client.getMapping(index);
      const schemaColumns = collectElasticMappingColumns(mappings);
      return schemaColumns.length ? schemaColumns : ["result"];
    } catch {
      return ["result"];
    }
  }

  quoteIdentifier(identifier: string): string {
    return identifier;
  }

  async dispose(): Promise<void> {
    await this.client.close();
  }
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

function collectElasticColumns(rows: Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      columns.add(column);
    }
  }
  return [...columns];
}

function extractElasticSearchIndexFromPath(path: string): string | undefined {
  const pathname = String(path || "").split("?")[0];
  const match = pathname.match(/^\/([^/]+)\/_search$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function collectElasticMappingColumns(mappings: Record<string, { mappings?: unknown }>): string[] {
  const columns = new Set<string>();
  for (const item of Object.values(mappings)) {
    for (const column of flattenElasticProperties(item.mappings ?? {})) {
      columns.add(column.name);
    }
  }
  return [...columns];
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
