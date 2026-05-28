const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const calls = [];

class FakeObjectId {
  constructor(value) {
    this.value = value;
  }

  toHexString() {
    return this.value;
  }

  toString() {
    return this.value;
  }
}

function parseEjson(text) {
  return JSON.parse(text, (_key, value) => {
    if (value && typeof value === "object" && typeof value.$oid === "string") {
      return new FakeObjectId(value.$oid);
    }
    if (value && typeof value === "object" && typeof value.$date === "string") {
      return new Date(value.$date);
    }
    return value;
  });
}

class FakeMongoClient {
  constructor(uri, options) {
    calls.push(["connectOptions", uri, options]);
  }

  async connect() {
    calls.push(["connect"]);
  }

  db(name) {
    calls.push(["db", name]);
    return {
      admin: () => ({
        listDatabases: async () => ({
          databases: [{ name: "admin" }, { name: "app" }, { name: "logs" }],
        }),
      }),
      command: async (document) => {
        calls.push(["command", document]);
        return { ok: 1 };
      },
      collection: (collectionName) => makeCollection(collectionName),
      createCollection: async (collectionName) => ({ collectionName }),
      listCollections: () => ({
        toArray: async () => [
          { name: "users", type: "collection", options: {} },
          { name: "system.profile", type: "collection", options: {} },
        ],
      }),
    };
  }

  async close() {
    calls.push(["close"]);
  }
}

function makeCollection(collectionName) {
  return {
    find(filter, options) {
      calls.push(["find", collectionName, filter, options]);
      const cursor = {
        sort(sort) {
          calls.push(["sort", sort]);
          return cursor;
        },
        skip(skip) {
          calls.push(["skip", skip]);
          return cursor;
        },
        limit(limit) {
          calls.push(["limit", limit]);
          return cursor;
        },
        async toArray() {
          return [{ _id: new FakeObjectId("64f000000000000000000001"), name: "Alice", profile: { level: 1 } }];
        },
      };
      return cursor;
    },
    async createIndex(keys, options) {
      calls.push(["createIndex", collectionName, keys, options]);
      return options?.name || "idx";
    },
    async indexes() {
      return [
        { name: "_id_", key: { _id: 1 } },
        { name: "idx_name", key: { name: 1 }, unique: true },
      ];
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
  if (request === "mongodb") {
    return {
      BSON: { EJSON: { parse: parseEjson } },
      MongoClient: FakeMongoClient,
      ObjectId: FakeObjectId,
    };
  }
  return originalLoad.apply(this, arguments);
};

const { DatabaseService } = require("../out/database/service");

async function run() {
  const service = new DatabaseService();
  const connection = { id: "mongo", name: "mongo", type: "mongodb", host: "127.0.0.1", port: 27017, username: "", password: "" };

  calls.length = 0;
  const databases = await service.listDatabases(connection);
  assert.deepEqual(databases, ["app", "logs"]);

  calls.length = 0;
  await service.query(
    { ...connection, username: "u", password: "p", database: "" },
    "app",
    'db.getCollection("users").find({}).limit(1)',
    30
  );
  assert.equal(calls[0][1], "mongodb://u:p@127.0.0.1:27017");
  assert.equal(calls[0][2].authSource, "admin");

  calls.length = 0;
  const result = await service.query(
    connection,
    "app",
    'db.getCollection("users").find({ _id: ObjectId("64f000000000000000000001") }).sort({ name: -1 }).skip(2).limit(3)',
    30
  );
  assert.equal(result.rows[0]._id, "64f000000000000000000001");
  assert.deepEqual(calls.find((item) => item[0] === "find").slice(1), [
    "users",
    { _id: new FakeObjectId("64f000000000000000000001") },
    undefined,
  ]);
  assert.deepEqual(calls.find((item) => item[0] === "sort").slice(1), [{ name: -1 }]);
  assert.deepEqual(calls.find((item) => item[0] === "skip").slice(1), [2]);
  assert.deepEqual(calls.find((item) => item[0] === "limit").slice(1), [3]);

  calls.length = 0;
  const ddl = await service.getCreateTableSql(connection, "app", "users");
  assert.match(ddl, /db\.createCollection\("users"\);/);
  assert.match(ddl, /createIndex/);

  calls.length = 0;
  const indexResult = await service.query(connection, "app", 'db.getCollection("users").createIndex({ name: 1 }, { name: "idx_name" })', 30);
  assert.equal(indexResult.rows[0].index, "idx_name");
  assert.deepEqual(calls.find((item) => item[0] === "createIndex").slice(1), ["users", { name: 1 }, { name: "idx_name" }]);

  console.log("ok - DatabaseService MongoDB 查询和集合结构");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
