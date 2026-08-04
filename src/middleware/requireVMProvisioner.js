const { getActiveTeamRole } = require("../utils/isAdmin");

// Must run after authenticate. Gates VM provisioning/binding writes (POST
// /api/admin/vms/:vmId/bindings) to Admin or Engineer — deliberately
// separate from requireAdmin.js, which still gates everything else
// (VM destroy, admin read-bypass) to Admin only. This must never be widened
// beyond this one route; it's not a general admin/engineer permission merge.
async function requireVMProvisioner(req, res, next) {
  try {
    const role = await getActiveTeamRole(req.user?.id);
    if (role !== "Admin" && role !== "Engineer") {
      const err = new Error("Admin or Engineer role required");
      err.status = 403;
      throw err;
    }
    req.teamRole = role;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireVMProvisioner;
