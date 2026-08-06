const express = require("express");
const router = express.Router();
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");
const authenticate = require("../middleware/authenticate");
const rateLimitUser = require("../middleware/rateLimitUser");
const requireAdmin = require("../middleware/requireAdmin");

// GET /api/nodes — list only the nodes the caller has at least one VM on,
// unless the caller is an admin. Prevents cross-tenant cluster topology leaks.
router.get("/", authenticate, rateLimitUser, async (req, res, next) => {
  try {
    const isAdmin = req.user?.appMetadata?.role === "admin";

    if (isAdmin) {
      const { data } = await proxmox.get("/nodes");
      return res.json({ ok: true, data: data.data });
    }

    const { data: owned, error } = await supabaseAdmin
      .from("vm_ownership")
      .select("node")
      .eq("user_id", req.user.id);

    if (error) throw error;

    const nodes = [...new Set((owned || []).map((o) => o.node))];
    res.json({ ok: true, data: nodes });
  } catch (err) {
    next(err);
  }
});

// GET /api/nodes/:node — only return status for nodes the caller owns a VM on,
// unless the caller is an admin.
router.get("/:node", authenticate, rateLimitUser, async (req, res, next) => {
  try {
    const { node } = req.params;
    const isAdmin = req.user?.appMetadata?.role === "admin";

    if (!isAdmin) {
      const { data: owned, error } = await supabaseAdmin
        .from("vm_ownership")
        .select("vmid")
        .eq("user_id", req.user.id)
        .eq("node", node)
        .limit(1);

      if (error || !owned?.length) {
        const err = new Error("Forbidden");
        err.status = 403;
        throw err;
      }
    }

    const { data } = await proxmox.get(`/nodes/${node}/status`);
    res.json({ ok: true, node, data: data.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
