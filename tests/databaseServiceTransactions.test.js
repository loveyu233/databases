const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const calls = [];

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

function makeMysqlConnection() {
  return {
    async ping() {},
    async end() {
      calls.push("mysql:END");
    },
    async query(sql) {
      calls.push("mysql:" + sql);
      if (/FAIL/i.test(sql)) {
        throw new Error("mysql boom");
      }
      if (/^select\b/i.test(String(sql).trim())) {
        return [[{ id: 1 }], [{ name: "id" }]];
      }
      return [{ affectedRows: 1, insertId: 0, changedRows: 0 }, []];
    },
  };
}

class FakePgClient {
  async connect() {
    calls.push("pg:CONNECT");
  }

  async end() {
    calls.push("pg:END");
  }

  async query(sql) {
    calls.push("pg:" + sql);
    if (/FAIL/i.test(sql)) {
      throw new Error("pg boom");
    }
    return { rows: [], fields: [], rowCount: 1, command: "UPDATE" };
  }
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return fakeVscode;
  }
  if (request === "mysql2/promise") {
    return {
      createConnection: async () => makeMysqlConnection(),
    };
  }
  if (request === "pg") {
    return { Client: FakePgClient };
  }
  return originalLoad.apply(this, arguments);
};

const { DatabaseService } = require("../out/database/clients");

async function run() {
  const service = new DatabaseService();
  const mysqlConnection = { id: "mysql", name: "mysql", type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "" };
  const pgConnection = { id: "pg", name: "pg", type: "postgres", host: "127.0.0.1", port: 5432, username: "postgres", password: "" };

  calls.length = 0;
  await service.queryStatements(mysqlConnection, "db", ["UPDATE a SET b = 1", "UPDATE a SET b = 2"], 100);
  assert.deepEqual(calls, [
    "mysql:START TRANSACTION",
    "mysql:UPDATE a SET b = 1",
    "mysql:UPDATE a SET b = 2",
    "mysql:COMMIT",
    "mysql:END",
  ]);

  calls.length = 0;
  let mysqlError;
  try {
    await service.queryStatements(mysqlConnection, "db", ["UPDATE a SET b = 1", "FAIL"], 100);
  } catch (error) {
    mysqlError = error;
  }
  assert.match(mysqlError.message, /mysql boom/);
  assert.equal(mysqlError.failedIndex, 1);
  assert.equal(mysqlError.results.length, 1);
  assert.deepEqual(calls, [
    "mysql:START TRANSACTION",
    "mysql:UPDATE a SET b = 1",
    "mysql:FAIL",
    "mysql:ROLLBACK",
    "mysql:END",
  ]);

  calls.length = 0;
  await service.queryStatements(pgConnection, "db", ["UPDATE a SET b = 1", "UPDATE a SET b = 2"], 100);
  assert.deepEqual(calls, [
    "pg:CONNECT",
    "pg:BEGIN",
    "pg:UPDATE a SET b = 1",
    "pg:UPDATE a SET b = 2",
    "pg:COMMIT",
    "pg:END",
  ]);

  console.log("ok - DatabaseService 多语句使用事务执行");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
