import { createDecipheriv, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { testAiConnection } from "./ai";
import { DatabaseService } from "./database/clients";
import { registerOfflineLicenseCommands, requireProFeature } from "./license/offlineLicense";
import { SchemaComparePanel } from "./schemaComparePanel";
import { showSqlConfirmDialog } from "./sqlConfirmDialog";
import { ConnectionStore, normalizeConnectionGroupColor } from "./storage";
import { ActiveTreeSelection, asConnectionNode, asDatabaseFilterNode, asDatabaseNode, asGroupNode, asSchemaNode, asTableNode, ConnectionGroupDecorationProvider, ConnectionsTreeProvider, getTreeNodePinKey, TreeNode } from "./tree";
import { AI_PROVIDER_PRESETS, ConnectionGroup, ConnectionGroupColor, DatabaseType, DbConnectionConfig, getAiConfig, getAiProviderPreset } from "./types";
import { DatabaseWorkbenchPanel } from "./workbenchPanel";

let outputChannel: vscode.OutputChannel | undefined;
const createResourcePanels = new Map<string, vscode.WebviewPanel>();
const connectionEditorPanels = new Map<string, vscode.WebviewPanel>();
const connectionExportPanels = new Map<string, vscode.WebviewPanel>();
const GROUP_COLOR_OPTIONS: Array<{ color: ConnectionGroupColor; label: string }> = [
  { color: "red", label: "红色" },
  { color: "orange", label: "橙色" },
  { color: "yellow", label: "黄色" },
  { color: "green", label: "绿色" },
  { color: "blue", label: "蓝色" },
  { color: "purple", label: "紫色" },
];

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Database Workbench");
  outputChannel.appendLine("Database Workbench 已激活。");

  const store = new ConnectionStore(context);
  const databaseService = new DatabaseService();
  const treeProvider = new ConnectionsTreeProvider(store, databaseService);
  const groupDecorationProvider = new ConnectionGroupDecorationProvider();
  const connectionsTreeView = vscode.window.createTreeView("databaseWorkbench.connections", {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
  });

  context.subscriptions.push(
    outputChannel,
    ...registerOfflineLicenseCommands(context),
    connectionsTreeView,
    vscode.window.registerFileDecorationProvider(groupDecorationProvider),
    DatabaseWorkbenchPanel.onDidChangeActiveTreeSelection((selection) => {
      void revealActiveTreeSelection(connectionsTreeView, treeProvider, selection);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("databaseWorkbench.table")) {
        DatabaseWorkbenchPanel.refreshTableDisplayConfig();
      }
    }),
    vscode.commands.registerCommand("databaseWorkbench.refresh", () => treeProvider.refresh()),
    vscode.commands.registerCommand("databaseWorkbench.refreshNode", (node) => runSafely("刷新失败", async () => {
      await refreshTreeNode(context, store, databaseService, treeProvider, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.showAddMenu", () => runSafely("打开添加菜单失败", async () => {
      await showAddMenu(context, store, databaseService, treeProvider, groupDecorationProvider);
    })),
    vscode.commands.registerCommand("databaseWorkbench.exportConnections", () => runSafely("导出连接失败", async () => {
      await openConnectionsExportPanel(context, store);
    })),
    vscode.commands.registerCommand("databaseWorkbench.addConnection", (node) => runSafely("添加连接失败", async () => {
      await openConnectionEditor(context, store, databaseService, undefined, asGroupNode(node)?.group.id);
    })),
    vscode.commands.registerCommand("databaseWorkbench.addConnectionToGroup", (node) => runSafely("添加分组连接失败", async () => {
      const group = asGroupNode(node)?.group;
      if (!group) {
        throw new Error("没有拿到分组信息，请刷新左侧连接树后重试。");
      }
      await openConnectionEditor(context, store, databaseService, undefined, group.id);
    })),
    vscode.commands.registerCommand("databaseWorkbench.pinNode", (node) => runSafely("置顶失败", async () => {
      await pinTreeNode(store, treeProvider, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.unpinNode", (node) => runSafely("取消置顶失败", async () => {
      await unpinTreeNode(store, treeProvider, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.addGroup", () => runSafely("添加分组失败", async () => {
      await addGroup(store, treeProvider, groupDecorationProvider);
    })),
    vscode.commands.registerCommand("databaseWorkbench.renameGroup", (node) => runSafely("修改分组名称失败", async () => {
      await renameGroup(store, treeProvider, asGroupNode(node)?.group);
    })),
    vscode.commands.registerCommand("databaseWorkbench.changeGroupColor", (node) => runSafely("修改分组颜色失败", async () => {
      await changeGroupColor(store, treeProvider, groupDecorationProvider, asGroupNode(node)?.group);
    })),
    vscode.commands.registerCommand("databaseWorkbench.deleteGroup", (node) => runSafely("删除分组失败", async () => {
      await deleteGroup(store, treeProvider, asGroupNode(node)?.group);
    })),
    vscode.commands.registerCommand("databaseWorkbench.editConnection", (node) => runSafely("编辑连接失败", async () => {
      await editConnection(context, store, databaseService, asConnectionNode(node)?.connection);
    })),
    vscode.commands.registerCommand("databaseWorkbench.deleteConnection", (node) => runSafely("删除连接失败", async () => {
      await deleteConnection(store, asConnectionNode(node)?.connection);
      treeProvider.refresh();
    })),
    vscode.commands.registerCommand("databaseWorkbench.testConnection", (node) => runSafely("测试连接失败", async () => {
      await testConnection(store, databaseService, asConnectionNode(node)?.connection);
    })),
    vscode.commands.registerCommand("databaseWorkbench.configureAi", () => runSafely("配置 AI 失败", async () => {
      if (!await requireProFeature(context, "ai", "AI 配置")) return;
      await configureAi();
    })),
    vscode.commands.registerCommand("databaseWorkbench.testAiConfig", () => runSafely("测试 AI 配置失败", async () => {
      if (!await requireProFeature(context, "ai", "AI 配置测试")) return;
      await testAiConfiguration();
    })),
    vscode.commands.registerCommand("databaseWorkbench.filterDatabases", (node) => runSafely("筛选显示数据库失败", async () => {
      await filterDatabases(store, databaseService, node);
      treeProvider.refresh();
    })),
    vscode.commands.registerCommand("databaseWorkbench.createResource", (node) => runSafely("打开创建页面失败", async () => {
      await openCreateResourcePanel(context, store, databaseService, asConnectionNode(node)?.connection);
    })),
    vscode.commands.registerCommand("databaseWorkbench.openTable", (node) => runSafely("打开表失败", async () => {
      await openTable(context, store, databaseService, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.openDatabase", (node) => runSafely("打开数据库失败", async () => {
      await openDatabase(context, store, databaseService, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.editDatabase", (node) => runSafely("修改数据库失败", async () => {
      await editDatabase(store, databaseService, asDatabaseNode(node));
      treeProvider.refresh();
    })),
    vscode.commands.registerCommand("databaseWorkbench.deleteDatabase", (node) => runSafely("删除数据库失败", async () => {
      await deleteDatabase(store, databaseService, asDatabaseNode(node));
      treeProvider.refresh();
    })),
    vscode.commands.registerCommand("databaseWorkbench.addTable", (node) => runSafely("添加表失败", async () => {
      await addTable(context, store, databaseService, node);
      treeProvider.refresh(asSchemaNode(node) ?? asDatabaseNode(node) ?? undefined);
    })),
    vscode.commands.registerCommand("databaseWorkbench.copyDatabaseSchema", (node) => runSafely("复制表结构失败", async () => {
      await copyDatabaseSchema(store, databaseService, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.openQueryConsole", (node) => runSafely("打开查询控制台失败", async () => {
      await openQueryConsole(context, store, databaseService, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.compareSchema", (node) => runSafely("打开表结构对比失败", async () => {
      await compareSchema(context, store, databaseService, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.editTable", (node) => runSafely("修改表结构失败", async () => {
      await editTable(context, store, databaseService, node);
    })),
    vscode.commands.registerCommand("databaseWorkbench.deleteTable", (node) => runSafely("删除表失败", async () => {
      await deleteTable(store, databaseService, asTableNode(node));
      treeProvider.refresh();
    }))
  );
}

export function deactivate(): void {}

async function revealActiveTreeSelection(
  treeView: vscode.TreeView<TreeNode>,
  treeProvider: ConnectionsTreeProvider,
  selection: ActiveTreeSelection | undefined
): Promise<void> {
  if (!selection) {
    return;
  }
  const node = treeProvider.resolveActiveSelectionNode(selection);
  if (!node) {
    return;
  }

  try {
    await treeView.reveal(node, {
      expand: selection.kind === "table",
      focus: false,
      select: true,
    });
  } catch {
    // The node may be filtered out or unavailable while its parent is refreshing.
  }
}

async function refreshTreeNode(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  treeProvider: ConnectionsTreeProvider,
  node: unknown
): Promise<void> {
  const tableNode = asTableNode(node);
  if (tableNode) {
    await DatabaseWorkbenchPanel.refreshTableData(context, store, databaseService, tableNode.connection, tableNode.database, tableNode.table);
    vscode.window.setStatusBarMessage(`Database Workbench: 已刷新 ${tableNode.table} 表数据。`, 2000);
    return;
  }

  const databaseNode = asDatabaseNode(node);
  if (databaseNode) {
    treeProvider.refresh(databaseNode);
    await DatabaseWorkbenchPanel.refreshOpenDatabase(databaseNode.connection.id, databaseNode.database);
    vscode.window.setStatusBarMessage(`Database Workbench: 已刷新 ${databaseNode.database}。`, 2000);
    return;
  }

  const schemaNode = asSchemaNode(node);
  if (schemaNode) {
    treeProvider.refresh(schemaNode);
    await DatabaseWorkbenchPanel.refreshOpenDatabase(schemaNode.connection.id, schemaNode.database);
    vscode.window.setStatusBarMessage(`Database Workbench: 已刷新 ${schemaNode.database}.${schemaNode.schema}。`, 2000);
    return;
  }

  const connectionNode = asConnectionNode(node);
  if (connectionNode) {
    treeProvider.refresh(connectionNode);
    await DatabaseWorkbenchPanel.refreshOpenConnection(connectionNode.connection.id);
    vscode.window.setStatusBarMessage(`Database Workbench: 已刷新 ${connectionNode.connection.name}。`, 2000);
    return;
  }

  treeProvider.refresh();
  vscode.window.setStatusBarMessage("Database Workbench: 已刷新连接树。", 2000);
}

async function showAddMenu(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  treeProvider: ConnectionsTreeProvider,
  groupDecorationProvider: ConnectionGroupDecorationProvider
): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(folder) 添加分组",
        description: "例如 dev、prod、local、阿里云、腾讯云",
        action: "group" as const,
      },
      {
        label: "$(database) 添加数据库连接",
        description: "MySQL / PostgreSQL / Redis / Elasticsearch",
        action: "connection" as const,
      },
    ],
    { placeHolder: "选择要添加的内容" }
  );
  if (!picked) {
    return;
  }

  if (picked.action === "group") {
    await addGroup(store, treeProvider, groupDecorationProvider);
    return;
  }

  await openConnectionEditor(context, store, databaseService);
}

async function addGroup(
  store: ConnectionStore,
  treeProvider: ConnectionsTreeProvider,
  groupDecorationProvider: ConnectionGroupDecorationProvider
): Promise<void> {
  const name = await promptText(
    "添加连接分组",
    "",
    false,
    (value) => validateGroupName(store, value)
  );
  if (!name) {
    return;
  }

  const color = await pickGroupColor("选择分组文字颜色", "blue");
  if (!color) {
    return;
  }

  const group: ConnectionGroup = {
    id: randomUUID(),
    name: name.trim(),
    color,
  };
  await store.saveGroup(group);
  treeProvider.refresh();
  groupDecorationProvider.refresh(group);
  vscode.window.setStatusBarMessage(`Database Workbench: 已创建分组 ${group.name}。`, 2500);
}

async function renameGroup(
  store: ConnectionStore,
  treeProvider: ConnectionsTreeProvider,
  existing?: ConnectionGroup
): Promise<void> {
  const group = existing ?? await pickGroup(store, "选择要修改名称的分组");
  if (!group) {
    return;
  }

  const name = await promptText(
    `修改分组名称：${group.name}`,
    group.name,
    false,
    (value) => validateGroupName(store, value, group.id)
  );
  if (!name || name.trim() === group.name) {
    return;
  }

  await store.saveGroup({ ...group, name: name.trim() });
  treeProvider.refresh();
  vscode.window.setStatusBarMessage(`Database Workbench: 分组已改名为 ${name.trim()}。`, 2500);
}

async function changeGroupColor(
  store: ConnectionStore,
  treeProvider: ConnectionsTreeProvider,
  groupDecorationProvider: ConnectionGroupDecorationProvider,
  existing?: ConnectionGroup
): Promise<void> {
  const group = existing ?? await pickGroup(store, "选择要修改颜色的分组");
  if (!group) {
    return;
  }

  const color = await pickGroupColor(`选择「${group.name}」的文字颜色`, group.color);
  if (!color || color === group.color) {
    return;
  }

  const next = { ...group, color };
  await store.saveGroup(next);
  treeProvider.refresh();
  groupDecorationProvider.refresh(next);
  vscode.window.setStatusBarMessage(`Database Workbench: 已更新分组 ${group.name} 的颜色。`, 2500);
}

async function deleteGroup(
  store: ConnectionStore,
  treeProvider: ConnectionsTreeProvider,
  existing?: ConnectionGroup
): Promise<void> {
  const group = existing ?? await pickGroup(store, "选择要删除的分组");
  if (!group) {
    return;
  }

  const connectionCount = store.getAll().filter((connection) => connection.groupId === group.id).length;
  const confirmed = await vscode.window.showWarningMessage(
    `确定删除分组「${group.name}」吗？分组中的 ${connectionCount} 个连接会保留并移到根目录。`,
    { modal: true },
    "删除分组"
  );
  if (confirmed !== "删除分组") {
    return;
  }

  await store.deleteGroup(group.id);
  treeProvider.refresh();
  vscode.window.setStatusBarMessage(`Database Workbench: 已删除分组 ${group.name}。`, 2500);
}

async function pinTreeNode(
  store: ConnectionStore,
  treeProvider: ConnectionsTreeProvider,
  value: unknown
): Promise<void> {
  const node = asPinnableTreeNode(value);
  if (!node) {
    throw new Error("没有拿到可置顶的节点信息，请刷新左侧连接树后重试。");
  }

  await store.pinNodeKey(getTreeNodePinKey(node));
  treeProvider.refresh();
  vscode.window.setStatusBarMessage(`Database Workbench: 已置顶${getTreeNodeLabel(node)}。`, 2500);
}

async function unpinTreeNode(
  store: ConnectionStore,
  treeProvider: ConnectionsTreeProvider,
  value: unknown
): Promise<void> {
  const node = asPinnableTreeNode(value);
  if (!node) {
    throw new Error("没有拿到可取消置顶的节点信息，请刷新左侧连接树后重试。");
  }

  await store.unpinNodeKey(getTreeNodePinKey(node));
  treeProvider.refresh();
  vscode.window.setStatusBarMessage(`Database Workbench: 已取消置顶${getTreeNodeLabel(node)}。`, 2500);
}

function asPinnableTreeNode(value: unknown): TreeNode | undefined {
  return asGroupNode(value) ?? asConnectionNode(value) ?? asDatabaseNode(value) ?? asTableNode(value);
}

function getTreeNodeLabel(node: TreeNode): string {
  if (node.kind === "group") return `分组「${node.group.name}」`;
  if (node.kind === "connection") return `连接「${node.connection.name}」`;
  if (node.kind === "database") return `${node.connection.type === "elasticsearch" ? "索引空间" : "数据库"}「${node.database}」`;
  if (node.kind === "schema") return `Schema「${node.schema}」`;
  if (node.kind === "table") return `${node.connection.type === "elasticsearch" ? "索引" : "表"}「${node.table}」`;
  return "节点";
}

async function pickGroup(store: ConnectionStore, placeHolder: string): Promise<ConnectionGroup | undefined> {
  const groups = store.getGroups();
  if (!groups.length) {
    vscode.window.showInformationMessage("当前还没有连接分组。");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    groups.map((group) => ({
      label: group.name,
      description: getGroupColorLabel(group.color),
      iconPath: new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(`databaseWorkbench.group.${group.color}`)),
      group,
    })),
    { placeHolder }
  );
  return picked?.group;
}

async function pickGroupColor(title: string, current: ConnectionGroupColor): Promise<ConnectionGroupColor | undefined> {
  const picked = await vscode.window.showQuickPick(
    GROUP_COLOR_OPTIONS.map((item) => ({
      label: item.label,
      description: item.color === current ? "当前颜色" : undefined,
      picked: item.color === current,
      iconPath: new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(`databaseWorkbench.group.${item.color}`)),
      color: item.color,
    })),
    { title, placeHolder: "像日志标记一样选择一个颜色小球" }
  );
  return picked?.color;
}

function validateGroupName(store: ConnectionStore, value: string, currentId?: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "分组名称不能为空。";
  }
  if (store.getGroups().some((group) => group.id !== currentId && group.name === name)) {
    return "已经存在同名分组。";
  }
  return undefined;
}

