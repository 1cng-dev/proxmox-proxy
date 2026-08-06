const cron = require("node-cron");
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");

// Keeps vm_ownership.node / status_cache aligned with reality so the
// authorizeVm middleware routes to the node a VM actually lives on after a
// migration, and so a VM list can be rendered without a live Proxmox call
// per row. Never touches user_id — ownership is only ever set by the
// provisioning workflow, not by this job.
async function syncOnce() {
  const { data, status } = await proxmox.get("/cluster/resources", { params: { type: "vm" } });

  if (!status || status < 200 || status >= 300) {
    console.error("[syncVmStatus] Proxmox returned non-2xx, skipping sync");
    return;
  }

  const vms = data?.data || [];
  if (!vms.length) {
    console.warn("[syncVmStatus] Proxmox returned no VMs; aborting to avoid deleting ownership rows");
    return;
  }

  const liveVmids = new Set(vms.map((vm) => vm.vmid));

  for (const vm of vms) {
    const { error } = await supabaseAdmin
      .from("vm_ownership")
      .update({ node: vm.node, status_cache: vm.status, updated_at: new Date().toISOString() })
      .eq("vmid", vm.vmid);

    if (error) console.error("[syncVmStatus] update failed", vm.vmid, error);
  }

  // Clean up ownership rows for VMs that no longer exist in the cluster,
  // guarding against accidental full deletion if Proxmox returned empty data.
  const { data: orphaned } = await supabaseAdmin
    .from("vm_ownership")
    .select("id, vmid")
    .not("vmid", "in", `(${[...liveVmids].join(",")})`);

  for (const row of orphaned || []) {
    const { error } = await supabaseAdmin.from("vm_ownership").delete().eq("id", row.id);
    if (error) {
      console.error("[syncVmStatus] orphan cleanup failed", row.vmid, error);
    } else {
      console.log("[syncVmStatus] removed orphan ownership", row.vmid);
    }
  }
}

function start() {
  cron.schedule("*/2 * * * *", () => {
    syncOnce().catch((err) => console.error("[syncVmStatus] run failed", err));
  });
  console.log("[syncVmStatus] scheduled every 2 minutes");
}

module.exports = { start, syncOnce };
