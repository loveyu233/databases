const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {};
  }
  return originalLoad.apply(this, arguments);
};

const { renderWorkbenchHtml } = require("../out/workbench/webviewHtml");

const html = renderWorkbenchHtml({ cspSource: "vscode-webview:" });

assert.match(html, /\.copyable-cell\s*\{/);
assert.match(html, /const copyable = !editable;/);
assert.match(html, /cell\.addEventListener\("dblclick", \(\) => handleDataCellDblClick\(cell\)\)/);
assert.match(html, /function handleDataCellDblClick\(cell\)/);
assert.match(html, /if \(canEditColumn\(column, row\)\) \{\s*startCellEdit\(cell\);\s*return;\s*\}/);
assert.match(html, /copyReadonlyCellValue\(column, row\);/);
assert.match(html, /successMessage: "单元格内容已复制"/);
assert.doesNotMatch(html, /querySelectorAll\("\\.copyable-cell"\)\.forEach/);

console.log("ok - Readonly data cells double click copy their displayed value");