async function resolveConnectionGroupId(
  store: ConnectionStore,
  payload: ConnectionEditorPayload,
  fallbackGroupId?: string
): Promise<string | undefined> {
  if (payload.groupMode === "none") {
    return undefined;
  }

  if (payload.groupMode === "existing") {
    const group = payload.groupId ? store.getGroup(payload.groupId) : undefined;
    if (!group) {
      throw new Error("请选择一个有效的连接分组。");
    }
    return group.id;
  }

  if (payload.groupMode === "custom") {
    const groupName = String(payload.customGroupName ?? "").trim();
    if (!groupName) {
      throw new Error("自定义分组名称不能为空。");
    }
    return (await ensureConnectionGroup(store, groupName, payload.customGroupColor)).id;
  }

  const importedGroupName = String(payload.groupName ?? "").trim();
  if (importedGroupName) {
    return (await ensureConnectionGroup(store, importedGroupName, payload.customGroupColor)).id;
  }

  return fallbackGroupId && store.getGroup(fallbackGroupId) ? fallbackGroupId : undefined;
}

async function ensureConnectionGroup(
  store: ConnectionStore,
  name: string,
  color: ConnectionGroupColor | undefined
): Promise<ConnectionGroup> {
  const normalizedName = name.trim();
  const existing = store.getGroups().find((group) => group.name === normalizedName);
  if (existing) {
    return existing;
  }

  const group: ConnectionGroup = {
    id: randomUUID(),
    name: normalizedName,
    color: color ?? "blue",
  };
  await store.saveGroup(group);
  return group;
}

function getGroupColorLabel(color: ConnectionGroupColor): string {
  return GROUP_COLOR_OPTIONS.find((item) => item.color === color)?.label ?? "蓝色";
}

