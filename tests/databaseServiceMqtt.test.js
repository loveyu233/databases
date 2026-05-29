const assert = require("node:assert/strict");
const fs = require("node:fs");

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

assert.deepEqual(parseMqttCommand('PUBLISH sensors/1 QOS 2 PAYLOAD "hello world"'), {
  kind: "publish",
  topic: "sensors/1",
  qos: 2,
  retain: false,
  payload: "hello world",
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
const createResourceMenus = packageJson.contributes.menus["view/item/context"].filter((item) => item.command === "databaseWorkbench.createResource");
assert.ok(createResourceMenus.some((item) => item.when.includes("database\\.mqtt")));
assert.ok(!createResourceMenus.some((item) => item.when.includes("connection\\.") && item.when.includes("mqtt")));
assert.ok(!packageJson.activationEvents.includes("onCommand:databaseWorkbench.sendMqttMessage"));
assert.ok(!packageJson.contributes.commands.some((item) => item.command === "databaseWorkbench.sendMqttMessage"));
assert.ok(!packageJson.contributes.menus["view/item/context"].some((item) => item.command === "databaseWorkbench.sendMqttMessage"));

const webviewSource = fs.readFileSync("src/workbench/webviewHtml.ts", "utf8");
assert.ok(webviewSource.includes('id="sendMessageBtn"'));
assert.ok(webviewSource.includes('state.connectionType === "mqtt"'));
assert.ok(webviewSource.includes("PUBLISH "));

console.log("ok - MQTT command parsing and package metadata");
