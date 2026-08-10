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
// Any other failure (auth, permission, timeout, a vmid that genuinely doesn't
// exist anywhere) is rethrown unchanged — this only ever fires for the one
// specific, identifiable "stale node cache" case.
async function withNodeFailover(vmid, node, run) {
  try {
    return { node, result: await run(node) };
  } catch (err) {
    if (!looksLikeWrongNode(err)) throw err;

    const freshNode = await resolveNodeForVmid(vmid).catch(() => null);
    if (!freshNode || freshNode === node) throw err;

    console.warn(
      `[nodeFailover] vmid=${vmid} not on cached node "${node}" (${err.message}) — retrying on "${freshNode}"`
    );

    const result = await run(freshNode);

    const { error: healError } = await supabaseAdmin
      .from("vm_ownership")
      .update({ node: freshNode, updated_at: new Date().toISOString() })
      .eq("vmid", vmid);
    if (healError) {
      console.error(`[nodeFailover] self-heal update failed for vmid=${vmid}`, healError);
    } else {
      console.log(`[nodeFailover] self-healed vm_ownership.node for vmid=${vmid}: "${node}" -> "${freshNode}"`);
    }

    return { node: freshNode, result };
  }
}

module.exports = { withNodeFailover, looksLikeWrongNode };
