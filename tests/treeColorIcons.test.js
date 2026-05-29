const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const treeSource = fs.readFileSync(path.join(__dirname, "../src/tree.ts"), "utf8");
const treeIconDir = path.join(__dirname, "../assets/icons/tree");
const expectedIcons = [
  "group-red.svg",
  "group-orange.svg",
  "group-yellow.svg",
  "group-green.svg",
  "group-blue.svg",
  "group-purple.svg",
  "filter.svg",
  "database.svg",
  "redis-db.svg",
  "index-space.svg",
  "topic-space.svg",
  "subscription-space.svg",
  "key-space.svg",
  "schema.svg",
  "table.svg",
  "collection.svg",
  "index.svg",
  "timeseries-table.svg",
  "topic.svg",
  "subscription.svg",
  "key.svg",
];

for (const icon of expectedIcons) {
  assert.ok(fs.existsSync(path.join(treeIconDir, icon)), `缺少侧边栏彩色图标 ${icon}`);
  assert.ok(treeSource.includes(`"${icon}"`), `tree.ts 未接入侧边栏彩色图标 ${icon}`);
}

assert.ok(treeSource.includes('"assets", "icons", "tree"'));
assert.ok(treeSource.includes("getGroupIcon"));
assert.ok(treeSource.includes("getDatabaseIcon"));
assert.ok(treeSource.includes("getTableIcon"));

console.log("ok - 侧边栏彩色语义图标资源和映射");
