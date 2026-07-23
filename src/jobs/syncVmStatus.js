const cron = require("node-cron");
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");

// Keeps vm_ownership.node / status_cache aligned with reality so the
// authorizeVm middleware routes to the node a VM actually lives on after a
// migration, and so a VM list can be rendered without a live Proxmox call
// per row. Never touches user_id — ownership is only ever set by the
// provisioning workflow, not by this job.
async function syncOnce() {
  const { data } = await proxmox.get("/cluster/resources", { params: { type: "vm" } });

  for (const vm of data.data || []) {
    const { error } = await supabaseAdmin
      .from("vm_ownership")
      .update({ node: vm.node, status_cache: vm.status, updated_at: new Date().toISOString() })
      .eq("vmid", vm.vmid);

    if (error) console.error("[syncVmStatus] update failed", vm.vmid, error);
  }
}

function start() {
  cron.schedule("*/2 * * * *", () => {
    syncOnce().catch((err) => console.error("[syncVmStatus] run failed", err));
  });
  console.log("[syncVmStatus] scheduled every 2 minutes");
}

module.exports = { start, syncOnce };
