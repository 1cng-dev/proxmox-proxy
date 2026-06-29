const express = require("express");
const router = express.Router({ mergeParams: true });
const proxmox = require("../proxmoxClient");

// ─── Helper ───────────────────────────────────────────
const node = (req) => req.params.node || process.env.PROXMOX_DEFAULT_NODE;
const cleanVmid = (vmid) => vmid.replace(/^:/, "");

// ─── GET /api/nodes/:node/vms ─────────────────────────
// List all VMs in a node
router.get("/", async (req, res, next) => {
  try {
    const { data } = await proxmox.get(`/nodes/${node(req)}/qemu`);
    res.json({ ok: true, node: node(req), data: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/nodes/:node/vms/:vmid ──────────────────
// VM config + status
router.get("/:vmid", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const [status, config] = await Promise.all([
      proxmox.get(`/nodes/${node(req)}/qemu/${cleanId}/status/current`),
      proxmox.get(`/nodes/${node(req)}/qemu/${cleanId}/config`),
    ]);
    res.json({
      ok: true,
      vmid: cleanId,
      status: status.data.data,
      config: config.data.data,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/nodes/:node/vms/:vmid/start ───────────
router.post("/:vmid/start", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const { data } = await proxmox.post(
      `/nodes/${node(req)}/qemu/${cleanId}/status/start`,
      {}
    );
    res.json({ ok: true, vmid: cleanId, task: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/nodes/:node/vms/:vmid/stop ────────────
router.post("/:vmid/stop", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const { data } = await proxmox.post(
      `/nodes/${node(req)}/qemu/${cleanId}/status/stop`,
      {}
    );
    res.json({ ok: true, vmid: cleanId, task: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/nodes/:node/vms/:vmid/shutdown ────────
// Graceful shutdown (ACPI)
router.post("/:vmid/shutdown", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const { data } = await proxmox.post(
      `/nodes/${node(req)}/qemu/${cleanId}/status/shutdown`,
      {}
    );
    res.json({ ok: true, vmid: cleanId, task: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/nodes/:node/vms/:vmid/reboot ──────────
router.post("/:vmid/reboot", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const { data } = await proxmox.post(
      `/nodes/${node(req)}/qemu/${cleanId}/status/reboot`,
      {}
    );
    res.json({ ok: true, vmid: cleanId, task: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/nodes/:node/vms/:vmid ───────────────
// Terminate (destroy) VM — destructive!
router.delete("/:vmid", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const { data } = await proxmox.delete(
      `/nodes/${node(req)}/qemu/${cleanId}`
    );
    res.json({ ok: true, vmid: cleanId, task: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/nodes/:node/vms/:vmid/stats ────────────
// CPU / Memory / Disk / Network realtime stats
router.get("/:vmid/stats", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const { timeframe = "hour" } = req.query; // hour | day | week | month | year
    const { data } = await proxmox.get(
      `/nodes/${node(req)}/qemu/${cleanId}/rrddata`,
      { params: { timeframe, cf: "AVERAGE" } }
    );
    res.json({ ok: true, vmid: cleanId, timeframe, data: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/nodes/:node/vms/:vmid/console ──────────
// Get noVNC console ticket — for embedding noVNC in VMP UI
router.get("/:vmid/console", async (req, res, next) => {
  try {
    const { vmid } = req.params;
    const cleanId = cleanVmid(vmid);
    const { data } = await proxmox.post(
      `/nodes/${node(req)}/qemu/${cleanId}/vncproxy`,
      {}
    );
    const ticket = data.data;
    // Build noVNC URL
    const consoleUrl =
      `${process.env.PROXMOX_URL}/?console=kvm&novnc=1` +
      `&vmid=${cleanId}&node=${node(req)}` +
      `&ticket=${encodeURIComponent(ticket.ticket)}` +
      `&port=${ticket.port}`;

    res.json({ ok: true, vmid: cleanId, ticket, consoleUrl });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/nodes/:node/vms/:vmid/task/:upid ───────
// Check task status (whether start/stop task is completed)
router.get("/:vmid/task/:upid", async (req, res, next) => {
  try {
    const { vmid, upid } = req.params;
    const cleanId = cleanVmid(vmid);
    const encodedUpid = encodeURIComponent(upid);
    const { data } = await proxmox.get(
      `/nodes/${node(req)}/tasks/${encodedUpid}/status`
    );
    res.json({ ok: true, task: data.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
