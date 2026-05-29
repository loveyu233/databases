const assert = require("node:assert/strict");
const fs = require("node:fs");

const extensionSource = fs.readFileSync("src/extension.ts", "utf8");
assert.match(
  extensionSource,
  /if \(wasNew\) \{\s*panel\.dispose\(\);\s*\}/,
  "新增连接保存成功后应关闭连接编辑标签页"
);
assert.match(
  extensionSource,
  /已导入 \$\{savedCount\} 个连接[\s\S]+setStatusBarMessage[\s\S]+panel\.dispose\(\);/,
  "批量导入连接成功后应关闭连接编辑标签页"
);
assert.match(
  extensionSource,
  /createResourceStatus[\s\S]+左侧连接树已刷新[\s\S]+setStatusBarMessage[\s\S]+panel\.dispose\(\);/,
  "创建数据库、Topic、索引等资源成功后应关闭创建标签页"
);

const workbenchPanelSource = fs.readFileSync("src/workbenchPanel.ts", "utf8");
assert.match(
  workbenchPanelSource,
  /if \(createMode\) \{\s*this\.panel\.dispose\(\);\s*\}/,
  "新建表成功后应关闭新建表标签页"
);

console.log("ok - 创建类标签页成功后自动关闭");
