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
  Disposable: class { dispose() {} },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  },
  ProgressLocation: { Notification: 15 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: { joinPath: (...parts) => ({ parts }) },
  ViewColumn: { One: 1 },
  env: { clipboard: { writeText: async () => {} } },
  window: {
    createWebviewPanel() {},
    setStatusBarMessage() {},
    showErrorMessage() {},
    showInformationMessage() {},
    showWarningMessage() {},
    withProgress(_options, task) {
      return task();
    },
  },
  workspace: {
    getConfiguration() {
      return {
        get(_key, fallback) {
          return fallback;
        },
        update() {},
      };
    },
  },
};

const { buildFieldValueConditionSql, buildRelationQuerySql } = require("../out/workbenchPanel");

assert.equal(
  buildFieldValueConditionSql("mysql", "status", ["active", "disabled", "active"]),
  "`status` IN ('active', 'disabled')"
);
assert.equal(
  buildFieldValueConditionSql("postgres", "user_id", [1, 2, 2, null]),
  "(\"user_id\" IN (1, 2) OR \"user_id\" IS NULL)"
);
assert.equal(
  buildFieldValueConditionSql("mongodb", "_id", ["64f000000000000000000001", "64f000000000000000000002"]),
  '{ "_id": { "$in": [ObjectId("64f000000000000000000001"), ObjectId("64f000000000000000000002")] } }'
);
assert.equal(
  buildFieldValueConditionSql("mongodb", "status", ["active", null]),
  '{ "$or": [{ "status": "active" }, { "status": null }] }'
);

const mysqlSql = buildRelationQuerySql("mysql", "users", "id", "orders", "user_id", [1, 2, 2, null]);
assert.equal(mysqlSql, [
  "SELECT *",
  "FROM `orders`",
  "WHERE (`user_id` IN (1, 2) OR `user_id` IS NULL);",
].join("\n"));

const pgSql = buildRelationQuerySql("postgres", "tenant.users", "dept_id", "tenant.departments", "id", ["a", "b'c"]);
assert.equal(pgSql, [
  "SELECT *",
  "FROM \"tenant\".\"departments\"",
  "WHERE \"id\" IN ('a', 'b''c');",
].join("\n"));

const mongoSql = buildRelationQuerySql("mongodb", "orders", "user_id", "users", "_id", ["64f000000000000000000001"]);
assert.equal(mongoSql, 'db.getCollection("users").find({ "_id": ObjectId("64f000000000000000000001") }).limit(30);');

assert.throws(
  () => buildRelationQuerySql("postgres", "users", "id", "orders", "user_id", []),
  /选中行里没有可用于关联查询的字段值/
);

console.log("ok - Workbench 表格关联查询和快速条件查询 SQL 生成");
