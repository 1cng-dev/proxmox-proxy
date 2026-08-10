const supabaseAdmin = require("../supabaseClient");
const { cleanVmid } = require("../utils/vmid");

const STAFF_ROLES = ["admin", "engineer", "sales", "finance"];

// Must run after authenticate. Confirms req.user owns :vmid via the
// vm_ownership table, then overwrites req.params.node with the DB's record —
// a client-supplied node in the URL is never trusted for the actual
// Proxmox call, only used for routing to this middleware.
// Staff roles (admin, engineer, sales, finance) may view any VM on GET/HEAD
// without owning it, but power actions and deletes still require ownership.
async function authorizeVm(req, res, next) {
  try {
    const vmid = parseInt(cleanVmid(req.params.vmid), 10);

    if (!Number.isInteger(vmid)) {
      const err = new Error("Invalid vmid");
      err.status = 400;
      throw err;
    }

    const role = req.user?.appMetadata?.role;
    const isStaff = STAFF_ROLES.includes(role);
    const isRead = req.method === "GET" || req.method === "HEAD";

    let query = supabaseAdmin
      .from("vm_ownership")
      .select("vmid, node, customer_id")
      .eq("vmid", vmid);

    if (!isStaff || !isRead) {
      query = query.eq("user_id", req.user.id);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      supabaseAdmin
        .from("vm_action_audit")
        .insert({
          user_id: req.user?.id || null,
          vmid,
          node: req.params.node || null,
          action: "authorize-failed",
          result: "denied",
          ip_address: req.ip,
        })
        .catch(() => {});

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
