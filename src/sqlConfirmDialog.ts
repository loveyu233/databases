import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

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
    pre { width: 100%; height: 100%; min-height: 0; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); white-space: pre; font-family: var(--mono); font-size: 12px; line-height: 1.6; overscroll-behavior: contain; }
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
    sql.textContent = formatSql(sql.textContent);
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
