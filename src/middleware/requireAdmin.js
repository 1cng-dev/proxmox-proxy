const { isAdminUser } = require("../utils/isAdmin");

// Must run after authenticate. Gates destructive, cluster-wide operations
// (e.g. VM destroy, admin bindings writes) behind team_members
// (role='Admin', status='Active') — ownership alone (authorizeVm) is not
// sufficient for these. Previously checked Supabase app_metadata.role,
// which nothing in this app ever sets, making this a permanent 403 for
// every caller — see src/utils/isAdmin.js for why team_members is the
// trustworthy source instead.
async function requireAdmin(req, res, next) {
  try {
    if (!(await isAdminUser(req.user?.id))) {
      const err = new Error("Admin role required");
      err.status = 403;
      throw err;
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAdmin;
