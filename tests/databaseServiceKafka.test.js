const assert = require("node:assert/strict");
const fs = require("node:fs");

const { parseKafkaCommand } = require("../out/database/clients/kafka");
const packageJson = require("../package.json");

assert.deepEqual(parseKafkaCommand("SHOW TOPICS"), {
  kind: "showTopics",
  includeInternal: false,
});

assert.deepEqual(parseKafkaCommand("SHOW TOPICS ALL"), {
  kind: "showTopics",
  includeInternal: true,
});

assert.deepEqual(parseKafkaCommand('DESCRIBE TOPIC "orders.created"'), {
  kind: "describeTopic",
  topic: "orders.created",
});

assert.deepEqual(parseKafkaCommand("CONSUME orders.created FROM LATEST LIMIT 20 TIMEOUT 1000", 30), {
  kind: "consume",
  topic: "orders.created",
  limit: 20,
  fromBeginning: false,
  timeoutMs: 1000,
});

assert.deepEqual(parseKafkaCommand('PRODUCE orders.created KEY user-1 VALUE {"id":1}'), {
  kind: "produce",
  topic: "orders.created",
  key: "user-1",
  value: '{"id":1}',
});

assert.deepEqual(parseKafkaCommand('PRODUCE orders.created KEY "user 1" VALUE "hello world"'), {
  kind: "produce",
  topic: "orders.created",
  key: "user 1",
  value: "hello world",
});

assert.deepEqual(parseKafkaCommand("CREATE TOPIC orders.created PARTITIONS 3 REPLICATION_FACTOR 2"), {
  kind: "createTopic",
  topic: "orders.created",
  partitions: 3,
  replicationFactor: 2,
});

assert.deepEqual(parseKafkaCommand('CREATE TOPIC orders.created PARTITIONS 6 REPLICATION_FACTOR 3 CONFIG cleanup.policy=compact,delete CONFIG retention.ms=-1 CONFIG compression.type="zstd"'), {
  kind: "createTopic",
  topic: "orders.created",
  partitions: 6,
  replicationFactor: 3,
  configEntries: [
    { name: "cleanup.policy", value: "compact,delete" },
    { name: "retention.ms", value: "-1" },
    { name: "compression.type", value: "zstd" },
  ],
});

assert.equal(packageJson.dependencies.kafkajs, "^2.2.4");
assert.ok(packageJson.description.includes("Kafka"));
assert.ok(packageJson.keywords.includes("kafka"));
assert.ok(!packageJson.activationEvents.includes("onCommand:databaseWorkbench.sendKafkaMessage"));
assert.ok(!packageJson.contributes.commands.some((item) => item.command === "databaseWorkbench.sendKafkaMessage"));
assert.ok(!packageJson.contributes.menus["view/item/context"].some((item) => item.command === "databaseWorkbench.sendKafkaMessage"));
const createResourceMenus = packageJson.contributes.menus["view/item/context"].filter((item) => item.command === "databaseWorkbench.createResource");
assert.ok(createResourceMenus.some((item) => item.when.includes("database\\.kafka")));

const webviewSource = fs.readFileSync("src/workbench/webviewHtml.ts", "utf8");
assert.ok(webviewSource.includes('id="sendMessageBtn"'));
assert.ok(webviewSource.includes('state.connectionType === "kafka"'));
assert.ok(webviewSource.includes("PRODUCE "));
assert.ok(webviewSource.includes("function renderMessageStreamResult"));
assert.ok(webviewSource.includes("Consumed record"));

const extensionSource = fs.readFileSync("src/extension.ts", "utf8");
assert.ok(extensionSource.includes("cleanupPolicyInput"));
assert.ok(extensionSource.includes("customConfigsInput"));
assert.ok(extensionSource.includes("CONFIG ${item.name}="));
assert.ok(extensionSource.includes("buildKafkaTopicConfigEntries"));

console.log("ok - Kafka command parsing and package metadata");
