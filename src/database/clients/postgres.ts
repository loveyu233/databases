import { Client as PgClient } from "pg";
import { DbConnectionWithSecret, QueryResult, TableColumn, TableInfo, TableSummary } from "../../types";
import { DbClient } from "../core/client";
import { applySafetyLimit, sliceRows } from "../core/utils";

function isPostgresGeneratedDefault(defaultValue: string | null | undefined): boolean {
  return /nextval\(/i.test(String(defaultValue || ""));
}

function toPostgresSqlLiteral(value: unknown): string {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

export class PostgresClient implements DbClient {
  private constructor(private readonly client: PgClient) {}

  static async connect(config: DbConnectionWithSecret, database?: string): Promise<PostgresClient> {
    const client = new PgClient({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: database || config.database || "postgres",
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
      statement_timeout: 30000,
    });
    await client.connect();
    return new PostgresClient(client);
  }

  async ping(): Promise<void> {
    await this.client.query("SELECT 1");
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname"
    );
    return result.rows.map((row) => row.datname);
  }

  async listTables(): Promise<string[]> {
    return (await this.listTableSummaries()).map((item) => item.name);
  }

  async listTableSummaries(): Promise<TableSummary[]> {
    const result = await this.client.query<{ table_name: string; table_schema: string; raw_table_name: string; table_comment: string | null }>(
      `SELECT CASE WHEN t.table_schema = 'public' THEN t.table_name ELSE t.table_schema || '.' || t.table_name END AS table_name,
              t.table_schema AS table_schema,
              t.table_name AS raw_table_name,
              obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass::oid, 'pg_class') AS table_comment
       FROM information_schema.tables t
       WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema') AND t.table_schema NOT LIKE 'pg_toast%' AND t.table_schema NOT LIKE 'pg_temp_%' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_schema, t.table_name`
    );
    return result.rows.map((row) => ({
      name: row.table_name,
      schema: row.table_schema,
      displayName: row.raw_table_name,
      comment: row.table_comment ?? "",
    }));
  }

  async loadSchema(): Promise<TableInfo[]> {
    const result = await this.client.query<{
      table_name: string;
      table_schema: string;
      raw_table_name: string;
      column_name: string;
      data_type: string;
      not_null: boolean;
      column_default: string | null;
      column_key: string | null;
      primary_key_name: string | null;
      column_comment: string | null;
      table_comment: string | null;
      is_identity: boolean;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS table_name,
              n.nspname AS table_schema,
              c.relname AS raw_table_name,
              a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
              a.attnotnull AS not_null,
              pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
              a.attidentity <> '' AS is_identity,
              CASE WHEN pk.conname IS NOT NULL THEN 'PRI' ELSE NULL END AS column_key,
              pk.conname AS primary_key_name,
              col_description(c.oid, a.attnum) AS column_comment,
              obj_description(c.oid, 'pg_class') AS table_comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
       LEFT JOIN (
         SELECT conrelid, conname, unnest(conkey) AS attnum
         FROM pg_constraint
         WHERE contype = 'p'
       ) pk ON pk.conrelid = c.oid AND pk.attnum = a.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY n.nspname, c.relname, a.attnum`
    );
    const indexRows = await this.client.query<{
      table_name: string;
      index_name: string;
      is_unique: boolean;
      column_name: string | null;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN t.relname ELSE n.nspname || '.' || t.relname END AS table_name,
              i.relname AS index_name,
              ix.indisunique AS is_unique,
              a.attname AS column_name
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, seq) ON ord.attnum > 0
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ord.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND ix.indisprimary = false
       ORDER BY n.nspname, t.relname, i.relname, ord.seq`
    );
    const foreignKeyRows = await this.client.query<{
      table_name: string;
      constraint_name: string;
      column_name: string;
      referenced_table_name: string;
      referenced_column_name: string;
      update_rule: string;
      delete_rule: string;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN t.relname ELSE n.nspname || '.' || t.relname END AS table_name,
              con.conname AS constraint_name,
              a.attname AS column_name,
              CASE WHEN rn.nspname = 'public' THEN rt.relname ELSE rn.nspname || '.' || rt.relname END AS referenced_table_name,
              ra.attname AS referenced_column_name,
              CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END AS update_rule,
              CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END AS delete_rule
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class rt ON rt.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rt.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, seq) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, seq) ON fk.seq = ck.seq
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ck.attnum
       JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = fk.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND con.contype = 'f'
       ORDER BY n.nspname, t.relname, con.conname, ck.seq`
    );
    const checkRows = await this.client.query<{
      table_name: string;
      constraint_name: string;
      expression: string;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN t.relname ELSE n.nspname || '.' || t.relname END AS table_name,
              con.conname AS constraint_name,
              regexp_replace(pg_get_constraintdef(con.oid), '^CHECK \\((.*)\\)$', '\\1') AS expression
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND con.contype = 'c'
       ORDER BY n.nspname, t.relname, con.conname`
    );
    const triggerRows = await this.client.query<{
      table_name: string;
      trigger_name: string;
      timing: string;
      event: string;
      statement: string;
      function_name: string | null;
      function_language: string | null;
      function_definition: string | null;
    }>(
      `SELECT CASE WHEN tn.nspname = 'public' THEN tbl.relname ELSE tn.nspname || '.' || tbl.relname END AS table_name,
              trg.tgname AS trigger_name,
              CASE
                WHEN (trg.tgtype::int & 2) <> 0 THEN 'BEFORE'
                WHEN (trg.tgtype::int & 64) <> 0 THEN 'INSTEAD OF'
                ELSE 'AFTER'
              END AS timing,
              concat_ws(' OR ',
                CASE WHEN (trg.tgtype::int & 4) <> 0 THEN 'INSERT' END,
                CASE WHEN (trg.tgtype::int & 8) <> 0 THEN 'DELETE' END,
                CASE WHEN (trg.tgtype::int & 16) <> 0 THEN 'UPDATE' END,
                CASE WHEN (trg.tgtype::int & 32) <> 0 THEN 'TRUNCATE' END
              ) AS event,
              pg_get_triggerdef(trg.oid, true) AS statement,
              CASE WHEN pn.nspname = 'public' THEN p.proname ELSE pn.nspname || '.' || p.proname END AS function_name,
              lang.lanname AS function_language,
              pg_get_functiondef(p.oid) AS function_definition
       FROM pg_trigger trg
       JOIN pg_class tbl ON tbl.oid = trg.tgrelid
       JOIN pg_namespace tn ON tn.oid = tbl.relnamespace
       JOIN pg_proc p ON p.oid = trg.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
       JOIN pg_language lang ON lang.oid = p.prolang
       WHERE NOT trg.tgisinternal
         AND tn.nspname NOT IN ('pg_catalog', 'information_schema')
         AND tn.nspname NOT LIKE 'pg_toast%'
         AND tn.nspname NOT LIKE 'pg_temp_%'
       ORDER BY tn.nspname, tbl.relname, trg.tgname`
    );
    const enumRows = await this.client.query<{
      table_name: string;
      column_name: string;
      type_schema: string;
      type_name: string;
      enum_values: unknown;
    }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS table_name,
              n.nspname AS table_schema,
              c.relname AS raw_table_name,
              a.attname AS column_name,
              typn.nspname AS type_schema,
              typ.typname AS type_name,
              json_agg(e.enumlabel ORDER BY e.enumsortorder) AS enum_values
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_type typ ON typ.oid = a.atttypid
       JOIN pg_namespace typn ON typn.oid = typ.typnamespace
       JOIN pg_enum e ON e.enumtypid = typ.oid
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped
       GROUP BY n.nspname, c.relname, a.attname, a.attnum, typn.nspname, typ.typname
       ORDER BY n.nspname, c.relname, a.attnum`
    );

    const byTable = new Map<string, TableColumn[]>();
    const tableSchemas = new Map<string, string>();
    const tableDisplayNames = new Map<string, string>();
    const tableComments = new Map<string, string>();
    const primaryKeyNames = new Map<string, string>();
    const enumValuesByColumn = new Map(enumRows.rows.map((row) => [
      `${row.table_name}\u0000${row.column_name}`,
      normalizePostgresEnumValues(row.enum_values),
    ]));
    const customTypesByTable = new Map<string, Map<string, { name: string; kind: string; values: string[]; definition: string }>>();
    for (const row of enumRows.rows) {
      const values = normalizePostgresEnumValues(row.enum_values);
      if (!values.length) continue;
      const tableTypes = customTypesByTable.get(row.table_name) ?? new Map<string, { name: string; kind: string; values: string[]; definition: string }>();
      const typeName = formatPostgresCustomTypeName(row.type_schema, row.type_name);
      tableTypes.set(typeName, {
        name: typeName,
        kind: "enum",
        values,
        definition: `CREATE TYPE ${quotePostgresIdentifier(typeName)} AS ENUM (${values.map(toPostgresSqlLiteral).join(", ")});`,
      });
      customTypesByTable.set(row.table_name, tableTypes);
    }
    for (const row of result.rows) {
      const columns = byTable.get(row.table_name) ?? [];
      tableSchemas.set(row.table_name, row.table_schema);
      tableDisplayNames.set(row.table_name, row.raw_table_name);
      tableComments.set(row.table_name, row.table_comment ?? "");
      if (row.primary_key_name) {
        primaryKeyNames.set(row.table_name, row.primary_key_name);
      }
      const enumValues = enumValuesByColumn.get(`${row.table_name}\u0000${row.column_name}`) || [];
      columns.push({
        name: row.column_name,
        type: enumValues.length ? formatPostgresInlineEnumType(enumValues) : row.data_type,
        nullable: row.not_null !== true,
        key: row.column_key ?? undefined,
        defaultValue: row.column_default,
        comment: row.column_comment ?? "",
        extra: row.is_identity || isPostgresGeneratedDefault(row.column_default) ? "auto_increment" : "",
        enumValues: enumValues.length ? enumValues : undefined,
        enumTypeName: enumValues.length ? row.data_type : undefined,
      });
      byTable.set(row.table_name, columns);
    }

    const indexesByTable = new Map<string, Map<string, { name: string; unique: boolean; columns: string[] }>>();
    for (const row of indexRows.rows) {
      if (!row.column_name) continue;
      const tableIndexes = indexesByTable.get(row.table_name) ?? new Map<string, { name: string; unique: boolean; columns: string[] }>();
      const index = tableIndexes.get(row.index_name) ?? { name: row.index_name, unique: row.is_unique === true, columns: [] };
      index.columns.push(row.column_name);
      tableIndexes.set(row.index_name, index);
      indexesByTable.set(row.table_name, tableIndexes);
    }

    const foreignKeysByTable = new Map<string, Map<string, { name: string; columns: string[]; referenceTable: string; referenceColumns: string[]; onUpdate?: string; onDelete?: string }>>();
    for (const row of foreignKeyRows.rows) {
      const tableForeignKeys = foreignKeysByTable.get(row.table_name) ?? new Map<string, { name: string; columns: string[]; referenceTable: string; referenceColumns: string[]; onUpdate?: string; onDelete?: string }>();
      const foreignKey = tableForeignKeys.get(row.constraint_name) ?? {
        name: row.constraint_name,
        columns: [],
        referenceTable: row.referenced_table_name,
        referenceColumns: [],
        onUpdate: row.update_rule || "",
        onDelete: row.delete_rule || "",
      };
      foreignKey.columns.push(row.column_name);
      foreignKey.referenceColumns.push(row.referenced_column_name);
      tableForeignKeys.set(row.constraint_name, foreignKey);
      foreignKeysByTable.set(row.table_name, tableForeignKeys);
    }

    const checksByTable = new Map<string, Array<{ name: string; expression: string }>>();
    for (const row of checkRows.rows) {
      const checks = checksByTable.get(row.table_name) ?? [];
      checks.push({ name: row.constraint_name, expression: row.expression || "" });
      checksByTable.set(row.table_name, checks);
    }

    const triggersByTable = new Map<string, Array<{ name: string; timing: string; event: string; statement: string; functionName?: string; functionDefinition?: string }>>();
    const customFunctionsByTable = new Map<string, Map<string, { name: string; language?: string; definition: string }>>();
    for (const row of triggerRows.rows) {
      const triggers = triggersByTable.get(row.table_name) ?? [];
      const statement = extractPostgresTriggerStatement(row.statement || "");
      const functionName = row.function_name || "";
      const functionDefinition = row.function_definition || "";
      triggers.push({
        name: row.trigger_name,
        timing: row.timing || "",
        event: row.event || "",
        statement,
        functionName: functionName || undefined,
        functionDefinition: functionDefinition || undefined,
      });
      triggersByTable.set(row.table_name, triggers);
      if (functionName && functionDefinition) {
        const tableFunctions = customFunctionsByTable.get(row.table_name) ?? new Map<string, { name: string; language?: string; definition: string }>();
        tableFunctions.set(functionName, { name: functionName, language: row.function_language || "", definition: functionDefinition });
        customFunctionsByTable.set(row.table_name, tableFunctions);
      }
    }

    return [...byTable.entries()].map(([name, columns]) => ({
      name,
      schema: tableSchemas.get(name) ?? "",
      displayName: tableDisplayNames.get(name) ?? name,
      columns,
      comment: tableComments.get(name) ?? "",
      primaryKeyName: primaryKeyNames.get(name) ?? "",
      indexes: [...(indexesByTable.get(name)?.values() ?? [])],
      foreignKeys: [...(foreignKeysByTable.get(name)?.values() ?? [])],
      checks: checksByTable.get(name) ?? [],
      triggers: triggersByTable.get(name) ?? [],
      customFunctions: [...(customFunctionsByTable.get(name)?.values() ?? [])],
      customTypes: [...(customTypesByTable.get(name)?.values() ?? [])],
    }));
  }

  async getCreateTableSql(table: string): Promise<string> {
    const tableInfo = (await this.loadSchema()).find((item) => item.name === table || (item.schema === "public" && item.displayName === table));
    if (!tableInfo) {
      throw new Error(`未读取到 ${table} 的表结构。`);
    }

    const columnLines = tableInfo.columns.map((column) => {
      const defaultSql = column.defaultValue ? ` DEFAULT ${column.defaultValue}` : "";
      const identitySql = !column.defaultValue && /auto_increment/i.test(column.extra || "") ? " GENERATED BY DEFAULT AS IDENTITY" : "";
      const nullableSql = column.nullable ? "" : " NOT NULL";
      const columnType = column.enumTypeName || column.type;
      return `  ${this.quoteIdentifier(column.name)} ${columnType}${identitySql}${defaultSql}${nullableSql}`;
    });
    const primaryKeys = tableInfo.columns.filter((column) => column.key === "PRI").map((column) => column.name);
    if (primaryKeys.length) {
      const name = tableInfo.primaryKeyName || `${table}_pkey`;
      columnLines.push(`  CONSTRAINT ${this.quoteIdentifier(name)} PRIMARY KEY (${primaryKeys.map((key) => this.quoteIdentifier(key)).join(", ")})`);
    }
    for (const foreignKey of tableInfo.foreignKeys || []) {
      columnLines.push(
        `  CONSTRAINT ${this.quoteIdentifier(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map((column) => this.quoteIdentifier(column)).join(", ")}) REFERENCES ${this.quoteIdentifier(foreignKey.referenceTable)} (${foreignKey.referenceColumns.map((column) => this.quoteIdentifier(column)).join(", ")})${foreignKey.onUpdate ? ` ON UPDATE ${foreignKey.onUpdate}` : ""}${foreignKey.onDelete ? ` ON DELETE ${foreignKey.onDelete}` : ""}`
      );
    }
    for (const check of tableInfo.checks || []) {
      if (check.expression) {
        columnLines.push(`  CONSTRAINT ${this.quoteIdentifier(check.name)} CHECK (${check.expression})`);
      }
    }

    const enumTypeStatements: string[] = [];
    for (const column of tableInfo.columns) {
      if (!column.enumValues?.length) continue;
      const statement = `CREATE TYPE ${this.quoteIdentifier(column.enumTypeName || column.type)} AS ENUM (${column.enumValues.map(toPostgresSqlLiteral).join(", ")});`;
      if (!enumTypeStatements.includes(statement)) {
        enumTypeStatements.push(statement);
      }
    }
    const statements = [...enumTypeStatements, `CREATE TABLE ${this.quoteIdentifier(table)} (\n${columnLines.join(",\n")}\n);`];
    if (tableInfo.comment) {
      statements.push(`COMMENT ON TABLE ${this.quoteIdentifier(table)} IS ${toPostgresSqlLiteral(tableInfo.comment)};`);
    }
    for (const column of tableInfo.columns) {
      if (column.comment) {
        statements.push(`COMMENT ON COLUMN ${this.quoteIdentifier(table)}.${this.quoteIdentifier(column.name)} IS ${toPostgresSqlLiteral(column.comment)};`);
      }
    }
    for (const index of tableInfo.indexes || []) {
      const unique = index.unique ? "UNIQUE " : "";
      statements.push(`CREATE ${unique}INDEX ${this.quoteIdentifier(index.name)} ON ${this.quoteIdentifier(table)} (${index.columns.map((column) => this.quoteIdentifier(column)).join(", ")});`);
    }
    for (const customFunction of tableInfo.customFunctions || []) {
      if (customFunction.definition && !statements.includes(customFunction.definition)) {
        statements.push(customFunction.definition.trim().replace(/;\s*$/, ";"));
      }
    }
    for (const trigger of tableInfo.triggers || []) {
      if (trigger.statement) {
        statements.push(`CREATE TRIGGER ${this.quoteIdentifier(trigger.name)} ${trigger.timing || "BEFORE"} ${trigger.event || "INSERT"} ON ${this.quoteIdentifier(table)} FOR EACH ROW ${trigger.statement};`);
      }
    }
    return statements.join("\n");
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const normalizedSql = applySafetyLimit(sql, maxRows, "postgres");
    const startedAt = Date.now();
    const result = await this.client.query<Record<string, unknown>>(normalizedSql);
    const elapsedMs = Date.now() - startedAt;
    const rows = sliceRows(result.rows, maxRows);
    const columns = result.fields.map((field) => field.name);
    return {
      columns,
      rows,
      rowCount: result.rowCount ?? rows.length,
      affectedRows: result.rowCount ?? undefined,
      command: result.command,
      elapsedMs,
    };
  }

  async beginTransaction(): Promise<void> {
    await this.client.query("BEGIN");
  }

  async commit(): Promise<void> {
    await this.client.query("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.client.query("ROLLBACK");
  }

  quoteIdentifier(identifier: string): string {
    return quotePostgresIdentifier(identifier);
  }

  async dispose(): Promise<void> {
    await this.client.end();
  }
}


function quotePostgresIdentifier(identifier: string): string {
  return identifier
    .split(".")
    .map((part) => `"${part.replace(/"/g, "\"\"")}"`)
    .join(".");
}

function formatPostgresCustomTypeName(schema: string, name: string): string {
  return schema && schema !== "public" ? `${schema}.${name}` : name;
}

function extractPostgresTriggerStatement(triggerDefinition: string): string {
  const text = String(triggerDefinition || "").trim().replace(/;\s*$/, "");
  const match = text.match(/\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+[\s\S]+$/i);
  return match ? match[0].trim() : text;
}

function formatPostgresInlineEnumType(values: string[]): string {
  return `enum(${values.map(toPostgresSqlLiteral).join(",")})`;
}

function normalizePostgresEnumValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      return [];
    }
  }
  return [];
}
