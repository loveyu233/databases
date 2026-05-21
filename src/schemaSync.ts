import { DbConnectionConfig, TableColumn, TableInfo } from "./types";

type SqlDialect = Extract<DbConnectionConfig["type"], "mysql" | "postgres">;

export type SchemaSyncResult = {
  sql: string;
  statements: string[];
};

export function buildSchemaSyncSql(
  dialect: SqlDialect,
  sourceTable: TableInfo,
  targetTable: TableInfo
): SchemaSyncResult {
  const statements = dialect === "postgres"
    ? buildPostgresSchemaSyncSql(sourceTable, targetTable)
    : buildMysqlSchemaSyncSql(sourceTable, targetTable);
  return {
    statements,
    sql: statements.length ? statements.join("\n") : "-- 两边表结构一致，无需执行 SQL。",
  };
}

export function areTableSchemasEqual(
  dialect: SqlDialect,
  sourceTable: TableInfo,
  targetTable: TableInfo
): boolean {
  return buildSchemaSyncSql(dialect, sourceTable, targetTable).statements.length === 0
    && buildSchemaSyncSql(dialect, targetTable, sourceTable).statements.length === 0;
}

function buildMysqlSchemaSyncSql(sourceTable: TableInfo, targetTable: TableInfo): string[] {
  const table = targetTable.name;
  const statements: string[] = [];
  const sourceColumns = sourceTable.columns;
  const targetColumns = targetTable.columns;
  const sourceColumnMap = new Map(sourceColumns.map((column) => [column.name, column]));
  const targetColumnMap = new Map(targetColumns.map((column) => [column.name, column]));
  const removedColumnNames = new Set(targetColumns.filter((column) => !sourceColumnMap.has(column.name)).map((column) => column.name));

  if ((sourceTable.comment ?? "") !== (targetTable.comment ?? "")) {
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} COMMENT = ${toSqlLiteral(sourceTable.comment ?? "")};`);
  }
  if (normalizeRule(sourceTable.engine) !== normalizeRule(targetTable.engine) && sourceTable.engine) {
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} ENGINE = ${sourceTable.engine};`);
  }
  if ((sourceTable.charset || sourceTable.collation) && (normalizeRule(sourceTable.charset) !== normalizeRule(targetTable.charset) || normalizeRule(sourceTable.collation) !== normalizeRule(targetTable.collation))) {
    const charsetSql = sourceTable.charset ? ` DEFAULT CHARACTER SET ${sourceTable.charset}` : "";
    const collationSql = sourceTable.collation ? ` COLLATE ${sourceTable.collation}` : "";
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)}${charsetSql}${collationSql};`);
  }

  const sourceForeignKeys = normalizeForeignKeys(sourceTable);
  const targetForeignKeys = normalizeForeignKeys(targetTable);
  const sourceChecks = normalizeChecks(sourceTable);
  const targetChecks = normalizeChecks(targetTable);
  const sourceIndexes = normalizeIndexes(sourceTable);
  const targetIndexes = normalizeIndexes(targetTable);
  const sourcePrimary = primaryColumns(sourceTable);
  const targetPrimary = primaryColumns(targetTable);

  for (const [name, foreignKey] of targetForeignKeys) {
    if (!sourceForeignKeys.has(name) || normalizeForeignKey(sourceForeignKeys.get(name)!) !== normalizeForeignKey(foreignKey)) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} DROP FOREIGN KEY ${quoteIdentifier("mysql", name)};`);
    }
  }
  for (const [name, check] of targetChecks) {
    if (!sourceChecks.has(name) || normalizeCheckExpression(sourceChecks.get(name)!.expression) !== normalizeCheckExpression(check.expression)) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} DROP CHECK ${quoteIdentifier("mysql", name)};`);
    }
  }
  for (const [name, index] of targetIndexes) {
    if (!sourceIndexes.has(name) || normalizeIndex(sourceIndexes.get(name)!) !== normalizeIndex(index)) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} DROP INDEX ${quoteIdentifier("mysql", name)};`);
    }
  }
  if (sourcePrimary.join("\n") !== targetPrimary.join("\n") && targetPrimary.length) {
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} DROP PRIMARY KEY;`);
  }

  for (const column of targetColumns) {
    if (!sourceColumnMap.has(column.name)) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} DROP COLUMN ${quoteIdentifier("mysql", column.name)};`);
    }
  }

  const workingOrder = targetColumns.map((column) => column.name).filter((name) => !removedColumnNames.has(name));
  for (const sourceColumn of sourceColumns) {
    const targetColumn = targetColumnMap.get(sourceColumn.name);
    const desiredPrevious = previousSourceColumnName(sourceColumns, sourceColumn.name);
    const currentPrevious = previousWorkingColumnName(workingOrder, sourceColumn.name);
    const positionSql = mysqlColumnPositionSql(desiredPrevious);
    if (!targetColumn) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} ADD COLUMN ${buildMysqlColumnDefinition(sourceColumn)}${positionSql};`);
      moveWorkingColumn(workingOrder, sourceColumn.name, desiredPrevious);
      continue;
    }
    if (normalizeMysqlColumn(sourceColumn) !== normalizeMysqlColumn(targetColumn) || currentPrevious !== desiredPrevious) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} MODIFY COLUMN ${buildMysqlColumnDefinition(sourceColumn)}${positionSql};`);
      moveWorkingColumn(workingOrder, sourceColumn.name, desiredPrevious);
    }
  }

  if (sourcePrimary.join("\n") !== targetPrimary.join("\n") && sourcePrimary.length) {
    statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} ADD PRIMARY KEY (${sourcePrimary.map((column) => quoteIdentifier("mysql", column)).join(", ")});`);
  }
  for (const [name, index] of sourceIndexes) {
    if (!targetIndexes.has(name) || normalizeIndex(targetIndexes.get(name)!) !== normalizeIndex(index)) {
      const unique = index.unique ? "UNIQUE " : "";
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} ADD ${unique}INDEX ${quoteIdentifier("mysql", name)} (${index.columns.map((column) => quoteIdentifier("mysql", column)).join(", ")});`);
    }
  }
  for (const [name, foreignKey] of sourceForeignKeys) {
    if (!targetForeignKeys.has(name) || normalizeForeignKey(targetForeignKeys.get(name)!) !== normalizeForeignKey(foreignKey)) {
      statements.push(buildMysqlForeignKeySql(table, name, foreignKey));
    }
  }
  for (const [name, check] of sourceChecks) {
    if (!targetChecks.has(name) || normalizeCheckExpression(targetChecks.get(name)!.expression) !== normalizeCheckExpression(check.expression)) {
      statements.push(`ALTER TABLE ${quoteIdentifier("mysql", table)} ADD CONSTRAINT ${quoteIdentifier("mysql", name)} CHECK (${check.expression});`);
    }
  }
  for (const statement of buildTriggerSyncSql("mysql", sourceTable, targetTable)) {
    statements.push(statement);
  }

  return statements;
}

