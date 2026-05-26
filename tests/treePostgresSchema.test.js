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