async function openConnectionsExportPanel(context: vscode.ExtensionContext, store: ConnectionStore): Promise<void> {
  const key = "connections-export";
  const opened = connectionExportPanels.get(key);
  if (opened) {
    opened.reveal(vscode.ViewColumn.One);
    opened.webview.html = renderConnectionsExportHtml(await buildConnectionsExportModel(store));
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "databaseWorkbench.connectionsExport",
    "导出数据库连接",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  connectionExportPanels.set(key, panel);
  panel.onDidDispose(() => connectionExportPanels.delete(key), null, context.subscriptions);
  panel.webview.html = renderConnectionsExportHtml(await buildConnectionsExportModel(store));
  panel.webview.onDidReceiveMessage(async (message: { type?: string; groupIds?: string[]; connectionIds?: string[] }) => {
    try {
      if (message.type === "exportConnections") {
        await exportSelectedConnections(panel, store, message.groupIds ?? [], message.connectionIds ?? []);
      }
    } catch (error) {
      panel.webview.postMessage({ type: "exportStatus", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }, null, context.subscriptions);
}

type ConnectionsExportModel = {
  groups: ConnectionGroup[];
  connections: DbConnectionConfig[];
};

async function buildConnectionsExportModel(store: ConnectionStore): Promise<ConnectionsExportModel> {
  return {
    groups: store.getGroups(),
    connections: store.getAll(),
  };
}

async function exportSelectedConnections(
  panel: vscode.WebviewPanel,
  store: ConnectionStore,
  groupIds: string[],
  connectionIds: string[]
): Promise<void> {
  const selectedGroupIds = new Set(groupIds);
  const selectedConnectionIds = new Set(connectionIds);
  const allConnections = store.getAll();
  const selectedConnections = allConnections.filter((connection) =>
    selectedConnectionIds.has(connection.id) || (connection.groupId ? selectedGroupIds.has(connection.groupId) : false)
  );
  if (!selectedConnections.length && !selectedGroupIds.size) {
    throw new Error("请至少选择一个分组或连接。");
  }

  const selectedConnectionGroupIds = new Set(selectedConnections.map((connection) => connection.groupId).filter((id): id is string => Boolean(id)));
  const exportGroups = store.getGroups().filter((group) => selectedGroupIds.has(group.id) || selectedConnectionGroupIds.has(group.id));
  const groupMap = new Map(exportGroups.map((group) => [group.id, group]));
  const connections = [];
  for (const connection of selectedConnections) {
    const withSecret = await store.getWithSecret(connection.id);
    const group = connection.groupId ? groupMap.get(connection.groupId) : undefined;
    connections.push({
      id: connection.id,
      name: connection.name,
      type: connection.type,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: withSecret?.password ?? "",
      database: connection.database ?? "",
      groupId: group?.id,
      groupName: group?.name,
      groupColor: group?.color,
      ssl: Boolean(connection.ssl),
      allowInsecureTls: Boolean(connection.allowInsecureTls),
    });
  }

  const exportPayload = {
    schema: "databaseWorkbench.connections.export",
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: exportGroups,
    connections,
  };
  const target = await vscode.window.showSaveDialog({
    title: "保存连接导出 JSON",
    defaultUri: vscode.Uri.file(`database-workbench-connections-${formatDateForFileName(new Date())}.json`),
    filters: { "JSON 文件": ["json"] },
  });
  if (!target) {
    panel.webview.postMessage({ type: "exportStatus", message: "已取消导出。" });
    return;
  }

  await fs.writeFile(target.fsPath, JSON.stringify(exportPayload, null, 2), "utf8");
  panel.webview.postMessage({
    type: "exportStatus",
    ok: true,
    message: `已导出 ${connections.length} 个连接和 ${exportGroups.length} 个分组到 ${target.fsPath}`,
  });
  vscode.window.setStatusBarMessage(`Database Workbench: 已导出 ${connections.length} 个连接。`, 2500);
}

function renderConnectionsExportHtml(model: ConnectionsExportModel): string {
  const nonce = randomUUID().replace(/-/g, "");
  const data = {
    groups: model.groups.map((group) => ({
      ...group,
      connectionCount: model.connections.filter((connection) => connection.groupId === group.id).length,
    })),
    connections: model.connections,
  };
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { --bg: var(--vscode-editor-background); --panel: var(--vscode-sideBar-background); --line: var(--vscode-panel-border); --muted: var(--vscode-descriptionForeground); --button: var(--vscode-button-background); --button-fg: var(--vscode-button-foreground); --ok: var(--vscode-testing-iconPassed, #4aa36b); --danger: var(--vscode-errorForeground); }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: radial-gradient(circle at 16% 0, color-mix(in srgb, var(--button) 12%, transparent), transparent 28rem), var(--bg); font-family: var(--vscode-font-family); }
    .page { min-height: 100vh; padding: 24px; }
    .shell { max-width: 980px; margin: 0 auto; display: grid; gap: 16px; }
    .hero { display: flex; justify-content: space-between; gap: 16px; align-items: end; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .sub { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .card { border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--panel) 94%, transparent); overflow: hidden; }
    .toolbar { display: flex; gap: 8px; align-items: center; padding: 14px; border-bottom: 1px solid var(--line); }
    .toolbar .status { margin-left: auto; }
    .list { padding: 10px 14px 14px; display: grid; gap: 10px; }
    .group { border: 1px solid color-mix(in srgb, var(--line) 75%, transparent); border-radius: 12px; overflow: hidden; background: color-mix(in srgb, var(--bg) 24%, transparent); }
    .row { display: flex; gap: 10px; align-items: center; padding: 10px 12px; }
    .group-head { background: color-mix(in srgb, var(--button) 7%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
    .child { padding-left: 34px; }
    .name { font-weight: 650; }
    .meta { color: var(--muted); font-size: 12px; }
    input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--button); }
    button { border: 0; border-radius: 9px; padding: 8px 12px; color: var(--button-fg); background: var(--button); cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .status { min-height: 20px; color: var(--muted); font-size: 13px; }
    .status.ok { color: var(--ok); }
    .status.error { color: var(--danger); }
    .empty { padding: 24px; color: var(--muted); text-align: center; }
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <div class="hero">
        <div>
          <h1>导出数据库连接</h1>
          <div class="sub">选择要导出的分组或单个连接。导出的 JSON 可在“快捷导入连接信息”中重新导入并恢复分组。</div>
        </div>
      </div>
      <section class="card">
        <div class="toolbar">
          <button class="secondary" id="selectAllBtn">全选</button>
          <button class="secondary" id="clearBtn">清空</button>
          <button id="exportBtn">导出 JSON</button>
          <div class="status" id="status"></div>
        </div>
        <div class="list" id="list"></div>
      </section>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const data = ${JSON.stringify(data)};
    const list = document.querySelector("#list");
    const status = document.querySelector("#status");
    const byGroup = new Map();
    data.connections.forEach((connection) => {
      const key = connection.groupId || "";
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(connection);
    });
    function setStatus(message, kind) {
      status.textContent = message || "";
      status.className = "status" + (kind ? " " + kind : "");
    }
    function connectionRow(connection, child) {
      return '<label class="row ' + (child ? 'child' : '') + '">' +
        '<input type="checkbox" class="connection-check" value="' + escapeAttr(connection.id) + '" />' +
        '<span><span class="name">' + escapeHtml(connection.name) + '</span> ' +
        '<span class="meta">' + escapeHtml(connection.type + '://' + connection.host + ':' + connection.port) + '</span></span>' +
      '</label>';
    }
    function render() {
      if (!data.groups.length && !data.connections.length) {
        list.innerHTML = '<div class="empty">当前没有可导出的连接。</div>';
        return;
      }
      const html = [];
      data.groups.forEach((group) => {
        const connections = byGroup.get(group.id) || [];
        html.push('<section class="group"><label class="row group-head">' +
          '<input type="checkbox" class="group-check" value="' + escapeAttr(group.id) + '" />' +
          '<span><span class="name">' + escapeHtml(group.name) + '</span> <span class="meta">' + connections.length + ' 个连接</span></span>' +
          '</label>' + connections.map((connection) => connectionRow(connection, true)).join('') + '</section>');
      });
      const root = data.connections.filter((connection) => !connection.groupId || !data.groups.some((group) => group.id === connection.groupId));
      if (root.length) {
        html.push('<section class="group"><div class="row group-head"><span class="name">未分组连接</span><span class="meta">' + root.length + ' 个连接</span></div>' + root.map((connection) => connectionRow(connection, true)).join('') + '</section>');
      }
      list.innerHTML = html.join('');
    }
    function currentSelection() {
      return {
        groupIds: Array.from(document.querySelectorAll(".group-check:checked")).map((item) => item.value),
        connectionIds: Array.from(document.querySelectorAll(".connection-check:checked")).map((item) => item.value),
      };
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function escapeAttr(value) { return escapeHtml(value); }
    document.querySelector("#selectAllBtn").addEventListener("click", () => document.querySelectorAll('input[type="checkbox"]').forEach((item) => item.checked = true));
    document.querySelector("#clearBtn").addEventListener("click", () => document.querySelectorAll('input[type="checkbox"]').forEach((item) => item.checked = false));
    document.querySelector("#exportBtn").addEventListener("click", () => {
      const selection = currentSelection();
      setStatus("正在准备导出文件...", "");
      vscode.postMessage({ type: "exportConnections", ...selection });
    });
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "exportStatus") {
        setStatus(message.message || "", message.ok ? "ok" : "error");
      }
    });
    render();
  </script>
</body>
</html>`;
}

function formatDateForFileName(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function editConnection(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  existing?: DbConnectionConfig
): Promise<void> {
  const target = existing ?? await pickConnection(store, "选择要编辑的连接");
  if (!target) {
    return;
  }

  await openConnectionEditor(context, store, databaseService, target);
}

async function openConnectionEditor(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  existing?: DbConnectionConfig,
  initialGroupId?: string
): Promise<void> {
  let activeKey = existing ? `edit:${existing.id}` : initialGroupId ? `new:${initialGroupId}` : "new";
  const opened = connectionEditorPanels.get(activeKey);
  if (opened) {
    opened.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "databaseWorkbench.connectionEditor",
    existing ? `修改连接 · ${existing.name}` : "添加数据库连接",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  connectionEditorPanels.set(activeKey, panel);
  panel.onDidDispose(() => connectionEditorPanels.delete(activeKey), null, context.subscriptions);
  panel.webview.html = renderConnectionEditorHtml(existing, store.getGroups(), initialGroupId);
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.type === "saveConnection") {
        const wasNew = !existing;
        existing = await saveConnectionFromEditor(panel, store, existing, message.payload as ConnectionEditorPayload);
        if (wasNew) {
          connectionEditorPanels.delete(activeKey);
          activeKey = `edit:${existing.id}`;
          connectionEditorPanels.set(activeKey, panel);
        }
        return;
      }
      if (message.type === "testConnectionDraft") {
        await testConnectionDraftFromEditor(panel, store, databaseService, existing, message.payload as ConnectionEditorPayload);
        return;
      }
      if (message.type === "importConnectionDraft") {
        await importConnectionDraftToEditor(panel, store);
        return;
      }
    } catch (error) {
      panel.webview.postMessage({ type: "connectionEditorStatus", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }, null, context.subscriptions);
}

type ConnectionEditorPayload = {
  name?: string;
  type?: DatabaseType;
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  database?: string;
  groupMode?: "none" | "existing" | "custom";
  groupId?: string;
  groupName?: string;
  customGroupName?: string;
  customGroupColor?: ConnectionGroupColor;
  ssl?: boolean;
  allowInsecureTls?: boolean;
  updatePassword?: boolean;
};

type ParsedConnectionImport = {
  drafts: ConnectionEditorPayload[];
  groups: Array<{ name: string; color: ConnectionGroupColor }>;
  format: "databaseWorkbenchJson" | "navicat" | "unknown";
  hasGroups: boolean;
};

async function saveConnectionFromEditor(
  panel: vscode.WebviewPanel,
  store: ConnectionStore,
  existing: DbConnectionConfig | undefined,
  payload: ConnectionEditorPayload
): Promise<DbConnectionConfig> {
  const draft = normalizeConnectionEditorPayload(payload);
  const groupId = await resolveConnectionGroupId(store, payload, existing?.groupId);
  const connection: DbConnectionConfig = {
    id: existing?.id ?? randomUUID(),
    name: draft.name,
    type: draft.type,
    host: draft.host,
    port: draft.port,
    username: draft.username,
    database: draft.database,
    groupId,
    ssl: draft.ssl,
    allowInsecureTls: draft.allowInsecureTls,
  };
  const shouldSavePassword = !existing || draft.updatePassword;
  await store.save(connection, shouldSavePassword ? draft.password : undefined);
  await vscode.commands.executeCommand("databaseWorkbench.refresh");
  panel.webview.postMessage({
    type: "connectionEditorStatus",
    ok: true,
    message: existing ? `连接「${connection.name}」已保存，左侧连接树已刷新。` : `连接「${connection.name}」已创建，左侧连接树已刷新。`,
  });
  panel.title = `修改连接 · ${connection.name}`;
  vscode.window.setStatusBarMessage(`Database Workbench: 已保存连接 ${connection.name}。`, 2500);
  return connection;
}

async function testConnectionDraftFromEditor(
  panel: vscode.WebviewPanel,
  store: ConnectionStore,
  databaseService: DatabaseService,
  existing: DbConnectionConfig | undefined,
  payload: ConnectionEditorPayload
): Promise<void> {
  const draft = normalizeConnectionEditorPayload(payload);
  let password = draft.password;
  if (existing && !draft.updatePassword) {
    password = (await store.getWithSecret(existing.id))?.password ?? "";
  }
  panel.webview.postMessage({ type: "connectionEditorStatus", loading: true, message: `正在测试 ${draft.name}...` });
  await databaseService.testConnection({ ...draft, id: existing?.id ?? "draft", password });
  panel.webview.postMessage({ type: "connectionEditorStatus", ok: true, message: `连接「${draft.name}」测试成功。` });
}

function normalizeConnectionEditorPayload(payload: ConnectionEditorPayload): ConnectionDraft & { updatePassword: boolean } {
  const type = isDatabaseType(payload.type) ? payload.type : "mysql";
  const name = String(payload.name ?? "").trim();
  if (!name) {
    throw new Error("连接名称不能为空。");
  }
  const host = String(payload.host ?? "").trim();
  if (!host) {
    throw new Error("主机地址不能为空。");
  }
  const portText = String(payload.port ?? "").trim();
  const portError = validatePort(portText);
  if (portError) {
    throw new Error(portError);
  }
  const username = String(payload.username ?? "").trim();
  if (!canUseEmptyUsername(type) && !username) {
    throw new Error("用户名不能为空。");
  }
  return {
    name,
    type,
    host,
    port: Number(portText),
    username,
    password: String(payload.password ?? ""),
    database: String(payload.database ?? "").trim() || undefined,
    ssl: Boolean(payload.ssl),
    allowInsecureTls: type === "elasticsearch" && Boolean(payload.ssl) && Boolean(payload.allowInsecureTls),
    updatePassword: Boolean(payload.updatePassword),
  };
}

function isDatabaseType(value: unknown): value is DatabaseType {
  return value === "mysql" || value === "postgres" || value === "redis" || value === "elasticsearch";
}

async function importConnectionDraftToEditor(panel: vscode.WebviewPanel, store: ConnectionStore): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: "导入数据库连接配置",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      "Database Workbench JSON": ["json"],
      "Navicat 连接导出": ["ncx"],
      "XML 文件": ["xml"],
      "所有文件": ["*"],
    },
  });
  const file = picked?.[0];
  if (!file) {
    panel.webview.postMessage({ type: "connectionEditorStatus", message: "已取消导入。" });
    return;
  }

  const text = await fs.readFile(file.fsPath, "utf8");
  const parsed = parseConnectionImportFile(text);
  const drafts = parsed.drafts;
  if (drafts.length === 0 && parsed.groups.length === 0) {
    throw new Error("没有从文件中解析到支持的连接信息。当前支持 Database Workbench JSON 和 Navicat .ncx 导出的 MySQL / PostgreSQL / Redis / Elasticsearch 连接。");
  }

  if (parsed.format === "databaseWorkbenchJson") {
    const actions = drafts.length > 0
      ? ["导入到连接列表", "选择一个填入", "取消"] as const
      : ["导入到连接列表", "取消"] as const;
    const action = await vscode.window.showInformationMessage(
      `已识别 Database Workbench JSON，共 ${drafts.length} 个连接、${parsed.groups.length} 个分组。`,
      ...actions
    );
    if (action === "导入到连接列表") {
      const savedCount = await saveImportedConnectionDrafts(store, drafts, parsed.groups);
      await vscode.commands.executeCommand("databaseWorkbench.refresh");
      panel.webview.postMessage({
        type: "connectionEditorStatus",
        ok: true,
        message: `已导入 ${savedCount} 个连接${parsed.hasGroups ? "并恢复分组" : ""}，左侧连接树已刷新。`,
      });
      vscode.window.setStatusBarMessage(`Database Workbench: 已导入 ${savedCount} 个连接。`, 2500);
      return;
    }
    if (action !== "选择一个填入") {
      panel.webview.postMessage({ type: "connectionEditorStatus", message: "已取消导入。" });
      return;
    }
  }

  let selected = drafts[0];
  if (drafts.length > 1) {
    const action = await vscode.window.showInformationMessage(
      `已从文件中解析到 ${drafts.length} 个连接。你可以一次保存全部，也可以选择其中一个填入当前页面。`,
      "批量保存全部",
      "选择一个填入",
      "取消"
    );
    if (action === "批量保存全部") {
      const savedCount = await saveImportedConnectionDrafts(store, drafts, parsed.groups);
      await vscode.commands.executeCommand("databaseWorkbench.refresh");
      panel.webview.postMessage({
        type: "connectionEditorStatus",
        ok: true,
        message: `已批量导入 ${savedCount} 个连接，左侧连接树已刷新。`,
      });
      vscode.window.setStatusBarMessage(`Database Workbench: 已批量导入 ${savedCount} 个连接。`, 2500);
      return;
    }
    if (action !== "选择一个填入") {
      panel.webview.postMessage({ type: "connectionEditorStatus", message: "已取消导入。" });
      return;
    }

    const pickedDraft = await vscode.window.showQuickPick(
      drafts.map((draft) => ({
        label: draft.name || `${draft.type}://${draft.host}:${draft.port}`,
        description: `${draft.type}://${draft.host}:${draft.port}`,
        detail: draft.database ? `默认库：${draft.database}` : undefined,
        draft,
      })),
      { placeHolder: "选择要导入的连接" }
    );
    if (!pickedDraft) {
      panel.webview.postMessage({ type: "connectionEditorStatus", message: "已取消导入。" });
      return;
    }
    selected = pickedDraft.draft;
  }

  panel.webview.postMessage({
    type: "connectionEditorImportResult",
    payload: selected,
    message: `已导入连接「${selected.name}」。请检查信息后测试并保存。`,
  });
}

