# Database Workbench
Database Workbench 是一款面向 VS Code 的数据库工作台插件，支持在编辑器内管理连接、浏览结构、预览数据、执行查询、编辑数据、导入导出，并通过 AI 辅助生成 SQL / Redis 命令 / Elasticsearch 查询。

它重点覆盖 MySQL、PostgreSQL、Redis、Elasticsearch 四类常用数据源：

- **MySQL / PostgreSQL**：库表浏览、数据预览、快速查询、SQL 控制台、数据编辑、建表、改表、导入导出、表结构对比。
- **Redis**：DB 浏览、Key 列表、TTL / Memory 查看、常见数据结构预览、搜索、编辑、删除、命令执行。
- **Elasticsearch**：索引浏览、Mapping / Settings 查看、HTTP Query DSL、Elasticsearch SQL、数据编辑和删除。
- **AI 辅助**：根据当前表结构、Key 信息或索引 Mapping 生成查询、改写查询、分析错误、辅助建表。

基础查询能力可以直接使用。AI、操作日志、表结构对比等高级能力属于 Pro 功能，需要离线许可证激活。

> **重要说明**：Pro 激活只代表解锁 AI 功能入口，不包含任何大模型额度或内置 API Key。使用 AI 功能前，仍需要你自行准备 OpenAI、DeepSeek、通义千问、豆包等大模型供应商的 API Key，并在插件设置中完成配置。

