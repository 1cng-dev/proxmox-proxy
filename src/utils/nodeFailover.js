const supabaseAdmin = require("../supabaseClient");
const { resolveNodeForVmid } = require("./resolveNode");

// A Proxmox cluster is dynamic on two axes: which nodes exist (nodes can be
// added/removed), and which node any given vmid currently lives on (VMs live-
// migrate between nodes — automatically on HA failover, or manually — at any
// time). vm_ownership.node is a cache of the second axis, refreshed only every
// 2 minutes by jobs/syncVmStatus.js (or written once at bind time by
// routes/admin.js) — so a request landing inside that window after a real
// migration targets a node the vmid no longer lives on.
//
// Proxmox's own signal for that exact situation is distinctive: a config-file
// lookup for a real vmid on the wrong node, not a missing/unauthorized vmid.
function looksLikeWrongNode(err) {
  if (!err) return false;
  const status = err.status;
  if (status !== 500 && status !== 404) return false;
  const text = `${err.message || ""} ${err.proxmoxStatusText || ""}`;
  return /configuration file .* does not exist|no such (vm|guest|resource)/i.test(text);
}

// Runs `run(node)` — one Proxmox call, or several in parallel — against the
// caller-supplied (cached) node. If it fails with the "wrong node" signature
// above, re-resolves the vmid's actual current node from live
// /cluster/resources data and retries `run` exactly once against it. A
// successful retry self-heals vm_ownership.node immediately, so every other
// in-flight or subsequent request for this vmid targets the right node right
// away instead of waiting out the rest of the 2-minute sync cycle.
//
// Any other failure (auth, permission, timeout) is rethrown unchanged — this
// only ever fires for the one specific, identifiable "stale node cache" case.
// The re-resolution step itself can land in one of three distinct outcomes,
// each surfaced as its own error class rather than silently collapsing into
// the original opaque Proxmox message (see errorHandler.js — err.status
// drives the HTTP response, err.message is customer/operator-visible):
//   - migrated:    fresh node differs from the stale one → retry, self-heal.
//   - not found:   vmid isn't in /cluster/resources at all anymore → the VM
//                  was deleted/never existed, not a routing problem.
//   - unreachable: fresh node *is* the same node we already tried (so the
//                  cluster itself still thinks the VM lives there), or the
//                  /cluster/resources lookup itself failed → this isn't a
//                  migration, something else is wrong (the node is offline,
//                  or cluster state can't currently be read at all).
async function withNodeFailover(vmid, node, run) {
  try {
    return { node, result: await run(node) };
  } catch (err) {
    if (!looksLikeWrongNode(err)) throw err;

    let freshNode;
    let resolveFailed = false;
    try {
      freshNode = await resolveNodeForVmid(vmid);
    } catch (resolveErr) {
      resolveFailed = true;
      console.error(
        `[VM-RESOLVE] vmid=${vmid} cluster lookup failed while re-resolving after a stale-node failure: ${resolveErr.message}`
      );
    }

    if (resolveFailed) {
      const e = new Error(
        `Could not verify this VM's current location — cluster state is temporarily unreadable. Try again shortly.`
      );
      e.status = 503;
      e.clusterUnreadable = true;
      throw e;
    }

    if (!freshNode) {
      console.warn(`[VM-RESOLVE] vmid=${vmid} not found anywhere in the current cluster state`);
      const e = new Error(`VM ${vmid} could not be located on the cluster.`);
      e.status = 404;
      e.vmNotFound = true;
      throw e;
    }

    if (freshNode === node) {
      // Cluster state agrees the VM is still on `node` — this isn't a
      // migration, so retrying would just fail the same way. Most likely
      // that node itself is offline/unreachable, or the earlier failure had
      // an unrelated cause that happens to share the same error signature.
      console.error(
        `[VM-RESOLVE] vmid=${vmid} cluster state still reports node "${node}", but the operation failed there — the node may be offline`
      );
      const e = new Error(
        `This VM's node ("${node}") could not be reached. It may be temporarily offline.`
      );
      e.status = 503;
      e.nodeUnreachable = true;
      e.node = node;
      throw e;
    }

    console.warn(
      `[VM-MIGRATION-DETECTED] vmid=${vmid} previousNode=${node} currentNode=${freshNode} (${err.message})`
    );

    const result = await run(freshNode);

    const { error: healError } = await supabaseAdmin
      .from("vm_ownership")
      .update({ node: freshNode, updated_at: new Date().toISOString() })
      .eq("vmid", vmid);
    if (healError) {
      console.error(`[VM-MIGRATION-DETECTED] self-heal update failed for vmid=${vmid}`, healError);
    } else {
      console.log(
        `[VM-MIGRATION-DETECTED] self-healed vm_ownership.node for vmid=${vmid}: "${node}" -> "${freshNode}"`
      );
    }

    return { node: freshNode, result };
  }
}

// Structured, low-volume log for a completed mutating VM operation (power
// actions, delete) — not called for status/stats reads, which are polled by
// the portal every few seconds and would flood logs at this volume. Matches
// the project's existing convention of logging anomalies/actions, not every
// routine read (see syncVmStatus.js, proxmoxClient.js).
function logVmOperation(vmid, node, operation, status) {
  console.log(`[VM-OPERATION] vmid=${vmid} node=${node} operation=${operation} status=${status}`);
}

module.exports = { withNodeFailover, looksLikeWrongNode, logVmOperation };
