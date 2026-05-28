# Database Workbench

Database Workbench 是一个在 VS Code 内使用的数据库工作台。它把连接管理、结构浏览、数据预览、查询编辑、数据修改、导入导出、操作日志和 AI 辅助放到同一个侧边栏与标签页工作流里。

当前支持：**MySQL、PostgreSQL、Redis、Elasticsearch、MongoDB、TDengine、Kafka**。

> Pro 只解锁 AI、操作日志、表结构对比等高级入口，不包含大模型额度或内置 API Key。使用 AI 前仍需要自行配置 OpenAI、DeepSeek、通义千问、豆包、Ollama 等 OpenAI 兼容接口。

项目地址：[https://github.com/loveyu233/databases](https://github.com/loveyu233/databases)

## 支持能力矩阵

| 能力 | MySQL | PostgreSQL | Redis | Elasticsearch | MongoDB | TDengine | Kafka |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 连接管理 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 分组 / 置顶 / 导入导出连接 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 资源浏览 | 库 / 表 | 库 / schema / 表 | DB / Key | 索引 | 数据库 / 集合 | 库 / 超级表 / 表 | Topic |
| 快速查询 | WHERE 片段 | WHERE 片段 | Key 搜索 / INSPECT | Query DSL / query_string | JSON Filter | WHERE 时间条件 | CONSUME Topic |
| 查询控制台 | SQL | SQL | Redis 命令 | HTTP Query DSL / ES SQL | Mongo shell 风格命令 | TDengine SQL | Kafka 命令 |
| 数据预览 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅，消费消息 |
| 双击编辑 | ✅ | ✅ | ✅ | ✅ | ✅，按 `_id` | - | - |
| 新增 / 删除 | ✅ | ✅ | 部分 Key/成员 | ✅ | ✅，按 `_id` | - | 创建 / 删除 Topic，发送消息 |
| 创建资源 | 数据库 / 表 | 数据库 / schema 表 | - | 索引 | 数据库 / 集合 | 数据库 | Topic |
| 修改表结构 | ✅ | ✅ | - | - | - | - | - |
| 表结构对比，Pro | ✅ | ✅ | - | - | - | - | - |
| 操作日志，Pro | ✅ | ✅ | ✅ | ✅ | ✅ | ✅，SQL 变更 | - |
| AI 辅助，Pro | SQL | SQL | 命令 | Query DSL / ES SQL | MongoDB 命令 | TDengine SQL | Kafka 命令 |

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [界面与操作习惯](#界面与操作习惯)
- [各数据库使用示例](#各数据库使用示例)
- [AI 辅助，Pro](#ai-辅助pro)
- [操作日志，Pro](#操作日志pro)
- [表结构对比，Pro](#表结构对比pro)
- [连接分组、置顶、导入导出](#连接分组置顶导入导出)
- [设置项](#设置项)
- [数据与隐私](#数据与隐私)
- [项目结构](#项目结构)
- [常见问题](#常见问题)

## 核心特性

- **统一连接树**：按分组、连接、数据库 / Schema / DB / 索引 / 集合展示资源。
- **一致的工作台体验**：点击左侧资源后，右侧标签页展示预览、快速条件、SQL / 命令编辑器、AI 时间线和结果表格。
- **多数据源支持**：MySQL、PostgreSQL、Redis、Elasticsearch、MongoDB、TDengine、Kafka 使用同一套操作习惯。
- **可视化数据编辑**：双击编辑、JSON 格式化与高亮、枚举/布尔快捷按钮、快速新增、右键删除和批量删除。
- **结构管理**：MySQL / PostgreSQL 支持创建表、修改表、SQL 建表导入、复制结构、触发器、自定义类型等。
- **安全确认**：变更类 SQL / 命令执行前会弹出格式化确认预览；MySQL / PostgreSQL 多条 SQL 执行会使用事务包裹。
- **AI 辅助**：基于当前表结构、Redis Key、ES Mapping、MongoDB 集合结构、TDengine 时序表结构或 Kafka Topic 信息生成查询和分析错误。
- **操作日志**：记录数据变更和结构变更，支持查看前后数据、标签和回滚。

## 快速开始

1. 安装插件后，打开 VS Code 左侧 **Database Workbench**。
2. 点击连接树标题栏的 `+`。
3. 选择「添加数据库连接」。
4. 选择类型：MySQL / PostgreSQL / Redis / Elasticsearch / MongoDB / TDengine / Kafka。
5. 填写 host、port、username、password、默认数据库或认证库等信息。
6. 点击「测试连接」。
7. 展开连接，点击数据库、表、索引、集合、Redis DB 或 Kafka Topic。
8. 在右侧标签页中查询、编辑、导出或使用 AI。

命令面板也可以直接执行：

```text
Database Workbench: 添加数据库连接
Database Workbench: 配置 AI
Database Workbench: 显示机器码
Database Workbench: 激活 Pro
```

## 界面与操作习惯

### 左侧连接树

```text
Database Workbench
├─ 本地环境
│  ├─ MySQL 本地连接
│  │  └─ app_blog
│  │     └─ users
│  ├─ PostgreSQL 本地连接
│  │  └─ pg_type_test
│  │     └─ public
│  │        └─ mqtt_user
│  ├─ Redis 本地连接
│  │  └─ db0
│  ├─ Elasticsearch 本地连接
│  │  └─ indices
│  │     └─ logs.2026.05
│  ├─ MongoDB 本地连接
│  │  └─ app_blog
│  │     └─ users
│  ├─ TDengine 本地连接
│  │  └─ power
│  │     ├─ meters
│  │     └─ d1001
│  └─ Kafka 本地连接
│     └─ topics
│        ├─ orders.created
│        └─ user.events
```

- 分组可修改名称和颜色。
- 连接可拖拽到分组，也可以移出分组。
- 分组、连接、数据库、表 / 集合 / 索引都支持同层级置顶。
- 右侧当前操作的表会同步高亮左侧对应节点。

### 右侧工作台

```text
顶部：刷新 / 自动刷新 / 复制结构 / 修改结构 / 选择显示字段 / 操作日志
快速条件：WHERE 片段、TDengine 时间条件、ES 条件、MongoDB JSON Filter、Redis Key 搜索
SQL / 命令 / AI：完整 SQL、TDengine SQL、Redis 命令、ES 请求、MongoDB 命令、Kafka 命令、AI 时间线
结果表格：预览、排序、分页、横向滚动、编辑、右键菜单
```

## 各数据库使用示例

### MySQL：查询、编辑和导入导出

快速条件只输入 `WHERE` 后面的内容：

```sql
status = 'paid' AND id > 100
```

完整 SQL 可以放到 SQL 编辑器：

```sql
SELECT id, title, created_at
FROM blogs
WHERE deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 30;
```

常用操作：

- 双击单元格编辑字段值。
- JSON 字段支持格式化、高亮和校验。
- 枚举字段会展示快捷选择按钮。
- 布尔字段会展示 `true` / `false` 快捷按钮。
- 快速新增行支持默认值、自增字段显示为 `auto`。
- 导出支持 Excel / SQL、字段选择、别名、拖拽排序。
- 从其他 MySQL 表导入时支持字段映射、批量写入和事务。

### PostgreSQL：schema、enum、role 和触发器

PostgreSQL 支持 schema 分层展示：

```text
pg_type_test
├─ public
│  └─ mqtt_user
└─ type_lab
   └─ primitive_types
```

创建表时可以指定 schema。DDL 执行 Role 可填写角色名，执行时会自动包裹：

```sql
SET ROLE xtj_smart_pen_owner;

CREATE TABLE xxx (
  id bigserial PRIMARY KEY,
  name text NOT NULL
);

RESET ROLE;
```

PostgreSQL 专属增强：

- 支持读取和展示 `CREATE TYPE ... AS ENUM` 自定义枚举。
- 创建 / 修改字段时可以像 MySQL 一样写 `enum('active','disabled')`，插件会自动生成对应 `CREATE TYPE`。
- 修改 enum 删除旧值或调整顺序时，会生成替换类型迁移方案。
- `更新时 CURRENT_TIMESTAMP` 会通过触发器函数实现。
- 触发器、自定义方法、自定义类型会格式化展示并高亮。
- SQL 建表入口可粘贴 `CREATE TYPE`、`CREATE TABLE`、`COMMENT`、`INDEX`、`TRIGGER` 等 SQL 并转成可视化草案。

### Redis：DB、Key 和安全预览

Redis 面板围绕 Key 管理：

- 展示 `db0`、`db1` 等 DB。
- 支持 Key 分页浏览、搜索、TTL、Memory 查看。
- 支持 string、hash、list、set、zset、stream 预览。
- 支持详情分页、成员删除和 zset score 排序。
- TTL 可以双击修改，支持 `10`、`1s`、`1m`、`1h`、`1d`、`persist`。

示例命令：

```text
SCAN 0 MATCH user:* COUNT 100
HSCAN user:1 0 COUNT 100
ZRANGE rank 0 20 WITHSCORES
```

为避免阻塞 Redis，插件会提示 `KEYS`、无界范围读取、大 Key 删除等高风险命令，并建议更安全的 SCAN / 分页方案。

### Elasticsearch：索引、Mapping 和 Query DSL

Elasticsearch 支持 HTTP 请求格式：

```text
GET /logs.2026.05/_search
{
  "query": {
    "match_all": {}
  },
  "size": 30
}
```

也支持 Elasticsearch SQL。

增强点：

- 左侧索引名会完整展示，例如 `logs.2026.05` 不会被错误显示成 `05`。
- 空索引预览时会读取 mapping 字段作为表头，不再只显示 `result`。
- 支持 Mapping / Settings 复制。
- 支持文档预览、双击编辑、右键删除。
- 支持本地自签名证书，可按需开启不安全 TLS。

### MongoDB：数据库、集合和 Shell 风格命令

MongoDB 支持无认证本地连接，也支持用户名密码认证。默认端口为 `27017`。如果填写用户名但不填写认证库，默认使用 `admin` 作为认证库。

集合预览默认执行：

```javascript
db.getCollection("users").find({}).limit(30)
```

快速条件输入 JSON Filter：

```json
{ "status": "active", "age": { "$gte": 18 } }
```

命令控制台支持常用 Mongo Shell 风格命令：

```javascript
show dbs
show collections
db.runCommand({ ping: 1 })
db.createCollection("users")
db.getCollection("users").find({ _id: ObjectId("64f000000000000000000001") }).limit(30)
db.getCollection("users").countDocuments({ status: "active" })
db.getCollection("users").aggregate([{ "$match": { "status": "active" } }])
db.getCollection("users").insertOne({ name: "Alice", status: "active" })
db.getCollection("users").updateOne({ _id: ObjectId("64f000000000000000000001") }, { "$set": { status: "disabled" } })
db.getCollection("users").deleteMany({ status: "disabled" })
db.getCollection("users").createIndex({ status: 1 }, { name: "idx_status" })
```

MongoDB 表格编辑说明：

- 集合结构由采样文档推断。
- `_id` 被识别为主键。
- 双击编辑支持 JSON / object / array 字段。
- 新增、修改、删除会生成对应 `insertOne`、`updateOne`、`deleteMany`。
- 关联查询和字段快速条件查询支持 ObjectId 自动识别。

### TDengine：时序库、超级表和时间窗口查询

TDengine 连接通过 taosAdapter WebSocket 端口访问，默认端口为 `6041`。本地默认账号通常是 `root`，默认密码通常是 `taosdata`；开启 SSL 时会使用 `wss://` 连接。

左侧树会展示数据库，下一级合并展示超级表、子表和普通表。点击时序表后，右侧会预览数据并读取字段结构；空结果也会保留 `ts`、指标字段和 tag 字段表头。

常用查询：

```sql
SHOW DATABASES;
SHOW STABLES;
SHOW TABLES;
DESCRIBE meters;

SELECT *
FROM meters
WHERE ts >= now - 1d
LIMIT 30;

SELECT avg(current) AS avg_current
FROM meters
WHERE ts >= now - 1h
INTERVAL(10m);
```

TDengine 操作说明：

- 快速条件可直接输入 `ts >= now - 1d AND current > 10`。
- 查询控制台支持 `SHOW`、`DESCRIBE`、`SELECT`、`CREATE DATABASE`、`CREATE STABLE`、`INSERT` 等 TDengine SQL。
- 复制结构会优先读取 `SHOW CREATE STABLE` / `SHOW CREATE TABLE`。
- 行右键支持关联查询和字段快速条件查询，方便用 tag 或时间字段反查其它时序表。
- 表格双击编辑、快速新增和右键删除行暂不开放，建议通过 SQL 控制台显式执行 TDengine 写入或清理语句。

### Kafka：Topic 浏览、消息消费和测试发送

Kafka 默认连接 `host:9092`。用户名可留空；如果填写用户名和密码，插件会按 SASL/PLAIN 认证。开启 SSL 后会使用 TLS，也可以在可信内网环境下允许自签名证书。

连接配置中的“Topic 筛选”可以留空，也可以填写通配符或逗号分隔的多个规则：

```text
orders-*
user-*,event-*
```

左侧树会在 `topics` 下展示 Topic。点击 Topic 后，右侧会按限制条数消费消息并展示 `topic`、`partition`、`offset`、`timestamp`、`key`、`value`、`headers`、`size` 等字段。

查询控制台支持的常用 Kafka 命令：

```text
SHOW TOPICS
SHOW TOPICS ALL
LIST GROUPS
DESCRIBE TOPIC orders.created
DESCRIBE GROUP order-consumer
CONSUME orders.created LIMIT 20
CONSUME orders.created FROM LATEST LIMIT 20 TIMEOUT 5000
PRODUCE orders.created KEY user-1 VALUE {"id":1,"status":"created"}
CREATE TOPIC orders.created PARTITIONS 3 REPLICATION_FACTOR 1
DELETE TOPIC orders.created
```

Kafka 操作说明：

- 预览和快速查询默认使用 `CONSUME <topic> LIMIT N`，适合快速查看消息内容。
- `FROM LATEST` 可用于等待新消息；默认从头开始消费，并使用临时 consumer group，不会影响已有业务消费组 offset。
- 右键 Topic 可删除 Topic；连接右键“创建”可创建 Topic。
- 表格不开放双击编辑，消息写入请使用 `PRODUCE` 命令。

## AI 辅助，Pro

激活 Pro 并配置 AI 后，可以在 MySQL、PostgreSQL、Redis、Elasticsearch、MongoDB、TDengine、Kafka 中使用 AI。

AI 能力包括：

- 根据当前表结构生成 SQL。
- 根据 Redis Key 信息生成 Redis 命令。
- 根据 Elasticsearch Mapping 生成 Query DSL 或 ES SQL。
- 根据 MongoDB 集合结构生成 find / aggregate / countDocuments 等命令。
- 根据 TDengine 时序表结构生成时间范围、INTERVAL 和聚合 SQL。
- 根据 Kafka Topic 信息生成消费、描述 Topic 或发送测试消息命令。
- 根据错误信息分析失败原因。
- 根据自然语言辅助创建表结构草案。
- 对上一次 AI 结果继续追问和改写。

编辑器内支持特殊标签：

```text
@ai{查询最近 7 天创建的订单}
<ai>统计每个状态的订单数量</ai>
@table{orders}
<table>users</table>
@gen{生成 10 条订单测试数据}
<gen>生成 10 条订单测试数据</gen>
```

配置入口：

```text
Database Workbench: 配置 AI
Database Workbench: 测试 AI 配置
```

支持 OpenAI 兼容 Chat Completions 接口，内置 OpenAI、Anthropic、Gemini、DeepSeek、通义千问、豆包、智谱、Kimi、xAI、Perplexity、Cohere、OpenRouter、硅基流动、Groq、Together、Ollama、LM Studio 等预设。

示例配置：

```json
{
  "databaseWorkbench.ai.provider": "openai",
  "databaseWorkbench.ai.useStream": true,
  "databaseWorkbench.ai.baseUrl": "https://api.openai.com/v1",
  "databaseWorkbench.ai.apiKey": "sk-xxx",
  "databaseWorkbench.ai.modelName": "gpt-4o-mini",
  "databaseWorkbench.ai.timeoutMs": 30000,
  "databaseWorkbench.ai.maxSchemaChars": 16000
}
```

## 操作日志，Pro

> 使用操作日志前，请确保本机安装 SQLite。日志以 SQLite 文件保存在本机。

记录内容：

- 执行的 SQL / 命令。
- INSERT、UPDATE、DELETE 的修改前数据、修改后数据和当前数据。
- 表结构变更。
- 执行失败的错误信息。
- AI 错误分析结果。
- 回滚记录及其来源日志。

日志弹窗支持：

- 按颜色标签筛选。
- 右键给日志打标签。
- 查看修改前 / 修改后 / 当前数据对比。
- 对支持回滚的记录生成回滚 SQL 或命令并执行。

## 表结构对比，Pro

MySQL / PostgreSQL 数据库节点右键可以打开「对比表结构」。

特点：

- 支持选择源连接 / 数据库和目标连接 / 数据库。
- 支持全库对比，也支持单表对比。
- 展示字段、索引、约束、触发器等差异。
- 支持同步到目标或同步到源。
- 同步后自动重新对比当前表。

> 该功能可能生成 `ALTER TABLE`、`DROP TABLE`、`DROP COLUMN` 等高风险语句。生产环境使用前务必备份，并先在测试库验证。

## 连接分组、置顶、导入导出

连接管理增强：

- 侧边栏 `+` 支持添加分组或添加连接。
- 分组右键可直接添加数据库连接，新连接会自动放入该分组。
- 普通添加连接时可以选择已有分组，也可以创建自定义分组。
- 连接可拖拽到分组或移出分组。
- 分组、连接、数据库、表 / 集合 / 索引都可右键置顶；置顶只在同类别同层级内生效。
- 侧边栏顶部导出按钮可导出分组和连接为 JSON。
- 快捷导入连接信息支持导入 Database Workbench JSON，并恢复分组。

> 导出的连接 JSON 可能包含密码，请妥善保存，不要提交到代码仓库。

## Pro 离线激活

Database Workbench 采用离线机器绑定许可证。激活过程不需要联网，许可证绑定当前机器。

获取机器码：

```text
Database Workbench: 显示机器码
```

激活 Pro：

```text
Database Workbench: 激活 Pro
Database Workbench: 查看 Pro 状态
Database Workbench: 取消激活（测试使用）
```

也可以在 Pro 功能弹窗中复制机器码。购买激活码、交流使用经验或反馈 Bug，可以加入 QQ 交流群并联系群主。

<p align="center">
  <a href="https://github.com/loveyu233/databases/blob/main/images/qq.jpg">
    <img src="https://raw.githubusercontent.com/loveyu233/databases/main/images/qq.jpg" alt="Database Workbench QQ 交流群二维码" width="280" />
  </a>
</p>

如果二维码加载失败，可以在 QQ 中搜索群号：`1103462459`。

## 设置项

### 查询

```json
{
  "databaseWorkbench.query.defaultLimit": 30,
  "databaseWorkbench.query.maxRows": 500
}
```

- `defaultLimit`：点击表 / 集合 / 索引预览和快速查询时默认读取行数。设置为负数表示查询全部。
- `maxRows`：任意查询最多展示的行数，用于避免误查过大结果集。

### 导出

```json
{
  "databaseWorkbench.export.transactionThreshold": 100,
  "databaseWorkbench.export.pageSize": 100,
  "databaseWorkbench.export.maxRows": 10000
}
```

### 表格展示

```json
{
  "databaseWorkbench.table.showColumnComments": true,
  "databaseWorkbench.table.hiddenColumnCommentNames": ["id", "created_at", "updated_at", "deleted_at"],
  "databaseWorkbench.table.dataGridFontSize": 12,
  "databaseWorkbench.table.sqlConfirmFontSize": 15
}
```

- `dataGridFontSize`：结果表格字号。
- `sqlConfirmFontSize`：SQL 确认弹窗字号。

### AI，Pro

```json
{
  "databaseWorkbench.ai.provider": "openai",
  "databaseWorkbench.ai.useStream": true,
  "databaseWorkbench.ai.baseUrl": "",
  "databaseWorkbench.ai.apiKey": "",
  "databaseWorkbench.ai.modelName": "",
  "databaseWorkbench.ai.debugMode": false,
  "databaseWorkbench.ai.timeoutMs": 30000,
  "databaseWorkbench.ai.errorTranslationTimeoutMs": 5000,
  "databaseWorkbench.ai.maxSchemaChars": 16000
}
```

### 日志，Pro

```json
{
  "databaseWorkbench.log.enabled": true,
  "databaseWorkbench.log.directory": "",
  "databaseWorkbench.log.maxEntriesPerTable": 1000
}
```

### Elasticsearch

```json
{
  "databaseWorkbench.elasticsearch.requestTimeoutMs": 30000,
  "databaseWorkbench.elasticsearch.maxResponseBytes": 10485760,
  "databaseWorkbench.elasticsearch.allowInsecureTls": false
}
```

- `requestTimeoutMs`：HTTP 请求超时时间。
- `maxResponseBytes`：单次响应体最大字节数。
- `allowInsecureTls`：是否允许 HTTPS 跳过证书校验，仅建议在本地 Docker 或可信测试环境开启。

## 数据与隐私

- 连接密码保存在 VS Code `SecretStorage`。
- 普通连接信息保存在 VS Code 扩展全局状态中。
- 导出的连接 JSON 可能包含密码。
- AI 请求会发送表结构、Key / 索引 / 集合 / 时序表摘要和你的需求描述，默认不发送查询结果数据行。
- 操作日志保存在本机，可能包含修改前后的真实业务数据。
- Pro 许可证保存在 VS Code `SecretStorage`，插件不会联网校验许可证。
- Elasticsearch 自签名证书需要手动开启 `allowInsecureTls`，远程或不可信网络环境不建议开启。

## 项目结构

当前代码已按较大的软件项目结构拆分，后续新增功能请尽量遵守边界：

```text
src/
├─ database/
│  ├─ service.ts              # 数据库应用服务入口
│  ├─ core/                   # DbClient、事务判断、通用工具
│  └─ clients/                # mysql / postgres / redis / elasticsearch / mongodb / tdengine
├─ workbench/
│  ├─ logic.ts                # 查询、结构 SQL、导出、回滚等纯逻辑
│  └─ webviewHtml.ts          # 右侧工作台 HTML / CSS / 前端脚本
├─ workbenchPanel.ts          # Panel 生命周期和消息编排
├─ tree.ts                    # 左侧连接树
├─ extension.ts               # VS Code 命令注册
├─ ai.ts                      # AI 请求与提示词
├─ logService.ts              # 操作日志
└─ schemaSync.ts              # 表结构同步逻辑
```

更多说明见：[`docs/architecture.md`](docs/architecture.md)。

## 常见问题

### 没激活 Pro，会影响基础查询吗？

不会。连接管理、资源浏览、基础查询、数据预览、基础编辑、MySQL / PostgreSQL 表结构编辑等基础能力可以直接使用。AI、操作日志和表结构对比需要 Pro。

### 激活 Pro 后 AI 为什么还不能用？

Pro 只解锁 AI 功能入口，不提供模型额度或通用 API Key。你需要自行准备大模型供应商的 API Key，并在「配置 AI」里填写 Base URL、API Key 和模型名。

### AI 生成的 SQL / 命令可以直接执行吗？

不建议无脑执行。AI 生成结果可能不符合业务预期，尤其是 `UPDATE`、`DELETE`、`ALTER`、`DROP`、`dropDatabase` 等变更操作。执行前请认真阅读确认弹窗。

### 为什么 Redis 有些命令会被提示风险？

大数据量 Redis 上，`KEYS`、无边界范围读取、大 Key 删除等操作可能阻塞服务。插件会尽量提示更安全的 `SCAN`、分页读取或渐进式删除方案。

### Elasticsearch 本地自签名证书连接失败怎么办？

如果确认是本地 Docker 或可信测试环境，可以开启：

```json
{
  "databaseWorkbench.elasticsearch.allowInsecureTls": true
}
```

远程生产环境不建议关闭证书校验。

### MongoDB 为什么新建数据库时需要初始集合？

MongoDB 数据库只有在创建集合或写入文档后才会真正存在。插件创建 MongoDB 数据库时会让你填写初始集合名，默认 `default_collection`。

### TDengine 为什么使用 6041 端口？

插件使用 TDengine 官方 WebSocket 连接器访问 taosAdapter，默认端口是 `6041`。如果你的 taosAdapter 端口或反向代理地址不同，请在连接配置里改成实际端口；开启 SSL 后会使用 `wss://`。

### 操作日志会不会占用很多空间？

如果频繁修改大表，日志会增长。可以调整 `databaseWorkbench.log.maxEntriesPerTable`，也可以把日志目录改到更安全、更大的磁盘位置，并定期清理。

### Pro 许可证为什么不能直接复制到另一台电脑？

Pro 许可证绑定机器码。更换电脑、重装系统或 VS Code 环境变化后，机器码可能变化，需要联系作者重新发放许可证。