async function saveImportedConnectionDrafts(
  store: ConnectionStore,
  drafts: ConnectionEditorPayload[],
  groups: Array<{ name: string; color: ConnectionGroupColor }> = []
): Promise<number> {
  for (const group of groups) {
    await ensureConnectionGroup(store, group.name, group.color);
  }

  let savedCount = 0;
  for (const payload of drafts) {
    const draft = normalizeConnectionEditorPayload(payload);
    const groupId = await resolveConnectionGroupId(store, payload);
    await store.save(
      {
        id: randomUUID(),
        name: draft.name,
        type: draft.type,
        host: draft.host,
        port: draft.port,
        username: draft.username,
        database: draft.database,
        groupId,
        ssl: draft.ssl,
        allowInsecureTls: draft.allowInsecureTls,
      },
      draft.updatePassword ? draft.password : undefined
    );
    savedCount += 1;
  }
  return savedCount;
}

function parseConnectionImportFile(text: string): ParsedConnectionImport {
  const jsonDrafts = parseDatabaseWorkbenchJsonConnections(text);
  if (jsonDrafts) {
    const groups = parseDatabaseWorkbenchJsonGroups(text);
    return {
      drafts: jsonDrafts,
      groups,
      format: "databaseWorkbenchJson",
      hasGroups: groups.length > 0 || jsonDrafts.some((draft) => Boolean(String(draft.groupName ?? "").trim())),
    };
  }

  if (/<Connections\b/i.test(text) || /<Connection\b/i.test(text)) {
    return {
      drafts: parseNavicatNcxConnections(text),
      groups: [],
      format: "navicat",
      hasGroups: false,
    };
  }
  return { drafts: [], groups: [], format: "unknown", hasGroups: false };
}

function parseDatabaseWorkbenchJsonGroups(text: string): Array<{ name: string; color: ConnectionGroupColor }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const source = parsed as Record<string, unknown>;
  const groups = Array.isArray(source.groups) ? source.groups : [];
  const seen = new Set<string>();
  const result: Array<{ name: string; color: ConnectionGroupColor }> = [];
  for (const item of groups) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const group = item as Record<string, unknown>;
    const name = String(group.name ?? "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push({ name, color: normalizeConnectionGroupColor(group.color) });
  }
  return result;
}

function parseDatabaseWorkbenchJsonConnections(text: string): ConnectionEditorPayload[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { connections: parsed };
  const groupMap = new Map<string, { name: string; color: ConnectionGroupColor }>();
  const groups = Array.isArray(source.groups) ? source.groups : [];
  for (const item of groups) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const group = item as Record<string, unknown>;
    const id = String(group.id ?? "").trim();
    const name = String(group.name ?? "").trim();
    if (!name) {
      continue;
    }
    const color = normalizeConnectionGroupColor(group.color);
    if (id) {
      groupMap.set(id, { name, color });
    }
    groupMap.set(name, { name, color });
  }

  const connections = Array.isArray(source.connections) ? source.connections : [];
  return connections
    .map((item): ConnectionEditorPayload | undefined => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const value = item as Record<string, unknown>;
      const type = mapImportedConnectionType(String(value.type ?? value.databaseType ?? ""));
      if (!type) {
        return undefined;
      }

      const groupKey = String(value.groupId ?? value.groupName ?? "").trim();
      const group = groupKey ? groupMap.get(groupKey) : undefined;
      const groupName = String(value.groupName ?? group?.name ?? "").trim();
      return {
        name: String(value.name ?? `${type}://${String(value.host ?? "127.0.0.1")}:${Number(value.port) || getDefaultPort(type)}`).trim(),
        type,
        host: String(value.host ?? "127.0.0.1").trim(),
        port: String(Number(value.port) || getDefaultPort(type)),
        username: String(value.username ?? ""),
        password: typeof value.password === "string" ? value.password : "",
        database: String(value.database ?? ""),
        groupName,
        customGroupColor: group?.color ?? normalizeConnectionGroupColor(value.groupColor),
        ssl: Boolean(value.ssl),
        allowInsecureTls: Boolean(value.allowInsecureTls),
        updatePassword: Object.prototype.hasOwnProperty.call(value, "password"),
      };
    })
    .filter((item): item is ConnectionEditorPayload => Boolean(item));
}

function parseNavicatNcxConnections(text: string): ConnectionEditorPayload[] {
  const drafts: ConnectionEditorPayload[] = [];
  const connectionPattern = /<Connection\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = connectionPattern.exec(text))) {
    const attrs = parseXmlAttributes(match[1]);
    const type = mapImportedConnectionType(getAttr(attrs, "ConnType", "Type", "DatabaseType"));
    if (!type) {
      continue;
    }

    const host = getAttr(attrs, "Host", "Hostname", "Server") || "127.0.0.1";
    const portText = getAttr(attrs, "Port");
    const port = Number(portText) || getDefaultPort(type);
    const importedPassword = getAttr(attrs, "Password");
    const password = decryptImportedPassword(importedPassword);
    drafts.push({
      name: getAttr(attrs, "ConnectionName", "Name") || `${type}://${host}:${port}`,
      type,
      host,
      port: String(port),
      username: getAttr(attrs, "UserName", "Username", "User") || "",
      password: password ?? "",
      database: getAttr(attrs, "Database", "InitialDatabase", "DefaultDatabase", "DBName", "Schema") || "",
      ssl: parseImportedBoolean(getAttr(attrs, "SSL", "UseSSL")),
      allowInsecureTls: false,
      updatePassword: Boolean(importedPassword.trim()) && password !== undefined,
    });
  }
  return drafts;
}

function parseXmlAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrPattern = /([A-Za-z0-9_:-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(source))) {
    attrs.set(match[1].toLowerCase(), decodeXmlText(match[3]));
  }
  return attrs;
}

function getAttr(attrs: Map<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = attrs.get(name.toLowerCase());
    if (value !== undefined) {
      return value;
    }
  }
  return "";
}

function mapImportedConnectionType(type: string): DatabaseType | undefined {
  const normalized = type.trim().toLowerCase();
  if (normalized === "mysql" || normalized === "mariadb") return "mysql";
  if (normalized === "postgres" || normalized === "postgresql" || normalized === "pgsql") return "postgres";
  if (normalized === "redis") return "redis";
  if (normalized === "elasticsearch" || normalized === "elastic") return "elasticsearch";
  return undefined;
}

function parseImportedBoolean(value: string): boolean {
  return /^(true|1|yes|on)$/i.test(value.trim());
}

