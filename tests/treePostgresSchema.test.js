const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return fakeVscode;
  }
  return originalLoad.apply(this, arguments);
};

const fakeVscode = {
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: {
    from(value) {
      return value;
    },
  },
  window: {
    showErrorMessage() {},
  },
};

const { ConnectionsTreeProvider } = require("../out/tree");

const connection = { id: "pg", name: "Postgres", type: "postgres", host: "127.0.0.1", port: 5432, username: "huangzhenyu" };
const tables = [
  { name: "users", schema: "public", displayName: "users", comment: "用户" },
  { name: "type_lab.primitive_types", schema: "type_lab", displayName: "primitive_types", comment: "类型" },
];
const store = {
  getGroups: () => [],
  getAll: () => [connection],
  getWithSecret: async () => ({ ...connection, password: "" }),
  getDatabaseFilter: () => undefined,
  isPinnedNodeKey: () => false,
  getPinnedNodeRank: () => Number.MAX_SAFE_INTEGER,
};
const databaseService = {
  listDatabases: async () => ["pg_type_test"],
  listTableSummaries: async () => tables,
};

(async () => {
  const devGroup = { id: "dev", name: "开发", color: "blue" };
  const testGroup = { id: "test", name: "测试", color: "green" };
  const prodGroup = { id: "prod", name: "生产", color: "red" };
  const groupedProvider = new ConnectionsTreeProvider({
    ...store,
    getGroups: () => [devGroup, testGroup, prodGroup],
    getAll: () => [],
  }, databaseService);
  const rootNodes = await groupedProvider.getChildren();
  assert.deepEqual(rootNodes.map((node) => node.kind), ["group", "groupSpacer", "group", "groupSpacer", "group"], "第一个顶部分组前不应加间距，其余分组前应加间距");

  const searchConnections = [
    { ...connection, id: "mysql-local", name: "MySQL 本地", type: "mysql", port: 3306, groupId: devGroup.id, database: "app_blog" },
    { ...connection, id: "pg-prod", name: "Postgres 生产", type: "postgres", host: "10.0.0.8", groupId: prodGroup.id, database: "orders" },
    { ...connection, id: "redis-cache", name: "Redis 缓存", type: "redis", port: 6379, groupId: undefined, database: "0" },
  ];
  const searchProvider = new ConnectionsTreeProvider({
    ...store,
    getGroups: () => [devGroup, prodGroup],
    getAll: () => searchConnections,
  }, databaseService);
  searchProvider.setConnectionSearchQuery("mysql app");
  const mysqlNodes = await searchProvider.getChildren();
  assert.deepEqual(mysqlNodes.map((node) => node.kind), ["group"], "连接搜索应只保留命中的分组");
  assert.deepEqual((await searchProvider.getChildren(mysqlNodes[0])).map((node) => node.kind === "connection" ? node.connection.id : node.kind), ["mysql-local"], "分组下只展示命中的连接");
  searchProvider.setConnectionSearchQuery("生产");
  const prodNodes = await searchProvider.getChildren();
  assert.deepEqual(prodNodes.map((node) => node.kind), ["group"], "搜索分组名应展示该分组");
  assert.deepEqual((await searchProvider.getChildren(prodNodes[0])).map((node) => node.kind === "connection" ? node.connection.id : node.kind), ["pg-prod"], "搜索命中分组名时展示该分组下连接");
  searchProvider.setConnectionSearchQuery("redis");
  assert.deepEqual((await searchProvider.getChildren()).map((node) => node.kind === "connection" ? node.connection.id : node.kind), ["redis-cache"], "搜索未分组连接时应直接展示连接");
  searchProvider.setConnectionSearchQuery("不存在");
  assert.deepEqual((await searchProvider.getChildren()).map((node) => node.kind), ["searchEmpty"], "无匹配连接时展示空搜索提示");

  const provider = new ConnectionsTreeProvider(store, databaseService);
  const databaseNode = { kind: "database", connection, database: "pg_type_test" };
  const schemaNodes = await provider.getChildren(databaseNode);
  assert.deepEqual(schemaNodes.map((node) => node.kind + ":" + node.schema), ["schema:public", "schema:type_lab"], "PostgreSQL 数据库节点应先按 schema 分层");
  const typeLabTables = await provider.getChildren(schemaNodes[1]);
  assert.equal(typeLabTables.length, 1, "schema 节点下只展示该 schema 的表");
  assert.equal(typeLabTables[0].table, "type_lab.primitive_types", "表节点保留 schema 限定名用于查询");
  assert.equal(typeLabTables[0].displayName, "primitive_types", "表节点展示无 schema 的表名");
  const item = provider.getTreeItem(typeLabTables[0]);
  assert.equal(item.label, "primitive_types", "左侧表名不重复显示 schema 前缀");
  console.log("ok - PostgreSQL schema 分层表树");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
