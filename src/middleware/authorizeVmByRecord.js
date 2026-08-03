const supabaseAdmin = require("../supabaseClient");
const { isAdminUser } = require("../utils/isAdmin");

// Customer-facing counterpart to authorizeVm.js. Resolves (vmid, node) from
// vm_ownership.id (an opaque UUID, req.params.recordId) instead of the raw
// Proxmox vmid — the browser never holds or sends the real Proxmox VMID for
// these routes. On any failure to resolve, responds 404 (never 403) so a
// customer probing record IDs can't learn whether a given ID exists at all.
//
// Sets req.params.vmid / req.params.node (matching authorizeVm.js's shape) so
// downstream handlers and auditLog can stay identical between the two
// middlewares — only the identifier a caller supplies differs.
async function authorizeVmByRecord(req, res, next) {
  try {
    const recordId = req.params.recordId;

    if (!recordId) {
      const err = new Error("Not found");
      err.status = 404;
      throw err;
    }

    const admin = await isAdminUser(req.user.id);

    let query = supabaseAdmin
      .from("vm_ownership")
      .select("id, vmid, node, customer_id")
      .eq("id", recordId);

    if (!admin) {
      query = query.eq("user_id", req.user.id);
    }

    const { data, error } = await query.maybeSingle();

    if (error || !data) {
      const err = new Error("Not found");
      err.status = 404;
      throw err;
    }

    req.params.vmid = String(data.vmid);
    req.params.node = data.node;
    req.params.recordId = data.id;
    req.vmOwnership = data;
    req.isAdmin = admin;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authorizeVmByRecord;
