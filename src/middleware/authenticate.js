const supabaseAdmin = require("../supabaseClient");

// Requires a Supabase-issued access token: `Authorization: Bearer <jwt>`.
// On success, attaches { id, email, appMetadata } to req.user.
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      const err = new Error("Missing access token");
      err.status = 401;
      throw err;
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      const err = new Error("Invalid or expired token");
      err.status = 401;
      throw err;
    }

    req.user = {
      id: data.user.id,
      email: data.user.email,
      appMetadata: data.user.app_metadata || {},
    };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authenticate;