function buildPostgresSchemaSyncSql(sourceTable: TableInfo, targetTable: TableInfo): string[] {
  const table = targetTable.name;
  const statements: string[] = [];
  const sourceColumnMap = new Map(sourceTable.columns.map((column) => [column.name, column]));
  const targetColumnMap = new Map(targetTable.columns.map((column) => [column.name, column]));
  const removedColumnNames = new Set(targetTable.columns.filter((column) => !sourceColumnMap.has(column.name)).map((column) => column.name));

  if ((sourceTable.comment ?? "") !== (targetTable.comment ?? "")) {
    statements.push(`COMMENT ON TABLE ${quoteIdentifier("postgres", table)} IS ${sourceTable.comment ? toSqlLiteral(sourceTable.comment) : "NULL"};`);
  }

  const sourceForeignKeys = normalizeForeignKeys(sourceTable);
  const targetForeignKeys = normalizeForeignKeys(targetTable);
  const sourceChecks = normalizeChecks(sourceTable);
  const targetChecks = normalizeChecks(targetTable);
  const sourceIndexes = normalizeIndexes(sourceTable);
  const targetIndexes = normalizeIndexes(targetTable);
  const sourcePrimary = primaryColumns(sourceTable);
  const targetPrimary = primaryColumns(targetTable);

  const droppedConstraints = new Set<string>();
  const dropConstraint = (name: string) => {
    if (!name || droppedConstraints.has(name)) return;
    droppedConstraints.add(name);
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} DROP CONSTRAINT ${quoteIdentifier("postgres", name)};`);
  };

  for (const [name, foreignKey] of targetForeignKeys) {
    if (!sourceForeignKeys.has(name) || normalizeForeignKey(sourceForeignKeys.get(name)!) !== normalizeForeignKey(foreignKey)) {
      dropConstraint(name);
    }
  }
  for (const [name, check] of targetChecks) {
    if (!sourceChecks.has(name) || normalizeCheckExpression(sourceChecks.get(name)!.expression) !== normalizeCheckExpression(check.expression)) {
      dropConstraint(name);
    }
  }
  if ((sourceTable.primaryKeyName || "") !== (targetTable.primaryKeyName || "") || sourcePrimary.join("\n") !== targetPrimary.join("\n")) {
    dropConstraint(targetTable.primaryKeyName || `${table}_pkey`);
  }
  for (const [name, index] of targetIndexes) {
    if (!sourceIndexes.has(name) || normalizeIndex(sourceIndexes.get(name)!) !== normalizeIndex(index)) {
      statements.push(`DROP INDEX ${quoteIdentifier("postgres", name)};`);
    }
  }
  for (const columnName of removedColumnNames) {
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} DROP COLUMN ${quoteIdentifier("postgres", columnName)};`);
  }

  for (const sourceColumn of sourceTable.columns) {
    const targetColumn = targetColumnMap.get(sourceColumn.name);
    if (!targetColumn) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} ADD COLUMN ${buildPostgresColumnDefinition(sourceColumn)};`);
      if (sourceColumn.comment) {
        statements.push(`COMMENT ON COLUMN ${quoteIdentifier("postgres", table)}.${quoteIdentifier("postgres", sourceColumn.name)} IS ${toSqlLiteral(sourceColumn.comment)};`);
      }
      continue;
    }
    if (sourceColumn.type !== targetColumn.type) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} ALTER COLUMN ${quoteIdentifier("postgres", sourceColumn.name)} TYPE ${sourceColumn.type};`);
    }
    if (sourceColumn.nullable !== targetColumn.nullable) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} ALTER COLUMN ${quoteIdentifier("postgres", sourceColumn.name)} ${sourceColumn.nullable ? "DROP" : "SET"} NOT NULL;`);
    }
    if (normalizeDefaultForCompare(sourceColumn.defaultValue) !== normalizeDefaultForCompare(targetColumn.defaultValue)) {
      const defaultValue = normalizeDefaultSql(sourceColumn.defaultValue);
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} ALTER COLUMN ${quoteIdentifier("postgres", sourceColumn.name)} ${hasDefault(sourceColumn.defaultValue) ? `SET DEFAULT ${formatPostgresDefault(defaultValue)}` : "DROP DEFAULT"};`);
    }
    if ((sourceColumn.comment ?? "") !== (targetColumn.comment ?? "")) {
      statements.push(`COMMENT ON COLUMN ${quoteIdentifier("postgres", table)}.${quoteIdentifier("postgres", sourceColumn.name)} IS ${sourceColumn.comment ? toSqlLiteral(sourceColumn.comment) : "NULL"};`);
    }
  }

  if (sourcePrimary.join("\n") !== targetPrimary.join("\n") && sourcePrimary.length) {
    const name = sourceTable.primaryKeyName || `${table}_pkey`;
    statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} ADD CONSTRAINT ${quoteIdentifier("postgres", name)} PRIMARY KEY (${sourcePrimary.map((column) => quoteIdentifier("postgres", column)).join(", ")});`);
  }
  for (const [name, index] of sourceIndexes) {
    if (!targetIndexes.has(name) || normalizeIndex(targetIndexes.get(name)!) !== normalizeIndex(index)) {
      const unique = index.unique ? "UNIQUE " : "";
      statements.push(`CREATE ${unique}INDEX ${quoteIdentifier("postgres", name)} ON ${quoteIdentifier("postgres", table)} (${index.columns.map((column) => quoteIdentifier("postgres", column)).join(", ")});`);
    }
  }
  for (const [name, foreignKey] of sourceForeignKeys) {
    if (!targetForeignKeys.has(name) || normalizeForeignKey(targetForeignKeys.get(name)!) !== normalizeForeignKey(foreignKey)) {
      statements.push(buildPostgresForeignKeySql(table, name, foreignKey));
    }
  }
  for (const [name, check] of sourceChecks) {
    if (!targetChecks.has(name) || normalizeCheckExpression(targetChecks.get(name)!.expression) !== normalizeCheckExpression(check.expression)) {
      statements.push(`ALTER TABLE ${quoteIdentifier("postgres", table)} ADD CONSTRAINT ${quoteIdentifier("postgres", name)} CHECK (${check.expression});`);
    }
  }
  for (const statement of buildTriggerSyncSql("postgres", sourceTable, targetTable)) {
    statements.push(statement);
  }

  return statements;
}

function buildTriggerSyncSql(dialect: SqlDialect, sourceTable: TableInfo, targetTable: TableInfo): string[] {
  const table = targetTable.name;
  const statements: string[] = [];
  const sourceTriggers = normalizeTriggers(sourceTable);
  const targetTriggers = normalizeTriggers(targetTable);
  for (const [name, trigger] of targetTriggers) {
    if (!sourceTriggers.has(name) || normalizeTrigger(sourceTriggers.get(name)!) !== normalizeTrigger(trigger)) {
      statements.push(dialect === "postgres"
        ? `DROP TRIGGER ${quoteIdentifier("postgres", name)} ON ${quoteIdentifier("postgres", table)};`
        : `DROP TRIGGER ${quoteIdentifier("mysql", name)};`);
    }
  }
  for (const [name, trigger] of sourceTriggers) {
    if (!targetTriggers.has(name) || normalizeTrigger(targetTriggers.get(name)!) !== normalizeTrigger(trigger)) {
      statements.push(`CREATE TRIGGER ${quoteIdentifier(dialect, name)} ${trigger.timing || "BEFORE"} ${trigger.event || "INSERT"} ON ${quoteIdentifier(dialect, table)} FOR EACH ROW ${trigger.statement};`);
    }
  }
  return statements;
}

function buildMysqlColumnDefinition(column: TableColumn): string {
  let sql = `${quoteIdentifier("mysql", column.name)} ${column.type}`;
  if (column.charset) {
    sql += ` CHARACTER SET ${column.charset}`;
  }
  if (column.collation) {
    sql += ` COLLATE ${column.collation}`;
  }
  sql += column.nullable ? " NULL" : " NOT NULL";
  if (hasDefault(column.defaultValue)) {
    const defaultValue = normalizeDefaultSql(column.defaultValue);
    sql += ` DEFAULT ${formatMysqlDefault(defaultValue)}`;
  }
  if (/auto_increment/i.test(column.extra || "")) {
    sql += " AUTO_INCREMENT";
  }
  const onUpdate = parseMysqlOnUpdate(column.extra || "");
  if (onUpdate) {
    sql += ` ON UPDATE ${onUpdate}`;
  }
  if (column.comment) {
    sql += ` COMMENT ${toSqlLiteral(column.comment)}`;
  }
  return sql;
}

function buildPostgresColumnDefinition(column: TableColumn): string {
  let sql = `${quoteIdentifier("postgres", column.name)} ${column.type}`;
  const defaultValue = normalizeDefaultSql(column.defaultValue);
  if (/auto_increment/i.test(column.extra || "") && !defaultValue) {
    sql += " GENERATED BY DEFAULT AS IDENTITY";
  }
  if (!column.nullable) {
    sql += " NOT NULL";
  }
  if (hasDefault(column.defaultValue)) {
    sql += ` DEFAULT ${formatPostgresDefault(defaultValue)}`;
  }
  return sql;
}

function buildMysqlForeignKeySql(table: string, name: string, foreignKey: NonNullable<TableInfo["foreignKeys"]>[number]): string {
  return `ALTER TABLE ${quoteIdentifier("mysql", table)} ADD CONSTRAINT ${quoteIdentifier("mysql", name)} FOREIGN KEY (${foreignKey.columns.map((column) => quoteIdentifier("mysql", column)).join(", ")}) REFERENCES ${quoteIdentifier("mysql", foreignKey.referenceTable)} (${foreignKey.referenceColumns.map((column) => quoteIdentifier("mysql", column)).join(", ")})${foreignKey.onUpdate ? ` ON UPDATE ${foreignKey.onUpdate}` : ""}${foreignKey.onDelete ? ` ON DELETE ${foreignKey.onDelete}` : ""};`;
}

function buildPostgresForeignKeySql(table: string, name: string, foreignKey: NonNullable<TableInfo["foreignKeys"]>[number]): string {
  return `ALTER TABLE ${quoteIdentifier("postgres", table)} ADD CONSTRAINT ${quoteIdentifier("postgres", name)} FOREIGN KEY (${foreignKey.columns.map((column) => quoteIdentifier("postgres", column)).join(", ")}) REFERENCES ${quoteIdentifier("postgres", foreignKey.referenceTable)} (${foreignKey.referenceColumns.map((column) => quoteIdentifier("postgres", column)).join(", ")})${foreignKey.onUpdate ? ` ON UPDATE ${foreignKey.onUpdate}` : ""}${foreignKey.onDelete ? ` ON DELETE ${foreignKey.onDelete}` : ""};`;
}

function normalizeMysqlColumn(column: TableColumn): string {
  return JSON.stringify({
    name: column.name,
    type: normalizeWhitespace(column.type).toLowerCase(),
    nullable: column.nullable,
    defaultValue: normalizeDefaultForCompare(column.defaultValue),
    autoIncrement: /auto_increment/i.test(column.extra || ""),
    onUpdate: normalizeWhitespace(parseMysqlOnUpdate(column.extra || "")).toLowerCase(),
    comment: column.comment ?? "",
    charset: column.charset ?? "",
    collation: column.collation ?? "",
  });
}

function normalizeIndexes(table: TableInfo): Map<string, NonNullable<TableInfo["indexes"]>[number]> {
  return new Map((table.indexes || []).map((index) => [index.name, index]));
}

function normalizeForeignKeys(table: TableInfo): Map<string, NonNullable<TableInfo["foreignKeys"]>[number]> {
  return new Map((table.foreignKeys || []).map((foreignKey) => [foreignKey.name, foreignKey]));
}

function normalizeChecks(table: TableInfo): Map<string, NonNullable<TableInfo["checks"]>[number]> {
  return new Map((table.checks || []).map((check) => [check.name, check]));
}

function normalizeTriggers(table: TableInfo): Map<string, NonNullable<TableInfo["triggers"]>[number]> {
  return new Map((table.triggers || []).map((trigger) => [trigger.name, trigger]));
}

function normalizeIndex(index: NonNullable<TableInfo["indexes"]>[number]): string {
  return JSON.stringify({ unique: Boolean(index.unique), columns: index.columns });
}

function normalizeForeignKey(foreignKey: NonNullable<TableInfo["foreignKeys"]>[number]): string {
  return JSON.stringify({
    columns: foreignKey.columns,
    referenceTable: foreignKey.referenceTable,
    referenceColumns: foreignKey.referenceColumns,
    onUpdate: normalizeRule(foreignKey.onUpdate),
    onDelete: normalizeRule(foreignKey.onDelete),
  });
}

function normalizeTrigger(trigger: NonNullable<TableInfo["triggers"]>[number]): string {
  return JSON.stringify({
    timing: normalizeWhitespace(trigger.timing).toUpperCase(),
    event: normalizeWhitespace(trigger.event).toUpperCase(),
    statement: normalizeWhitespace(trigger.statement),
  });
}

function normalizeRule(value: unknown): string {
  return normalizeWhitespace(String(value || "")).toUpperCase();
}

function normalizeCheckExpression(expression: string): string {
  return normalizeWhitespace(expression)
    .replace(/[`"]/g, "")
    .replace(/_utf8mb4\s*''/gi, "''")
    .toLowerCase();
}