function decryptImportedPassword(value: string): string | undefined {
  const text = value.trim();
  if (!text) return "";
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 32 !== 0) {
    return text;
  }

  try {
    const decipher = createDecipheriv(
      "aes-128-cbc",
      Buffer.from("libcckeylibcckey", "utf8"),
      Buffer.from("libcciv libcciv ", "utf8")
    );
    const decrypted = Buffer.concat([decipher.update(Buffer.from(text, "hex")), decipher.final()]).toString("utf8");
    return decrypted.replace(/\0+$/g, "");
  } catch {
    return undefined;
  }
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function deleteConnection(store: ConnectionStore, existing?: DbConnectionConfig): Promise<void> {
  const target = existing ?? await pickConnection(store, "选择要删除的连接");
  if (!target) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `确定删除连接「${target.name}」吗？密码也会从 VS Code SecretStorage 中删除。`,
    { modal: true },
    "删除"
  );
  if (confirmed !== "删除") {
    return;
  }

  await store.delete(target.id);
  vscode.window.showInformationMessage(`已删除连接 ${target.name}。`);
}

async function testConnection(
  store: ConnectionStore,
  databaseService: DatabaseService,
  existing?: DbConnectionConfig
): Promise<void> {
  const target = existing ?? await pickConnection(store, "选择要测试的连接");
  if (!target) {
    return;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在测试 ${target.name}`, cancellable: false },
      async () => {
        const connection = await store.getWithSecret(target.id);
        if (!connection) {
          throw new Error("连接配置不存在。");
        }
        await databaseService.testConnection(connection);
      }
    );
    vscode.window.showInformationMessage(`连接 ${target.name} 测试成功。`);
  } catch (error) {
    showError("测试连接失败", error);
  }
}

async function configureAi(): Promise<void> {
  const current = getAiConfig();
  const provider = await vscode.window.showQuickPick(
    AI_PROVIDER_PRESETS.map((item) => ({
      label: item.label,
      description: item.description,
      detail: item.baseUrl ? `${item.baseUrl} · ${item.modelName}` : "手动填写 Base URL 和模型名称",
      value: item.value,
      picked: current.provider === item.value,
    })),
    { placeHolder: "选择大模型供应商" }
  );
  if (!provider) {
    return;
  }

  const aiSettings = vscode.workspace.getConfiguration("databaseWorkbench.ai");
  const target = vscode.ConfigurationTarget.Global;
  await aiSettings.update("provider", provider.value, target);
  const preset = getAiProviderPreset(provider.value);
  if (preset.baseUrl && shouldApplyAiProviderPreset(current.baseUrl, provider.value !== current.provider)) {
    await aiSettings.update("baseUrl", preset.baseUrl, target);
  }
  if (preset.modelName && shouldApplyAiProviderPreset(current.modelName, provider.value !== current.provider)) {
    await aiSettings.update("modelName", preset.modelName, target);
  }
  if (provider.value !== current.provider) {
    await aiSettings.update("useStream", preset.useStream, target);
  }
  const action = await vscode.window.showInformationMessage(
    "已选择 AI 供应商，并已预填推荐的 Base URL 和模型名称。请在设置页填写 API Key 或按需修改。",
    "打开 AI 设置",
    "测试配置"
  );
  if (action === "打开 AI 设置") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:loveyu.loveyu-database-workbench databaseWorkbench.ai");
    return;
  }
  if (action === "测试配置") {
    await testAiConfiguration();
  }
}

function shouldApplyAiProviderPreset(value: string, providerChanged: boolean): boolean {
  return providerChanged || !value.trim();
}

async function testAiConfiguration(): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在测试 Database Workbench AI 配置", cancellable: false },
    async () => testAiConnection(getAiConfig())
  );
  vscode.window.showInformationMessage(`AI 配置测试成功：${truncateText(result, 80)}`);
}

async function filterDatabases(
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const connection = asConnectionNode(node)?.connection
    ?? asDatabaseFilterNode(node)?.connection
    ?? await pickConnection(store, "选择要筛选的连接");
  if (!connection) {
    return;
  }

  const connectionWithSecret = await store.getWithSecret(connection.id);
  if (!connectionWithSecret) {
    throw new Error("连接配置不存在。");
  }

  const isIndexFilter = connection.type === "elasticsearch";
  const targetName = isIndexFilter ? "索引" : getFilterTargetName(connection.type);
  const values = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在读取 ${connection.name} 的${targetName}列表`, cancellable: false },
    async () => {
      if (isIndexFilter) {
        return (await databaseService.listTableSummaries(connectionWithSecret, "indices")).map((item) => item.name);
      }
      return databaseService.listDatabases(connectionWithSecret);
    }
  );

  if (!values.length) {
    vscode.window.showInformationMessage(`${connection.name} 当前没有可筛选的${targetName}。`);
    return;
  }

  const saved = store.getDatabaseFilter(connection.id);
  const selected = new Set(saved ?? values);
  const picked = await vscode.window.showQuickPick(
    values.map((value) => ({ label: value, picked: selected.has(value) })),
    {
      canPickMany: true,
      title: `筛选 ${connection.name}`,
      placeHolder: `选择要在左侧展示的${targetName}，取消全选则只保留筛选入口`,
    }
  );

  if (!picked) {
    return;
  }

  await store.setDatabaseFilter(connection.id, picked.map((item) => item.label));
  vscode.window.showInformationMessage(`已更新 ${connection.name} 的左侧${targetName}展示范围：${picked.length}/${values.length}`);
}

async function openDatabase(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const tableNode = asTableNode(node);
  if (tableNode) {
    DatabaseWorkbenchPanel.open(context, store, databaseService, tableNode.connection, tableNode.database, tableNode.table);
    return;
  }

  const databaseNode = asDatabaseNode(node);
  if (databaseNode) {
    DatabaseWorkbenchPanel.open(context, store, databaseService, databaseNode.connection, databaseNode.database);
    return;
  }

  const connection = await pickConnection(store, "选择数据库连接");
  if (!connection) {
    return;
  }

  const connectionWithSecret = await store.getWithSecret(connection.id);
  if (!connectionWithSecret) {
    throw new Error("连接配置不存在。");
  }

  const database = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在读取 ${connection.name} 的数据库列表`, cancellable: false },
    async () => {
      const databases = await databaseService.listDatabases(connectionWithSecret);
      return vscode.window.showQuickPick(databases, { placeHolder: "选择要打开的数据库" });
    }
  );

  if (!database) {
    return;
  }

  DatabaseWorkbenchPanel.open(context, store, databaseService, connection, database);
}

async function openTable(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const tableNode = asTableNode(node);
  if (!tableNode) {
    throw new Error("没有拿到表节点信息，请刷新左侧数据库树后重试。");
  }

  DatabaseWorkbenchPanel.open(context, store, databaseService, tableNode.connection, tableNode.database, tableNode.table);
}

async function editDatabase(
  store: ConnectionStore,
  databaseService: DatabaseService,
  node?: ReturnType<typeof asDatabaseNode>
): Promise<void> {
  if (!node) {
    throw new Error("没有拿到数据库节点信息，请刷新左侧数据库树后重试。");
  }

  if (node.connection.type !== "mysql" && node.connection.type !== "postgres") {
    vscode.window.showWarningMessage("当前连接类型不支持修改数据库。");
    return;
  }

  if (node.connection.type === "mysql") {
    vscode.window.showWarningMessage("MySQL 不支持直接重命名数据库。建议新建数据库后迁移表，再删除旧数据库。");
    return;
  }

  const nextName = await promptIdentifier(`修改数据库名称：${node.database}`, node.database);
  if (!nextName || nextName === node.database) {
    return;
  }

  const sql = `ALTER DATABASE ${quoteIdentifier(node.connection.type, node.database)} RENAME TO ${quoteIdentifier(node.connection.type, nextName)};`;
  if (!await showSqlConfirmDialog({
    title: "确认执行下面的数据库修改 SQL 吗？",
    sql,
    dialect: node.connection.type,
  })) {
    return;
  }

  const connection = await requireConnection(store, node.connection.id);
  await databaseService.queryAdmin(connection, sql, getQueryConfigForCommand());
  vscode.window.showInformationMessage(`数据库已修改为 ${nextName}。`);
}

async function deleteDatabase(
  store: ConnectionStore,
  databaseService: DatabaseService,
  node?: ReturnType<typeof asDatabaseNode>
): Promise<void> {
  if (!node) {
    throw new Error("没有拿到数据库节点信息，请刷新左侧数据库树后重试。");
  }
  if (node.connection.type !== "mysql" && node.connection.type !== "postgres") {
    vscode.window.showWarningMessage("当前连接类型不支持删除数据库。");
    return;
  }

  const sql = `DROP DATABASE ${quoteIdentifier(node.connection.type, node.database)};`;
  if (!await showSqlConfirmDialog({
    title: `确定删除数据库「${node.database}」吗？这个操作不可恢复。`,
    sql,
    confirmLabel: "确认删除",
    dialect: node.connection.type,
  })) {
    return;
  }

  const typed = await promptText(`再次输入数据库名 ${node.database} 以确认删除`, "", false);
  if (typed !== node.database) {
    vscode.window.showInformationMessage("数据库名未匹配，已取消删除。");
    return;
  }

  const connection = await requireConnection(store, node.connection.id);
  await databaseService.queryAdmin(connection, sql, getQueryConfigForCommand());
  vscode.window.showInformationMessage(`已删除数据库 ${node.database}。`);
}

async function addTable(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const schemaNode = asSchemaNode(node);
  const databaseNode = schemaNode ?? asDatabaseNode(node);
  if (!databaseNode) {
    throw new Error("没有拿到数据库节点信息，请刷新左侧数据库树后重试。");
  }
  if (databaseNode.connection.type !== "mysql" && databaseNode.connection.type !== "postgres") {
    vscode.window.showWarningMessage("添加表暂时只支持 MySQL 和 PostgreSQL。");
    return;
  }

  DatabaseWorkbenchPanel.open(context, store, databaseService, databaseNode.connection, databaseNode.database, undefined, {
    schemaEditorMode: "createTable",
    defaultSchema: schemaNode?.schema ?? (databaseNode.connection.type === "postgres" ? "public" : undefined),
  });
}

async function copyDatabaseSchema(
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const databaseNode = asDatabaseNode(node);
  if (!databaseNode) {
    throw new Error("没有拿到数据库节点信息，请刷新左侧数据库树后重试。");
  }
  if (databaseNode.connection.type !== "mysql") {
    vscode.window.showWarningMessage("复制整个数据库表结构暂时只支持 MySQL。");
    return;
  }

  const connection = await requireConnection(store, databaseNode.connection.id);
  const ddlList = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在复制 ${databaseNode.database} 的全部表结构`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "读取表结构..." });
      return databaseService.getDatabaseCreateTableSql(connection, databaseNode.database);
    }
  );
  if (!ddlList.length) {
    vscode.window.showInformationMessage(`数据库 ${databaseNode.database} 中没有可复制的表结构。`);
    return;
  }

  const text = ddlList
    .map((item) => `-- 表结构：${item.table}\n${item.sql.replace(/;\s*$/, "")};`)
    .join("\n\n");
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(`已复制 ${databaseNode.database} 的 ${ddlList.length} 张表结构。`);
}

async function compareSchema(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const databaseNode = asDatabaseNode(node);
  if (!databaseNode) {
    throw new Error("没有拿到数据库节点信息，请刷新左侧数据库树后重试。");
  }
  if (databaseNode.connection.type !== "mysql" && databaseNode.connection.type !== "postgres") {
    vscode.window.showWarningMessage("表结构对比暂时只支持 MySQL 和 PostgreSQL。");
    return;
  }
  if (!await requireProFeature(context, "schemaCompare", "表结构对比")) {
    return;
  }

  SchemaComparePanel.open(context, store, databaseService, databaseNode.connection, databaseNode.database);
}

