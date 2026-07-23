const supabaseAdmin = require("../supabaseClient");
const { cleanVmid } = require("../utils/vmid");

// Must run after authenticate (and authorizeVm, where applicable). Records
// one row per action to vm_action_audit, keyed off the same response body
// the client receives — logging never blocks or fails the request itself.
function auditLog(action) {
  return function auditLogMiddleware(req, res, next) {
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      supabaseAdmin
        .from("vm_action_audit")
        .insert({
          user_id: req.user?.id || null,
          vmid: parseInt(cleanVmid(req.params.vmid || "0"), 10),
          node: req.params.node || null,
          action,
          result: body?.ok ? "success" : "error",
          ip_address: req.ip,
        })
        .then(({ error }) => {
          if (error) console.error("[auditLog] insert failed", error);
        })
        .catch((e) => console.error("[auditLog] insert threw", e));

      return originalJson(body);
    };

    next();
  };
}

module.exports = auditLog;
