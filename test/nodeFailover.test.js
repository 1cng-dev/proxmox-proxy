const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadNodeFailover } = require("./helpers/loadNodeFailover");

function wrongNodeError(node, vmid) {
  const e = new Error(`Configuration file 'nodes/${node}/qemu/${vmid}.conf' does not exist`);
  e.status = 500;
  return e;
}

test("looksLikeWrongNode: recognizes Proxmox's config-file-missing signature", () => {
  const { looksLikeWrongNode } = loadNodeFailover();
  assert.equal(
    looksLikeWrongNode({ status: 500, message: "Configuration file 'nodes/old/qemu/100.conf' does not exist" }),
    true
  );
  assert.equal(
    looksLikeWrongNode({ status: 500, proxmoxStatusText: "Configuration file 'nodes/old/qemu/100.conf' does not exist" }),
    true
  );
  assert.equal(looksLikeWrongNode({ status: 404, message: "no such VM" }), true);
});

test("looksLikeWrongNode: does not misclassify unrelated errors", () => {
  const { looksLikeWrongNode } = loadNodeFailover();
  assert.equal(looksLikeWrongNode({ status: 403, message: "Forbidden" }), false);
  assert.equal(looksLikeWrongNode({ status: 500, message: "Proxmox connection failed" }), false);
  assert.equal(looksLikeWrongNode({ status: 401, message: "Configuration file does not exist" }), false);
  assert.equal(looksLikeWrongNode(null), false);
});

test("withNodeFailover: happy path — no failover triggered", async () => {
  const { withNodeFailover } = loadNodeFailover();
  const calls = [];
  const { node, result } = await withNodeFailover(100, "pve1", async (n) => {
    calls.push(n);
    return "ok-" + n;
  });
  assert.equal(node, "pve1");
  assert.equal(result, "ok-pve1");
  assert.deepEqual(calls, ["pve1"]);
});

test("withNodeFailover: migration detected — retries once on the resolved node and self-heals", async () => {
  const { withNodeFailover, updateCalls } = loadNodeFailover({
    resolveNodeForVmid: async () => "pve3",
  });

  const calls = [];
  const { node, result } = await withNodeFailover(200, "pve1", async (n) => {
    calls.push(n);
    if (n === "pve1") throw wrongNodeError("pve1", 200);
    return "ok-" + n;
  });

  assert.equal(node, "pve3");
  assert.equal(result, "ok-pve3");
  assert.deepEqual(calls, ["pve1", "pve3"]); // exactly one retry, not a loop
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, "vm_ownership");
  assert.equal(updateCalls[0].fields.node, "pve3");
  assert.equal(updateCalls[0].val, 200);
});

test("withNodeFailover: self-heal write failing doesn't fail the request", async () => {
  const { withNodeFailover, updateCalls } = loadNodeFailover({
    resolveNodeForVmid: async () => "pve3",
    supabaseUpdateShouldError: true,
  });

  const { node, result } = await withNodeFailover(201, "pve1", async (n) => {
    if (n === "pve1") throw wrongNodeError("pve1", 201);
    return "ok";
  });

  assert.equal(node, "pve3");
  assert.equal(result, "ok");
  assert.equal(updateCalls.length, 1); // the write was attempted
});

test("withNodeFailover: unrelated error (e.g. permission) passes through untouched, no retry", async () => {
  const { withNodeFailover } = loadNodeFailover({
    resolveNodeForVmid: async () => {
      throw new Error("resolveNodeForVmid should not be called for a non-wrong-node error");
    },
  });

  const calls = [];
  await assert.rejects(
    withNodeFailover(300, "pve1", async (n) => {
      calls.push(n);
      const e = new Error("Forbidden");
      e.status = 403;
      throw e;
    }),
    /Forbidden/
  );
  assert.deepEqual(calls, ["pve1"]);
});

test("withNodeFailover: vmid not found anywhere in the cluster -> 404, vmNotFound", async () => {
  const { withNodeFailover } = loadNodeFailover({
    resolveNodeForVmid: async () => null,
  });

  await assert.rejects(
    withNodeFailover(400, "pve1", async (n) => {
      throw wrongNodeError("pve1", 400);
    }),
    (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.vmNotFound, true);
      return true;
    }
  );
});

test("withNodeFailover: cluster still reports the same node (likely offline) -> 503, nodeUnreachable", async () => {
  const { withNodeFailover } = loadNodeFailover({
    resolveNodeForVmid: async () => "pve1", // same as the node that just failed
  });

  await assert.rejects(
    withNodeFailover(500, "pve1", async (n) => {
      throw wrongNodeError("pve1", 500);
    }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.nodeUnreachable, true);
      assert.equal(err.node, "pve1");
      return true;
    }
  );
});

test("withNodeFailover: cluster lookup itself fails -> 503, clusterUnreadable", async () => {
  const { withNodeFailover } = loadNodeFailover({
    resolveNodeForVmid: async () => {
      throw new Error("ETIMEDOUT");
    },
  });

  await assert.rejects(
    withNodeFailover(600, "pve1", async (n) => {
      throw wrongNodeError("pve1", 600);
    }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.clusterUnreadable, true);
      return true;
    }
  );
});

test("logVmOperation: does not throw and is a plain logging call", () => {
  const { logVmOperation } = loadNodeFailover();
  assert.doesNotThrow(() => logVmOperation(100, "pve1", "start", "success"));
});
