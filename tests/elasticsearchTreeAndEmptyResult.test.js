const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const originalLoad = Module._load;
const requests = [];

const fakeVscode = {
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: {
    from(value) {
      return value;
    },
  },
  window: {
    showErrorMessage() {},
  },
  workspace: {
    getConfiguration() {
      return {
        get(_key, fallback) {
          return fallback;
        },
      };
    },
  },
};

function makeHttpModule() {
  return {
    request(options, callback) {
      const request = new EventEmitter();
      let payload = "";
      request.write = (chunk) => {
        payload += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      };
      request.end = () => {
        requests.push({ method: options.method, path: options.path, body: payload });
        const response = new EventEmitter();
        response.statusCode = 200;
        setImmediate(() => {
          callback(response);
          response.emit("data", Buffer.from(JSON.stringify(routeElasticResponse(options.method, options.path, payload))));
          response.emit("end");
        });
      };
      request.setTimeout = () => request;
      request.destroy = (error) => {
        if (error) request.emit("error", error);
      };
      return request;
    },
  };
}

function routeElasticResponse(method, path) {
  if (method === "GET" && path === "/") {
    return { ok: true };
  }
  if (method === "GET" && path.startsWith("/_cat/indices")) {
    return [
      { index: "logs.2026.05", "docs.count": "0", "store.size": "225b", health: "green", status: "open" },
    ];
  }
  if (method === "GET" && path === "/logs.2026.05/_mapping") {
    return {
      "logs.2026.05": {
        mappings: {
          properties: {
            message: { type: "text" },
            status: { type: "keyword" },
            user: {
              properties: {
                id: { type: "keyword" },
              },
            },
          },
        },
      },
    };
  }
  if (method === "POST" && path === "/logs.2026.05/_search") {
    return { hits: { total: { value: 0 }, hits: [] } };
  }
  throw new Error(`未模拟的 Elasticsearch 请求：${method} ${path}`);
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return fakeVscode;
  }
  if (request === "http" || request === "https") {
    return makeHttpModule();
  }
  return originalLoad.apply(this, arguments);
};

const { DatabaseService } = require("../out/database/service");
const { ConnectionsTreeProvider } = require("../out/tree");

const connection = {
  id: "es",
  name: "Local ES",
  type: "elasticsearch",
  host: "127.0.0.1",
  port: 9200,
  username: "",
};

const store = {
  getGroups: () => [],
  getAll: () => [connection],
  getWithSecret: async () => ({ ...connection, password: "" }),
  getDatabaseFilter: () => undefined,
  isPinnedNodeKey: () => false,
  getPinnedNodeRank: () => Number.MAX_SAFE_INTEGER,
};

(async () => {
  const service = new DatabaseService();
  const summaries = await service.listTableSummaries({ ...connection, password: "" }, "indices");
  assert.equal(summaries[0].name, "logs.2026.05");

  const provider = new ConnectionsTreeProvider(store, {
    listTableSummaries: async () => summaries,
  });
  const tableNodes = await provider.getChildren({ kind: "database", connection, database: "indices" });
  const item = provider.getTreeItem(tableNodes[0]);
  assert.equal(item.label, "logs.2026.05", "ES 索引名包含点号时左侧树应展示完整索引名");

  const result = await service.query(
    { ...connection, password: "" },
    "indices",
    'POST /logs.2026.05/_search\n{"query":{"match_all":{}}}',
    30
  );
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.columns, ["_id", "message", "status", "user", "user.id"]);
  assert.ok(requests.some((request) => request.path === "/logs.2026.05/_mapping"), "空结果应读取 mapping 作为表头");

  console.log("ok - Elasticsearch 索引树和空结果表头");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
