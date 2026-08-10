const { test } = require("node:test");
const assert = require("node:assert/strict");
const { nodeFromUpid } = require("../src/utils/upid");

test("nodeFromUpid extracts the node from a well-formed UPID", () => {
  assert.equal(
    nodeFromUpid("UPID:pve2:00001234:0002ABCD:6614A1B2:qmstart:100:user@pve:"),
    "pve2"
  );
});

test("nodeFromUpid handles a node name containing hyphens/digits", () => {
  assert.equal(
    nodeFromUpid("UPID:pve-node-05:1:2:3:qmreboot:139:engineer@pve:"),
    "pve-node-05"
  );
});

test("nodeFromUpid returns null for a non-UPID string", () => {
  assert.equal(nodeFromUpid("not-a-upid"), null);
});

test("nodeFromUpid returns null for non-string input", () => {
  assert.equal(nodeFromUpid(12345), null);
  assert.equal(nodeFromUpid(null), null);
  assert.equal(nodeFromUpid(undefined), null);
});

test("nodeFromUpid returns null when the node segment is empty", () => {
  assert.equal(nodeFromUpid("UPID:"), null);
  assert.equal(nodeFromUpid("UPID::1:2:3:qmstart:100:user@pve:"), null);
});
