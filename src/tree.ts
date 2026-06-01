import * as vscode from "vscode";
import { DatabaseService } from "./database/service";
import { ConnectionStore } from "./storage";
import { ConnectionGroup, ConnectionGroupColor, DatabaseNode, DatabaseType, DbConnectionConfig } from "./types";

type DatabaseFilterScope = "database" | "index" | "topic" | "subscription" | "key";
const CONNECTION_DRAG_MIME = "application/vnd.databaseWorkbench.connectionIds";
const GROUP_DECORATION_SCHEME = "database-workbench-group";
const GROUP_LABEL_MARK = "▌";
const GROUP_DECORATION_BADGE = "组";
const GROUP_SPACER_PREFIX = "group-spacer:";
const CONNECTION_ICON_FILES: Record<DatabaseType, string> = {
  mysql: "mysql.svg",
  postgres: "postgres.svg",
  redis: "redis.svg",
  elasticsearch: "elasticsearch.svg",
  mongodb: "mongodb.svg",
  tdengine: "tdengine.svg",
  kafka: "kafka.svg",
  mqtt: "mqtt.svg",
  etcd: "etcd.svg",
};
const GROUP_ICON_FILES: Record<ConnectionGroupColor, string> = {
  red: "group-red.svg",
  orange: "group-orange.svg",
  yellow: "group-yellow.svg",
  green: "group-green.svg",
  blue: "group-blue.svg",
  purple: "group-purple.svg",
};

