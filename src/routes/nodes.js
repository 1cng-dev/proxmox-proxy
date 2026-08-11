const express = require("express");
const router = express.Router();
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");
const authenticate = require("../middleware/authenticate");
const rateLimitUser = require("../middleware/rateLimitUser");
const requireAdmin = require("../middleware/requireAdmin");

// GET /api/nodes — list all nodes in cluster. Always a live call to Proxmox's
// own /nodes endpoint, never a cached or hard-coded list — a node being added
// or removed on the cluster shows up here on the very next request with no
// restart or code change needed.
router.get("/", authenticate, async (req, res, next) => {
  try {
    const { data } = await proxmox.get("/nodes");
    const nodes = data.data || [];
    console.log(`[NODE-DISCOVERY] nodes=${nodes.map((n) => n.node).join(",") || "(none)"}`);
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
