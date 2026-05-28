import { DbConnectionConfig, getQueryConfig, OperationLogEntry, PanelMessage, QueryResult, TableInfo } from "../types";

export type SqlPaginationPlan = {
  executableSql: string;
  baseSql?: string;
  countSql?: string;
  page?: number;
  pageSize?: number;
  isSelect: boolean;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
};

export type RollbackPlan = {
  table: string;
  statements: string[];
  primaryKeys: string[];
  primaryValuesList: Array<Record<string, unknown>>;
};

export function buildQuickQuerySql(
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

export function buildQuickCountSql(type: DbConnectionConfig["type"], table: string, where: string): string {
  const condition = where.trim();
  if (/;|--|\/\*/.test(condition)) {
    throw new Error("快速条件不支持分号或 SQL 注释；复杂语句请打开 SQL 编辑器执行。");
  }

  const quotedTable = quoteIdentifier(type, table);
  const whereClause = condition ? ` WHERE ${condition}` : "";
  return `SELECT COUNT(*) AS totalRows FROM ${quotedTable}${whereClause}`;
}

export function buildExportPreviewSql(
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

export function buildOrderColumnsClause(type: DbConnectionConfig["type"], columns: string[]): string {
  const safeColumns = columns.map((column) => String(column || "").trim()).filter(Boolean);
  if (!safeColumns.length) {
    return "";
  }
  return ` ORDER BY ${safeColumns.map((column) => `${quoteIdentifier(type, column)} ASC`).join(", ")}`;
}

export function buildElasticQuickSearchBody(
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

export function buildElasticQuickCountBody(queryText: string): Record<string, unknown> {
  const searchBody = buildElasticQueryBody(queryText);
  return { query: searchBody.query ?? { match_all: {} } };
}

export function buildElasticQueryBody(queryText: string): Record<string, unknown> {
  const text = queryText.trim();
  if (!text) {
    return { query: { match_all: {} } };
  }
  if (text.startsWith("{")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return { query: { query_string: { query: text } } };
}

export function buildMongoQuickFindCommand(
  collection: string,
  filterText: string,
  limit: number,
  page = 1,
  sortColumn?: string,
  sortDirection?: "asc" | "desc"
): string {
  const filter = buildMongoFilterExpression(filterText);
  const skip = limit > 0 ? Math.max(0, Math.floor(page - 1) * limit) : 0;
  let command = `db.getCollection(${JSON.stringify(collection)}).find(${filter})`;
  if (sortColumn) {
    command += `.sort({ ${JSON.stringify(sortColumn)}: ${normalizeSortDirection(sortDirection) === "desc" ? -1 : 1} })`;
  }
  if (skip > 0) {
    command += `.skip(${skip})`;
  }
  if (limit > 0) {
    command += `.limit(${limit})`;
  }
  return command;
}

export function buildMongoQuickCountCommand(collection: string, filterText: string): string {
  return `db.getCollection(${JSON.stringify(collection)}).countDocuments(${buildMongoFilterExpression(filterText)})`;
}

export function buildMongoFilterExpression(filterText: string): string {
  const text = filterText.trim();
  if (!text) {
    return "{}";
  }
  if (!text.startsWith("{")) {
    throw new Error("MongoDB 快速查询条件需要填写 JSON Filter，例如 { \"status\": \"active\" }。");
  }
  return text;
}

export function buildSqlPaginationPlan(
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

export function buildOrderClause(type: DbConnectionConfig["type"], sortColumn?: string, sortDirection?: "asc" | "desc"): string {
  const column = String(sortColumn || "").trim();
  if (!column) return "";
  return ` ORDER BY ${quoteIdentifier(type, column)} ${normalizeSortDirection(sortDirection).toUpperCase()}`;
}

export function normalizeSortDirection(direction?: "asc" | "desc"): "asc" | "desc" {
  return direction === "desc" ? "desc" : "asc";
}

export function parseTrailingLimit(sql: string): { baseSql: string; limit: number; offset: number } | undefined {
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

export function readTotalRows(result: QueryResult): number {
  const first = result.rows[0] ?? {};
  const knownValue = first.totalRows ?? first.totalrows ?? first.count ?? first["COUNT(*)"] ?? first["count(*)"];
  return Number(knownValue ?? Object.values(first)[0] ?? 0);
}

export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "");
}

export function splitSqlStatements(sql: string): string[] {
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

export function getSqlStatementTitle(sql: string): string {
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

export function stripSqlLeadingComments(sql: string): string {
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

export function createSqlPreview(sql: string, maxLength: number): string {
  const preview = sql.replace(/\s+/g, " ").trim();
  return preview.length > maxLength ? `${preview.slice(0, maxLength - 1)}...` : preview;
}

export function isSelectLikeSql(sql: string): boolean {
  return /^(select|with)\b/i.test(sql.trim());
}

export function buildUpdateSql(
  type: DbConnectionConfig["type"],
  table: string,
  primaryKeys: string[],
  primaryValues: Record<string, unknown>,
  changes: Record<string, unknown>
): string {
	if (type === "elasticsearch") {
	  return buildElasticUpdateSql(table, primaryKeys, primaryValues, changes);
	}
	if (type === "mongodb") {
	  return buildMongoUpdateSql(table, primaryKeys, primaryValues, changes);
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

export function buildElasticUpdateSql(
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

export function buildElasticDeleteRowsSql(table: string, ids: string[]): string {
  return `POST /${encodePathPart(table)}/_delete_by_query?refresh=true\n${JSON.stringify({ query: { ids: { values: ids } } }, null, 2)}`;
}

export function buildElasticIndexDocumentSql(table: string, row: Record<string, unknown>): string {
  const id = row._id;
  if (id === undefined || id === null || String(id).trim() === "") {
    throw new Error("ES 回滚数据缺少 _id，无法恢复文档。");
  }
  const doc = Object.fromEntries(Object.entries(row)
    .filter(([column]) => !["_index", "_id", "_score"].includes(column))
    .map(([column, value]) => [column, toElasticDocumentValue(value)]));
  return `PUT /${encodePathPart(String(row._index || table))}/_doc/${encodePathPart(String(id))}?refresh=true\n${JSON.stringify(doc, null, 2)}`;
}

export function buildMongoUpdateSql(
  collection: string,
  primaryKeys: string[],
  primaryValues: Record<string, unknown>,
  changes: Record<string, unknown>
): string {
  const filter = buildMongoPrimaryFilter(primaryKeys, primaryValues, "UPDATE");
  const document = Object.fromEntries(Object.entries(changes)
    .filter(([column]) => !primaryKeys.includes(column))
    .map(([column, value]) => [column, toMongoDocumentValue(value)]));
  if (!Object.keys(document).length) {
    throw new Error("没有可更新的 MongoDB 文档字段。");
  }
  return `db.getCollection(${JSON.stringify(collection)}).updateOne(${filter}, { "$set": ${toMongoLiteral(document)} });`;
}

export function buildMongoPrimaryFilter(primaryKeys: string[], primaryValues: Record<string, unknown>, action: string): string {
  if (primaryKeys.length !== 1 || primaryKeys[0] !== "_id") {
    throw new Error(`MongoDB ${action} 目前只能使用 _id 作为主键。`);
  }
  const value = primaryValues._id;
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`MongoDB ${action} 缺少 _id，无法执行。`);
  }
  return `{ "_id": ${toMongoLiteral(value, "_id")} }`;
}

export function buildMongoIdsFilter(primaryKeys: string[], primaryValuesList: Array<Record<string, unknown>>, action: string): string {
  if (primaryKeys.length !== 1 || primaryKeys[0] !== "_id") {
    throw new Error(`MongoDB ${action} 目前只能使用 _id 作为主键。`);
  }
  const ids = primaryValuesList.map((primaryValues) => primaryValues._id);
  if (ids.some((id) => id === undefined || id === null || String(id).trim() === "")) {
    throw new Error(`MongoDB ${action} 缺少 _id，无法执行。`);
  }
  if (ids.length === 1) {
    return `{ "_id": ${toMongoLiteral(ids[0], "_id")} }`;
  }
  return `{ "_id": { "$in": [${ids.map((id) => toMongoLiteral(id, "_id")).join(", ")}] } }`;
}

export function buildMongoInsertDocumentsSql(collection: string, rows: Record<string, unknown>[]): string {
  if (!rows.length) {
    throw new Error("缺少待写入文档，无法构造 MongoDB insertMany。");
  }
  return rows.length === 1
    ? `db.getCollection(${JSON.stringify(collection)}).insertOne(${toMongoLiteral(toMongoDocument(rowWithoutUndefined(rows[0])))});`
    : `db.getCollection(${JSON.stringify(collection)}).insertMany(${toMongoLiteral(rows.map((row) => toMongoDocument(rowWithoutUndefined(row))))});`;
}

export function collectElasticIds(primaryKeys: string[], primaryValuesList: Array<Record<string, unknown>>, action: string): string[] {
  if (primaryKeys.length !== 1 || primaryKeys[0] !== "_id") {
    throw new Error(`ES ${action} 只能使用 _id 作为主键。`);
  }
  const ids = primaryValuesList.map((primaryValues) => primaryValues._id).map((value) => String(value ?? "").trim());
  if (ids.some((id) => !id)) {
    throw new Error(`ES ${action} 缺少 _id，无法执行。`);
  }
  return ids;
}

export function toElasticDocumentValue(value: unknown): unknown {
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

export function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

export function buildDeleteRowsSql(
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
	if (type === "mongodb") {
	  return `db.getCollection(${JSON.stringify(table)}).deleteMany(${buildMongoIdsFilter(primaryKeys, primaryValuesList, "DELETE")});`;
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

export function buildRelationQuerySql(
  type: DbConnectionConfig["type"],
  sourceTable: string,
  sourceColumn: string,
  targetTable: string,
  targetColumn: string,
  values: unknown[]
): string {
	if (type !== "mysql" && type !== "postgres" && type !== "mongodb") {
	  throw new Error("关联查询暂时只支持 MySQL、PostgreSQL 和 MongoDB。");
	}
  const safeSourceTable = sourceTable.trim();
  const safeSourceColumn = sourceColumn.trim();
  const safeTargetTable = targetTable.trim();
  const safeTargetColumn = targetColumn.trim();
  if (!safeSourceTable || !safeSourceColumn || !safeTargetTable || !safeTargetColumn) {
    throw new Error("请选择当前表字段、目标表和目标表字段。");
  }
  if (!values.some((value) => value !== undefined)) {
    throw new Error("选中行里没有可用于关联查询的字段值。");
  }
	const where = buildFieldValueConditionSql(type, safeTargetColumn, values);
	if (type === "mongodb") {
	  return `db.getCollection(${JSON.stringify(safeTargetTable)}).find(${where}).limit(${getQueryConfig().defaultLimit});`;
	}

  return [
    `SELECT *`,
    `FROM ${quoteIdentifier(type, safeTargetTable)}`,
    `WHERE ${where};`,
  ].join("\n");
}

export function buildFieldValueConditionSql(type: DbConnectionConfig["type"], column: string, values: unknown[]): string {
	if (type !== "mysql" && type !== "postgres" && type !== "mongodb") {
	  throw new Error("字段快速条件查询暂时只支持 MySQL、PostgreSQL 和 MongoDB。");
	}
  const safeColumn = column.trim();
  if (!safeColumn) {
    throw new Error("请选择要作为快速条件的字段。");
  }

  const uniqueValues = dedupeSqlValues(values.filter((value) => value !== undefined));
  if (!uniqueValues.length) {
    throw new Error("选中行里没有可用于快速条件查询的字段值。");
  }

	const nonNullValues = uniqueValues.filter((value) => value !== null);
	const hasNull = uniqueValues.length !== nonNullValues.length;
	if (type === "mongodb") {
	  return buildMongoFieldValueFilter(safeColumn, nonNullValues, hasNull);
	}
	const quotedColumn = quoteIdentifier(type, safeColumn);
  const conditions: string[] = [];
  if (nonNullValues.length) {
    conditions.push(`${quotedColumn} IN (${nonNullValues.map(toSqlLiteral).join(", ")})`);
  }
  if (hasNull) {
    conditions.push(`${quotedColumn} IS NULL`);
  }
  if (!conditions.length) {
    throw new Error("选中行里没有可用于快速条件查询的字段值。");
  }
  return conditions.length > 1 ? `(${conditions.join(" OR ")})` : conditions[0];
}

export function dedupeSqlValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of values) {
    const key = normalizeSqlValueKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function buildMongoFieldValueFilter(column: string, nonNullValues: unknown[], hasNull: boolean): string {
  const conditions: string[] = [];
  if (nonNullValues.length) {
    const fieldFilter = nonNullValues.length === 1
      ? `{ ${JSON.stringify(column)}: ${toMongoLiteral(nonNullValues[0], column)} }`
      : `{ ${JSON.stringify(column)}: { "$in": [${nonNullValues.map((value) => toMongoLiteral(value, column)).join(", ")}] } }`;
    conditions.push(fieldFilter);
  }
  if (hasNull) {
    conditions.push(`{ ${JSON.stringify(column)}: null }`);
  }
  if (!conditions.length) {
    throw new Error("选中行里没有可用于快速条件查询的字段值。");
  }
  return conditions.length === 1 ? conditions[0] : `{ "$or": [${conditions.join(", ")}] }`;
}

export function normalizeSqlValueKey(value: unknown): string {
  if (value instanceof Date) {
    return `date:${value.toISOString()}`;
  }
  if (Buffer.isBuffer(value)) {
    return `buffer:${value.toString("base64")}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

export function buildRollbackSql(type: DbConnectionConfig["type"], log: OperationLogEntry): RollbackPlan {
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
	        : type === "mongodb"
	          ? [buildMongoInsertDocumentsSql(log.tableName, rows)]
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

export function buildSelectRowsByPrimaryKeysSql(
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
	if (type === "mongodb") {
	  return `db.getCollection(${JSON.stringify(table)}).find(${buildMongoIdsFilter(primaryKeys, primaryValuesList, "查询")}).limit(${Math.max(primaryValuesList.length, 1)})`;
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

export function buildInsertSql(type: DbConnectionConfig["type"], table: string, values: Record<string, unknown>): string {
	if (type === "mongodb") {
	  return `db.getCollection(${JSON.stringify(table)}).insertOne(${toMongoLiteral(toMongoDocument(rowWithoutUndefined(values)))});`;
	}
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

export function buildInsertRowsSql(type: DbConnectionConfig["type"], table: string, rows: Record<string, unknown>[]): string {
	if (type === "mongodb") {
	  return buildMongoInsertDocumentsSql(table, rows);
	}
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

export function buildImportPreviewSql(
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

export function pickExportRows(resultColumns: string[], rows: Record<string, unknown>[], requestedColumns: string[]): { columns: string[]; rows: Record<string, unknown>[] } {
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

export function buildPreviewInsertSql(table: string, rows: Record<string, unknown>[], columns: string[]): string {
  if (!rows.length) {
    return `-- ${table} 当前没有可导出的数据。\n`;
  }
  const quotedColumns = columns.map((column) => quoteIdentifier("mysql", column)).join(", ");
  const values = rows.map((row) => `(${columns.map((column) => toSqlLiteral(row[column] ?? null)).join(", ")})`).join(", ");
  return `INSERT INTO ${quoteIdentifier("mysql", table)} (${quotedColumns}) VALUES ${values};\n`;
}

export function buildXlsxBuffer(sheetName: string, columns: string[], rows: Record<string, unknown>[], aliases: Record<string, string> = {}): Buffer {
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

export function buildXlsxCell(value: unknown, columnIndex: number, rowNumber: number): string {
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

export function xlsxColumnName(index: number): string {
  let value = index;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

export function formatExportCellValue(value: unknown): string {
  if (value instanceof Date) return formatDateForSql(value);
  if (typeof value === "string") return formatStringForSqlLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function sanitizeSheetName(value: string): string {
  const name = String(value || "Sheet1").replace(/[\\/?*\[\]:]/g, " ").trim() || "Sheet1";
  return name.slice(0, 31);
}

export function sanitizeFileName(value: string): string {
  return String(value || "export").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "export";
}

export function escapeXmlText(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

export function createZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
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

export function crc32(data: Buffer): number {
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

export function collectRowColumns(rows: Record<string, unknown>[]): string[] {
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

export function getPrimaryKeysFromSnapshots(log: OperationLogEntry): string[] {
  return Object.keys(log.snapshots.find((snapshot) => Object.keys(snapshot.rowKey).length > 0)?.rowKey ?? {});
}

export function getChangedRollbackValues(
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

export function findRowByPrimaryValues(rows: Record<string, unknown>[], primaryValues: Record<string, unknown>): Record<string, unknown> | null {
  const entries = Object.entries(primaryValues);
  if (!entries.length) {
    return null;
  }
  return rows.find((row) => entries.every(([key, value]) => String(row[key]) === String(value))) ?? null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isRecordSubsetEqual(current: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => normalizeComparableValue(current[key]) === normalizeComparableValue(value));
}

export function normalizeComparableValue(value: unknown): string {
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

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getStatementErrorIndex(error: unknown, fallbackIndex: number): number {
  const value = Number((error as { failedIndex?: unknown })?.failedIndex);
  return Number.isInteger(value) && value >= 0 ? value : Math.max(0, fallbackIndex);
}

export function getStatementPartialResults(error: unknown): QueryResult[] {
  const results = (error as { results?: unknown })?.results;
  return Array.isArray(results) ? results as QueryResult[] : [];
}

export function buildSchemaDraftSql(originalTable: TableInfo, draft: Record<string, unknown>, type: DbConnectionConfig["type"] = "mysql"): string[] {
  if (type === "postgres") {
    return withPostgresDdlRole(buildPostgresSchemaDraftSql(originalTable, draft), draft);
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

export function buildCreateTableDraftSql(draft: Record<string, unknown>, type: DbConnectionConfig["type"] = "mysql"): string[] {
  if (type === "postgres") {
    return withPostgresDdlRole(buildPostgresCreateTableDraftSql(draft), draft);
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

export function buildPostgresSchemaDraftSql(originalTable: TableInfo, draft: Record<string, unknown>): string[] {
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
  const primaryChanged = primaryDeleted || nextPrimaryKeys.join("\n") !== originalPrimaryKeys.join("\n") || (primaryDraft && asString(primaryDraft.name) !== (originalTable.primaryKeyName || getDefaultPostgresPrimaryKeyName(workingTable)));

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
    dropConstraint(originalTable.primaryKeyName || getDefaultPostgresPrimaryKeyName(originalName));
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
      pushPostgresEnumTypeStatement(statements, workingTable, asString(column.name), asString(column.type));
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ADD COLUMN ${buildPostgresColumnDefinitionFromDraft(column, workingTable)};`);
      const comment = asString(column.comment);
      if (comment) {
        statements.push(`COMMENT ON COLUMN ${quoteIdentifier("postgres", workingTable)}.${quoteIdentifier("postgres", asString(column.name))} IS ${toSqlLiteral(comment)};`);
      }
      pushPostgresColumnOnUpdateStatements(statements, workingTable, asString(column.name), asString(column.onUpdate));
      continue;
    }

    let currentColumnName = originalColumnName;
    const nextColumnName = asString(column.name);
    if (nextColumnName !== originalColumnName) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} RENAME COLUMN ${quoteIdentifier("postgres", originalColumnName)} TO ${quoteIdentifier("postgres", nextColumnName)};`);
      currentColumnName = nextColumnName;
    }
    const originalDefault = originalColumn.defaultValue === null || originalColumn.defaultValue === undefined ? "" : String(originalColumn.defaultValue);
    const nextDefault = asString(column.defaultValue);
    let droppedDefaultForTypeChange = false;
    const preferredEnumTypeName = asString(column.enumTypeName) || originalColumn.enumTypeName || "";
    const nextTypePlan = resolvePostgresColumnType(workingTable, currentColumnName, asString(column.type), preferredEnumTypeName);
    const originalTypePlan = resolvePostgresColumnType(workingTable, currentColumnName, originalColumn.type, originalColumn.enumTypeName || "");
    if (normalizeQualifiedIdentifier(nextTypePlan.actualType) !== normalizeQualifiedIdentifier(originalTypePlan.actualType)) {
      const typePlan = nextTypePlan;
      pushUniqueStatement(statements, typePlan.createTypeSql);
      if (typePlan.inlineEnum && originalDefault) {
        statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} DROP DEFAULT;`);
        droppedDefaultForTypeChange = true;
      }
      const usingSql = typePlan.inlineEnum ? ` USING ${quoteIdentifier("postgres", currentColumnName)}::text::${typePlan.typeSql}` : "";
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} TYPE ${typePlan.typeSql}${usingSql};`);
    }
    const enumValueAlterPlan = buildPostgresEnumValueAlterSql(nextTypePlan, originalColumn, workingTable, currentColumnName, originalDefault);
    if (enumValueAlterPlan.dropsDefault) {
      droppedDefaultForTypeChange = true;
    }
    for (const statement of enumValueAlterPlan.statements) {
      statements.push(statement);
    }
    if ((column.notNull === true) !== !originalColumn.nullable) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} ${column.notNull === true ? "SET" : "DROP"} NOT NULL;`);
    }
    const originalAutoIncrement = /auto_increment/i.test(originalColumn.extra || "") || isPostgresGeneratedDefault(originalColumn.defaultValue);
    const nextAutoIncrement = column.autoIncrement === true;
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
    } else if (!nextAutoIncrement) {
      if (nextDefault && (droppedDefaultForTypeChange || nextDefault !== originalDefault)) {
        statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} SET DEFAULT ${formatPostgresDefault(nextDefault)};`);
      } else if (!nextDefault && !droppedDefaultForTypeChange && nextDefault !== originalDefault) {
        statements.push(`ALTER TABLE ${quoteIdentifier("postgres", workingTable)} ALTER COLUMN ${quoteIdentifier("postgres", currentColumnName)} DROP DEFAULT;`);
      }
    }
    if (asString(column.comment) !== (originalColumn.comment ?? "")) {
      const comment = asString(column.comment);
      statements.push(`COMMENT ON COLUMN ${quoteIdentifier("postgres", workingTable)}.${quoteIdentifier("postgres", currentColumnName)} IS ${comment ? toSqlLiteral(comment) : "NULL"};`);
    }
    pushPostgresColumnOnUpdateStatements(statements, workingTable, currentColumnName, asString(column.onUpdate));
  }

  if (primaryChanged && nextPrimaryKeys.length) {
    const primaryName = asString(primaryDraft?.name) || getDefaultPostgresPrimaryKeyName(workingTable);
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

export function buildPostgresCreateTableDraftSql(draft: Record<string, unknown>): string[] {
  const draftTable = asRecord(draft.table);
  const tableName = getDraftTableName(draft, "postgres");
  if (!tableName) {
    throw new Error("表名称不能为空。");
  }
  const columns = asArray(draft.columns).map(asRecord).filter((column) => !isDraftPendingDelete(column));
  if (!columns.length) {
    throw new Error("新建表至少需要一个列。");
  }
  const enumTypeStatements: string[] = [];
  for (const column of columns) {
    pushPostgresEnumTypeStatement(enumTypeStatements, tableName, asString(column.name), asString(column.type));
  }
  const lines = columns.map((column) => `  ${buildPostgresColumnDefinitionFromDraft(column, tableName)}`);
  const validColumns = new Set(columns.map((column) => asString(column.name)).filter(Boolean));
  const normalizeColumns = (value: unknown) => asArray(value).map(String).filter((column) => column && validColumns.has(column));

  for (const keyDraft of asArray(draft.keys).map(asRecord).filter((item) => !isDraftPendingDelete(item))) {
    const keyColumns = normalizeColumns(keyDraft.columns);
    if (!keyColumns.length) continue;
    if (keyDraft.primary === true) {
      lines.push(`  CONSTRAINT ${quoteIdentifier("postgres", asString(keyDraft.name) || getDefaultPostgresPrimaryKeyName(tableName))} PRIMARY KEY (${keyColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")})`);
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

  const statements = [...enumTypeStatements, `CREATE TABLE ${quoteIdentifier("postgres", tableName)} (\n${lines.join(",\n")}\n);`];
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
  for (const column of columns) {
    pushPostgresColumnOnUpdateStatements(statements, tableName, asString(column.name), asString(column.onUpdate));
  }
  return statements;
}

export function buildPostgresColumnDefinitionFromDraft(column: Record<string, unknown>, tableName = ""): string {
  const name = asString(column.name);
  if (!name) {
    throw new Error("列名称不能为空。");
  }
  const typePlan = resolvePostgresColumnType(tableName, name, asString(column.type));
  let sql = `${quoteIdentifier("postgres", name)} ${typePlan.typeSql}`;
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

export function resolvePostgresColumnType(table: string, column: string, rawType: string, preferredEnumTypeName = ""): {
  typeSql: string;
  actualType: string;
  createTypeSql?: string;
  inlineEnum: boolean;
  enumValues?: string[];
} {
  const type = String(rawType || "").trim() || "text";
  const enumValues = parseInlineEnumType(type);
  if (!enumValues) {
    return { typeSql: type, actualType: type, inlineEnum: false };
  }
  const enumType = preferredEnumTypeName || buildPostgresEnumTypeName(table, column);
  return {
    typeSql: quoteIdentifier("postgres", enumType),
    actualType: enumType,
    createTypeSql: preferredEnumTypeName ? undefined : `CREATE TYPE ${quoteIdentifier("postgres", enumType)} AS ENUM (${enumValues.map(toSqlLiteral).join(", ")});`,
    inlineEnum: true,
    enumValues,
  };
}

export function pushPostgresEnumTypeStatement(statements: string[], table: string, column: string, rawType: string): void {
  pushUniqueStatement(statements, resolvePostgresColumnType(table, column, rawType).createTypeSql);
}

export function pushUniqueStatement(statements: string[], statement: string | undefined): void {
  if (statement && !statements.includes(statement)) {
    statements.push(statement);
  }
}

export function pushPostgresColumnOnUpdateStatements(statements: string[], table: string, column: string, rawExpression: string): void {
  const expression = stripTrailingSemicolon(rawExpression).trim();
  if (!table || !column || !expression) {
    return;
  }
  const plan = buildPostgresColumnOnUpdatePlan(table, column);
  const body = [
    "BEGIN",
    `  NEW.${quoteIdentifier("postgres", column)} := ${expression};`,
    "  RETURN NEW;",
    "END;",
  ].join("\n");
  const quotedBody = toPostgresDollarQuotedBody(body);
  pushUniqueStatement(
    statements,
    `CREATE OR REPLACE FUNCTION ${quoteIdentifier("postgres", plan.functionName)}()\nRETURNS trigger AS ${quotedBody}\nLANGUAGE plpgsql;`
  );
  statements.push(`DROP TRIGGER IF EXISTS ${quoteIdentifier("postgres", plan.triggerName)} ON ${quoteIdentifier("postgres", table)};`);
  statements.push(`CREATE TRIGGER ${quoteIdentifier("postgres", plan.triggerName)} BEFORE UPDATE ON ${quoteIdentifier("postgres", table)} FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier("postgres", plan.functionName)}();`);
}

export function buildPostgresColumnOnUpdatePlan(table: string, column: string): { functionName: string; triggerName: string } {
  const parts = splitPostgresQualifiedName(table);
  const tableName = parts.pop() || "table";
  const schema = parts.join(".");
  const tablePart = toPostgresIdentifierPart(tableName);
  const columnPart = toPostgresIdentifierPart(column);
  const functionBase = shortenPostgresIdentifier(`dbw_${tablePart}_${columnPart}_on_update_fn`);
  const triggerName = shortenPostgresIdentifier(`dbw_${tablePart}_${columnPart}_on_update_trg`);
  return {
    functionName: schema ? `${schema}.${functionBase}` : functionBase,
    triggerName,
  };
}

export function toPostgresDollarQuotedBody(body: string): string {
  let tag = "dbw";
  let delimiter = `$${tag}$`;
  let index = 0;
  while (body.includes(delimiter)) {
    index += 1;
    tag = `dbw_${index}`;
    delimiter = `$${tag}$`;
  }
  return `${delimiter}\n${body}\n${delimiter}`;
}

export function withPostgresDdlRole(statements: string[], draft: Record<string, unknown>): string[] {
  const role = formatPostgresRoleName(asString(draft.ddlRole));
  if (!role || statements.length === 0) {
    return statements;
  }
  return [`SET ROLE ${role};`, ...statements, "RESET ROLE;"];
}

export function formatPostgresRoleName(role: string): string {
  const text = role.trim();
  if (!text) {
    return "";
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return text;
  }
  if (/^"(?:[^"]|"")+"$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export function normalizePostgresColumnType(table: string, column: string, rawType: string): string {
  return normalizeQualifiedIdentifier(resolvePostgresColumnType(table, column, rawType).actualType);
}

export function buildPostgresEnumValueAlterSql(
  typePlan: ReturnType<typeof resolvePostgresColumnType>,
  originalColumn: TableInfo["columns"][number],
  tableName: string,
  columnName: string,
  originalDefault: string
): { statements: string[]; dropsDefault: boolean } {
  if (!typePlan.inlineEnum || !typePlan.enumValues || !originalColumn.enumValues?.length) {
    return { statements: [], dropsDefault: false };
  }
  const originalValues = originalColumn.enumValues.map(String);
  const nextValues = typePlan.enumValues.map(String);
  if (isPostgresEnumPureAppend(originalValues, nextValues)) {
    return {
      statements: nextValues
        .slice(originalValues.length)
        .map((value) => `ALTER TYPE ${quoteIdentifier("postgres", typePlan.actualType)} ADD VALUE IF NOT EXISTS ${toSqlLiteral(value)};`),
      dropsDefault: false,
    };
  }

  const replacementType = buildPostgresReplacementEnumTypeName(typePlan.actualType, nextValues);
  const statements = [
    `CREATE TYPE ${quoteIdentifier("postgres", replacementType)} AS ENUM (${nextValues.map(toSqlLiteral).join(", ")});`,
  ];
  if (originalDefault) {
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", tableName)} ALTER COLUMN ${quoteIdentifier("postgres", columnName)} DROP DEFAULT;`);
  }
  statements.push(
    `ALTER TABLE ${quoteIdentifier("postgres", tableName)} ALTER COLUMN ${quoteIdentifier("postgres", columnName)} TYPE ${quoteIdentifier("postgres", replacementType)} USING ${quoteIdentifier("postgres", columnName)}::text::${quoteIdentifier("postgres", replacementType)};`,
    `DROP TYPE ${quoteIdentifier("postgres", typePlan.actualType)};`,
    `ALTER TYPE ${quoteIdentifier("postgres", replacementType)} RENAME TO ${quoteIdentifier("postgres", getPostgresQualifiedNameBase(typePlan.actualType))};`
  );
  return { statements, dropsDefault: Boolean(originalDefault) };
}

export function isPostgresEnumPureAppend(originalValues: string[], nextValues: string[]): boolean {
  return nextValues.length >= originalValues.length
    && originalValues.every((value, index) => nextValues[index] === value);
}

export function buildPostgresReplacementEnumTypeName(enumTypeName: string, nextValues: string[]): string {
  const parts = splitPostgresQualifiedName(enumTypeName);
  const baseName = parts.pop() || "enum_type";
  const schema = parts.join(".");
  const replacementName = shortenPostgresIdentifier(`${toPostgresIdentifierPart(baseName)}_replacement_${hashIdentifier(nextValues.join("\u0000")).slice(0, 8)}`);
  return schema ? `${schema}.${replacementName}` : replacementName;
}

export function getPostgresQualifiedNameBase(value: string): string {
  const parts = splitPostgresQualifiedName(value);
  return parts[parts.length - 1] || value;
}

export function getPostgresTableSchemaName(table: Pick<TableInfo, "name" | "schema">): string {
  if (table.schema) {
    return table.schema;
  }
  const parts = splitPostgresQualifiedName(table.name);
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "public";
}

export function splitPostgresQualifiedName(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = false;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ".") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.filter((part) => part.length > 0);
}

export function normalizeQualifiedIdentifier(value: string): string {
  return String(value || "")
    .split(".")
    .map((part) => part.trim().replace(/^"|"$/g, "").replace(/""/g, '"').toLowerCase())
    .join(".");
}

export function buildPostgresEnumTypeName(table: string, column: string): string {
  const parts = String(table || "").split(".");
  const tableName = parts.pop() || "table";
  const schema = parts.join(".");
  const typeName = shortenPostgresIdentifier(`${toPostgresIdentifierPart(tableName)}_${toPostgresIdentifierPart(column)}_enum`);
  return schema ? `${schema}.${typeName}` : typeName;
}

export function getDefaultPostgresPrimaryKeyName(table: string): string {
  return shortenPostgresIdentifier(`${toPostgresIdentifierPart(getPostgresQualifiedNameBase(table))}_pkey`);
}

export function toPostgresIdentifierPart(value: string): string {
  const text = String(value || "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/""/g, '"')
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const safe = text || "field";
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

export function shortenPostgresIdentifier(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= 63) {
    return value;
  }
  const suffix = `_${hashIdentifier(value)}`;
  let head = value;
  while (head.length > 1 && Buffer.byteLength(`${head}${suffix}`, "utf8") > 63) {
    head = head.slice(0, -1);
  }
  return `${head.replace(/_+$/g, "")}${suffix}`;
}

export function hashIdentifier(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function parseInlineEnumType(rawType: string): string[] | undefined {
  const match = String(rawType || "").trim().match(/^enum\s*\(([\s\S]*)\)$/i);
  if (!match) {
    return undefined;
  }
  const values = parseSqlStringList(match[1]);
  if (!values.length) {
    throw new Error("PostgreSQL enum 类型至少需要一个枚举值。");
  }
  return values;
}

export function parseSqlStringList(value: string): string[] {
  const values: string[] = [];
  let index = 0;
  const text = String(value || "");
  const skipWhitespace = () => {
    while (/\s/.test(text[index] || "")) index += 1;
  };
  while (index < text.length) {
    skipWhitespace();
    const quote = text[index];
    if (quote !== "'" && quote !== '"') {
      throw new Error("PostgreSQL enum 类型值需要使用引号，例如 enum('active','disabled')。");
    }
    index += 1;
    let current = "";
    let closed = false;
    while (index < text.length) {
      const char = text[index];
      const next = text[index + 1];
      if (char === "\\" && next) {
        current += next;
        index += 2;
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          current += quote;
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      current += char;
      index += 1;
    }
    if (!closed) {
      throw new Error("PostgreSQL enum 类型值缺少结束引号。");
    }
    values.push(current);
    skipWhitespace();
    if (index >= text.length) break;
    if (text[index] !== ",") {
      throw new Error("PostgreSQL enum 类型值格式错误，请使用 enum('active','disabled')。");
    }
    index += 1;
  }
  return values;
}

export function buildPostgresForeignKeySql(table: string, fkDraft: Record<string, unknown>): string {
  const columns = asArray(fkDraft.columns).map(String).filter(Boolean);
  const referenceColumns = parseColumnList(fkDraft.referenceColumns);
  const referenceTable = asString(fkDraft.referenceTable);
  if (!columns.length || !referenceTable || !referenceColumns.length) return "";
  const onUpdate = asString(fkDraft.onUpdate);
  const onDelete = asString(fkDraft.onDelete);
  return `ALTER TABLE ${quoteIdentifier("postgres", table)} ADD CONSTRAINT ${quoteIdentifier("postgres", asString(fkDraft.name) || "fk_new")} FOREIGN KEY (${columns.map((column) => quoteIdentifier("postgres", column)).join(", ")}) REFERENCES ${quoteIdentifier("postgres", referenceTable)} (${referenceColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")})${onUpdate ? ` ON UPDATE ${onUpdate}` : ""}${onDelete ? ` ON DELETE ${onDelete}` : ""};`;
}

export function formatPostgresDefault(value: string): string {
  const text = value.trim();
  if (/^(NULL|CURRENT_TIMESTAMP(?:\(\))?|CURRENT_DATE(?:\(\))?|CURRENT_TIME(?:\(\))?|NOW\(\))$/i.test(text)) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^'(?:''|[^'])*'::/.test(text)) return text;
  if (/^'.*'$/.test(text)) return text;
  if (/^nextval\(/i.test(text)) return text;
  return toSqlLiteral(text);
}

export function isCheckExpressionReferencingColumn(expression: string, columnName: string): boolean {
  const compactExpression = String(expression || "").replace(/"/g, "").toLowerCase();
  const compactColumn = String(columnName || "").replace(/"/g, "").toLowerCase();
  return Boolean(compactColumn) && new RegExp(`(^|[^a-z0-9_])${escapeRegExp(compactColumn)}([^a-z0-9_]|$)`, "i").test(compactExpression);
}

export function isPostgresGeneratedDefault(defaultValue: unknown): boolean {
  return /nextval\(/i.test(String(defaultValue || ""));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isCreateTableDraft(draft: Record<string, unknown>): boolean {
  return asString(draft.mode) === "createTable";
}

export function isDraftPendingDelete(value: Record<string, unknown>): boolean {
  return value.pendingDelete === true;
}

export function getPreviousDraftColumnName(columns: Array<Record<string, unknown>>, originalName: string): string {
  const index = columns.findIndex((column) => (asString(column.originalName) || asString(column.name)) === originalName);
  return index > 0 ? asString(columns[index - 1].name) : "";
}

export function getDraftTableName(draft: Record<string, unknown>, type: DbConnectionConfig["type"] = "mysql"): string {
  const draftTable = asRecord(draft.table);
  const tableName = asString(draftTable.name);
  if (type !== "postgres" || !isCreateTableDraft(draft) || !tableName) {
    return tableName;
  }
  if (splitPostgresQualifiedName(tableName).length > 1) {
    return tableName;
  }
  const schema = asString(draftTable.schema);
  if (!schema && Object.prototype.hasOwnProperty.call(draftTable, "schema")) {
    throw new Error("PostgreSQL 创建表需要指定 schema。");
  }
  return schema ? `${schema}.${tableName}` : tableName;
}

export function buildMysqlColumnDefinitionFromDraft(column: Record<string, unknown>): string {
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

export function columnNeedsChange(original: TableInfo["columns"][number], draft: Record<string, unknown>): boolean {
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

export function formatMysqlDefault(value: string): string {
  const text = value.trim();
  if (/^(NULL|CURRENT_TIMESTAMP(?:\(\))?|CURRENT_DATE(?:\(\))?|CURRENT_TIME(?:\(\))?)$/i.test(text)) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^'.*'$/.test(text)) return text;
  return toSqlLiteral(text);
}

export function parseMysqlOnUpdate(extra: string): string {
  const match = extra.match(/on update\s+(.+)$/i);
  return match ? match[1] : "";
}

export function parseColumnList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function quoteIdentifier(type: DbConnectionConfig["type"], identifier: string): string {
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

export function toSqlLiteral(value: unknown): string {
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

export function toMongoLiteral(value: unknown, column?: string): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (column === "_id" && typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value.trim())) {
    return `ObjectId(${JSON.stringify(value.trim())})`;
  }
  if (value instanceof Date) {
    return `ISODate(${JSON.stringify(value.toISOString())})`;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    const parsed = parseJsonDocumentValue(value);
    if (parsed !== undefined) {
      return toMongoLiteral(parsed, column);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => toMongoLiteral(toMongoDocumentValue(item))).join(", ")}]`;
  }
  if (typeof value === "object") {
    return `{ ${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)}: ${toMongoLiteral(toMongoDocumentValue(item), key)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

export function toMongoDocumentValue(value: unknown): unknown {
  if (typeof value === "string") {
    const parsed = parseJsonDocumentValue(value);
    return parsed === undefined ? value : parsed;
  }
  return value;
}

export function toMongoDocument(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toMongoDocumentValue(value)]));
}

export function rowWithoutUndefined(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

export function parseJsonDocumentValue(value: string): unknown {
  const text = value.trim();
  if (!/^[\[{]/.test(text)) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function formatStringForSqlLiteral(value: string): string {
  const date = parseIsoUtcDate(value);
  return date ? formatDateForSql(date) : value;
}

export function parseIsoUtcDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDateForSql(value: Date): string {
  const beijing = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}

export function clampLimit(limit: number): number {
  const maxRows = getQueryConfig().maxRows;
  if (!Number.isFinite(limit)) {
    return getQueryConfig().defaultLimit;
  }
  if (limit < 0) {
    return Math.floor(limit);
  }

  return Math.max(1, Math.min(Math.floor(limit), maxRows));
}

export function getAiLoadingMessage(type: DbConnectionConfig["type"]): string {
  if (type === "redis") return "正在根据 Redis Key 信息生成命令...";
  if (type === "elasticsearch") return "正在根据索引结构生成 Elasticsearch 查询...";
  if (type === "mongodb") return "正在根据集合结构生成 MongoDB 查询...";
  return "正在根据表结构生成 SQL...";
}

export function parseRedisTtlInput(input: string): { seconds: number | null } {
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

export function sanitizeCompletionUsage(value: unknown): Record<string, number> {
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

export function sanitizeStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

export function isMySqlCheckConstraintEnforcedVersion(version: string): boolean {
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

export function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
