const { createClient } = require("@supabase/supabase-js");

// Some deployments of this service's .env use SUPABASE_PUBLIC_URL / SERVICE_ROLE_KEY
// instead of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — accept either naming.
const supabaseUrl = process.env.SUPABASE_URL || process.env.SUPABASE_PUBLIC_URL;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn(
    "[supabaseClient] SUPABASE_URL (or SUPABASE_PUBLIC_URL) / SUPABASE_SERVICE_ROLE_KEY " +
      "(or SERVICE_ROLE_KEY) not set — authentication, authorization, and audit logging will fail."
  );
}

// Service-role client — runs only inside Proxcy-API, never exposed to a client.
// Bypasses RLS, so ownership checks (authorizeVm) must be enforced in code.
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = supabaseAdmin;
