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

function buildWorkbenchScript() {
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
  new DatabaseWorkbenchPanel(panel, context, { getAll: () => [] }, {}, { id: "pg", name: "pg", type: "postgres" }, "db");
  const match = panel.webview.html.match(/<script nonce="[^"]*">([\s\S]*)<\/script>/);
  assert.ok(match, "workbench webview script should exist");
  return match[1];
}

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
  setTimeout() {
    return 1;
  },
  clearTimeout() {},
};
context.window = context;

vm.runInNewContext(buildWorkbenchScript(), context);

const sql = [
  "CREATE TYPE \"new_table_new_column_5_enum\" AS ENUM ('aaa', 'bbb', 'ccc');",
  "CREATE TABLE \"new_table\" (\"id\" bigint, \"new_column_5\" \"new_table_new_column_5_enum\");",
  "COMMENT ON COLUMN \"new_table\".\"id\" IS '主键 ID';",
].join(" ");
const formatted = context.formatConfirmSqlPreview(sql);

assert.ok(formatted.startsWith("START TRANSACTION;\n\n"), "MySQL 多语句预览应显示事务开始");
assert.ok(formatted.includes(";\n\nCREATE TABLE"), "CREATE TYPE 和 CREATE TABLE 之间应空一行");
assert.ok(formatted.includes(";\n\nCOMMENT"), "CREATE TABLE 和 COMMENT 之间应空一行");
assert.ok(formatted.includes("\n\nCOMMIT;\n\n-- 执行失败时插件会自动 ROLLBACK"), "多语句预览应显示提交和失败回滚提示");

const literalFormatted = context.formatConfirmSqlPreview("SELECT 'aaa; bbb'; SELECT 1;");
assert.ok(literalFormatted.includes("'aaa; bbb';\n\nSELECT"), "字符串后的下一条语句仍应空行分隔");
assert.ok(!literalFormatted.includes("'aaa;\n\n bbb'"), "字符串里的分号不能被当成语句分隔");

const singleFormatted = context.formatConfirmSqlPreview("SELECT 1;");
assert.ok(!singleFormatted.startsWith("START TRANSACTION"), "单条 SQL 预览不应额外显示事务包裹");

vm.runInContext('state.connectionType = "postgres";', context);
const pgFormatted = context.formatConfirmSqlPreview("CREATE TABLE a(id int); COMMENT ON TABLE a IS 'a';");
assert.ok(pgFormatted.startsWith("BEGIN;\n\n"), "PostgreSQL 多语句预览应显示 BEGIN");

console.log("ok - SQL 确认弹窗多语句预览会显示事务包裹");
