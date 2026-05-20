import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { getSqlConfirmFontSize } from "./types";

export type SqlConfirmOptions = {
  title: string;
  sql: string;
  confirmLabel?: string;
};

export function showSqlConfirmDialog(options: SqlConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      "databaseWorkbench.sqlConfirm",
      "确认执行 SQL",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
      panel.dispose();
    };

    panel.webview.html = renderSqlConfirmHtml(options);
    panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === "confirm") finish(true);
      if (message.type === "cancel") finish(false);
    });
    panel.onDidDispose(() => finish(false));
  });
}

function renderSqlConfirmHtml(options: SqlConfirmOptions): string {
  const nonce = randomUUID();
  const title = escapeHtml(options.title || "确认执行 SQL");
  const sql = escapeHtml(options.sql || "");
  const confirmLabel = escapeHtml(options.confirmLabel || "确认执行");
  const sqlConfirmFontSize = getSqlConfirmFontSize();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border); --card: var(--vscode-sideBar-background); --button: var(--vscode-button-background); --button-fg: var(--vscode-button-foreground); --button-hover: var(--vscode-button-hoverBackground); --secondary: var(--vscode-button-secondaryBackground); --secondary-fg: var(--vscode-button-secondaryForeground); --mono: var(--vscode-editor-font-family); }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); }
    .overlay { height: 100vh; display: flex; align-items: center; justify-content: center; padding: clamp(12px, 3vw, 30px); background: rgba(0,0,0,.30); overflow: hidden; }
    .card { width: min(1040px, calc(100vw - clamp(24px, 6vw, 60px))); max-width: calc(100vw - clamp(24px, 6vw, 60px)); height: min(76vh, calc(100vh - clamp(24px, 6vw, 60px))); min-height: min(360px, calc(100vh - clamp(24px, 6vw, 60px))); max-height: calc(100vh - clamp(24px, 6vw, 60px)); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: var(--card); box-shadow: 0 24px 70px rgba(0,0,0,.48); }
    .head { padding: 14px 16px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,255,255,.035), transparent); }
    .title { font-weight: 700; color: var(--fg); }
    .subtitle { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .body { min-height: 0; padding: 14px 16px; overflow: hidden; }
    pre { width: 100%; height: 100%; min-height: 0; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); white-space: pre; font-family: var(--mono); font-size: ${sqlConfirmFontSize}px; line-height: 1.6; overscroll-behavior: contain; }
    pre .sql-token-keyword { color: #7dd3fc; font-weight: 700; }
    pre .sql-token-string { color: #f9a8d4; }
    pre .sql-token-number { color: #fbbf24; }
    pre .sql-token-comment { color: var(--muted); font-style: italic; }
    pre .sql-token-field { color: #c4b5fd; }
    pre .sql-token-table { font-weight: 750; border-radius: 4px; padding: 0 2px; }
    pre .sql-token-table-0, pre .sql-token-field-0 { color: #34d399; }
    pre .sql-token-table-1, pre .sql-token-field-1 { color: #60a5fa; }
    pre .sql-token-table-2, pre .sql-token-field-2 { color: #f472b6; }
    pre .sql-token-table-3, pre .sql-token-field-3 { color: #fbbf24; }
    pre .sql-token-table-4, pre .sql-token-field-4 { color: #a78bfa; }
    pre .sql-token-table-5, pre .sql-token-field-5 { color: #fb7185; }
    pre .sql-token-table-6, pre .sql-token-field-6 { color: #2dd4bf; }
    pre .sql-token-table-7, pre .sql-token-field-7 { color: #c084fc; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: rgba(255,255,255,.015); }
    button { border: 0; border-radius: 8px; padding: 7px 14px; cursor: pointer; color: var(--button-fg); background: var(--button); }
    button:hover { background: var(--button-hover); }
    button.secondary { color: var(--secondary-fg); background: var(--secondary); }
  </style>
</head>
<body>
  <div class="overlay">
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="title">
      <div class="head">
        <div class="title" id="title">${title}</div>
        <div class="subtitle">请检查即将执行的 SQL，内容较长时可以在下方区域滚动查看。</div>
      </div>
      <div class="body"><pre id="sql">${sql}</pre></div>
      <div class="actions">
        <button class="secondary" id="cancel">取消</button>
        <button id="confirm">${confirmLabel}</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function formatSql(sql) {
      return String(sql || "")
        .replace(/\\r\\n/g, "\\n")
        .replace(/;\\s*/g, ";\\n")
        .replace(/\\b(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|SELECT|FROM|WHERE|SET|VALUES|ADD|MODIFY|CHANGE|RENAME|CONSTRAINT|PRIMARY KEY|FOREIGN KEY|REFERENCES|DEFAULT|COMMENT|LIMIT)\\b/gi, (match) => match.toUpperCase())
        .trim();
    }
    const sql = document.getElementById("sql");
    sql.innerHTML = renderHighlightedConfirmSql(formatSql(sql.textContent));
    function renderHighlightedConfirmSql(sqlText) {
      const tokens = tokenizeConfirmSql(sqlText);
      const tableStyles = collectConfirmSqlTableStyles(tokens);
      let html = "";
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type === "space" || token.type === "symbol") {
          html += escapeHtml(token.value);
          continue;
        }
        const normalized = normalizeSqlIdentifier(token.value);
        const upper = normalized.toUpperCase();
        if (token.type === "comment") html += wrapConfirmSqlToken(token.value, "sql-token-comment");
        else if (token.type === "string") html += wrapConfirmSqlToken(token.value, "sql-token-string");
        else if (token.type === "number") html += wrapConfirmSqlToken(token.value, "sql-token-number");
        else if (isConfirmSqlKeyword(upper)) html += wrapConfirmSqlToken(token.value, "sql-token-keyword");
        else if (tableStyles.has(normalized.toLowerCase())) html += wrapConfirmSqlToken(token.value, "sql-token-table " + tableStyles.get(normalized.toLowerCase()));
        else if (token.type === "identifier" || token.type === "word") {
          const ownerStyle = getConfirmSqlFieldOwnerStyle(tokens, index, tableStyles);
          html += wrapConfirmSqlToken(token.value, ownerStyle ? "sql-token-field " + ownerStyle.replace("sql-token-table", "sql-token-field") : "sql-token-field");
        } else html += escapeHtml(token.value);
      }
      return html;
    }
    function wrapConfirmSqlToken(value, className) {
      return '<span class="' + className + '">' + escapeHtml(value) + '</span>';
    }
    function tokenizeConfirmSql(sqlText) {
      const text = String(sqlText || "");
      const tokens = [];
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (/\\s/.test(char)) {
          let value = char;
          while (index + 1 < text.length && /\\s/.test(text[index + 1])) value += text[++index];
          tokens.push({ type: "space", value });
        } else if (char === "-" && text[index + 1] === "-") {
          let value = char + text[++index];
          while (index + 1 < text.length && text[index + 1] !== "\\n") value += text[++index];
          tokens.push({ type: "comment", value });
        } else if (char === "/" && text[index + 1] === "*") {
          let value = char + text[++index];
          while (index + 1 < text.length) {
            const next = text[++index];
            value += next;
            if (next === "/" && text[index - 1] === "*") break;
          }
          tokens.push({ type: "comment", value });
        } else if (char === "'") {
          let value = char;
          while (index + 1 < text.length) {
            const next = text[++index];
            value += next;
            if (next === "\\\\" && index + 1 < text.length) value += text[++index];
            else if (next === "'" && text[index + 1] === "'") value += text[++index];
            else if (next === "'") break;
          }
          tokens.push({ type: "string", value });
        } else if (char === '"' || char === String.fromCharCode(96)) {
          const quote = char;
          let value = char;
          while (index + 1 < text.length) {
            const next = text[++index];
            value += next;
            if (next === quote) break;
          }
          tokens.push({ type: "identifier", value });
        } else if (/[0-9]/.test(char)) {
          let value = char;
          while (index + 1 < text.length && /[0-9.]/.test(text[index + 1])) value += text[++index];
          tokens.push({ type: "number", value });
        } else if (isSqlIdentifierStart(char)) {
          let value = char;
          while (index + 1 < text.length && isSqlIdentifierPart(text[index + 1])) value += text[++index];
          tokens.push({ type: "word", value });
        } else {
          tokens.push({ type: "symbol", value: char });
        }
      }
      return tokens;
    }
    function collectConfirmSqlTableStyles(tokens) {
      const tableStyles = new Map();
      const names = [];
      const significant = tokens.map((token, index) => ({ token, index })).filter((item) => item.token.type !== "space" && item.token.type !== "comment");
      const addTable = (name) => {
        const normalized = normalizeSqlIdentifier(name).toLowerCase();
        if (!normalized || isConfirmSqlKeyword(normalized.toUpperCase())) return "";
        if (tableStyles.has(normalized)) return tableStyles.get(normalized);
        const style = "sql-token-table-" + (names.length % 8);
        tableStyles.set(normalized, style);
        names.push(normalized);
        return style;
      };
      let expectTable = false;
      let inFromList = false;
      for (let pos = 0; pos < significant.length; pos += 1) {
        const current = significant[pos].token;
        const upper = normalizeSqlIdentifier(current.value).toUpperCase();
        if (inFromList && isSqlClauseBoundary(upper)) inFromList = false;
        if (["FROM", "JOIN", "UPDATE", "INTO"].includes(upper) || (upper === "TABLE" && shouldSqlTableKeywordExpectName(significant, pos))) {
          expectTable = true;
          inFromList = upper === "FROM";
          continue;
        }
        if (expectTable && isSqlNameToken(current)) {
          const qualified = readQualifiedSqlName(significant, pos);
          const style = addTable(qualified.name);
          addConfirmSqlAliasStyle(significant, qualified.endPos + 1, style, tableStyles);
          pos = qualified.endPos;
          expectTable = false;
          continue;
        }
        if (inFromList && current.value === ",") expectTable = true;
      }
      return tableStyles;
    }
    function addConfirmSqlAliasStyle(significant, pos, style, tableStyles) {
      if (!style || pos >= significant.length) return;
      let aliasPos = pos;
      const maybeAs = normalizeSqlIdentifier(significant[aliasPos]?.token?.value || "").toUpperCase();
      if (maybeAs === "AS") aliasPos += 1;
      const alias = significant[aliasPos]?.token;
      const aliasName = normalizeSqlIdentifier(alias?.value || "");
      const aliasUpper = aliasName.toUpperCase();
      if (!isSqlNameToken(alias) || isConfirmSqlKeyword(aliasUpper) || isSqlClauseBoundary(aliasUpper)) return;
      tableStyles.set(aliasName.toLowerCase(), style);
    }

    function getConfirmSqlFieldOwnerStyle(tokens, index, tableStyles) {
      const prevDot = findSignificantSqlToken(tokens, index, -1);
      if (!prevDot || prevDot.value !== ".") return "";
      const owner = findSignificantSqlToken(tokens, prevDot.index, -1);
      return owner ? tableStyles.get(normalizeSqlIdentifier(owner.value).toLowerCase()) || "" : "";
    }
    function readQualifiedSqlName(significant, pos) {
      let name = significant[pos].token.value;
      let endPos = pos;
      while (endPos + 2 < significant.length && significant[endPos + 1].token.value === "." && isSqlNameToken(significant[endPos + 2].token)) {
        endPos += 2;
        name = significant[endPos].token.value;
      }
      return { name, endPos };
    }
    function shouldSqlTableKeywordExpectName(significant, pos) {
      const upper = normalizeSqlIdentifier(significant[pos - 1]?.token?.value || "").toUpperCase();
      return ["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "DESCRIBE", "DESC"].includes(upper);
    }
    function findSignificantSqlToken(tokens, start, direction) {
      for (let index = start + direction; index >= 0 && index < tokens.length; index += direction) {
        if (tokens[index].type !== "space" && tokens[index].type !== "comment") return { ...tokens[index], index };
      }
      return null;
    }
    function isSqlClauseBoundary(upper) {
      return ["WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "SET", "VALUES", "RETURNING", "ON", "USING"].includes(upper);
    }
    function isSqlNameToken(token) {
      return token && (token.type === "word" || token.type === "identifier");
    }
    function normalizeSqlIdentifier(value) {
      const text = String(value || "").trim();
      if ((text.startsWith(String.fromCharCode(96)) && text.endsWith(String.fromCharCode(96))) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
      return text;
    }
    function isSqlIdentifierStart(char) {
      return /[A-Za-z_$]/.test(char) || char.charCodeAt(0) > 127;
    }
    function isSqlIdentifierPart(char) {
      return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 127;
    }
    function isConfirmSqlKeyword(upper) {
      return ["ADD","AFTER","ALTER","AND","AS","ASC","BEGIN","BETWEEN","BY","CASCADE","CASE","CHANGE","CHECK","COLLATE","COLUMN","COMMENT","COMMIT","CONSTRAINT","CREATE","DATABASE","DEFAULT","DELETE","DESC","DISTINCT","DROP","ELSE","END","ENGINE","EXISTS","FOREIGN","FROM","GROUP","HAVING","IF","IN","INDEX","INNER","INSERT","INTO","IS","JOIN","KEY","LEFT","LIKE","LIMIT","MODIFY","NOT","NULL","ON","OR","ORDER","OUTER","PRIMARY","REFERENCES","RENAME","RETURNING","RIGHT","SELECT","SET","TABLE","THEN","TO","TRUNCATE","UNION","UNIQUE","UPDATE","USING","VALUES","WHEN","WHERE"].includes(upper);
    }
    function escapeHtml(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
    document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    document.getElementById("confirm").addEventListener("click", () => vscode.postMessage({ type: "confirm" }));
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
