const assert = require("node:assert/strict");

const { parseMqttCommand, parseMqttTopicFilters } = require("../out/database/clients/mqtt");
const packageJson = require("../package.json");

assert.deepEqual(parseMqttTopicFilters("sensors/+/temperature, test/#\nalerts"), [
  "sensors/+/temperature",
  "test/#",
  "alerts",
]);

assert.deepEqual(parseMqttCommand("SHOW SUBSCRIPTIONS"), {
  kind: "showSubscriptions",
});

assert.deepEqual(parseMqttCommand('SUBSCRIBE "sensors/+/temperature" QOS 1 LIMIT 20 TIMEOUT 3000', 30), {
  kind: "subscribe",
  topic: "sensors/+/temperature",
  qos: 1,
  limit: 20,
  timeoutMs: 3000,
});

assert.deepEqual(parseMqttCommand('PUBLISH sensors/1 QOS 0 RETAIN PAYLOAD {"temperature":26}'), {
  kind: "publish",
  topic: "sensors/1",
  qos: 0,
  retain: true,
  payload: '{"temperature":26}',
});

assert.deepEqual(parseMqttCommand("UNSUBSCRIBE test/#"), {
  kind: "unsubscribe",
  topic: "test/#",
});

assert.throws(() => parseMqttCommand("PUBLISH sensors/+ PAYLOAD hello"), /不能包含/);
assert.throws(() => parseMqttCommand("SUBSCRIBE sensors/#/bad"), /只能单独作为最后一级/);

assert.equal(packageJson.dependencies.mqtt, "^5.15.1");
assert.ok(packageJson.description.includes("MQTT"));
assert.ok(packageJson.keywords.includes("mqtt"));

console.log("ok - MQTT command parsing and package metadata");
