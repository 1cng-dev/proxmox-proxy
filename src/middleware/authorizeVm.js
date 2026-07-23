const supabaseAdmin = require("../supabaseClient");
const { cleanVmid } = require("../utils/vmid");

// Must run after authenticate. Confirms req.user owns :vmid via the
// vm_ownership table, then overwrites req.params.node with the DB's record —
// a client-supplied node in the URL is never trusted for the actual
// Proxmox call, only used for routing to this middleware.
async function authorizeVm(req, res, next) {
  try {
    const vmid = parseInt(cleanVmid(req.params.vmid), 10);

    if (!Number.isInteger(vmid)) {
      const err = new Error("Invalid vmid");
      err.status = 400;
      throw err;
    }

    const { data, error } = await supabaseAdmin
      .from("vm_ownership")
      .select("vmid, node, customer_id")
      .eq("user_id", req.user.id)
      .eq("vmid", vmid)
      .single();

    if (error || !data) {
      const err = new Error("Forbidden");
      err.status = 403;
      throw err;
    }

    req.params.vmid = String(vmid);
    req.params.node = data.node;
    req.vmOwnership = data;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authorizeVm;
