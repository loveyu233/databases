import { createClient as createRedisClient } from "redis";
import { DbConnectionWithSecret, QueryResult, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";

const REDIS_SCAN_BATCH_SIZE = 200;
const REDIS_DETAIL_PAGE_SIZE_MAX = 500;
const REDIS_STRING_PREVIEW_BYTES = 4096;
const REDIS_SAFE_RANGE_LIMIT = 1000;

export class RedisWorkbenchClient implements DbClient {
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