function hasDefault(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function normalizeDefaultSql(value: unknown): string {
  if (!hasDefault(value)) return "";
  return normalizeWhitespace(String(value));
}

function normalizeDefaultForCompare(value: unknown): string | null {
  if (!hasDefault(value)) return null;
  const text = normalizeWhitespace(String(value));
  return normalizeDefaultExpression(text);
}

function normalizeDefaultExpression(value: string): string {
  if (/^current_timestamp(?:\(\))?$/i.test(value)) return "current_timestamp";
  if (/^current_date(?:\(\))?$/i.test(value)) return "current_date";
  if (/^current_time(?:\(\))?$/i.test(value)) return "current_time";
  return value;
}

function normalizeWhitespace(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function primaryColumns(table: TableInfo): string[] {
  return table.columns.filter((column) => column.key === "PRI").map((column) => column.name);
}

function previousSourceColumnName(columns: TableColumn[], columnName: string): string {
  const index = columns.findIndex((column) => column.name === columnName);
  return index > 0 ? columns[index - 1].name : "";
}

function previousWorkingColumnName(columns: string[], columnName: string): string {
  const index = columns.indexOf(columnName);
  return index > 0 ? columns[index - 1] : "";
}

function moveWorkingColumn(columns: string[], columnName: string, previousColumnName: string): void {
  const oldIndex = columns.indexOf(columnName);
  if (oldIndex >= 0) {
    columns.splice(oldIndex, 1);
  }
  if (!previousColumnName) {
    columns.unshift(columnName);
    return;
  }
  const previousIndex = columns.indexOf(previousColumnName);
  columns.splice(previousIndex >= 0 ? previousIndex + 1 : columns.length, 0, columnName);
}

function mysqlColumnPositionSql(previousColumnName: string): string {
  return previousColumnName ? ` AFTER ${quoteIdentifier("mysql", previousColumnName)}` : " FIRST";
}

function formatMysqlDefault(value: string): string {
  const text = value.trim();
  if (/^(NULL|CURRENT_TIMESTAMP(?:\(\))?|CURRENT_DATE(?:\(\))?|CURRENT_TIME(?:\(\))?)$/i.test(text)) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^[bx]'.*'$/i.test(text)) return text;
  if (/^'.*'$/.test(text)) return text;
  return toSqlLiteral(text);
}

function formatPostgresDefault(value: string): string {
  const text = value.trim();
  if (/^(NULL|CURRENT_TIMESTAMP(?:\(\))?|CURRENT_DATE(?:\(\))?|CURRENT_TIME(?:\(\))?|NOW\(\))$/i.test(text)) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^'.*'$/.test(text)) return text;
  if (/^nextval\(/i.test(text)) return text;
  return toSqlLiteral(text);
}

function parseMysqlOnUpdate(extra: string): string {
  const match = extra.match(/on update\s+(.+)$/i);
  return match ? match[1] : "";
}

function quoteIdentifier(dialect: SqlDialect, identifier: string): string {
  if (dialect === "postgres") {
    return identifier
      .split(".")
      .map((part) => `"${part.replace(/"/g, "\"\"")}"`)
      .join(".");
  }
  return `\`${identifier.replace(/`/g, "``")}\``;
}

function toSqlLiteral(value: unknown): string {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}
