const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseEtcdCommand } = require("../out/database/clients/etcd");
const packageJson = require("../package.json");

assert.deepEqual(parseEtcdCommand("SHOW KEYS", 30), {
  kind: "showKeys",
  prefix: "",
  limit: 30,
});

assert.deepEqual(parseEtcdCommand('SHOW KEYS PREFIX "/config/app/" LIMIT 20', 30), {
  kind: "showKeys",
  prefix: "/config/app/",
  limit: 20,
});

assert.deepEqual(parseEtcdCommand("PREFIX /services/ LIMIT 5", 30), {
  kind: "prefix",
  prefix: "/services/",
  limit: 5,
});

assert.deepEqual(parseEtcdCommand("SCAN /feature/ LIMIT 7", 30), {
  kind: "prefix",
  prefix: "/feature/",
  limit: 7,
});

assert.deepEqual(parseEtcdCommand('GET "/config/app name"', 30), {
  kind: "get",
  key: "/config/app name",
});

assert.deepEqual(parseEtcdCommand('PUT /config/app VALUE {"enabled":true}', 30), {
  kind: "put",
  key: "/config/app",
  value: '{"enabled":true}',
});

assert.deepEqual(parseEtcdCommand('SET "/config/app name" = "hello world"', 30), {
  kind: "put",
  key: "/config/app name",
  value: "hello world",
});

assert.deepEqual(parseEtcdCommand("DELETE /config/app;", 30), {
  kind: "delete",
  key: "/config/app",
});

assert.deepEqual(parseEtcdCommand("DELETE_PREFIX /config/", 30), {
  kind: "deletePrefix",
  prefix: "/config/",
});

assert.throws(() => parseEtcdCommand(""), /请输入 ETCD 命令/);
assert.throws(() => parseEtcdCommand("PUT /config/app"), /PUT 命令需要 VALUE/);

assert.equal(packageJson.dependencies.etcd3, "^1.1.2");
assert.ok(packageJson.description.includes("ETCD"));
assert.ok(packageJson.keywords.includes("etcd"));

const menuItems = packageJson.contributes.menus["view/item/context"];
assert.ok(menuItems.some((item) => item.command === "databaseWorkbench.createResource" && item.when.includes("connection\\.(mysql|postgres|elasticsearch|mongodb|tdengine|kafka|etcd)")));
assert.ok(menuItems.some((item) => item.command === "databaseWorkbench.createResource" && item.when.includes("database\\.etcd")));
assert.ok(menuItems.some((item) => item.command === "databaseWorkbench.openQueryConsole" && item.when.includes("etcd")));
assert.ok(menuItems.some((item) => item.command === "databaseWorkbench.deleteTable" && item.when.includes("etcd")));

const treeSource = fs.readFileSync(path.join(__dirname, "../src/tree.ts"), "utf8");
for (const icon of ["mysql.svg", "postgres.svg", "redis.svg", "elasticsearch.svg", "mongodb.svg", "tdengine.svg", "kafka.svg", "mqtt.svg", "etcd.svg"]) {
  assert.ok(treeSource.includes(`"${icon}"`), `连接图标映射缺少 ${icon}`);
}
assert.ok(treeSource.includes('"assets", "icons"'));
assert.ok(treeSource.includes('scope: "key"'));
assert.ok(treeSource.includes('node.connection.type === "etcd" ? "查看 Key 信息"'));
assert.ok(treeSource.includes('type === "etcd" ? "ETCD" : type'));

const extensionSource = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
assert.ok(extensionSource.includes('<option value="etcd">ETCD</option>'));
assert.ok(extensionSource.includes('etcd: { port: 2379'));
assert.ok(extensionSource.includes("PUT ${quoteEtcdToken(name)} VALUE ${quoteEtcdValue(value)};"));
assert.ok(extensionSource.includes("DELETE ${quoteEtcdToken(node.table)};"));

const webviewSource = fs.readFileSync(path.join(__dirname, "../src/workbench/webviewHtml.ts"), "utf8");
assert.ok(webviewSource.includes("const etcdKeywords"));
assert.ok(webviewSource.includes("buildEtcdCompletionItems"));
assert.ok(webviewSource.includes('state.connectionType === "etcd"'));
assert.ok(webviewSource.includes("执行 ETCD 命令"));

console.log("ok - etcd command parsing, menus, and icon wiring");