async function openQueryConsole(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const databaseNode = asSchemaNode(node) ?? asDatabaseNode(node);
  if (!databaseNode) {
    throw new Error("没有拿到数据库节点信息，请刷新左侧数据库树后重试。");
  }
  if (databaseNode.connection.type !== "mysql" && databaseNode.connection.type !== "postgres") {
    vscode.window.showWarningMessage("查询控制台暂时只支持 MySQL 和 PostgreSQL。");
    return;
  }

  DatabaseWorkbenchPanel.open(context, store, databaseService, databaseNode.connection, databaseNode.database, undefined, {
    queryConsole: true,
  });
}

async function editTable(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  node: unknown
): Promise<void> {
  const tableNode = asTableNode(node);
  if (!tableNode) {
    throw new Error("没有拿到表节点信息，请刷新左侧数据库树后重试。");
  }
  if (tableNode.connection.type !== "mysql" && tableNode.connection.type !== "postgres") {
    vscode.window.showWarningMessage("修改表结构暂时只支持 MySQL 和 PostgreSQL。");
    return;
  }

  DatabaseWorkbenchPanel.open(context, store, databaseService, tableNode.connection, tableNode.database, tableNode.table, {
    schemaEditorMode: "editTable",
  });
}

async function deleteTable(
  store: ConnectionStore,
  databaseService: DatabaseService,
  node?: ReturnType<typeof asTableNode>
): Promise<void> {
  if (!node) {
    throw new Error("没有拿到表节点信息，请刷新左侧数据库树后重试。");
  }
  if (node.connection.type !== "mysql" && node.connection.type !== "postgres") {
    vscode.window.showWarningMessage("当前连接类型不支持删除表。");
    return;
  }

  const sql = `DROP TABLE ${quoteIdentifier(node.connection.type, node.table)};`;
  if (!await showSqlConfirmDialog({
    title: `确定删除表「${node.table}」吗？这个操作不可恢复。`,
    sql,
    confirmLabel: "确认删除",
    dialect: node.connection.type,
  })) {
    return;
  }

  const connection = await requireConnection(store, node.connection.id);
  await databaseService.query(connection, node.database, sql, getQueryConfigForCommand());
  vscode.window.showInformationMessage(`已删除表 ${node.table}。`);
}

