const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const packageJson = require("../package.json");
const packageText = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
const extensionSource = fs.readFileSync(path.join(repoRoot, "src/extension.ts"), "utf8");
const workbenchSource = fs.readFileSync(path.join(repoRoot, "src/workbenchPanel.ts"), "utf8");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

const removedCommands = [
  "databaseWorkbench.showMachineCode",
  "databaseWorkbench.activatePro",
  "databaseWorkbench.deactivateProForTesting",
  "databaseWorkbench.showProStatus",
];

for (const command of removedCommands) {
  assert.ok(
    !packageJson.activationEvents.some((event) => event.includes(command)),
    `activationEvents 不应再注册授权命令 ${command}`
  );
  assert.ok(
    !packageJson.contributes.commands.some((item) => item.command === command),
    `contributes.commands 不应再暴露授权命令 ${command}`
  );
  assert.ok(!extensionSource.includes(command), `extension.ts 不应再引用授权命令 ${command}`);
}

const configurationKeys = Object.keys(packageJson.contributes.configuration.properties);
assert.ok(
  !configurationKeys.some((key) => key.startsWith("databaseWorkbench.pro.")),
  "设置项中不应再包含 databaseWorkbench.pro.*"
);
assert.equal(packageJson.pricing, "Free", "扩展市场定价应标记为免费");
assert.ok(!fs.existsSync(path.join(repoRoot, "src/license/offlineLicense.ts")), "离线授权源码应删除");
assert.ok(!fs.existsSync(path.join(repoRoot, "tools/generate-license.js")), "授权生成工具应删除");
assert.ok(!extensionSource.includes("offlineLicense"), "extension.ts 不应再导入离线授权模块");
assert.ok(!workbenchSource.includes("requireProFeature"), "workbenchPanel.ts 不应再要求 Pro 功能");
assert.ok(!workbenchSource.includes("hasProFeature"), "workbenchPanel.ts 不应再检查 Pro 功能");
assert.ok(!/\\bPro\\b|机器码|许可证|付费|付款/.test(packageText), "package.json 不应再包含 Pro 或授权文案");
assert.ok(!/\\bPro\\b|机器码|许可证|付费|付款/.test(readme), "README 不应再包含 Pro 或授权文案");

console.log("ok - 全部功能默认免费且无激活限制");
