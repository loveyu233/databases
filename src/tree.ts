import * as vscode from "vscode";
import { DatabaseService } from "./database/service";
import { ConnectionStore } from "./storage";
import { ConnectionGroup, ConnectionGroupColor, DatabaseNode, DbConnectionConfig } from "./types";

type DatabaseFilterScope = "database" | "index" | "topic" | "subscription";
const CONNECTION_DRAG_MIME = "application/vnd.databaseWorkbench.connectionIds";
const GROUP_DECORATION_SCHEME = "database-workbench-group";

export type TreeNode =
  | { kind: "group"; group: ConnectionGroup }
  | { kind: "connection"; connection: DbConnectionConfig }
  | { kind: "databaseFilter"; connection: DbConnectionConfig; scope: DatabaseFilterScope; total: number; selected: number }
  | { kind: "database"; connection: DbConnectionConfig; database: string }
  | { kind: "schema"; connection: DbConnectionConfig; database: string; schema: string; tableCount?: number }
  | { kind: "table"; connection: DbConnectionConfig; database: string; table: string; schema?: string; displayName?: string; comment?: string };

export type ActiveTreeSelection =
  | { kind: "database"; connectionId: string; database: string }
  | { kind: "table"; connectionId: string; database: string; table: string };

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly connectionCounts = new Map<string, { selected: number; total: number }>();
  private readonly nodeCache = new Map<string, TreeNode>();
  readonly dragMimeTypes = [CONNECTION_DRAG_MIME];
  readonly dropMimeTypes = [CONNECTION_DRAG_MIME];

  constructor(
    private readonly store: ConnectionStore,
    private readonly databaseService: DatabaseService
  ) {}

  refresh(node?: TreeNode): void {
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "group") {
      const connections = this.store.getAll().filter((connection) => connection.groupId === node.group.id);
      const item = new vscode.TreeItem(node.group.name, vscode.TreeItemCollapsibleState.Expanded);
      const pinned = this.isPinned(node);
      item.description = `${pinned ? "置顶 · " : ""}${connections.length} 个连接`;
      item.tooltip = `分组：${node.group.name}\n${pinned ? "已置顶。\n" : ""}可把连接拖拽到此分组中。`;
      item.contextValue = `databaseWorkbench.group.node.${pinned ? "pinned" : "unpinned"}`;
      item.iconPath = new vscode.ThemeIcon("folder", new vscode.ThemeColor(`databaseWorkbench.group.${node.group.color}`));
      item.resourceUri = getGroupDecorationUri(node.group);
      return item;
    }

    if (node.kind === "connection") {
      const item = new vscode.TreeItem(node.connection.name, vscode.TreeItemCollapsibleState.Collapsed);
      const count = this.connectionCounts.get(node.connection.id);
      const countText = count ? ` [${count.selected}/${count.total}]` : "";
      const pinned = this.isPinned(node);
      item.description = `${pinned ? "置顶 · " : ""}${node.connection.type}://${node.connection.host}:${node.connection.port}${countText}`;
      item.tooltip = `${pinned ? "已置顶。\n" : ""}${node.connection.username}@${node.connection.host}:${node.connection.port}`;
      item.contextValue = `databaseWorkbench.connection.${node.connection.type}.${pinned ? "pinned" : "unpinned"}`;
      item.iconPath = new vscode.ThemeIcon("server-environment");
      return item;
    }

    if (node.kind === "databaseFilter") {
      const target = node.scope === "index" ? "索引" : node.scope === "topic" ? "Topic" : node.scope === "subscription" ? "订阅 Topic" : getDatabaseDescription(node.connection.type);
      const item = new vscode.TreeItem(`[${node.selected}/${node.total}] 选择显示${target}`, vscode.TreeItemCollapsibleState.None);
      item.tooltip = `选择哪些${target}显示在左侧连接树中`;
      item.contextValue = "databaseWorkbench.databaseFilter";
      item.iconPath = new vscode.ThemeIcon("filter");
      item.command = {
        command: "databaseWorkbench.filterDatabases",
        title: `筛选显示${target}`,
        arguments: [node],
      };
      return item;
    }

    if (node.kind === "database") {
      const collapsible = node.connection.type === "redis"
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(node.database, collapsible);
      const pinned = this.isPinned(node);
      item.description = `${pinned ? "置顶 · " : ""}${getDatabaseDescription(node.connection.type)}`;
      item.tooltip = pinned ? `已置顶：${node.database}` : node.database;
      item.contextValue = `databaseWorkbench.database.${node.connection.type}.${pinned ? "pinned" : "unpinned"}`;
      item.iconPath = new vscode.ThemeIcon(node.connection.type === "redis" ? "server-process" : "database");
      if (node.connection.type === "redis") {
        item.command = {
          command: "databaseWorkbench.openDatabase",
          title: "查看 Redis Key",
          arguments: [node],
        };
      }
      return item;
    }

    if (node.kind === "schema") {
      const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = typeof node.tableCount === "number" ? `${node.tableCount} 张表` : "schema";
      item.tooltip = `Schema：${node.schema}`;
      item.contextValue = `databaseWorkbench.schema.${node.connection.type}`;
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
      return item;
    }

    const tableLabel = node.displayName || node.table;
    const item = new vscode.TreeItem(tableLabel, vscode.TreeItemCollapsibleState.None);
    const pinned = this.isPinned(node);
    item.description = `${pinned ? "置顶 · " : ""}${node.comment?.trim() || getTableDescription(node.connection.type)}`;
    item.tooltip = node.comment?.trim()
      ? `${pinned ? "已置顶。\n" : ""}${node.table}\n${node.comment.trim()}`
      : `${pinned ? "已置顶： " : ""}${node.table}`;
    item.contextValue = `databaseWorkbench.table.${node.connection.type}.${pinned ? "pinned" : "unpinned"}`;
    item.iconPath = new vscode.ThemeIcon(node.connection.type === "redis" ? "symbol-key" : node.connection.type === "elasticsearch" ? "symbol-array" : node.connection.type === "mongodb" ? "symbol-object" : node.connection.type === "tdengine" ? "pulse" : node.connection.type === "kafka" || node.connection.type === "mqtt" ? "radio-tower" : "table");
    item.command = {
      command: "databaseWorkbench.openTable",
      title: node.connection.type === "mongodb" ? "查看集合信息" : node.connection.type === "tdengine" ? "查看时序表信息" : node.connection.type === "kafka" ? "查看 Topic 消息" : node.connection.type === "mqtt" ? "订阅 Topic 消息" : "查看表信息",
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const groups = this.store.getGroups();
      const connections = this.store.getAll();
      const groupIds = new Set(groups.map((group) => group.id));
      return [
        ...this.sortPinnedFirst(groups.map((group): TreeNode => this.getCachedNode({ kind: "group", group }))),
        ...this.sortPinnedFirst(connections
          .filter((connection) => !connection.groupId || !groupIds.has(connection.groupId))
          .map((connection): TreeNode => this.getCachedNode({ kind: "connection", connection }))),
      ];
    }

    if (node.kind === "group") {
      return this.sortPinnedFirst(this.store.getAll()
        .filter((connection) => connection.groupId === node.group.id)
        .map((connection): TreeNode => this.getCachedNode({ kind: "connection", connection })));
    }

    if (node.kind === "connection") {
      const connection = await this.store.getWithSecret(node.connection.id);
      if (!connection) {
        return [];
      }

      try {
        const databases = await this.databaseService.listDatabases(connection);
        if (connection.type === "elasticsearch") {
          const indexes = (await this.databaseService.listTableSummaries(connection, "indices")).map((item) => item.name);
          const selectedIndexes = await this.resolveSelectedNames(connection.id, indexes);
          this.updateConnectionCount(node, selectedIndexes.length, indexes.length);
          return [
            this.getCachedNode({ kind: "databaseFilter", connection: node.connection, scope: "index", selected: selectedIndexes.length, total: indexes.length }),
            ...this.sortPinnedFirst(databases.map((database): TreeNode => this.getCachedNode({ kind: "database", connection: node.connection, database }))),
          ];
        }
        if (connection.type === "kafka") {
          const topics = (await this.databaseService.listTableSummaries(connection, "topics")).map((item) => item.name);
          const selectedTopics = await this.resolveSelectedNames(connection.id, topics);
          this.updateConnectionCount(node, selectedTopics.length, topics.length);
          return [
            this.getCachedNode({ kind: "databaseFilter", connection: node.connection, scope: "topic", selected: selectedTopics.length, total: topics.length }),
            ...this.sortPinnedFirst(databases.map((database): TreeNode => this.getCachedNode({ kind: "database", connection: node.connection, database }))),
          ];
        }
        if (connection.type === "mqtt") {
          const topics = (await this.databaseService.listTableSummaries(connection, "subscriptions")).map((item) => item.name);
          const selectedTopics = await this.resolveSelectedNames(connection.id, topics);
          this.updateConnectionCount(node, selectedTopics.length, topics.length);
          return [
            this.getCachedNode({ kind: "databaseFilter", connection: node.connection, scope: "subscription", selected: selectedTopics.length, total: topics.length }),
            ...this.sortPinnedFirst(databases.map((database): TreeNode => this.getCachedNode({ kind: "database", connection: node.connection, database }))),
          ];
        }

        const selectedDatabases = await this.resolveSelectedNames(connection.id, databases);
        this.updateConnectionCount(node, selectedDatabases.length, databases.length);
        return [
          this.getCachedNode({ kind: "databaseFilter", connection: node.connection, scope: "database", selected: selectedDatabases.length, total: databases.length }),
          ...this.sortPinnedFirst(selectedDatabases.map((database): TreeNode => this.getCachedNode({ kind: "database", connection: node.connection, database }))),
        ];
      } catch (error) {
        vscode.window.showErrorMessage(`读取数据库列表失败：${formatError(error)}`);
        return [];
      }
    }

    if (node.kind === "database") {
      if (node.connection.type === "redis") {
        return [];
      }
      const connection = await this.store.getWithSecret(node.connection.id);
      if (!connection) {
        return [];
      }

      try {
        const tables = await this.databaseService.listTableSummaries(connection, node.database);
        if (node.connection.type === "postgres") {
          const schemas = groupPostgresTablesBySchema(tables);
          return this.sortPinnedFirst([...schemas.entries()].map(([schema, schemaTables]) => this.getCachedNode({
            kind: "schema",
            connection: node.connection,
            database: node.database,
            schema,
            tableCount: schemaTables.length,
          })));
        }
        const visibleTables = node.connection.type === "elasticsearch" || node.connection.type === "kafka" || node.connection.type === "mqtt"
          ? filterBySavedNames(tables, this.store.getDatabaseFilter(node.connection.id))
          : tables;
        return this.sortPinnedFirst(visibleTables.map((table) => this.getCachedNode({
          kind: "table",
          connection: node.connection,
          database: node.database,
          table: table.name,
          schema: table.schema,
          displayName: table.displayName,
          comment: table.comment,
        })));
      } catch (error) {
        vscode.window.showErrorMessage(`读取表列表失败：${formatError(error)}`);
        return [];
      }
    }

    if (node.kind === "schema") {
      const connection = await this.store.getWithSecret(node.connection.id);
      if (!connection) {
        return [];
      }
      try {
        const tables = await this.databaseService.listTableSummaries(connection, node.database);
        return this.sortPinnedFirst(tables
          .filter((table) => getPostgresTableSchema(table) === node.schema)
          .map((table) => this.getCachedNode({
            kind: "table",
            connection: node.connection,
            database: node.database,
            table: table.name,
            schema: node.schema,
            displayName: table.displayName || getTableDisplayName(table.name),
            comment: table.comment,
          })));
      } catch (error) {
        vscode.window.showErrorMessage(`读取 ${node.schema} 的表列表失败：${formatError(error)}`);
        return [];
      }
    }

    return [];
  }

  getParent(node: TreeNode): vscode.ProviderResult<TreeNode> {
    if (node.kind === "group") {
      return undefined;
    }

    if (node.kind === "connection") {
      const group = node.connection.groupId
        ? this.store.getGroups().find((item) => item.id === node.connection.groupId)
        : undefined;
      return group ? this.getCachedNode({ kind: "group", group }) : undefined;
    }

    if (node.kind === "database" || node.kind === "databaseFilter") {
      return this.getCachedNode({ kind: "connection", connection: node.connection });
    }

    if (node.kind === "schema") {
      return this.getCachedNode({ kind: "database", connection: node.connection, database: node.database });
    }

    if (node.connection.type === "postgres") {
      return this.getCachedNode({
        kind: "schema",
        connection: node.connection,
        database: node.database,
        schema: node.schema || getPostgresTableSchema({ name: node.table }),
      });
    }

    return this.getCachedNode({ kind: "database", connection: node.connection, database: node.database });
  }

  resolveActiveSelectionNode(selection: ActiveTreeSelection): TreeNode | undefined {
    const connection = this.store.getAll().find((item) => item.id === selection.connectionId);
    if (!connection) {
      return undefined;
    }
    if (selection.kind === "database") {
      return this.getCachedNode({ kind: "database", connection, database: selection.database });
    }
    const schema = connection.type === "postgres" ? getPostgresTableSchema({ name: selection.table }) : undefined;
    return this.getCachedNode({
      kind: "table",
      connection,
      database: selection.database,
      table: selection.table,
      schema,
      displayName: connection.type === "postgres" ? getTableDisplayName(selection.table) : undefined,
    });
  }

  async handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): Promise<void> {
    const connectionIds = source
      .filter((node): node is { kind: "connection"; connection: DbConnectionConfig } => node.kind === "connection")
      .map((node) => node.connection.id);
    if (connectionIds.length) {
      dataTransfer.set(CONNECTION_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(connectionIds)));
    }
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const transferItem = dataTransfer.get(CONNECTION_DRAG_MIME);
    if (!transferItem) {
      return;
    }

    const value = await transferItem.asString();
    const connectionIds = parseDraggedConnectionIds(value);
    if (!connectionIds.length) {
      return;
    }

    const targetGroupId = target?.kind === "group" ? target.group.id : undefined;
    if (target && target.kind !== "group") {
      return;
    }

    await Promise.all(connectionIds.map((connectionId) => this.store.setConnectionGroup(connectionId, targetGroupId)));
    this.refresh();
    const verb = targetGroupId ? `移动到分组「${target?.kind === "group" ? target.group.name : ""}」` : "移出分组";
    vscode.window.setStatusBarMessage(`Database Workbench: 已${verb} ${connectionIds.length} 个连接。`, 2500);
  }

  private async resolveSelectedNames(connectionId: string, available: string[]): Promise<string[]> {
    const saved = this.store.getDatabaseFilter(connectionId);
    if (!saved) {
      return available;
    }

    const availableSet = new Set(available);
    const selected = saved.filter((name) => availableSet.has(name));
    if (selected.length !== saved.length) {
      await this.store.setDatabaseFilter(connectionId, selected);
    }
    return selected;
  }

  private updateConnectionCount(node: { kind: "connection"; connection: DbConnectionConfig }, selected: number, total: number): void {
    const previous = this.connectionCounts.get(node.connection.id);
    this.connectionCounts.set(node.connection.id, { selected, total });
    if (!previous || previous.selected !== selected || previous.total !== total) {
      setTimeout(() => this.refresh(node), 0);
    }
  }

  private isPinned(node: TreeNode): boolean {
    return this.store.isPinnedNodeKey(getTreeNodePinKey(node));
  }

  private getCachedNode<T extends TreeNode>(node: T): T {
    const key = getTreeNodePinKey(node);
    const existing = this.nodeCache.get(key);
    if (existing) {
      Object.assign(existing, node);
      return existing as T;
    }
    this.nodeCache.set(key, node);
    return node;
  }

  private sortPinnedFirst<T extends TreeNode>(nodes: T[]): T[] {
    return nodes
      .map((node, index) => ({ node, index, rank: this.store.getPinnedNodeRank(getTreeNodePinKey(node)) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((item) => item.node);
  }
}

export class ConnectionGroupDecorationProvider implements vscode.FileDecorationProvider {
  private readonly onDidChangeFileDecorationsEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.onDidChangeFileDecorationsEmitter.event;

  refresh(group?: ConnectionGroup): void {
    this.onDidChangeFileDecorationsEmitter.fire(group ? getGroupDecorationUri(group) : undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== GROUP_DECORATION_SCHEME) {
      return undefined;
    }
    const color = normalizeGroupColor(uri.query);
    return new vscode.FileDecoration(undefined, `分组颜色：${getGroupColorLabel(color)}`, new vscode.ThemeColor(`databaseWorkbench.group.${color}`));
  }
}

export function asConnectionNode(value: unknown): { kind: "connection"; connection: DbConnectionConfig } | undefined {
  return isTreeNode(value) && value.kind === "connection" ? value : undefined;
}

export function asGroupNode(value: unknown): { kind: "group"; group: ConnectionGroup } | undefined {
  return isTreeNode(value) && value.kind === "group" ? value : undefined;
}

export function asDatabaseNode(value: unknown): ({ kind: "database"; connection: DbConnectionConfig; database: string } & DatabaseNode) | undefined {
  if (!isTreeNode(value) || value.kind !== "database") {
    return undefined;
  }

  return { ...value, connectionId: value.connection.id };
}

export function asDatabaseFilterNode(value: unknown): { kind: "databaseFilter"; connection: DbConnectionConfig; scope: DatabaseFilterScope; total: number; selected: number } | undefined {
  return isTreeNode(value) && value.kind === "databaseFilter" ? value : undefined;
}

export function asSchemaNode(value: unknown): ({ kind: "schema"; connection: DbConnectionConfig; database: string; schema: string } & DatabaseNode) | undefined {
  if (!isTreeNode(value) || value.kind !== "schema") {
    return undefined;
  }

  return { ...value, connectionId: value.connection.id };
}

export function asTableNode(value: unknown): ({ kind: "table"; connection: DbConnectionConfig; database: string; table: string; schema?: string; displayName?: string } & DatabaseNode) | undefined {
  if (!isTreeNode(value) || value.kind !== "table") {
    return undefined;
  }

  return { ...value, connectionId: value.connection.id };
}

export function getTreeNodePinKey(node: TreeNode): string {
  if (node.kind === "group") {
    return `group:${node.group.id}`;
  }
  if (node.kind === "connection") {
    return `connection:${node.connection.id}`;
  }
  if (node.kind === "database" || node.kind === "databaseFilter") {
    return `database:${node.connection.id}:${encodePinPart(node.kind === "database" ? node.database : "__filter__")}`;
  }
  if (node.kind === "schema") {
    return `schema:${node.connection.id}:${encodePinPart(node.database)}:${encodePinPart(node.schema)}`;
  }
  return `table:${node.connection.id}:${encodePinPart(node.database)}:${encodePinPart(node.table)}`;
}

function isTreeNode(value: unknown): value is TreeNode {
  return Boolean(value && typeof value === "object" && "kind" in value);
}

function groupPostgresTablesBySchema(tables: Array<{ name: string; schema?: string }>): Map<string, Array<{ name: string; schema?: string }>> {
  const grouped = new Map<string, Array<{ name: string; schema?: string }>>();
  for (const table of tables) {
    const schema = getPostgresTableSchema(table);
    const schemaTables = grouped.get(schema) ?? [];
    schemaTables.push(table);
    grouped.set(schema, schemaTables);
  }
  return new Map([...grouped.entries()].sort(([left], [right]) => {
    if (left === "public" && right !== "public") return -1;
    if (right === "public" && left !== "public") return 1;
    return left.localeCompare(right);
  }));
}

function getPostgresTableSchema(table: { name: string; schema?: string }): string {
  if (table.schema) {
    return table.schema;
  }
  const parts = splitDottedIdentifier(table.name);
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "public";
}

function getTableDisplayName(name: string): string {
  const parts = splitDottedIdentifier(name);
  return parts[parts.length - 1] || name;
}

function splitDottedIdentifier(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = false;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ".") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current || !parts.length) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function encodePinPart(value: string): string {
  return encodeURIComponent(value);
}

function getGroupDecorationUri(group: ConnectionGroup): vscode.Uri {
  return vscode.Uri.from({
    scheme: GROUP_DECORATION_SCHEME,
    path: `/${encodeURIComponent(group.id)}`,
    query: group.color,
  });
}

function parseDraggedConnectionIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function normalizeGroupColor(color: string): ConnectionGroupColor {
  return color === "red"
    || color === "orange"
    || color === "yellow"
    || color === "green"
    || color === "blue"
    || color === "purple"
    ? color
    : "blue";
}

function getGroupColorLabel(color: ConnectionGroupColor): string {
  if (color === "red") return "红色";
  if (color === "orange") return "橙色";
  if (color === "yellow") return "黄色";
  if (color === "green") return "绿色";
  if (color === "purple") return "紫色";
  return "蓝色";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDatabaseDescription(type: DbConnectionConfig["type"]): string {
  if (type === "redis") return "Redis DB";
  if (type === "elasticsearch") return "索引空间";
  if (type === "mongodb") return "数据库";
  if (type === "tdengine") return "数据库";
  if (type === "kafka") return "Topic 空间";
  if (type === "mqtt") return "订阅空间";
  return "数据库";
}

function getTableDescription(type: DbConnectionConfig["type"]): string {
  if (type === "redis") return "Key";
  if (type === "elasticsearch") return "Index";
  if (type === "mongodb") return "Collection";
  if (type === "tdengine") return "时序表";
  if (type === "kafka") return "Topic";
  if (type === "mqtt") return "订阅 Topic";
  return "表";
}

function filterBySavedNames<T extends { name: string }>(items: T[], saved: string[] | undefined): T[] {
  if (!saved) {
    return items;
  }
  const selected = new Set(saved);
  return items.filter((item) => selected.has(item.name));
}