async function openCreateResourcePanel(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  databaseService: DatabaseService,
  existing?: DbConnectionConfig
): Promise<void> {
  const connection = existing ?? await pickConnection(store, "选择要创建资源的连接");
  if (!connection) {
    return;
  }
  if (connection.type === "redis") {
    vscode.window.showWarningMessage("Redis 连接不支持创建数据库或索引。");
    return;
  }

  const key = `${connection.id}:create-resource`;
  const opened = createResourcePanels.get(key);
  if (opened) {
    opened.reveal(vscode.ViewColumn.One);
    return;
  }

  const targetLabel = getCreateTargetLabel(connection.type);
  const panel = vscode.window.createWebviewPanel(
    "databaseWorkbench.createResource",
    `创建${targetLabel} · ${connection.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  createResourcePanels.set(key, panel);
  panel.onDidDispose(() => createResourcePanels.delete(key));
  panel.webview.html = renderCreateResourceHtml(connection, targetLabel);
  panel.webview.onDidReceiveMessage((message: { type?: string; payload?: Record<string, unknown> }) => {
    void runSafely("创建失败", async () => {
      if (message.type === "submitCreateResource") {
        await submitCreateResource(store, databaseService, panel, connection, message.payload ?? {});
      }
    });
  });
}

async function submitCreateResource(
  store: ConnectionStore,
  databaseService: DatabaseService,
  panel: vscode.WebviewPanel,
  connection: DbConnectionConfig,
  payload: Record<string, unknown>
): Promise<void> {
  const connectionWithSecret = await store.getWithSecret(connection.id);
  if (!connectionWithSecret) {
    throw new Error("连接配置不存在。");
  }

  const plan = buildCreateResourcePlan(connection.type, payload);
  if (!await showSqlConfirmDialog({
    title: `确认创建${plan.targetLabel}「${plan.name}」吗？`,
    sql: plan.sql,
    confirmLabel: "确认创建",
    dialect: connection.type === "mysql" || connection.type === "postgres" ? connection.type : undefined,
  })) {
    panel.webview.postMessage({ type: "createResourceStatus", ok: false, message: "已取消创建。" });
    return;
  }

  panel.webview.postMessage({ type: "createResourceStatus", loading: true, message: `正在创建${plan.targetLabel}...` });
  if (connection.type === "elasticsearch") {
    await databaseService.query(connectionWithSecret, "indices", plan.sql, getQueryConfigForCommand());
  } else {
    await databaseService.queryAdmin(connectionWithSecret, plan.sql, getQueryConfigForCommand());
  }

  const savedFilter = store.getDatabaseFilter(connection.id);
  if (savedFilter) {
    await store.setDatabaseFilter(connection.id, [...savedFilter, plan.name]);
  }
  await vscode.commands.executeCommand("databaseWorkbench.refresh");
  panel.webview.postMessage({ type: "createResourceStatus", ok: true, message: `${plan.targetLabel}「${plan.name}」已创建，左侧连接树已刷新。` });
  vscode.window.setStatusBarMessage(`Database Workbench: ${plan.targetLabel} ${plan.name} 已创建。`, 2500);
}

type ConnectionDraft = Omit<DbConnectionConfig, "id"> & { password: string };

async function promptText(
  title: string,
  value: string,
  password: boolean,
  validateInput?: (value: string) => string | undefined,
  allowEmpty = false
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    value,
    password,
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (!allowEmpty && !input.trim()) {
        return "不能为空。";
      }
      return validateInput?.(input);
    },
  });
}

function validatePort(value: string): string | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "端口必须是 1 到 65535 之间的整数。";
  }
  return undefined;
}

function getDefaultPort(type: DatabaseType): number {
  if (type === "mysql") return 3306;
  if (type === "postgres") return 5432;
  if (type === "redis") return 6379;
  return 9200;
}

function canUseEmptyUsername(type: DatabaseType): boolean {
  return type === "redis" || type === "elasticsearch";
}

function renderConnectionEditorHtml(existing: DbConnectionConfig | undefined, groups: ConnectionGroup[], initialGroupId?: string): string {
  const nonce = randomUUID().replace(/-/g, "");
  const mode = existing ? "edit" : "create";
  const selectedGroupId = existing?.groupId ?? initialGroupId ?? "";
  const current = {
    name: existing?.name ?? "MySQL 本地连接",
    type: existing?.type ?? "mysql",
    host: existing?.host ?? "127.0.0.1",
    port: existing?.port ?? getDefaultPort("mysql"),
    username: existing?.username ?? "root",
    database: existing?.database ?? "",
    groupId: groups.some((group) => group.id === selectedGroupId) ? selectedGroupId : "",
    ssl: Boolean(existing?.ssl),
    allowInsecureTls: Boolean(existing?.allowInsecureTls),
  };
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --panel: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-editor-background));
      --panel-2: color-mix(in srgb, var(--vscode-sideBar-background) 78%, var(--vscode-editor-background));
      --line: color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
      --muted: var(--vscode-descriptionForeground);
      --button: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --danger: var(--vscode-errorForeground);
      --ok: var(--vscode-testing-iconPassed, #4aa36b);
      --warn: var(--vscode-editorWarning-foreground, #d19a66);
    }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background:
      radial-gradient(circle at top left, color-mix(in srgb, var(--button) 10%, transparent), transparent 34rem),
      linear-gradient(180deg, color-mix(in srgb, var(--panel) 36%, transparent), transparent 18rem),
      var(--bg); font-family: var(--vscode-font-family); }
    .page { min-height: 100vh; padding: 22px; display: grid; place-items: start center; }
    .shell { width: min(1040px, 100%); display: grid; gap: 14px; }
    .hero { display: flex; justify-content: space-between; gap: 18px; align-items: flex-end; }
    h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -.02em; }
    .subtitle { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .badge { border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; color: var(--muted); background: color-mix(in srgb, var(--panel) 80%, transparent); font-size: 12px; white-space: nowrap; }
    .layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 14px; }
    .nav, .card { border: 1px solid var(--line); border-radius: 16px; background: var(--panel); overflow: hidden; box-shadow: 0 18px 48px color-mix(in srgb, #000 14%, transparent); }
    .nav { padding: 12px; align-self: start; }
    .nav-title { margin: 4px 4px 10px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .nav-item { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 11px; color: var(--muted); font-size: 13px; }
    .nav-item.active { color: var(--vscode-foreground); background: color-mix(in srgb, var(--button) 14%, transparent); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--button); }
    .card-head { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; align-items: center; background: color-mix(in srgb, var(--panel-2) 70%, transparent); }
    .card-title { font-weight: 700; }
    .card-sub { color: var(--muted); font-size: 12px; }
    .head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .form { padding: 18px; display: grid; gap: 16px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .field.full { grid-column: 1 / -1; }
    label { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; color: var(--muted); font-size: 12px; }
    .required { color: var(--warn); }
    input, select { width: 100%; height: 36px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 0 11px; outline: none; font-family: var(--vscode-font-family); }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
    input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--button); }
    .hint { margin-top: 6px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .inline { display: flex; align-items: center; gap: 9px; min-height: 36px; padding: 0 2px; }
    .inline label { margin: 0; justify-content: flex-start; }
    .tls-risk { display: none; margin-top: 8px; padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); border-radius: 10px; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); font-size: 12px; line-height: 1.45; }
    .tls-risk.show { display: block; }
    .status { min-height: 22px; color: var(--muted); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    .status.ok { color: var(--ok); }
    .status.error { color: var(--danger); }
    .actions { display: flex; justify-content: flex-end; gap: 10px; align-items: center; padding: 14px 18px; border-top: 1px solid var(--line); background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
    .actions .status { margin-right: auto; }
    button { border: 0; border-radius: 10px; padding: 9px 14px; color: var(--button-fg); background: var(--button); cursor: pointer; font-size: 13px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    @media (max-width: 820px) {
      .page { padding: 12px; }
      .layout, .grid { grid-template-columns: 1fr; }
      .nav { display: none; }
      .hero { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="shell">
      <section class="hero">
        <div>
          <h1>${existing ? "修改数据库连接" : "添加数据库连接"}</h1>
          <div class="subtitle">把连接信息集中在一个页面里填写，保存后左侧连接树会自动刷新。</div>
        </div>
        <div class="badge" id="summaryBadge">${escapeHtml(current.type)}://${escapeHtml(current.host)}:${current.port}</div>
      </section>
      <section class="layout">
        <aside class="nav" aria-hidden="true">
          <div class="nav-title">配置步骤</div>
          <div class="nav-item active"><span class="dot"></span><span>基础信息</span></div>
          <div class="nav-item"><span class="dot"></span><span>认证与默认库</span></div>
          <div class="nav-item"><span class="dot"></span><span>连接安全</span></div>
        </aside>
        <section class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${existing ? escapeHtml(existing.name) : "新的连接"}</div>
              <div class="card-sub">${existing ? "修改后点击保存即可覆盖当前连接配置。" : "密码可以为空，本地 Docker 和无认证 Redis / ES 可直接留空。"}</div>
            </div>
            <div class="head-actions">
              <button class="secondary" id="importBtn">快捷导入连接信息</button>
            </div>
          </div>
          <div class="form">
            <div class="grid">
              <div class="field">
                <label>数据库类型 <span class="required">*</span></label>
                <select id="typeInput">
                  <option value="mysql">MySQL</option>
                  <option value="postgres">PostgreSQL</option>
                  <option value="redis">Redis</option>
                  <option value="elasticsearch">Elasticsearch</option>
                </select>
              </div>
              <div class="field">
                <label>连接名称 <span class="required">*</span></label>
                <input id="nameInput" placeholder="例如：本地 MySQL" />
              </div>
              <div class="field">
                <label>主机地址 <span class="required">*</span></label>
                <input id="hostInput" placeholder="127.0.0.1" />
              </div>
              <div class="field">
                <label>端口 <span class="required">*</span></label>
                <input id="portInput" inputmode="numeric" placeholder="3306" />
              </div>
              <div class="field">
                <label>用户名 <span id="usernameRequired" class="required">*</span></label>
                <input id="usernameInput" placeholder="root" />
                <div class="hint" id="usernameHint"></div>
              </div>
              <div class="field">
                <label>密码</label>
                <input id="passwordInput" type="password" placeholder="${existing ? "留空保持原密码" : "可留空"}" />
                ${existing ? `<div class="inline"><input id="updatePasswordInput" type="checkbox" /><label for="updatePasswordInput">修改密码（勾选后可保存新密码，也可以保存为空密码）</label></div>` : ""}
              </div>
              <div class="field full">
                <label id="databaseLabel">默认数据库</label>
                <input id="databaseInput" placeholder="可留空" />
                <div class="hint" id="databaseHint"></div>
              </div>
              <div class="field full">
                <label>连接分组</label>
                <select id="groupInput">
                  <option value="">不选择分组</option>
                  ${groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("")}
                  <option value="__custom__">自定义新分组...</option>
                </select>
                <div class="hint">保存后会自动把连接放入选择的分组；自定义名称已存在时会直接使用已有分组。</div>
              </div>
              <div class="field" id="customGroupNameField">
                <label>自定义分组名称</label>
                <input id="customGroupNameInput" placeholder="例如：生产环境 / 本地测试" />
              </div>
              <div class="field" id="customGroupColorField">
                <label>自定义分组颜色</label>
                <select id="customGroupColorInput">
                  ${GROUP_COLOR_OPTIONS.map((item) => `<option value="${item.color}">${escapeHtml(item.label)}</option>`).join("")}
                </select>
              </div>
              <div class="field full">
                <div class="inline">
                  <input id="sslInput" type="checkbox" />
                  <label for="sslInput">启用 SSL / TLS</label>
                </div>
                <div class="inline" id="insecureTlsRow">
                  <input id="allowInsecureTlsInput" type="checkbox" />
                  <label for="allowInsecureTlsInput">允许自签名证书（仅限本地 Docker 或可信内网）</label>
                </div>
                <div class="tls-risk" id="tlsRisk">允许自签名证书会关闭 HTTPS 证书校验，只建议用于本地测试环境。</div>
              </div>
            </div>
          </div>
          <div class="actions">
            <div class="status" id="status"></div>
            <button class="secondary" id="resetBtn">重置</button>
            <button class="secondary" id="testBtn">测试连接</button>
            <button id="saveBtn">${existing ? "保存修改" : "保存连接"}</button>
          </div>
        </section>
      </section>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const mode = ${JSON.stringify(mode)};
    const initial = ${JSON.stringify(current)};
    const defaults = {
      mysql: { port: 3306, username: "root", name: "MySQL 本地连接", databaseLabel: "默认数据库", databaseHint: "可留空；展开连接时仍会列出全部数据库。", databasePlaceholder: "例如：app_blog" },
      postgres: { port: 5432, username: "postgres", name: "PostgreSQL 本地连接", databaseLabel: "默认数据库", databaseHint: "可留空；未填写时默认连接 postgres。", databasePlaceholder: "例如：app_blog" },
      redis: { port: 6379, username: "", name: "Redis 本地连接", databaseLabel: "默认 DB 编号", databaseHint: "可留空；默认使用 db0，左侧会根据服务端配置展示 DB。", databasePlaceholder: "例如：0" },
      elasticsearch: { port: 9200, username: "", name: "Elasticsearch 本地连接", databaseLabel: "默认索引筛选", databaseHint: "可留空；展开时列出全部索引。", databasePlaceholder: "例如：logs-*" },
    };
    const $ = (selector) => document.querySelector(selector);
    const typeInput = $("#typeInput");
    const nameInput = $("#nameInput");
    const hostInput = $("#hostInput");
    const portInput = $("#portInput");
    const usernameInput = $("#usernameInput");
    const passwordInput = $("#passwordInput");
    const databaseInput = $("#databaseInput");
    const groupInput = $("#groupInput");
    const customGroupNameInput = $("#customGroupNameInput");
    const customGroupColorInput = $("#customGroupColorInput");
    const sslInput = $("#sslInput");
    const allowInsecureTlsInput = $("#allowInsecureTlsInput");
    const updatePasswordInput = $("#updatePasswordInput");
    const status = $("#status");
    let portTouched = false;
    let usernameTouched = false;
    let nameTouched = mode === "edit";

    function setStatus(message, kind) {
      status.textContent = message || "";
      status.className = "status" + (kind ? " " + kind : "");
    }
    function payload() {
      return {
        name: nameInput.value,
        type: typeInput.value,
        host: hostInput.value,
        port: portInput.value,
        username: usernameInput.value,
        password: passwordInput.value,
        database: databaseInput.value,
        groupMode: groupInput.value === "__custom__" ? "custom" : groupInput.value ? "existing" : "none",
        groupId: groupInput.value === "__custom__" ? "" : groupInput.value,
        customGroupName: customGroupNameInput.value,
        customGroupColor: customGroupColorInput.value,
        ssl: sslInput.checked,
        allowInsecureTls: allowInsecureTlsInput.checked,
        updatePassword: mode === "create" ? true : Boolean(updatePasswordInput && updatePasswordInput.checked),
      };
    }
    function syncGroupFields() {
      const isCustom = groupInput.value === "__custom__";
      $("#customGroupNameField").style.display = isCustom ? "block" : "none";
      $("#customGroupColorField").style.display = isCustom ? "block" : "none";
    }
    function applyTypeMeta(type, fromTypeChange) {
      const meta = defaults[type] || defaults.mysql;
      if (fromTypeChange && !portTouched) portInput.value = String(meta.port);
      if (fromTypeChange && !usernameTouched) usernameInput.value = meta.username;
      if (fromTypeChange && !nameTouched) nameInput.value = meta.name;
      $("#databaseLabel").textContent = meta.databaseLabel;
      $("#databaseHint").textContent = meta.databaseHint;
      databaseInput.placeholder = meta.databasePlaceholder;
      $("#usernameRequired").style.display = type === "redis" || type === "elasticsearch" ? "none" : "inline";
      $("#usernameHint").textContent = type === "redis" || type === "elasticsearch" ? "用户名可留空，本地 Docker 默认无认证时直接留空。" : "MySQL / PostgreSQL 通常需要用户名。";
      $("#insecureTlsRow").style.display = type === "elasticsearch" && sslInput.checked ? "flex" : "none";
      $("#tlsRisk").classList.toggle("show", type === "elasticsearch" && sslInput.checked && allowInsecureTlsInput.checked);
      $("#summaryBadge").textContent = type + "://" + (hostInput.value || "127.0.0.1") + ":" + (portInput.value || meta.port);
    }
    function resetForm() {
      typeInput.value = initial.type;
      nameInput.value = initial.name;
      hostInput.value = initial.host;
      portInput.value = String(initial.port);
      usernameInput.value = initial.username;
      passwordInput.value = "";
      databaseInput.value = initial.database || "";
      groupInput.value = initial.groupId || "";
      customGroupNameInput.value = "";
      customGroupColorInput.value = "blue";
      sslInput.checked = Boolean(initial.ssl);
      allowInsecureTlsInput.checked = Boolean(initial.allowInsecureTls);
      if (updatePasswordInput) updatePasswordInput.checked = false;
      portTouched = false;
      usernameTouched = false;
      nameTouched = mode === "edit";
      applyTypeMeta(typeInput.value, false);
      syncGroupFields();
      setStatus("", "");
    }
    function applyImportedDraft(draft) {
      if (!draft) return;
      typeInput.value = draft.type || "mysql";
      nameInput.value = draft.name || "";
      hostInput.value = draft.host || "";
      portInput.value = String(draft.port || (defaults[typeInput.value] || defaults.mysql).port);
      usernameInput.value = draft.username || "";
      passwordInput.value = draft.password || "";
      databaseInput.value = draft.database || "";
      if (draft.groupId && Array.from(groupInput.options).some((option) => option.value === draft.groupId)) {
        groupInput.value = draft.groupId;
      } else if (draft.groupName) {
        groupInput.value = "__custom__";
        customGroupNameInput.value = draft.groupName;
        customGroupColorInput.value = draft.customGroupColor || "blue";
      } else {
        groupInput.value = "";
        customGroupNameInput.value = "";
      }
      sslInput.checked = Boolean(draft.ssl);
      allowInsecureTlsInput.checked = Boolean(draft.allowInsecureTls);
      if (updatePasswordInput) updatePasswordInput.checked = Boolean(draft.updatePassword || draft.password);
      portTouched = true;
      usernameTouched = true;
      nameTouched = true;
      applyTypeMeta(typeInput.value, false);
      syncGroupFields();
    }
    typeInput.addEventListener("change", () => applyTypeMeta(typeInput.value, true));
    nameInput.addEventListener("input", () => { nameTouched = true; });
    portInput.addEventListener("input", () => { portTouched = true; applyTypeMeta(typeInput.value, false); });
    hostInput.addEventListener("input", () => applyTypeMeta(typeInput.value, false));
    usernameInput.addEventListener("input", () => { usernameTouched = true; });
    groupInput.addEventListener("change", syncGroupFields);
    sslInput.addEventListener("change", () => applyTypeMeta(typeInput.value, false));
    allowInsecureTlsInput.addEventListener("change", () => applyTypeMeta(typeInput.value, false));
    if (updatePasswordInput) {
      updatePasswordInput.addEventListener("change", () => {
        passwordInput.placeholder = updatePasswordInput.checked ? "输入新密码；留空表示保存为空密码" : "留空保持原密码";
      });
    }
    $("#resetBtn").addEventListener("click", resetForm);
    $("#importBtn").addEventListener("click", () => {
      setStatus("正在选择并解析连接配置文件...", "");
      vscode.postMessage({ type: "importConnectionDraft" });
    });
    $("#testBtn").addEventListener("click", () => {
      setStatus("正在测试连接...", "");
      vscode.postMessage({ type: "testConnectionDraft", payload: payload() });
    });
    $("#saveBtn").addEventListener("click", () => {
      setStatus("正在保存连接...", "");
      vscode.postMessage({ type: "saveConnection", payload: payload() });
    });
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "connectionEditorStatus") {
        setStatus(message.message || "", message.ok ? "ok" : message.loading ? "" : "error");
      }
      if (message.type === "connectionEditorImportResult") {
        applyImportedDraft(message.payload);
        setStatus(message.message || "连接信息已导入，请检查后保存。", "ok");
      }
    });
    resetForm();
  </script>
</body>
</html>`;
}

async function pickConnection(store: ConnectionStore, placeHolder: string): Promise<DbConnectionConfig | undefined> {
  const connections = store.getAll();
  if (connections.length === 0) {
    const add = await vscode.window.showInformationMessage("还没有数据库连接，请先添加。", "添加连接");
    if (add === "添加连接") {
      await vscode.commands.executeCommand("databaseWorkbench.addConnection");
    }
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    connections.map((connection) => ({
      label: connection.name,
      description: `${connection.type}://${connection.host}:${connection.port}`,
      detail: connection.username,
      connection,
    })),
    { placeHolder }
  );
  return picked?.connection;
}

async function requireConnection(store: ConnectionStore, connectionId: string) {
  const connection = await store.getWithSecret(connectionId);
  if (!connection) {
    throw new Error("连接配置不存在。");
  }
  return connection;
}

async function promptIdentifier(title: string, value: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    value,
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (!input.trim()) return "名称不能为空。";
      if (input.includes("\0")) {
        return "名称不能包含空字符。";
      }
      return undefined;
    },
  }).then((input) => input?.trim());
}

