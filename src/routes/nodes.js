const express = require("express");
const router = express.Router();
const proxmox = require("../proxmoxClient");

// GET /api/nodes — list all nodes in cluster
router.get("/", async (req, res, next) => {
  try {
    const { data } = await proxmox.get("/nodes");
    res.json({ ok: true, data: data.data });
  } catch (err) {
    next(err);
  }
});



// GET /api/nodes/:node — specific node status
router.get("/:node", async (req, res, next) => {
  try {
    const { node } = req.params;
    const { data } = await proxmox.get(`/nodes/${node}/status`);
    res.json({ ok: true, node, data: data.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;