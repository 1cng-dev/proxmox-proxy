const rateLimit = require("express-rate-limit");

// Per-customer limiter for VM power actions/credential reveals — tighter
// than index.js's global IP-based limiter, and keyed by the authenticated
// user so one account's rapid start/stop loop can't hide behind, or get
// blamed on, other traffic sharing the same IP (e.g. NAT/office network).
// Must run after `authenticate` so req.user is populated.
const vmActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { ok: false, error: "Too many VM operations — slow down and try again" },
});

module.exports = vmActionLimiter;
