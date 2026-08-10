const express = require("express");
const router = express.Router();
const proxmox = require("../proxmoxClient");
const authenticate = require("../middleware/authenticate");

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



// GET /api/nodes/:node — specific node status
router.get("/:node", authenticate, async (req, res, next) => {
  try {
    const { node } = req.params;
    const { data } = await proxmox.get(`/nodes/${node}/status`);
    res.json({ ok: true, node, data: data.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;