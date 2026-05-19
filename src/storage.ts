import * as vscode from "vscode";
import { ConnectionGroup, ConnectionGroupColor, DbConnectionConfig, DbConnectionWithSecret } from "./types";

const CONNECTIONS_KEY = "databaseWorkbench.connections";
const CONNECTION_GROUPS_KEY = "databaseWorkbench.connectionGroups";
const DATABASE_FILTERS_KEY = "databaseWorkbench.connectionDatabaseFilters";
const PINNED_TREE_NODES_KEY = "databaseWorkbench.pinnedTreeNodes";
const SECRET_PREFIX = "databaseWorkbench.password.";

export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getAll(): DbConnectionConfig[] {
    return this.context.globalState.get<DbConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  get(id: string): DbConnectionConfig | undefined {
    return this.getAll().find((connection) => connection.id === id);
  }

  getGroups(): ConnectionGroup[] {
    return this.context.globalState
      .get<ConnectionGroup[]>(CONNECTION_GROUPS_KEY, [])
      .map(normalizeConnectionGroup)
      .filter((group) => Boolean(group.name));
  }

  getGroup(id: string): ConnectionGroup | undefined {
    return this.getGroups().find((group) => group.id === id);
  }

  async getWithSecret(id: string): Promise<DbConnectionWithSecret | undefined> {
    const config = this.get(id);
    if (!config) {
      return undefined;
    }

    const password = await this.context.secrets.get(`${SECRET_PREFIX}${id}`);
    return { ...config, password: password ?? "" };
  }

  async save(config: DbConnectionConfig, password?: string): Promise<void> {
    const connections = this.getAll();
    const index = connections.findIndex((item) => item.id === config.id);
    const normalized = normalizeConnection(config);

    if (index >= 0) {
      connections[index] = normalized;
    } else {
      connections.push(normalized);
    }

    await this.context.globalState.update(CONNECTIONS_KEY, connections);
    if (password !== undefined) {
      await this.context.secrets.store(`${SECRET_PREFIX}${config.id}`, password);
    }
  }

  async saveGroup(group: ConnectionGroup): Promise<void> {
    const groups = this.getGroups();
    const normalized = normalizeConnectionGroup(group);
    const index = groups.findIndex((item) => item.id === normalized.id);

    if (index >= 0) {
      groups[index] = normalized;
    } else {
      groups.push(normalized);
    }

    await this.context.globalState.update(CONNECTION_GROUPS_KEY, groups);
  }

  async setConnectionGroup(connectionId: string, groupId: string | undefined): Promise<void> {
    const group = groupId ? this.getGroup(groupId) : undefined;
    const connections = this.getAll().map((connection) => connection.id === connectionId
      ? normalizeConnection({ ...connection, groupId: group?.id })
      : connection);
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
  }

  async deleteGroup(groupId: string): Promise<void> {
    const groups = this.getGroups().filter((group) => group.id !== groupId);
    const connections = this.getAll().map((connection) => connection.groupId === groupId
      ? normalizeConnection({ ...connection, groupId: undefined })
      : connection);
    await this.context.globalState.update(CONNECTION_GROUPS_KEY, groups);
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
    await this.removePinnedNodeKeys((key) => key === `group:${groupId}`);
  }

  async delete(id: string): Promise<void> {
    const connections = this.getAll().filter((connection) => connection.id !== id);
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
    await this.context.secrets.delete(`${SECRET_PREFIX}${id}`);

    const filters = this.getDatabaseFilters();
    if (id in filters) {
      delete filters[id];
      await this.context.globalState.update(DATABASE_FILTERS_KEY, filters);
    }

    await this.removePinnedNodeKeys((key) =>
      key === `connection:${id}` || key.startsWith(`database:${id}:`) || key.startsWith(`table:${id}:`)
    );
  }

  getPinnedNodeKeys(): string[] {
    return this.context.globalState
      .get<string[]>(PINNED_TREE_NODES_KEY, [])
      .filter((key) => typeof key === "string" && Boolean(key));
  }

  isPinnedNodeKey(key: string): boolean {
    return this.getPinnedNodeKeys().includes(key);
  }

  getPinnedNodeRank(key: string): number {
    const index = this.getPinnedNodeKeys().indexOf(key);
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  }

  async pinNodeKey(key: string): Promise<void> {
    const normalized = key.trim();
    if (!normalized) {
      return;
    }
    const keys = this.getPinnedNodeKeys().filter((item) => item !== normalized);
    await this.context.globalState.update(PINNED_TREE_NODES_KEY, [normalized, ...keys]);
  }

  async unpinNodeKey(key: string): Promise<void> {
    await this.removePinnedNodeKeys((item) => item === key);
  }

  getDatabaseFilter(connectionId: string): string[] | undefined {
    const value = this.getDatabaseFilters()[connectionId];
    return Array.isArray(value) ? value : undefined;
  }

  async setDatabaseFilter(connectionId: string, selected: string[]): Promise<void> {
    const filters = this.getDatabaseFilters();
    filters[connectionId] = Array.from(new Set(selected));
    await this.context.globalState.update(DATABASE_FILTERS_KEY, filters);
  }

  private getDatabaseFilters(): Record<string, string[]> {
    return this.context.globalState.get<Record<string, string[]>>(DATABASE_FILTERS_KEY, {});
  }

  private async removePinnedNodeKeys(shouldRemove: (key: string) => boolean): Promise<void> {
    const keys = this.getPinnedNodeKeys().filter((key) => !shouldRemove(key));
    await this.context.globalState.update(PINNED_TREE_NODES_KEY, keys);
  }
}

function normalizeConnection(config: DbConnectionConfig): DbConnectionConfig {
  return {
    ...config,
    name: config.name.trim(),
    host: config.host.trim(),
    username: config.username.trim(),
    database: config.database?.trim() || undefined,
    groupId: config.groupId?.trim() || undefined,
    port: Number(config.port),
    ssl: Boolean(config.ssl),
    allowInsecureTls: Boolean(config.allowInsecureTls),
  };
}

function normalizeConnectionGroup(group: ConnectionGroup): ConnectionGroup {
  return {
    id: group.id,
    name: group.name.trim(),
    color: normalizeConnectionGroupColor(group.color),
  };
}

export function normalizeConnectionGroupColor(color: unknown): ConnectionGroupColor {
  return color === "red"
    || color === "orange"
    || color === "yellow"
    || color === "green"
    || color === "blue"
    || color === "purple"
    ? color
    : "blue";
}
