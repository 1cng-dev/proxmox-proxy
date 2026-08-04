const supabaseAdmin = require("../supabaseClient");

// The only server-side-trustworthy signal of staff/admin status in this system.
// vmp-ui's own role switching reads Supabase user_metadata, which is client-writable
// and must never be trusted for an authorization decision — team_members is the
// table the portal's RLS policies (is_staff()/is_admin()) are actually built on.
// Fails closed: any lookup error, missing row, or non-Active status means no role.
async function getActiveTeamRole(userId) {
  if (!userId) return null;

  const { data, error } = await supabaseAdmin
    .from("team_members")
    .select("role, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data || data.status !== "Active") return null;
  return data.role;
}

async function isAdminUser(userId) {
  return (await getActiveTeamRole(userId)) === "Admin";
}

// Provisioning-specific, not a general admin/engineer merge: engineers are
// the ones actually running the Proxmox provisioning, so they (along with
// admins) may bind the result to a customer's VM record. Used only by
// requireVMProvisioner (POST /api/admin/vms/:vmId/bindings) — every other
// admin-gated action (VM destroy, admin read-bypass) keeps using
// isAdminUser above, unaffected by this.
async function isVMProvisioner(userId) {
  const role = await getActiveTeamRole(userId);
  return role === "Admin" || role === "Engineer";
}

module.exports = { isAdminUser, isVMProvisioner, getActiveTeamRole };