function quoteIdentifier(type: DatabaseType, identifier: string): string {
  if (type === "mysql") {
    return `\`${identifier.replace(/`/g, "``")}\``;
  }
  if (type !== "postgres") {
    return identifier;
  }
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function getQueryConfigForCommand(): number {
  return vscode.workspace.getConfiguration("databaseWorkbench.query").get("maxRows", 500);
}

function getFilterTargetName(type: DatabaseType): string {
  if (type === "redis") return "DB";
  return "数据库";
}

function getCreateTargetLabel(type: DatabaseType): string {
  if (type === "elasticsearch") return "索引";
  return "数据库";
}

function buildCreateResourcePlan(type: DatabaseType, payload: Record<string, unknown>): { name: string; sql: string; targetLabel: string } {
  const name = asInputString(payload.name);
  if (!name) {
    throw new Error(`${getCreateTargetLabel(type)}名称不能为空。`);
  }
  if (type === "mysql") {
    const charset = asInputString(payload.charset) || "utf8mb4";
    const collation = asInputString(payload.collation) || "utf8mb4_unicode_ci";
    assertBareSqlOption(charset, "字符集");
    assertBareSqlOption(collation, "排序规则");
    return {
      name,
      targetLabel: "数据库",
      sql: `CREATE DATABASE ${quoteIdentifier(type, name)} CHARACTER SET ${charset} COLLATE ${collation};`,
    };
  }
  if (type === "postgres") {
    const encoding = asInputString(payload.encoding) || "UTF8";
    assertBareSqlOption(encoding, "编码");
    return {
      name,
      targetLabel: "数据库",
      sql: `CREATE DATABASE ${quoteIdentifier(type, name)} ENCODING '${escapeSqlString(encoding)}';`,
    };
  }
  if (type === "elasticsearch") {
    assertElasticsearchIndexName(name);
    const body = buildElasticsearchCreateIndexBody(payload);
    return {
      name,
      targetLabel: "索引",
      sql: `PUT /${encodeURIComponent(name)}\n${JSON.stringify(body, null, 2)}`,
    };
  }
  throw new Error("当前连接类型不支持创建。");
}

function assertBareSqlOption(value: string, label: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`${label}只能包含字母、数字和下划线。`);
  }
}

function assertElasticsearchIndexName(name: string): void {
  if (name !== name.toLowerCase()) {
    throw new Error("Elasticsearch 索引名称必须使用小写。");
  }
  if (/[\s\\/*?"<>|,#]/.test(name)) {
    throw new Error("Elasticsearch 索引名称不能包含空格或 \\ / * ? \" < > | , # 等字符。");
  }
  if (/^[-_+]/.test(name) || name === "." || name === "..") {
    throw new Error("Elasticsearch 索引名称不能以 -、_、+ 开头，也不能是 . 或 ..。");
  }
}

function buildElasticsearchCreateIndexBody(payload: Record<string, unknown>): Record<string, unknown> {
  const settings = parseOptionalJsonObject(asInputString(payload.settingsJson), "settings JSON");
  const mappingsInput = parseOptionalJsonObject(asInputString(payload.mappingsJson), "mappings JSON");
  const mappings = extractElasticMappings(mappingsInput);
  const shards = parsePositiveInteger(asInputString(payload.shards));
  const replicas = parseNonNegativeInteger(asInputString(payload.replicas));
  const mergedSettings: Record<string, unknown> = { ...settings };
  if (shards !== undefined) {
    mergedSettings.number_of_shards = shards;
  }
  if (replicas !== undefined) {
    mergedSettings.number_of_replicas = replicas;
  }

  const body: Record<string, unknown> = {};
  if (Object.keys(mergedSettings).length) {
    body.settings = mergedSettings;
  }
  if (mappings && Object.keys(mappings).length) {
    body.mappings = mappings;
  }
  return body;
}

function extractElasticMappings(value: Record<string, unknown>): Record<string, unknown> {
  const mappings = value.mappings;
  if (mappings && typeof mappings === "object" && !Array.isArray(mappings)) {
    return mappings as Record<string, unknown>;
  }
  return value;
}

function parseOptionalJsonObject(value: string, label: string): Record<string, unknown> {
  if (!value.trim()) {
    return {};
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return parsed as Record<string, unknown>;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("分片数必须是大于 0 的整数。");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("副本数必须是大于等于 0 的整数。");
  }
  return parsed;
}

function asInputString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function renderCreateResourceHtml(connection: DbConnectionConfig, targetLabel: string): string {
  const nonce = randomUUID().replace(/-/g, "");
  const isElastic = connection.type === "elasticsearch";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .shell { max-width: 920px; margin: 0 auto; }
    .hero { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; margin-bottom: 18px; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 700; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 13px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 12px; background: var(--vscode-sideBar-background); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th { width: 180px; text-align: left; vertical-align: top; padding: 16px; color: var(--vscode-descriptionForeground); font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-sideBar-background) 84%, var(--vscode-button-background)); }
    td { padding: 14px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    tr:last-child th, tr:last-child td { border-bottom: 0; }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border, transparent); border-radius: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 9px 10px; font-family: var(--vscode-font-family); outline: none; }
    textarea { min-height: 130px; resize: vertical; font-family: var(--vscode-editor-font-family); }
    input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
    .help { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 16px; }
    button { border: 0; border-radius: 8px; padding: 9px 14px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .status { min-height: 20px; flex: 1; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .status.ok { color: var(--vscode-testing-iconPassed); }
    .status.error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <main class="shell">
    <div class="hero">
      <div>
        <h1>创建${escapeHtml(targetLabel)}</h1>
        <div class="meta">${escapeHtml(connection.name)} · ${escapeHtml(connection.type)}://${escapeHtml(connection.host)}:${connection.port}</div>
      </div>
    </div>
    <section class="card">
      <table>
        <tbody>
          <tr>
            <th>${escapeHtml(targetLabel)}名称</th>
            <td>
              <input id="nameInput" placeholder="${isElastic ? "例如：articles-v1" : "例如：app_blog"}" autofocus />
              <div class="help">${isElastic ? "创建后会作为左侧索引节点展示。" : "创建后会作为左侧数据库节点展示。"}</div>
            </td>
          </tr>
          ${renderCreateResourceRows(connection.type)}
        </tbody>
      </table>
    </section>
    <div class="actions">
      <div class="status" id="status"></div>
      <button class="secondary" id="resetBtn">重置</button>
      <button id="submitBtn">提交创建</button>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (selector) => document.querySelector(selector);
    const status = $("#status");
    function setStatus(message, kind) {
      status.textContent = message || "";
      status.className = "status" + (kind ? " " + kind : "");
    }
    function payload() {
      return {
        name: $("#nameInput")?.value || "",
        charset: $("#charsetInput")?.value || "",
        collation: $("#collationInput")?.value || "",
        encoding: $("#encodingInput")?.value || "",
        shards: $("#shardsInput")?.value || "",
        replicas: $("#replicasInput")?.value || "",
        settingsJson: $("#settingsInput")?.value || "",
        mappingsJson: $("#mappingsInput")?.value || "",
      };
    }
    $("#submitBtn").addEventListener("click", () => {
      setStatus("正在提交创建请求...", "");
      vscode.postMessage({ type: "submitCreateResource", payload: payload() });
    });
    $("#resetBtn").addEventListener("click", () => {
      document.querySelectorAll("input, textarea").forEach((item) => item.value = item.dataset.default || "");
      setStatus("", "");
    });
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "createResourceStatus") {
        setStatus(message.message || "", message.ok ? "ok" : message.loading ? "" : "error");
      }
    });
  </script>
</body>
</html>`;
}

function renderCreateResourceRows(type: DatabaseType): string {
  if (type === "mysql") {
    return `
      <tr>
        <th>字符集</th>
        <td><input id="charsetInput" value="utf8mb4" data-default="utf8mb4" /><div class="help">默认使用 utf8mb4。</div></td>
      </tr>
      <tr>
        <th>排序规则</th>
        <td><input id="collationInput" value="utf8mb4_unicode_ci" data-default="utf8mb4_unicode_ci" /><div class="help">例如 utf8mb4_unicode_ci 或 utf8mb4_0900_ai_ci。</div></td>
      </tr>`;
  }
  if (type === "postgres") {
    return `
      <tr>
        <th>编码</th>
        <td><input id="encodingInput" value="UTF8" data-default="UTF8" /><div class="help">默认使用 UTF8。</div></td>
      </tr>`;
  }
  if (type === "elasticsearch") {
    return `
      <tr>
        <th>分片 / 副本</th>
        <td>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <input id="shardsInput" value="1" data-default="1" placeholder="number_of_shards" />
            <input id="replicasInput" value="1" data-default="1" placeholder="number_of_replicas" />
          </div>
          <div class="help">留空则不显式设置，使用 ES 默认值。</div>
        </td>
      </tr>
      <tr>
        <th>Settings JSON</th>
        <td><textarea id="settingsInput" spellcheck="false" placeholder='{ "analysis": { ... } }'></textarea><div class="help">只填写 settings 内部对象即可，分片和副本会自动合并进去。</div></td>
      </tr>
      <tr>
        <th>Mappings JSON</th>
        <td><textarea id="mappingsInput" spellcheck="false" placeholder='{ "properties": { "title": { "type": "text" } } }'></textarea><div class="help">可以填写 mappings 对象，或直接填写 properties 所在的对象。</div></td>
      </tr>`;
  }
  return "";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function showError(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  outputChannel?.appendLine(`${prefix}: ${message}`);
  if (error instanceof Error && error.stack) {
    outputChannel?.appendLine(error.stack);
  }
  vscode.window.showErrorMessage(`${prefix}：${message}`);
}

async function runSafely(prefix: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    showError(prefix, error);
  }
}
