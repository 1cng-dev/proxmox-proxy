const supabaseAdmin = require("../supabaseClient");
const { cleanVmid } = require("../utils/vmid");
const { isAdminUser } = require("../utils/isAdmin");
const { resolveNodeForVmid } = require("../utils/resolveNode");

// Must run after authenticate. Confirms req.user owns :vmid via the
// vm_ownership table, then overwrites req.params.node with the DB's record —
// a client-supplied node in the URL is never trusted for the actual
// Proxmox call, only used for routing to this middleware.
//
// authorizeVm({ allowAdminBypass: true }) additionally lets a caller who is an
// admin per team_members (role='Admin', status='Active') through regardless of
// ownership — reserved for read-only status/list routes. Power actions,
// console, and delete always call authorizeVm() (default false) and stay
// ownership-only even for admins.
function authorizeVm({ allowAdminBypass = false } = {}) {
  return async function authorizeVmMiddleware(req, res, next) {
    try {
      const vmid = parseInt(cleanVmid(req.params.vmid), 10);

      if (!Number.isInteger(vmid)) {
        const err = new Error("Invalid vmid");
        err.status = 400;
        throw err;
      }

      if (allowAdminBypass && (await isAdminUser(req.user.id))) {
        const { data: anyOwnership } = await supabaseAdmin
          .from("vm_ownership")
          .select("vmid, node, customer_id")
          .eq("vmid", vmid)
          .maybeSingle();

        const node = anyOwnership?.node || (await resolveNodeForVmid(vmid));

        if (!node) {
          const err = new Error("VM not found");
          err.status = 404;
          throw err;
        }

        req.params.vmid = String(vmid);
        req.params.node = node;
        req.vmOwnership = anyOwnership || null;
        req.isAdmin = true;
        return next();
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
  };
}

module.exports = authorizeVm;
module.exports.authorizeByRecord = authorizeByRecord;
