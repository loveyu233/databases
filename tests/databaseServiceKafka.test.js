const assert = require("node:assert/strict");

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

assert.equal(packageJson.dependencies.kafkajs, "^2.2.4");
assert.ok(packageJson.description.includes("Kafka"));
assert.ok(packageJson.keywords.includes("kafka"));
assert.ok(packageJson.activationEvents.includes("onCommand:databaseWorkbench.sendKafkaMessage"));
assert.ok(packageJson.contributes.commands.some((item) => item.command === "databaseWorkbench.sendKafkaMessage"));
assert.ok(packageJson.contributes.menus["view/item/context"].some((item) => item.command === "databaseWorkbench.sendKafkaMessage" && item.when.includes("table\\.kafka")));

console.log("ok - Kafka command parsing and package metadata");