项目地址：[https://github.com/loveyu233/databases](https://github.com/loveyu233/databases)

如果遇到问题，欢迎在 GitHub 提 Issue。

## 目录

- [功能概览](#功能概览)
- [支持的数据源](#支持的数据源)
- [快速开始](#快速开始)
- [核心使用场景](#核心使用场景)
- [AI 能力，Pro](#ai-能力pro)
- [操作日志，Pro](#操作日志pro)
- [表结构对比，Pro](#表结构对比pro)
- [Pro 离线激活](#pro-离线激活)
- [AI 配置，Pro](#ai-配置pro)
- [设置项](#设置项)
- [数据与隐私](#数据与隐私)
- [常见问题](#常见问题)

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 连接管理 | 支持新增、修改、删除、测试连接；密码使用 VS Code `SecretStorage` 保存。 |
| 资源树浏览 | 左侧树按连接、数据库 / DB / 索引、表展示，并支持筛选要显示的库、DB 或索引。 |
| 查询与预览 | 支持快速条件、完整 SQL、Redis 命令、Elasticsearch HTTP 查询和 ES SQL。 |
| 数据编辑 | 支持双击修改、快速新增、右键删除、批量删除，执行前展示确认语句。 |
| 表结构管理 | 支持创建表、修改表结构、删除表、复制表结构 SQL。 |
| 导入导出 | MySQL 支持导出 Excel / SQL，支持字段选择、别名、顺序调整和分页读取；支持从其他表导入。 |
| Redis 管理 | 支持 string、hash、list、set、zset、stream 等类型查看，支持 TTL 修改和 Memory 查看。 |
| Elasticsearch 管理 | 支持索引查询、文档预览、双击编辑、右键删除、分页查询。 |
| AI 辅助，Pro | 根据结构上下文生成 / 改写查询，分析 SQL / 命令 / DDL 错误；Pro 仅解锁入口，仍需自行配置大模型 API Key。 |
| 操作日志，Pro | 记录变更 SQL、修改前后数据、错误分析，支持标签和回滚；使用前需要本机安装 SQLite。 |
| 表结构对比，Pro | 基于元数据对比 MySQL / PostgreSQL 整库结构，并生成双向同步 SQL。 |

## 支持的数据源

| 数据源 | 支持状态 | 主要能力 |
| --- | --- | --- |
| MySQL | 重点支持 | 查询、编辑、建表、改表、复制结构、导入、导出、操作日志、表结构对比、AI 生成 SQL。 |
| PostgreSQL | 已支持 | 查询、编辑、创建表、修改表结构、删除表、操作日志、表结构对比，默认读取 `public` schema。 |
| Redis | 重点支持 | DB 浏览、Key 搜索、TTL / Memory、常见类型查看、字符串编辑、元素删除、AI 生成命令。 |
| Elasticsearch | 重点支持 | 索引浏览、Mapping / Settings、HTTP Query DSL、ES SQL、文档编辑、文档删除、AI 生成查询。 |

## 快速开始

1. 打开 VS Code 左侧 Activity Bar 的 **Database Workbench**。
2. 点击连接树标题栏的 `+`，新建数据库连接。
3. 选择数据源类型并填写连接信息。
4. 点击「测试连接」，确认连接可用。
5. 展开连接，选择数据库、表、Redis DB 或 Elasticsearch 索引。
6. 在右侧工作台中预览数据、执行查询、编辑数据或打开 AI 辅助。

也可以通过命令面板执行：

```text
Database Workbench: 添加数据库连接
```



> **Pro 激活说明**：Database Workbench 的基础能力可以直接使用；AI、操作日志、表结构对比等高级能力需要 Pro 激活。Pro 激活码 **只需 10 元即可终身使用**，采用 **一机一码** 授权方式。**AI 功能激活 Pro 后仍需自行配置大模型 API Key，不是激活后就能直接使用 AI。** 想购买激活码、交流使用经验或反馈 Bug，可以扫码加入 QQ 交流群并联系群主。

<p align="center">
  <a href="https://github.com/loveyu233/databases/blob/main/images/qq.jpg">
    <img src="https://raw.githubusercontent.com/loveyu233/databases/main/images/qq.jpg" alt="Database Workbench QQ 交流群二维码" width="280" />
  </a>
</p>


> 如果二维码图片加载失败，可以在 QQ 中搜索群号：`1103462459`。



## 核心使用场景

### 1. 查询表数据

打开 MySQL / PostgreSQL 表后，可以直接在顶部快速条件框输入 `WHERE` 后面的片段。

```sql
status = 'paid' AND id > 100
```

点击「查询」后，插件会按当前表执行预览查询。查询数量默认由 `databaseWorkbench.query.defaultLimit` 控制，右侧输入框修改只对当前页面临时生效。

### 2. 执行完整 SQL

点击「打开 SQL / AI」后，可以输入完整 SQL。若编辑器里存在多条 SQL，执行时会弹出选择框，也支持全部执行。

```sql
SELECT id, title, created_at
FROM blogs
WHERE deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 30;
```

### 3. 编辑数据

- 双击单元格可以编辑字段值。
- JSON 字段会自动格式化展示，并提供语法高亮、格式化、括号闭合和校验。
- 时间字段支持快速填入当前北京时间。
- 可空字段支持快捷设置为 `NULL`。
- 修改会先暂存，提交前展示即将执行的 SQL 或命令。

### 4. 新增和删除数据

- 点击「快速添加」会在表格第一行插入空白行。
- 有默认值或自增的字段会显示为 `auto`。
- 右键数据行可以删除，支持拖拽多选后批量删除。
- 批量删除会尽量合并成一个基于主键 `IN (...)` 的删除语句。

### 5. 导入和导出 MySQL 数据

导出支持：

- 选择导出字段。
- Excel 表头别名。
- 拖拽调整 Excel 列顺序。
- 导出为 Excel 或 SQL 文件。
- 大数据量导出时按配置开启事务和分页读取。

导入支持：

- 选择来源连接、数据库和表。
- 配置来源字段到当前表字段的映射。
- 选择导入数量。
- 分批插入并使用事务保证要么全部成功、要么全部失败。

### 6. 管理表结构

MySQL / PostgreSQL 支持：

- 添加表。
- 修改表名称、描述、字段、主键、索引、外键、检查约束、触发器等结构。
- 字段拖拽调整顺序。
- 复制单表或整库表结构 SQL。
- AI 辅助建表，将需求描述映射为可编辑的建表草案。

> 表结构操作风险较高。执行前请仔细确认弹窗中的 SQL，生产库建议先备份并在测试库验证。

### 7. Redis 数据管理

Redis 面板围绕 Key 管理进行设计：

- 左侧展示 Redis DB，例如 `db0`、`db1`。
- 点击 DB 后，右侧分页展示 Key 列表。
- 支持查看 Key 类型、TTL、Memory、预览值。
- 支持 string、hash、list、set、zset、stream 的详情查看。
- 详情弹窗支持分页、搜索、元素删除。
- zset 支持按 score 排序。
- TTL 支持双击修改，输入 `10`、`1s`、`1m`、`1h`、`1d` 等格式。

为避免大数据量 Redis 阻塞，插件会尽量使用 `SCAN`、分页命令和安全预览策略，并提示高风险命令。

### 8. Elasticsearch 查询与编辑

Elasticsearch 支持两种查询方式：

```text
GET /my_index/_search
{
  "query": {
    "match_all": {}
  },
  "size": 30
}
```

也支持 Elasticsearch SQL。查询结果支持分页预览、双击编辑文档字段、右键删除文档。

## AI 能力，Pro

激活 Pro 并配置 AI 后，可以在 MySQL、PostgreSQL、Redis、Elasticsearch 中使用 AI 辅助。

> **注意**：Pro 激活不包含大模型服务，也不会提供通用 API Key。AI 功能需要你自行在对应大模型平台注册并获取 API Key，然后在 Database Workbench 设置中填写 Base URL、API Key 和模型名称。

### AI 可以做什么

- 根据当前表结构生成 SQL。
- 根据 Redis Key 信息生成 Redis 命令。
- 根据 Elasticsearch Mapping 生成 Query DSL 或 ES SQL。
- 根据错误信息和即将执行的 SQL / 命令分析失败原因。
- 根据需求辅助创建表结构草案。
- 对上一次 AI 结果继续追问和改写。

### AI 输入方式

SQL / 命令编辑器旁边提供独立的 AI 时间线。你可以在「继续告诉 AI」输入框中描述需求，生成结果会追加到时间线，并可一键应用到编辑器。

编辑器内也支持特殊标签：

```text
@ai{查询最近 7 天创建的订单}
<ai>统计每个状态的订单数量</ai>
@table{orders}
<table>users</table>
@gen{生成 10 条订单测试数据}
<gen>生成 10 条订单测试数据</gen>
```

其中：

- `@ai{}` / `<ai></ai>`：生成或改写查询。
- `@table{}` / `<table></table>`：补充需要一起发送给 AI 的表结构。
- `@gen{}` / `<gen></gen>`：生成测试数据 SQL，并要求尽量使用单条插入语句。

AI 请求会发送结构信息、Key / 索引摘要和你的需求描述。默认不会发送查询结果中的数据行。

## 操作日志，Pro

> **重要依赖**：使用操作日志功能前，请确保本机已经安装 SQLite。操作日志会以 SQLite 数据库文件形式保存在本机，用于后续查看、对比和回滚。

激活 Pro 后，插件可以记录通过工作台执行的变更操作。

记录内容包括：

- 执行的 SQL / 命令。
- INSERT、UPDATE、DELETE 的修改前数据、修改后数据和当前数据。
- 表结构变更。
- 执行失败的错误信息。
- AI 错误分析结果。
- 回滚记录及其来源日志。

日志弹窗支持：

- 按颜色标签筛选。
- 右键给记录打标签。
- 查看修改前 / 修改后 / 当前数据对比。
- 对支持回滚的记录生成回滚 SQL，确认后执行。

日志默认保存在用户目录下的 `LoveyuDatabaseWorkbench/logs`，可以通过设置项自定义目录。

> 操作日志可能包含真实业务数据，请确保日志目录安全，不要随意同步到公共网盘或代码仓库。

## 表结构对比，Pro

MySQL / PostgreSQL 数据库节点右键可以打开「对比表结构」。该功能用于对比两个数据库的整库结构差异，并生成同步 SQL。

特点：

- 支持选择源连接、源数据库、目标连接、目标数据库。
- 支持对比全部表，也可以只对比单表。
- 使用 `information_schema` / 元数据硬编码对比，不依赖 AI 生成结论。
- 可视化展示源库和目标库的字段、索引、约束等差异。
- 支持「同步到目标」和「同步到源」两个方向。
- 同步后会自动重新对比当前表并刷新展示。

> 该功能可能生成 `ALTER TABLE`、`DROP TABLE`、`DROP COLUMN` 等高风险语句。生产环境使用前务必备份，并先在测试库验证。

## Pro 离线激活

Database Workbench 采用离线机器绑定许可证。激活过程不需要联网，许可证绑定当前机器。

### 获取机器码

任选一种方式：

- 命令面板执行 `Database Workbench: 显示机器码`。
- VS Code 设置中搜索 `databaseWorkbench.pro.machineCode`，点击「复制机器码」。
- 点击 Pro 功能弹窗中的「复制机器码」。

机器码会自动复制到剪贴板。

### 激活 Pro

1. 将机器码和付款信息发送给作者。
2. 作者生成离线许可证并发给你。
3. 命令面板执行 `Database Workbench: 激活 Pro`。
4. 粘贴许可证。
5. 看到激活成功提示后，即可使用 Pro 功能。

查看激活状态：

```text
Database Workbench: 查看 Pro 状态
```

测试时如需回到未激活状态，可以在设置页底部点击「取消激活（测试使用）」，或执行：

```text
Database Workbench: 取消激活（测试使用）
```

## AI 配置，Pro

执行：

```text
Database Workbench: 配置 AI
```

插件会让你选择供应商，并预填常见 Base URL 和模型名称。Pro 激活只解锁 AI 相关功能入口，实际调用大模型仍需要你自行准备并填写 API Key。然后在设置页填写：

- 是否使用流式请求。
- Base URL。
- API Key。
- Model Name。

配置完成后，点击 AI 供应商设置描述中的「测试」，或执行：

```text
Database Workbench: 测试 AI 配置
```

测试会发送一条 `hello` 请求，用于确认 Base URL、API Key、模型名称和流式开关是否正确。

### 支持的模型供应商

插件按 OpenAI 兼容 Chat Completions 接口接入，已内置常见供应商预设：

- OpenAI
- Anthropic
- Gemini
- DeepSeek
- 通义千问
- 豆包
- 智谱
- Kimi
- xAI
- Perplexity
- Cohere
- NVIDIA NIM
- OpenRouter
- 硅基流动
- Groq
- Together
- Ollama
- LM Studio
- 其他 OpenAI 兼容接口

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

如果没有配置 AI 信息，使用 AI 相关功能时会提示先到设置中配置。

## 设置项

### 查询设置

```json
{
  "databaseWorkbench.query.defaultLimit": 30,
  "databaseWorkbench.query.maxRows": 500
}
```

- `databaseWorkbench.query.defaultLimit`：点击表名预览和快速查询时默认读取行数。设置为负数表示查询全部。
- `databaseWorkbench.query.maxRows`：任意查询最多展示的行数，用于避免误查过大结果集。

### 导出设置

```json
{
  "databaseWorkbench.export.transactionThreshold": 100,
  "databaseWorkbench.export.pageSize": 100,
  "databaseWorkbench.export.maxRows": 10000
}
```

- `databaseWorkbench.export.transactionThreshold`：导出行数达到多少时开启事务分页读取。
- `databaseWorkbench.export.pageSize`：开启事务分页后，每批读取多少行。
- `databaseWorkbench.export.maxRows`：单次导出允许的最大行数，避免导出过大导致内存占用过高。

### 表格展示设置

```json
{
  "databaseWorkbench.table.showColumnComments": true,
  "databaseWorkbench.table.hiddenColumnCommentNames": [
    "id",
    "created_at",
    "updated_at",
    "deleted_at"
  ]
}
```

- `databaseWorkbench.table.showColumnComments`：是否在表格表头展示字段描述。
- `databaseWorkbench.table.hiddenColumnCommentNames`：不展示描述的字段名，大小写不敏感。

### AI 设置，Pro

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

- `databaseWorkbench.ai.debugMode`：开启后，每次发送 AI 请求前会把请求内容复制到剪贴板，便于排查提示词和上下文。
- `databaseWorkbench.ai.errorTranslationTimeoutMs`：数据库错误 AI 分析超时时间。日志错误分析会使用更长的超时时间。

### 日志设置，Pro

> 使用日志功能需要本机安装 SQLite；如果无法打开或写入日志，请先检查 SQLite 是否可用。

```json
{
  "databaseWorkbench.log.enabled": true,
  "databaseWorkbench.log.directory": "",
  "databaseWorkbench.log.maxEntriesPerTable": 1000
}
```

- `databaseWorkbench.log.enabled`：是否记录通过插件执行的数据和表结构修改。
- `databaseWorkbench.log.directory`：日志保存目录，留空时使用默认目录。
- `databaseWorkbench.log.maxEntriesPerTable`：每个连接 / 数据库 / 表最多保留多少条日志。

### Elasticsearch 设置

```json
{
  "databaseWorkbench.elasticsearch.requestTimeoutMs": 30000,
  "databaseWorkbench.elasticsearch.maxResponseBytes": 10485760,
  "databaseWorkbench.elasticsearch.allowInsecureTls": false
}
```

- `databaseWorkbench.elasticsearch.requestTimeoutMs`：HTTP 请求超时时间，单位毫秒。
- `databaseWorkbench.elasticsearch.maxResponseBytes`：单次响应体最大字节数，超过后会中止请求。
- `databaseWorkbench.elasticsearch.allowInsecureTls`：是否允许 HTTPS 跳过证书校验。仅建议在本地自签名证书或可信测试环境开启。

## 数据与隐私

- 连接密码保存在 VS Code `SecretStorage`。
- 普通连接信息保存在 VS Code 扩展全局状态中。
- AI 请求会发送表结构、Key / 索引摘要和你的需求描述，默认不发送查询结果数据行。
- 操作日志保存在本机，但可能包含修改前后的真实业务数据。
- Pro 许可证保存在 VS Code `SecretStorage`，插件不会联网校验许可证。
- Elasticsearch 自签名证书需要手动开启 `allowInsecureTls`，远程或不可信网络环境不建议开启。

## 常见问题

### 没激活 Pro，会影响基础查询吗？

不会。连接管理、库表浏览、基础查询、基础编辑、MySQL / PostgreSQL 表结构编辑、MySQL 数据导出等基础能力可以继续使用。AI、操作日志和表结构对比需要 Pro。需要注意的是，AI 功能即使激活 Pro，也仍然需要你自行配置大模型 API Key。

### AI 生成的 SQL / 命令可以直接执行吗？

不建议直接无脑执行。AI 生成结果可能不符合业务预期，尤其是 `UPDATE`、`DELETE`、`ALTER`、`DROP` 等变更语句。执行前请先阅读并确认。

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

### 操作日志会不会占用很多空间？

如果频繁修改大表，日志会增长。可以调整 `databaseWorkbench.log.maxEntriesPerTable`，也可以把日志目录改到更安全、更大的磁盘位置，并定期清理。

### Pro 许可证为什么不能直接复制到另一台电脑？

Pro 许可证绑定机器码。更换电脑、重装系统或 VS Code 环境变化后，机器码可能变化，需要联系作者重新发放许可证。
