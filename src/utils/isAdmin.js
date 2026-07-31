const supabaseAdmin = require("../supabaseClient");

// The only server-side-trustworthy signal of staff/admin status in this system.
// vmp-ui's own role switching reads Supabase user_metadata, which is client-writable
// and must never be trusted for an authorization decision — team_members is the
// table the portal's RLS policies (is_staff()/is_admin()) are actually built on.
// Fails closed: any lookup error or missing row means "not admin".
async function isAdminUser(userId) {
  if (!userId) return false;

  const { data, error } = await supabaseAdmin
    .from("team_members")
    .select("role, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return false;
  return data.role === "Admin" && data.status === "Active";
}

module.exports = { isAdminUser };
