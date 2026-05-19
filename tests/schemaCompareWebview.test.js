const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/schemaComparePanel.ts"), "utf8");
const scriptMatch = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/);

assert(scriptMatch, "未找到表结构对比 Webview 脚本");

const actualScript = scriptMatch[1]
  .replaceAll("${ALL_TABLES_VALUE}", "__database_workbench_all_tables__")
  .replaceAll("${SCHEMA_COMPARE_INIT_TIMEOUT_MS + 5000}", "35000");

const elements = new Map();
const posts = [];
const timers = [];

function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      textContent: "",
      title: "",
      className: "",
      innerHTML: "",
      value: "",
      disabled: false,
      options: [],
      style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {},
      prepend(child) { this.options.unshift(child); },
      appendChild(child) { this.options.push(child); },
      setAttribute() {},
      getAttribute() { return ""; },
    });
  }
  return elements.get(id);
}

const document = {
  querySelector(selector) {
    return element(selector.startsWith("#") ? selector.slice(1) : selector);
  },
  querySelectorAll() {
    return [];
  },
  createElement(tag) {
    return {
      tag,
      value: "",
      textContent: "",
      classList: { toggle() {}, add() {}, remove() {} },
    };
  },
};

const context = {
  document,
  window: {
    addEventListener() {},
    setTimeout(callback, timeout) {
      timers.push({ callback, timeout });
      return timers.length;
    },
    clearTimeout() {},
  },
  acquireVsCodeApi() {
    return {
      postMessage(message) {
        posts.push(message);
      },
    };
  },
  console,
};

vm.runInNewContext(actualScript, context);

assert.strictEqual(posts.length, 1, "Webview 脚本初始化后只应发送一次 ready 消息");
assert.strictEqual(posts[0].type, "ready", "Webview 脚本初始化后必须发送 ready 消息");
assert.deepStrictEqual(timers.map((item) => item.timeout), [35000], "初始化看门狗时间不符合预期");
assert.strictEqual(typeof context.parseElement, "function", "parseElement 应该可以正常注册");

const check = context.parseElement("CONSTRAINT `chk_name_valid` CHECK (TRIM(`name`) <> '')");
assert.strictEqual(check.kind, "检查", "CHECK 约束应被识别为检查项");

const column = context.parseElement("`title` varchar(128) NOT NULL DEFAULT '' COMMENT '标题'");
assert.strictEqual(column.kind, "字段", "字段定义应被识别为字段项");
assert.strictEqual(column.name, "title", "字段名称解析不正确");

console.log("ok - 表结构对比 Webview 脚本可初始化并发送 ready");
