const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadNodeFailover } = require("./helpers/loadNodeFailover");

// Simulates the exact scenario from the task spec: node1 had 40 VMs; node1
// goes away and every one of those 40 VMs redistributes across the
// remaining nodes simultaneously. vm_ownership still has all 40 cached at
// "node1" (stale). Each should independently resolve to its real current
// node and self-heal — with no cross-vmid contamination in the process.
test("40 VMs redistributed off a dead node all resolve to their correct current node concurrently", async () => {
  const VM_COUNT = 40;
  const NODES = ["node2", "node3", "node4", "node5"];
  const groundTruth = {}; // vmid -> the node it's "really" on right now
  for (let i = 0; i < VM_COUNT; i++) {
    const vmid = 100 + i;
    groundTruth[vmid] = NODES[i % NODES.length];
  }

  const { withNodeFailover, updateCalls } = loadNodeFailover({
    resolveNodeForVmid: async (vmid) => groundTruth[vmid] || null,
  });

  const attemptsPerVm = {};

  const results = await Promise.all(
    Object.keys(groundTruth).map((vmidStr) => {
      const vmid = Number(vmidStr);
      attemptsPerVm[vmid] = [];
      return withNodeFailover(vmid, "node1", async (node) => {
        attemptsPerVm[vmid].push(node);
        if (node !== groundTruth[vmid]) {
          const e = new Error(`Configuration file 'nodes/${node}/qemu/${vmid}.conf' does not exist`);
          e.status = 500;
          throw e;
        }
        return { vmid, node, status: "running" };
      });
    })
  );

  assert.equal(results.length, VM_COUNT);

  for (const { node, result } of results) {
    assert.equal(node, groundTruth[result.vmid]);
    assert.equal(result.node, groundTruth[result.vmid]);
  }

  // Every VM was tried on the stale node first, then exactly once on its
  // real node — no VM looped or retried more than once.
  for (const vmid of Object.keys(groundTruth).map(Number)) {
    assert.deepEqual(attemptsPerVm[vmid], ["node1", groundTruth[vmid]]);
  }

  // Every VM self-healed independently, to its own correct node — this is
  // the part most likely to break under concurrency (e.g. shared mutable
  // state accidentally leaking one vmid's resolved node into another's).
  assert.equal(updateCalls.length, VM_COUNT);
  const healedByVmid = Object.fromEntries(updateCalls.map((c) => [c.val, c.fields.node]));
  for (const vmid of Object.keys(groundTruth).map(Number)) {
    assert.equal(healedByVmid[vmid], groundTruth[vmid]);
  }

  // Nodes actually varied — this wasn't secretly a single-node test.
  const distinctNodesUsed = new Set(results.map((r) => r.node));
  assert.equal(distinctNodesUsed.size, NODES.length);
});

test("a mix of migrated, already-correct, and genuinely-missing VMs are each handled independently", async () => {
  // vmid 1: cached node is already correct — no failover should fire.
  // vmid 2: migrated node1 -> node2 — failover + self-heal.
  // vmid 3: genuinely gone — 404 vmNotFound, no self-heal write.
  const groundTruth = { 1: "node1", 2: "node2" }; // 3 deliberately absent

  const { withNodeFailover, updateCalls } = loadNodeFailover({
    resolveNodeForVmid: async (vmid) => groundTruth[vmid] || null,
  });

  const runFor = (vmid) => (node) => {
    if (groundTruth[vmid] && node !== groundTruth[vmid]) {
      const e = new Error(`Configuration file 'nodes/${node}/qemu/${vmid}.conf' does not exist`);
      e.status = 500;
      throw e;
    }
    if (!groundTruth[vmid]) {
      const e = new Error(`Configuration file 'nodes/${node}/qemu/${vmid}.conf' does not exist`);
      e.status = 500;
      throw e;
    }
    return "ok";
  };

  const r1 = await withNodeFailover(1, "node1", runFor(1));
  assert.equal(r1.node, "node1");

  const r2 = await withNodeFailover(2, "node1", runFor(2));
  assert.equal(r2.node, "node2");

  await assert.rejects(withNodeFailover(3, "node1", runFor(3)), (err) => {
    assert.equal(err.vmNotFound, true);
    return true;
  });

  // Only vmid 2 actually migrated and should have triggered a self-heal write.
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].val, 2);
  assert.equal(updateCalls[0].fields.node, "node2");
});
