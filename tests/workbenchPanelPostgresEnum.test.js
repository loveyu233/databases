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

const { DatabaseWorkbenchPanel } = require("../out/workbenchPanel");

function createPanel() {
  return {
    active: true,
    title: "",
    dispose() {},
    onDidChangeViewState() {},
    onDidDispose() {},
    reveal() {},
    webview: {
      cspSource: "vscode-webview:",
      html: "",
      asWebviewUri(uri) {
        return String(uri);
      },
      onDidReceiveMessage() {},
      postMessage() {},
    },
  };
}

function createWorkbench(initialTable) {
  const context = {
    extensionUri: {},
    globalState: { get() {}, update() {} },
    secrets: { delete() {}, get() {}, store() {} },
  };
  const store = { getAll: () => [] };
  return new DatabaseWorkbenchPanel(
    createPanel(),
    context,
    store,
    {},
    { id: "pg", name: "pg", type: "postgres" },
    "db",
    initialTable
  );
}

const createDraft = {
  mode: "createTable",
  table: { name: "devices", comment: "" },
  columns: [
    { name: "id", type: "bigint", notNull: true, autoIncrement: true },
    { name: "status", type: "enum('active','disabled')", notNull: true, defaultValue: "active" },
  ],
  keys: [],
  foreignKeys: [],
  checks: [],
  triggers: [],
};

const createSql = createWorkbench().buildSchemaDraftStatements(createDraft).statements.join("\n");
assert.ok(createSql.includes("CREATE TYPE \"devices_status_enum\" AS ENUM ('active', 'disabled');"), "创建表前应生成 PG enum 类型");
assert.ok(createSql.includes("\"status\" \"devices_status_enum\" NOT NULL DEFAULT 'active'"), "创建表字段应替换为生成的 enum 类型");

const editWorkbench = createWorkbench("devices");
editWorkbench.schema = [{
  name: "devices",
  columns: [{ name: "status", type: "text", nullable: false, defaultValue: "active", comment: "" }],
  indexes: [],
  foreignKeys: [],
  checks: [],
  triggers: [],
}];
const editDraft = {
  mode: "editTable",
  table: { name: "devices", comment: "" },
  columns: [{ name: "status", originalName: "status", type: "enum('active','disabled')", notNull: true, defaultValue: "active", comment: "" }],
  keys: [],
  indexes: [],
  foreignKeys: [],
  checks: [],
  triggers: [],
  deletedItems: { columns: [], keys: [], foreignKeys: [], indexes: [], checks: [], triggers: [] },
  columnOrderMoves: [],
};

const editSql = editWorkbench.buildSchemaDraftStatements(editDraft).statements.join("\n");
assert.ok(editSql.includes("CREATE TYPE \"devices_status_enum\" AS ENUM ('active', 'disabled');"), "修改字段前应生成 PG enum 类型");
assert.ok(editSql.includes("ALTER TABLE \"devices\" ALTER COLUMN \"status\" DROP DEFAULT;"), "修改 enum 类型前应先移除默认值");
assert.ok(editSql.includes("ALTER TABLE \"devices\" ALTER COLUMN \"status\" TYPE \"devices_status_enum\" USING \"status\"::text::\"devices_status_enum\";"), "修改字段应显式转换到生成的 enum 类型");
assert.ok(editSql.includes("ALTER TABLE \"devices\" ALTER COLUMN \"status\" SET DEFAULT 'active';"), "修改 enum 类型后应恢复默认值");

const existingEnumWorkbench = createWorkbench("devices");
existingEnumWorkbench.schema = [{
  name: "devices",
  columns: [{
    name: "status",
    type: "enum('active','disabled')",
    enumTypeName: "devices_status_enum",
    enumValues: ["active", "disabled"],
    nullable: false,
    defaultValue: "active",
    comment: "",
  }],
  indexes: [],
  foreignKeys: [],
  checks: [],
  triggers: [],
}];
const unchangedEnumDraft = {
  mode: "editTable",
  table: { name: "devices", comment: "" },
  columns: [{
    name: "status",
    originalName: "status",
    type: "enum('active','disabled')",
    enumTypeName: "devices_status_enum",
    enumValues: ["active", "disabled"],
    notNull: true,
    defaultValue: "active",
    comment: "",
  }],
  keys: [],
  indexes: [],
  foreignKeys: [],
  checks: [],
  triggers: [],
  deletedItems: { columns: [], keys: [], foreignKeys: [], indexes: [], checks: [], triggers: [] },
  columnOrderMoves: [],
};
assert.equal(existingEnumWorkbench.buildSchemaDraftStatements(unchangedEnumDraft).statements.length, 0, "已有 enum 字段用 enum(...) 展示时不应误判为类型修改");

const addEnumValueDraft = {
  ...unchangedEnumDraft,
  columns: [{
    ...unchangedEnumDraft.columns[0],
    type: "enum('active','disabled','lost')",
  }],
};
const addEnumValueSql = existingEnumWorkbench.buildSchemaDraftStatements(addEnumValueDraft).statements.join("\n");
assert.ok(addEnumValueSql.includes("ALTER TYPE \"devices_status_enum\" ADD VALUE IF NOT EXISTS 'lost';"), "已有 enum 字段追加值时应生成 ALTER TYPE ADD VALUE");
assert.ok(!addEnumValueSql.includes("CREATE TYPE \"devices_status_enum\""), "已有 enum 字段追加值时不应重复 CREATE TYPE");
assert.ok(!addEnumValueSql.includes("ALTER COLUMN \"status\" TYPE"), "已有 enum 字段追加值时不应误改字段类型");

console.log("ok - Workbench PostgreSQL enum 字段 SQL 生成");
