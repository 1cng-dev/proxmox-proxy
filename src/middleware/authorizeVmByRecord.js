const supabaseAdmin = require("../supabaseClient");
const { isAdminUser } = require("../utils/isAdmin");

// Customer-facing counterpart to authorizeVm.js. Resolves (vmid, node) from
// vm_ownership.id (an opaque UUID, req.params.recordId) instead of the raw
// Proxmox vmid — the browser never holds or sends the real Proxmox VMID for
// these routes. On any failure to resolve, responds 404 (never 403) so a
// customer probing record IDs can't learn whether a given ID exists at all.
//
// authorizeVmByRecord({ allowAdminBypass: true }) lets a verified admin
// (team_members) through regardless of ownership — reserved for read-only
// status/stats routes, mirroring authorizeVm.js's own bypass scope. Power
// actions, console, credentials, and task-status always call
// authorizeVmByRecord() (default false) and stay ownership-only even for
// admins — an admin who needs to control or view credentials for a VM they
// don't own uses the :vmid-keyed admin routes instead, not this one.
//
// Sets req.params.vmid / req.params.node (matching authorizeVm.js's shape) so
// downstream handlers and auditLog can stay identical between the two
// middlewares — only the identifier a caller supplies differs.
function authorizeVmByRecord({ allowAdminBypass = false } = {}) {
  return async function authorizeVmByRecordMiddleware(req, res, next) {
    try {
      const recordId = req.params.recordId;

      if (!recordId) {
        const err = new Error("Not found");
        err.status = 404;
        throw err;
      }

      const admin = allowAdminBypass && (await isAdminUser(req.user.id));

      let query = supabaseAdmin
        .from("vm_ownership")
        .select("id, vmid, node, customer_id")
        .eq("id", recordId);

      if (!admin) {
        query = query.eq("user_id", req.user.id);
      }

      const { data, error } = await query.maybeSingle();

      if (error || !data) {
        // Client-facing response stays a generic 404 either way — don't leak
        // which case it was. Server-side, distinguish them: a query error
        // (bad UUID format, DB connectivity) looks nothing like "this
        // customer doesn't own this record," and conflating them in logs is
        // exactly what makes a real bug (vs. an expected ownership miss)
        // hard to diagnose from the frontend alone.
        if (error) {
          console.error(`[authorizeVmByRecord] query failed for recordId=${recordId}:`, error.message);
        } else {
          console.warn(
            `[authorizeVmByRecord] no matching vm_ownership row for recordId=${recordId}` +
              (admin ? " (admin bypass — record truly doesn't exist)" : ` and user_id=${req.user.id}`)
          );
        }
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
  };
}

module.exports = authorizeVmByRecord;
