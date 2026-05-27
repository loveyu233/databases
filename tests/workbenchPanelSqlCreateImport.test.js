const assert = require("node:assert/strict");
const Module = require("node:module");
const vm = require("node:vm");

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

function makeClassList() {
  const values = new Set();
  return {
    add(...classes) {
      classes.forEach((item) => values.add(item));
    },
    remove(...classes) {
      classes.forEach((item) => values.delete(item));
    },
    toggle(className, force) {
      const shouldAdd = force === undefined ? !values.has(className) : Boolean(force);
      if (shouldAdd) values.add(className); else values.delete(className);
      return shouldAdd;
    },
    contains(className) {
      return values.has(className);
    },
  };
}

function makeElement(id = "") {
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    title: "",
    disabled: false,
    checked: false,
    className: "",
    type: "",
    rows: 0,
    scrollLeft: 0,
    scrollTop: 0,
    options: [],
    children: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: makeClassList(),
    addEventListener() {},
    removeEventListener() {},
    append(...items) {
      this.children.push(...items);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    prepend(child) {
      this.children.unshift(child);
      return child;
    },
    remove() {},
    setAttribute(name, value) {
      this[name] = String(value);
    },
    getAttribute(name) {
      return this[name] ?? "";
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this, name);
    },
    removeAttribute(name) {
      delete this[name];
    },
    querySelector() {
      return makeElement("child");
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    matches() {
      return false;
    },
    contains() {
      return false;
    },
    focus() {},
    blur() {},
    select() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };
}

function buildWorkbenchHtml() {
  const panel = {
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
  const context = {
    extensionUri: {},
    globalState: { get() {}, update() {} },
    secrets: { delete() {}, get() {}, store() {} },
  };
  new DatabaseWorkbenchPanel(panel, context, { getAll: () => [] }, {}, { id: "mysql", name: "mysql", type: "mysql" }, "db");
  return panel.webview.html;
}

function createWebviewContext(script) {
  const elements = new Map();
  const document = {
    body: makeElement("body"),
    documentElement: makeElement("html"),
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, makeElement(String(selector)));
      return elements.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    createElement: makeElement,
    execCommand() {
      return false;
    },
  };
  const context = {
    document,
    window: null,
    console,
    addEventListener() {},
    removeEventListener() {},
    acquireVsCodeApi() {
      return {
        getState() {
          return {};
        },
        setState() {},
        postMessage() {},
      };
    },
    Blob: class {},
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    URL: { createObjectURL: () => "blob:", revokeObjectURL() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout(callback) {
      if (typeof callback === "function") callback();
      return 1;
    },
    clearTimeout() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context);
  return context;
}

const html = buildWorkbenchHtml();
assert.ok(html.includes('id="sqlCreateTableBtn"'), "添加表弹窗应包含 SQL 建表按钮");
assert.ok(html.includes('id="sqlCreateTableOverlay"'), "添加表弹窗应包含 SQL 建表导入弹窗");

const scriptMatch = html.match(/<script nonce="[^"]*">([\s\S]*)<\/script>/);
assert.ok(scriptMatch, "workbench webview script should exist");
const context = createWebviewContext(scriptMatch[1]);

const mysqlDraft = context.parseCreateTableSqlToDraft(`
CREATE TABLE \`users\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`email\` VARCHAR(128) NOT NULL COMMENT '邮箱',
  \`status\` ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '状态',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_users_email\` (\`email\`),
  KEY \`idx_users_status\` (\`status\`)
) COMMENT='用户表';
`);
assert.equal(mysqlDraft.table.name, "users");
assert.equal(mysqlDraft.table.comment, "用户表");
assert.equal(mysqlDraft.columns.find((column) => column.name === "email").comment, "邮箱");
assert.equal(mysqlDraft.columns.find((column) => column.name === "status").type.toLowerCase(), "enum('active','disabled')");
assert.equal(JSON.stringify(mysqlDraft.keys[0].columns), JSON.stringify(["id"]));
assert.ok(mysqlDraft.indexes.some((index) => index.name === "uk_users_email" && index.unique === true));
assert.ok(mysqlDraft.indexes.some((index) => index.name === "idx_users_status" && index.unique === false));

vm.runInContext('state.connectionType = "postgres"; state.defaultSchema = "type_lab"; state.tables = [];', context);
const pgDraft = context.parseCreateTableSqlToDraft(`
CREATE TYPE "type_lab"."devices_status_enum" AS ENUM ('active', 'disabled');
CREATE TABLE "type_lab"."devices" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "status" "type_lab"."devices_status_enum" NOT NULL DEFAULT 'active',
  CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);
COMMENT ON TABLE "type_lab"."devices" IS '设备表';
COMMENT ON COLUMN "type_lab"."devices"."status" IS '设备状态';
`);
const statusColumn = pgDraft.columns.find((column) => column.name === "status");
assert.equal(pgDraft.table.schema, "type_lab");
assert.equal(pgDraft.table.name, "devices");
assert.equal(pgDraft.table.comment, "设备表");
assert.equal(statusColumn.type, "enum('active','disabled')");
assert.equal(statusColumn.comment, "设备状态");
assert.ok(pgDraft.keys.some((key) => key.name === "devices_pkey" && key.primary === true));

vm.runInContext('state.connectionType = "postgres"; state.defaultSchema = "public"; state.tables = [];', context);
const copiedPgEnumDraft = context.parseCreateTableSqlToDraft(`
CREATE TYPE "mqtt_user_type" AS ENUM ('pen', 'app', 'service');
CREATE TYPE "mqtt_user_status" AS ENUM ('active', 'disabled', 'lost', 'retired');
CREATE TABLE "mqtt_user" (
  "guid" text NOT NULL,
  "user_type" mqtt_user_type DEFAULT 'pen'::mqtt_user_type NOT NULL,
  "status" mqtt_user_status DEFAULT 'active'::mqtt_user_status NOT NULL,
  CONSTRAINT "mqtt_user_pkey" PRIMARY KEY ("guid")
);
`);
const copiedUserTypeColumn = copiedPgEnumDraft.columns.find((column) => column.name === "user_type");
const copiedStatusColumn = copiedPgEnumDraft.columns.find((column) => column.name === "status");
assert.equal(copiedUserTypeColumn.type, "enum('pen','app','service')");
assert.equal(copiedUserTypeColumn.defaultValue, "pen", "导入 PG 复制表结构时应移除旧 enum 类型转换，避免新建表引用不存在的原类型");
assert.equal(copiedStatusColumn.type, "enum('active','disabled','lost','retired')");
assert.equal(copiedStatusColumn.defaultValue, "active");

console.log("ok - Workbench SQL 建表导入弹窗和解析");
