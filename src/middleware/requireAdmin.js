// Must run after authenticate. Gates destructive, cluster-wide operations
// (e.g. VM destroy) behind a Supabase app_metadata role claim — ownership
// alone (authorizeVm) is not sufficient for these.
function requireAdmin(req, res, next) {
  const role = req.user?.appMetadata?.role;
  if (role !== "admin") {
    const err = new Error("Admin role required");
    err.status = 403;
    return next(err);
  }
  next();
}

module.exports = requireAdmin;