export type TreeNode =
  | { kind: "group"; group: ConnectionGroup }
  | { kind: "groupSpacer"; id: string }
  | { kind: "searchEmpty"; query: string }
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
  private connectionSearchQuery = "";
  private readonly connectionCounts = new Map<string, { selected: number; total: number }>();
  private readonly nodeCache = new Map<string, TreeNode>();
  readonly dragMimeTypes = [CONNECTION_DRAG_MIME];
  readonly dropMimeTypes = [CONNECTION_DRAG_MIME];

  constructor(
    private readonly store: ConnectionStore,
    private readonly databaseService: DatabaseService,
    private readonly extensionUri?: vscode.Uri
  ) {}

  getConnectionSearchQuery(): string {
    return this.connectionSearchQuery;
  }

  setConnectionSearchQuery(query: string): void {
    const nextQuery = normalizeConnectionSearchQuery(query);
    if (this.connectionSearchQuery === nextQuery) {
      return;
    }
    this.connectionSearchQuery = nextQuery;
    this.refresh();
  }

  refresh(node?: TreeNode): void {
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "searchEmpty") {
      const item = new vscode.TreeItem("未找到匹配连接", vscode.TreeItemCollapsibleState.None);
      item.description = `“${node.query}”`;
      item.tooltip = "没有匹配的连接。点击后可重新搜索，或清空搜索内容恢复全部连接。";
      item.contextValue = "databaseWorkbench.connectionSearchEmpty";
      item.iconPath = new vscode.ThemeIcon("search");
      item.command = {
        command: "databaseWorkbench.searchConnections",
        title: "重新搜索连接",
      };
      return item;
    }

    if (node.kind === "groupSpacer") {
      const item = new vscode.TreeItem(" ", vscode.TreeItemCollapsibleState.None);
      item.id = `${GROUP_SPACER_PREFIX}${node.id}`;
      item.contextValue = "databaseWorkbench.groupSpacer";
      item.iconPath = this.getTreeIcon("spacer.svg", "blank");
      item.accessibilityInformation = { label: "分组间距", role: "treeitem" };
      return item;
    }

    if (node.kind === "group") {
      const connections = this.getGroupConnections(node.group);
      const visibleConnections = this.getVisibleGroupConnections(node.group, connections);
      const item = new vscode.TreeItem(buildGroupTreeLabel(node.group.name), vscode.TreeItemCollapsibleState.Expanded);
      const pinned = this.isPinned(node);
      item.id = getTreeNodePinKey(node);
      const countText = this.hasConnectionSearchQuery()
        ? `筛选 · ${visibleConnections.length}/${connections.length} 个连接`
        : `分组 · ${connections.length} 个连接`;
      item.description = `${pinned ? "置顶 · " : ""}${countText}`;
      item.tooltip = `分组：${node.group.name}\n${pinned ? "已置顶。\n" : ""}可把连接拖拽到此分组中。`;
      item.contextValue = `databaseWorkbench.group.node.${pinned ? "pinned" : "unpinned"}`;
      item.iconPath = this.getGroupIcon(node.group.color);
      item.resourceUri = getGroupDecorationUri(node.group);
      item.accessibilityInformation = { label: `分组 ${node.group.name}，${connections.length} 个连接`, role: "treeitem" };
      return item;
    }

    if (node.kind === "connection") {
      const item = new vscode.TreeItem(node.connection.name, vscode.TreeItemCollapsibleState.Collapsed);
      const count = this.connectionCounts.get(node.connection.id);
      const countText = count ? ` [${count.selected}/${count.total}]` : "";
      const pinned = this.isPinned(node);
      item.description = `${pinned ? "置顶 · " : ""}${getConnectionTypeLabel(node.connection.type)}://${node.connection.host}:${node.connection.port}${countText}`;
      item.tooltip = `${pinned ? "已置顶。\n" : ""}${node.connection.username}@${node.connection.host}:${node.connection.port}`;
      item.contextValue = `databaseWorkbench.connection.${node.connection.type}.${pinned ? "pinned" : "unpinned"}`;
      item.iconPath = this.getConnectionIcon(node.connection.type);
      return item;
    }

    if (node.kind === "databaseFilter") {
      const target = node.scope === "index" ? "索引" : node.scope === "topic" ? "Topic" : node.scope === "subscription" ? "订阅 Topic" : node.scope === "key" ? "Key" : getDatabaseDescription(node.connection.type);
      const item = new vscode.TreeItem(`[${node.selected}/${node.total}] 选择显示${target}`, vscode.TreeItemCollapsibleState.None);
      item.tooltip = `选择哪些${target}显示在左侧连接树中`;
      item.contextValue = "databaseWorkbench.databaseFilter";
      item.iconPath = this.getTreeIcon("filter.svg", "filter");
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
      item.iconPath = this.getDatabaseIcon(node.connection.type);
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
      item.iconPath = this.getTreeIcon("schema.svg", "symbol-namespace");
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
    item.iconPath = this.getTableIcon(node.connection.type);
    item.command = {
      command: "databaseWorkbench.openTable",
      title: node.connection.type === "mongodb" ? "查看集合信息" : node.connection.type === "tdengine" ? "查看时序表信息" : node.connection.type === "kafka" ? "查看 Topic 消息" : node.connection.type === "mqtt" ? "订阅 Topic 消息" : node.connection.type === "etcd" ? "查看 Key 信息" : "查看表信息",
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const groups = this.store.getGroups();
      const connections = this.store.getAll();
      const groupIds = new Set(groups.map((group) => group.id));
      const visibleGroups = groups.filter((group) => this.shouldShowGroup(group, connections));
      const nodes: TreeNode[] = [
        ...this.withGroupTopSpacing(this.sortPinnedFirst(visibleGroups.map((group) => this.getCachedNode({ kind: "group", group })))),
        ...this.sortPinnedFirst(connections
          .filter((connection) => !connection.groupId || !groupIds.has(connection.groupId))
          .filter((connection) => this.matchesConnectionSearch(connection))
          .map((connection): TreeNode => this.getCachedNode({ kind: "connection", connection }))),
      ];
      if (!nodes.length && this.hasConnectionSearchQuery()) {
        return [{ kind: "searchEmpty", query: this.connectionSearchQuery }];
      }
      return nodes;
    }

    if (node.kind === "group") {
      return this.sortPinnedFirst(this.getVisibleGroupConnections(node.group)
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
        if (connection.type === "etcd") {
          const keys = (await this.databaseService.listTableSummaries(connection, "keys")).map((item) => item.name);
          const selectedKeys = await this.resolveSelectedNames(connection.id, keys);
          this.updateConnectionCount(node, selectedKeys.length, keys.length);
          return [
            this.getCachedNode({ kind: "databaseFilter", connection: node.connection, scope: "key", selected: selectedKeys.length, total: keys.length }),
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
        const visibleTables = node.connection.type === "elasticsearch" || node.connection.type === "kafka" || node.connection.type === "mqtt" || node.connection.type === "etcd"
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
    if (node.kind === "searchEmpty") {
      return undefined;
    }

    if (node.kind === "groupSpacer") {
      return undefined;
    }

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

  private getConnectionIcon(type: DatabaseType): vscode.ThemeIcon | vscode.Uri {
    if (!this.extensionUri) {
      return new vscode.ThemeIcon(getConnectionFallbackIcon(type));
    }
    return vscode.Uri.joinPath(this.extensionUri, "assets", "icons", CONNECTION_ICON_FILES[type]);
  }

  private getGroupIcon(color: ConnectionGroupColor): vscode.ThemeIcon | vscode.Uri {
    return this.getTreeIcon(GROUP_ICON_FILES[color], "folder", `databaseWorkbench.group.${color}`);
  }

  private getDatabaseIcon(type: DatabaseType): vscode.ThemeIcon | vscode.Uri {
    if (type === "redis") return this.getTreeIcon("redis-db.svg", "server-process");
    if (type === "elasticsearch") return this.getTreeIcon("index-space.svg", "symbol-array");
    if (type === "tdengine") return this.getTreeIcon("timeseries-table.svg", "pulse");
    if (type === "kafka") return this.getTreeIcon("topic-space.svg", "radio-tower");
    if (type === "mqtt") return this.getTreeIcon("subscription-space.svg", "radio-tower");
    if (type === "etcd") return this.getTreeIcon("key-space.svg", "key");
    return this.getTreeIcon("database.svg", "database");
  }

  private getTableIcon(type: DatabaseType): vscode.ThemeIcon | vscode.Uri {
    if (type === "redis" || type === "etcd") return this.getTreeIcon("key.svg", "symbol-key");
    if (type === "elasticsearch") return this.getTreeIcon("index.svg", "symbol-array");
    if (type === "mongodb") return this.getTreeIcon("collection.svg", "symbol-object");
    if (type === "tdengine") return this.getTreeIcon("timeseries-table.svg", "pulse");
    if (type === "kafka") return this.getTreeIcon("topic.svg", "radio-tower");
    if (type === "mqtt") return this.getTreeIcon("subscription.svg", "radio-tower");
    return this.getTreeIcon("table.svg", "table");
  }

  private getTreeIcon(file: string, fallback: string, fallbackColor?: string): vscode.ThemeIcon | vscode.Uri {
    if (!this.extensionUri) {
      return new vscode.ThemeIcon(fallback, fallbackColor ? new vscode.ThemeColor(fallbackColor) : undefined);
    }
    return vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "tree", file);
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

  private hasConnectionSearchQuery(): boolean {
    return Boolean(this.connectionSearchQuery);
  }

  private getGroupConnections(group: ConnectionGroup): DbConnectionConfig[] {
    return this.store.getAll().filter((connection) => connection.groupId === group.id);
  }

  private getVisibleGroupConnections(group: ConnectionGroup, connections = this.getGroupConnections(group)): DbConnectionConfig[] {
    if (!this.hasConnectionSearchQuery() || this.matchesGroupSearch(group)) {
      return connections;
    }
    return connections.filter((connection) => this.matchesConnectionSearch(connection, group));
  }

  private shouldShowGroup(group: ConnectionGroup, connections: DbConnectionConfig[]): boolean {
    if (!this.hasConnectionSearchQuery() || this.matchesGroupSearch(group)) {
      return true;
    }
    return connections.some((connection) => connection.groupId === group.id && this.matchesConnectionSearch(connection, group));
  }

  private matchesGroupSearch(group: ConnectionGroup): boolean {
    return matchesConnectionSearchQuery(this.connectionSearchQuery, group.name);
  }

  private matchesConnectionSearch(connection: DbConnectionConfig, group?: ConnectionGroup): boolean {
    return matchesConnectionSearchQuery(this.connectionSearchQuery, buildConnectionSearchText(connection, group));
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

  private withGroupTopSpacing(nodes: Array<{ kind: "group"; group: ConnectionGroup }>): TreeNode[] {
    return nodes.flatMap((node, index) => index === 0
      ? [node]
      : [{ kind: "groupSpacer", id: node.group.id }, node]);
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
    return new vscode.FileDecoration(GROUP_DECORATION_BADGE, `分组颜色：${getGroupColorLabel(color)}`, new vscode.ThemeColor(`databaseWorkbench.group.${color}`));
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
  if (node.kind === "searchEmpty") {
    return `connection-search-empty:${encodePinPart(node.query)}`;
  }
  if (node.kind === "groupSpacer") {
    return `${GROUP_SPACER_PREFIX}${node.id}`;
  }
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

function buildGroupTreeLabel(name: string): vscode.TreeItemLabel {
  const label = `${GROUP_LABEL_MARK} ${name}`;
  return {
    label,
    highlights: [[0, GROUP_LABEL_MARK.length]],
  };
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
  if (type === "etcd") return "Key 空间";
  return "数据库";
}

function getTableDescription(type: DbConnectionConfig["type"]): string {
  if (type === "redis") return "Key";
  if (type === "elasticsearch") return "Index";
  if (type === "mongodb") return "Collection";
  if (type === "tdengine") return "时序表";
  if (type === "kafka") return "Topic";
  if (type === "mqtt") return "订阅 Topic";
  if (type === "etcd") return "Key";
  return "表";
}

function getConnectionFallbackIcon(type: DatabaseType): string {
  if (type === "redis" || type === "etcd") return "symbol-key";
  if (type === "elasticsearch") return "symbol-array";
  if (type === "mongodb") return "symbol-object";
  if (type === "tdengine") return "pulse";
  if (type === "kafka" || type === "mqtt") return "radio-tower";
  if (type === "postgres") return "elephant";
  return "database";
}

function getConnectionTypeLabel(type: DatabaseType): string {
  return type === "etcd" ? "ETCD" : type;
}

function normalizeConnectionSearchQuery(value: string): string {
  return String(value || "").trim();
}

function matchesConnectionSearchQuery(query: string, text: string): boolean {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return true;
  }
  const searchText = normalizeSearchText(text);
  return terms.every((term) => searchText.includes(term));
}

function buildConnectionSearchText(connection: DbConnectionConfig, group?: ConnectionGroup): string {
  return [
    connection.name,
    connection.type,
    getConnectionTypeLabel(connection.type),
    getConnectionTypeSearchAliases(connection.type),
    connection.host,
    String(connection.port),
    connection.username,
    connection.database,
    group?.name,
  ].filter(Boolean).join(" ");
}

function normalizeSearchText(value: string): string {
  return String(value || "").toLocaleLowerCase();
}

function getConnectionTypeSearchAliases(type: DatabaseType): string {
  if (type === "mysql") return "MySQL";
  if (type === "postgres") return "PostgreSQL postgres pgsql";
  if (type === "redis") return "Redis";
  if (type === "elasticsearch") return "Elasticsearch ES";
  if (type === "mongodb") return "MongoDB Mongo";
  if (type === "tdengine") return "TDengine TD";
  if (type === "kafka") return "Kafka";
  if (type === "mqtt") return "MQTT";
  return "ETCD etcd";
}

function filterBySavedNames<T extends { name: string }>(items: T[], saved: string[] | undefined): T[] {
  if (!saved) {
    return items;
  }
  const selected = new Set(saved);
  return items.filter((item) => selected.has(item.name));
}
