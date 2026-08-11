// Proxmox task IDs (UPIDs) encode the node a task is/was running on directly:
// UPID:{node}:{pid}:{pstart}:{starttime}:{type}:{id}:{user}:
// A task-status lookup should always use that node, not vm_ownership.node —
// the latter tracks where a VM currently *lives* (and can go stale between
// syncVmStatus ticks, see utils/nodeFailover.js), which isn't necessarily
// where an already-launched task ran, and is unaffected by a migration that
// happens after the task itself completed. Parsing this is exact, not a
// guess, and never goes stale.
function nodeFromUpid(upid) {
  if (typeof upid !== "string") return null;
  const parts = upid.split(":");
  return parts.length > 1 && parts[0] === "UPID" && parts[1] ? parts[1] : null;
}

module.exports = { nodeFromUpid };
