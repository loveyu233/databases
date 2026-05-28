const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const originalLoad = Module._load;
const calls = [];
const repoLogDirectory = path.join(__dirname, "..", "logs");

class FakeWSConfig {
  constructor(url) {
    this.url = url;
    this.user = "";
    this.password = "";
    this.database = "";
    this.timeout = 0;
  }

  setUser(user) {
    this.user = user;
  }

  setPwd(password) {
    this.password = password;
  }

  setDb(database) {
    this.database = database;
  }

  setTimeOut(timeout) {
    this.timeout = timeout;
  }
}

class FakeWsSql {
  async version() {
    calls.push(["version"]);
    return "3.3.0.0";
  }

  async query(sql, reqId) {
    calls.push(["query", sql, reqId]);
    const normalized = sql.trim();
    if (/^SHOW DATABASES$/i.test(normalized)) {
      return makeRows([{ name: "name" }], [["information_schema"], ["power"], ["telemetry"]]);
    }
    if (/^SHOW STABLES$/i.test(normalized)) {
      return makeRows([{ name: "stable_name" }], [["meters"]]);
    }
    if (/^SHOW TABLES$/i.test(normalized)) {
      return makeRows([{ name: "table_name" }], [["d1001"], ["meters"]]);
    }
    if (/^DESCRIBE `meters`$/i.test(normalized)) {
      return makeRows(
        [{ name: "Field" }, { name: "Type" }, { name: "Length" }, { name: "Note" }],
        [
          ["ts", "TIMESTAMP", 8, ""],
          ["current", "FLOAT", 4, ""],
          ["location", "BINARY", 64, "TAG"],
        ]
      );
    }
    if (/^DESCRIBE `d1001`$/i.test(normalized)) {
      return makeRows(
        [{ name: "Field" }, { name: "Type" }, { name: "Length" }, { name: "Note" }],
        [
          ["ts", "TIMESTAMP", 8, ""],
          ["current", "FLOAT", 4, ""],
        ]
      );
    }
    if (/^SHOW CREATE STABLE `meters`$/i.test(normalized)) {
      return makeRows(
        [{ name: "Table" }, { name: "Create Table" }],
        [["meters", "CREATE STABLE `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`location` BINARY(64))"]]
      );
    }
    if (/^SELECT \* FROM `meters` LIMIT 5$/i.test(normalized)) {
      return makeRows(
        [{ name: "ts" }, { name: "current" }, { name: "counter" }],
        [[new Date("2026-05-28T00:00:00.000Z"), 10.5, 12n]]
      );
    }
    if (/^SELECT \* FROM `empty` LIMIT 3$/i.test(normalized)) {
      return makeRows([{ name: "ts" }, { name: "value" }], []);
    }
    throw new Error("unexpected TDengine query: " + sql);
  }

  async exec(sql, reqId) {
    calls.push(["exec", sql, reqId]);
    return { getAffectRows: () => 2 };
  }

  async close() {
    calls.push(["close"]);
  }
}

function makeRows(meta, data) {
  let index = -1;
  return {
    getMeta() {
      return meta;
    },
    async next() {
      index += 1;
      return index < data.length;
    },
    getData() {
      return data[index];
    },
    async close() {
      calls.push(["rowsClose"]);
    },
  };
}

const fakeVscode = {
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

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return fakeVscode;
  }
  if (request === "@tdengine/websocket") {
    const RotateFile = require("winston-daily-rotate-file");
    const transport = new RotateFile({ filename: "./logs/app-%DATE%.log", level: "info" });
    calls.push(["tdengineLogSilent", transport.silent]);
    return {
      WSConfig: FakeWSConfig,
      setLogLevel: (level) => {
        calls.push(["setLogLevel", level]);
      },
      sqlConnect: async (config) => {
        calls.push(["connect", { ...config }]);
        return new FakeWsSql();
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { DatabaseService } = require("../out/database/service");

async function run() {
  fs.rmSync(repoLogDirectory, { recursive: true, force: true });
  const service = new DatabaseService();
  const connection = {
    id: "td",
    name: "td",
    type: "tdengine",
    host: "127.0.0.1",
    port: 6041,
    username: "root",
    password: "taosdata",
  };

  calls.length = 0;
  const databases = await service.listDatabases(connection);
  assert.deepEqual(databases, ["power", "telemetry"]);
  assert.deepEqual(calls.find((item) => item[0] === "tdengineLogSilent"), ["tdengineLogSilent", true]);
  assert.equal(fs.existsSync(repoLogDirectory), false);
  assert.deepEqual(calls.find((item) => item[0] === "connect"), [
    "connect",
    {
      url: "ws://127.0.0.1:6041",
      user: "root",
      password: "taosdata",
      database: "",
      timeout: 30000,
    },
  ]);

  calls.length = 0;
  const schema = await service.loadSchema(connection, "power");
  assert.deepEqual(schema.map((table) => table.name), ["d1001", "meters"]);
  assert.deepEqual(schema.find((table) => table.name === "meters").columns.map((column) => [column.name, column.type, column.key, column.comment]), [
    ["ts", "TIMESTAMP", "PRI", ""],
    ["current", "FLOAT", undefined, ""],
    ["location", "BINARY(64)", undefined, "TAG"],
  ]);

  calls.length = 0;
  const ddl = await service.getCreateTableSql(connection, "power", "meters");
  assert.equal(ddl, "CREATE STABLE `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`location` BINARY(64));");

  calls.length = 0;
  const preview = await service.previewTable(connection, "power", "meters", 5);
  assert.equal(preview.sql, "SELECT * FROM `meters` LIMIT 5");
  assert.deepEqual(preview.result.columns, ["ts", "current", "counter"]);
  assert.equal(preview.result.rows[0].ts, "2026-05-28T00:00:00.000Z");
  assert.equal(preview.result.rows[0].counter, "12");

  calls.length = 0;
  const empty = await service.query(connection, "power", "SELECT * FROM `empty`", 3);
  assert.deepEqual(empty.columns, ["ts", "value"]);
  assert.deepEqual(empty.rows, []);

  calls.length = 0;
  const created = await service.queryAdmin(connection, "CREATE DATABASE `iot`;", 30);
  assert.equal(created.affectedRows, 2);
  assert.deepEqual(calls.find((item) => item[0] === "exec").slice(1), ["CREATE DATABASE `iot`;", 2]);

  console.log("ok - DatabaseService TDengine 连接、结构和查询");
  fs.rmSync(repoLogDirectory, { recursive: true, force: true });
}

run().catch((error) => {
  console.error(error);
  fs.rmSync(repoLogDirectory, { recursive: true, force: true });
  process.exitCode = 1;
});
