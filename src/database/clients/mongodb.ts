import { BSON, MongoClient, ObjectId, type Document, type Filter } from "mongodb";
import { DbConnectionWithSecret, QueryResult, TableColumn, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";

const MONGO_SCHEMA_SAMPLE_SIZE = 50;
const MONGO_DEFAULT_QUERY_LIMIT = 100;

export class MongoWorkbenchClient implements DbClient {
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
