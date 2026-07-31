const proxmox = require("../proxmoxClient");

// Fallback for admin lookups on a vmid with no vm_ownership row (e.g. a VM that
// exists on Proxmox but hasn't been provisioned through vmp-ui). Same call
// jobs/syncVmStatus.js already makes to keep vm_ownership.node in sync.
async function resolveNodeForVmid(vmid) {
  const { data } = await proxmox.get("/cluster/resources", { params: { type: "vm" } });
  const match = (data.data || []).find((r) => Number(r.vmid) === Number(vmid));
  return match ? match.node : null;
}

module.exports = { resolveNodeForVmid };
