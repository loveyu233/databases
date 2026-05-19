const assert = require("node:assert/strict");
const { areTableSchemasEqual, buildSchemaSyncSql } = require("../out/schemaSync");

function mysqlTable(overrides = {}) {
  return {
    name: "articles",
    comment: "文章表",
    engine: "InnoDB",
    charset: "utf8mb4",
    collation: "utf8mb4_unicode_ci",
    columns: [
      column("id", "bigint unsigned", { nullable: false, key: "PRI", extra: "auto_increment", comment: "主键" }),
      column("title", "varchar(128)", { nullable: false, defaultValue: "", comment: "标题", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("summary", "varchar(255)", { nullable: false, defaultValue: "", comment: "摘要", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("status", "enum('draft','published')", { nullable: false, defaultValue: "draft", comment: "状态", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("created_at", "datetime", { nullable: false, defaultValue: "CURRENT_TIMESTAMP" }),
      column("updated_at", "datetime", { nullable: false, defaultValue: "CURRENT_TIMESTAMP", extra: "on update CURRENT_TIMESTAMP" }),
    ],
    indexes: [
      { name: "idx_status_created", unique: false, columns: ["status", "created_at"] },
      { name: "uk_title", unique: true, columns: ["title"] },
    ],
    foreignKeys: [],
    checks: [
      { name: "chk_title_valid", expression: "TRIM(`title`) IS NOT NULL AND TRIM(`title`) <> ''" },
    ],
    triggers: [
      { name: "trg_articles_before_insert", timing: "BEFORE", event: "INSERT", statement: "SET NEW.title = TRIM(NEW.title)" },
    ],
    ...overrides,
  };
}

function postgresTable(overrides = {}) {
  return {
    name: "articles",
    comment: "文章表",
    columns: [
      column("id", "bigint", { nullable: false, key: "PRI", defaultValue: "nextval('articles_id_seq'::regclass)", comment: "主键" }),
      column("title", "character varying(128)", { nullable: false, defaultValue: "", comment: "标题" }),
      column("created_at", "timestamp without time zone", { nullable: false, defaultValue: "now()" }),
    ],
    primaryKeyName: "articles_pkey",
    indexes: [
      { name: "idx_articles_title", unique: false, columns: ["title"] },
    ],
    foreignKeys: [],
    checks: [
      { name: "chk_title_valid", expression: "TRIM(title) <> ''" },
    ],
    triggers: [],
    ...overrides,
  };
}

function column(name, type, overrides = {}) {
  return {
    name,
    type,
    nullable: true,
    defaultValue: null,
    comment: "",
    extra: "",
    ...overrides,
  };
}

function sqlOf(dialect, source, target) {
  return buildSchemaSyncSql(dialect, source, target).sql;
}

function assertContains(sql, fragment, label) {
  assert.ok(
    sql.includes(fragment),
    `${label}\n缺少片段：${fragment}\n实际 SQL：\n${sql}`
  );
}

function assertNotContains(sql, fragment, label) {
  assert.ok(
    !sql.includes(fragment),
    `${label}\n不应包含片段：${fragment}\n实际 SQL：\n${sql}`
  );
}

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("MySQL 完全一致时不生成 SQL", () => {
  const table = mysqlTable();
  assert.equal(areTableSchemasEqual("mysql", table, table), true);
  assert.equal(sqlOf("mysql", table, table), "-- 两边表结构一致，无需执行 SQL。");
});

run("MySQL 表选项、字段类型、默认值、注释和更新时间能同步", () => {
  const source = mysqlTable();
  const target = mysqlTable({
    comment: "旧文章表",
    engine: "MyISAM",
    charset: "utf8mb3",
    collation: "utf8mb3_general_ci",
    columns: [
      column("id", "bigint unsigned", { nullable: false, key: "PRI", extra: "auto_increment", comment: "主键" }),
      column("title", "varchar(64)", { nullable: true, defaultValue: null, comment: "旧标题", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("summary", "varchar(255)", { nullable: false, defaultValue: null, comment: "摘要", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("status", "enum('draft','published')", { nullable: false, defaultValue: null, comment: "状态", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("created_at", "datetime", { nullable: false, defaultValue: "CURRENT_TIMESTAMP()" }),
      column("updated_at", "datetime", { nullable: false, defaultValue: "CURRENT_TIMESTAMP" }),
    ],
  });
  const sql = sqlOf("mysql", source, target);
  assertContains(sql, "ALTER TABLE `articles` COMMENT = '文章表';", "应同步表注释");
  assertContains(sql, "ALTER TABLE `articles` ENGINE = InnoDB;", "应同步表引擎");
  assertContains(sql, "ALTER TABLE `articles` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;", "应同步表字符集");
  assertContains(sql, "MODIFY COLUMN `title` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '标题' AFTER `id`;", "应同步字段定义");
  assertContains(sql, "MODIFY COLUMN `summary` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '摘要' AFTER `title`;", "应保留空字符串默认值");
  assertContains(sql, "MODIFY COLUMN `status` enum('draft','published') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft' COMMENT '状态' AFTER `summary`;", "应给枚举默认值补引号");
  assertContains(sql, "MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;", "应同步 ON UPDATE");
  assertNotContains(sql, "MODIFY COLUMN `created_at`", "CURRENT_TIMESTAMP 和 CURRENT_TIMESTAMP() 应视为等价");
});

run("MySQL 删除字段后再调整顺序不会错误生成 FIRST", () => {
  const source = mysqlTable({
    columns: [
      column("a", "int", { nullable: false }),
      column("d", "int", { nullable: false }),
      column("c", "int", { nullable: false }),
    ],
    indexes: [],
    checks: [],
    triggers: [],
  });
  const target = mysqlTable({
    columns: [
      column("a", "int", { nullable: false }),
      column("b", "int", { nullable: false }),
      column("c", "int", { nullable: false }),
      column("d", "int", { nullable: false }),
    ],
    indexes: [{ name: "idx_b", unique: false, columns: ["b"] }],
    checks: [],
    triggers: [],
  });
  const sql = sqlOf("mysql", source, target);
  assertContains(sql, "ALTER TABLE `articles` DROP INDEX `idx_b`;", "删除字段前应先删除依赖索引");
  assertContains(sql, "ALTER TABLE `articles` DROP COLUMN `b`;", "应删除目标多余字段");
  assertContains(sql, "ALTER TABLE `articles` MODIFY COLUMN `d` int NOT NULL AFTER `a`;", "移动列应落在源表上一列之后");
  assertNotContains(sql, "MODIFY COLUMN `d` int NOT NULL FIRST", "不能错误移动到 FIRST");
});

run("MySQL 主键、唯一索引、普通索引、检查约束、外键和触发器能同步", () => {
  const source = mysqlTable({
    columns: [
      column("id", "bigint unsigned", { nullable: false, key: "PRI", extra: "auto_increment" }),
      column("tenant_id", "bigint unsigned", { nullable: false, key: "PRI" }),
      column("author_id", "bigint unsigned", { nullable: false }),
      column("title", "varchar(128)", { nullable: false, defaultValue: "", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
    ],
    indexes: [
      { name: "uk_author_title", unique: true, columns: ["author_id", "title"] },
    ],
    foreignKeys: [
      { name: "fk_articles_author", columns: ["author_id"], referenceTable: "users", referenceColumns: ["id"], onUpdate: "CASCADE", onDelete: "RESTRICT" },
    ],
    checks: [
      { name: "chk_title_valid", expression: "TRIM(`title`) IS NOT NULL AND TRIM(`title`) <> ''" },
    ],
    triggers: [
      { name: "trg_articles_before_insert", timing: "BEFORE", event: "INSERT", statement: "SET NEW.title = TRIM(NEW.title)" },
    ],
  });
  const target = mysqlTable({
    columns: [
      column("id", "bigint unsigned", { nullable: false, key: "PRI", extra: "auto_increment" }),
      column("tenant_id", "bigint unsigned", { nullable: false }),
      column("author_id", "bigint unsigned", { nullable: false }),
      column("title", "varchar(128)", { nullable: false, defaultValue: "", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
    ],
    indexes: [
      { name: "idx_author", unique: false, columns: ["author_id"] },
    ],
    foreignKeys: [
      { name: "fk_old_author", columns: ["author_id"], referenceTable: "old_users", referenceColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
    ],
    checks: [
      { name: "chk_title_valid", expression: "TRIM(`title`) <> ''" },
    ],
    triggers: [
      { name: "trg_old", timing: "BEFORE", event: "INSERT", statement: "SET NEW.title = NEW.title" },
    ],
  });
  const sql = sqlOf("mysql", source, target);
  assertContains(sql, "ALTER TABLE `articles` DROP FOREIGN KEY `fk_old_author`;", "应先删除旧外键");
  assertContains(sql, "ALTER TABLE `articles` DROP CHECK `chk_title_valid`;", "应删除不同检查约束");
  assertContains(sql, "ALTER TABLE `articles` DROP INDEX `idx_author`;", "应删除不同索引");
  assertContains(sql, "ALTER TABLE `articles` DROP PRIMARY KEY;", "应删除旧主键");
  assertContains(sql, "ALTER TABLE `articles` ADD PRIMARY KEY (`id`, `tenant_id`);", "应添加复合主键");
  assertContains(sql, "ALTER TABLE `articles` ADD UNIQUE INDEX `uk_author_title` (`author_id`, `title`);", "应添加唯一索引");
  assertContains(sql, "ALTER TABLE `articles` ADD CONSTRAINT `fk_articles_author` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON UPDATE CASCADE ON DELETE RESTRICT;", "应添加外键");
  assertContains(sql, "ALTER TABLE `articles` ADD CONSTRAINT `chk_title_valid` CHECK (TRIM(`title`) IS NOT NULL AND TRIM(`title`) <> '');", "应添加检查约束");
  assertContains(sql, "DROP TRIGGER `trg_old`;", "应删除旧触发器");
  assertContains(sql, "CREATE TRIGGER `trg_articles_before_insert` BEFORE INSERT ON `articles` FOR EACH ROW SET NEW.title = TRIM(NEW.title);", "应添加新触发器");
});

run("PostgreSQL 完全一致时不生成 SQL", () => {
  const table = postgresTable();
  assert.equal(areTableSchemasEqual("postgres", table, table), true);
  assert.equal(sqlOf("postgres", table, table), "-- 两边表结构一致，无需执行 SQL。");
});

run("PostgreSQL 字段、默认值、注释、主键、索引和约束能同步", () => {
  const source = postgresTable({
    columns: [
      column("id", "bigint", { nullable: false, key: "PRI", defaultValue: "nextval('articles_id_seq'::regclass)", comment: "主键" }),
      column("tenant_id", "bigint", { nullable: false, key: "PRI" }),
      column("title", "character varying(128)", { nullable: false, defaultValue: "", comment: "标题" }),
      column("created_at", "timestamp without time zone", { nullable: false, defaultValue: "now()" }),
    ],
    primaryKeyName: "articles_pkey",
    indexes: [{ name: "idx_articles_title", unique: true, columns: ["title"] }],
    foreignKeys: [{ name: "fk_articles_tenant", columns: ["tenant_id"], referenceTable: "tenants", referenceColumns: ["id"], onUpdate: "CASCADE", onDelete: "CASCADE" }],
    checks: [{ name: "chk_title_valid", expression: "TRIM(title) <> ''" }],
  });
  const target = postgresTable({
    comment: "旧文章表",
    columns: [
      column("id", "bigint", { nullable: false, key: "PRI", defaultValue: "nextval('articles_id_seq'::regclass)", comment: "旧主键" }),
      column("legacy", "text", { nullable: true }),
      column("title", "text", { nullable: true, defaultValue: null, comment: "旧标题" }),
      column("created_at", "timestamp without time zone", { nullable: false, defaultValue: "CURRENT_TIMESTAMP" }),
    ],
    primaryKeyName: "articles_old_pkey",
    indexes: [{ name: "idx_articles_title_old", unique: false, columns: ["title"] }],
    foreignKeys: [],
    checks: [{ name: "chk_old", expression: "title <> ''" }],
  });
  const sql = sqlOf("postgres", source, target);
  assertContains(sql, "COMMENT ON TABLE \"articles\" IS '文章表';", "应同步表注释");
  assertContains(sql, "ALTER TABLE \"articles\" DROP CONSTRAINT \"chk_old\";", "应删除旧检查");
  assertContains(sql, "ALTER TABLE \"articles\" DROP CONSTRAINT \"articles_old_pkey\";", "应删除旧主键");
  assertContains(sql, "DROP INDEX \"idx_articles_title_old\";", "应删除旧索引");
  assertContains(sql, "ALTER TABLE \"articles\" DROP COLUMN \"legacy\";", "应删除多余字段");
  assertContains(sql, "ALTER TABLE \"articles\" ADD COLUMN \"tenant_id\" bigint NOT NULL;", "应新增字段");
  assertContains(sql, "ALTER TABLE \"articles\" ALTER COLUMN \"title\" TYPE character varying(128);", "应同步字段类型");
  assertContains(sql, "ALTER TABLE \"articles\" ALTER COLUMN \"title\" SET NOT NULL;", "应同步非空");
  assertContains(sql, "ALTER TABLE \"articles\" ALTER COLUMN \"title\" SET DEFAULT '';", "应同步空字符串默认值");
  assertContains(sql, "COMMENT ON COLUMN \"articles\".\"title\" IS '标题';", "应同步字段注释");
  assertContains(sql, "ALTER TABLE \"articles\" ADD CONSTRAINT \"articles_pkey\" PRIMARY KEY (\"id\", \"tenant_id\");", "应添加复合主键");
  assertContains(sql, "CREATE UNIQUE INDEX \"idx_articles_title\" ON \"articles\" (\"title\");", "应添加唯一索引");
  assertContains(sql, "ALTER TABLE \"articles\" ADD CONSTRAINT \"fk_articles_tenant\" FOREIGN KEY (\"tenant_id\") REFERENCES \"tenants\" (\"id\") ON UPDATE CASCADE ON DELETE CASCADE;", "应添加外键");
  assertContains(sql, "ALTER TABLE \"articles\" ADD CONSTRAINT \"chk_title_valid\" CHECK (TRIM(title) <> '');", "应添加检查");
});

run("PostgreSQL CURRENT_TIMESTAMP 与 now() 不误判为相同", () => {
  const source = postgresTable({
    columns: [column("created_at", "timestamp without time zone", { nullable: false, defaultValue: "now()" })],
    indexes: [],
    checks: [],
  });
  const target = postgresTable({
    columns: [column("created_at", "timestamp without time zone", { nullable: false, defaultValue: "CURRENT_TIMESTAMP" })],
    indexes: [],
    checks: [],
  });
  const sql = sqlOf("postgres", source, target);
  assertContains(sql, "ALTER TABLE \"articles\" ALTER COLUMN \"created_at\" SET DEFAULT now();", "PostgreSQL 表达式默认值应精确同步");
});
