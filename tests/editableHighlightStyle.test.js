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

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(escaped + "\\s*\\{([\\s\\S]*?)\\}"));
  assert.ok(match, `缺少 CSS 选择器：${selector}`);
  return match[1];
}

const sqlTokenReset = cssBlock(".sql-highlight-wrap .sql-highlight-code span");
assert.match(sqlTokenReset, /font-weight:\s*400/);
assert.match(sqlTokenReset, /font-style:\s*normal/);
assert.match(sqlTokenReset, /letter-spacing:\s*inherit/);
assert.match(sqlTokenReset, /padding:\s*0/);
assert.match(sqlTokenReset, /background:\s*transparent/);

const jsonTokenReset = cssBlock(".json-editor-highlight .json-token");
assert.match(jsonTokenReset, /font-weight:\s*400/);
assert.match(jsonTokenReset, /font-style:\s*normal/);
assert.match(jsonTokenReset, /letter-spacing:\s*inherit/);
assert.match(jsonTokenReset, /padding:\s*0/);
assert.match(jsonTokenReset, /background:\s*transparent/);

const jsonEditor = cssBlock(".json-editor-wrap.json-active .cell-editor");
assert.match(jsonEditor, /white-space:\s*pre-wrap/);
assert.match(jsonEditor, /overflow-wrap:\s*anywhere/);
assert.match(jsonEditor, /word-break:\s*break-word/);

const sqlEditor = cssBlock(".editor-sql-highlight textarea");
assert.match(sqlEditor, /white-space:\s*pre-wrap/);
assert.match(sqlEditor, /overflow-wrap:\s*anywhere/);
assert.match(sqlEditor, /word-break:\s*break-word/);

console.log("ok - Editable highlight styles keep caret metrics aligned");
