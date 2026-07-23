const express = require("express");
const router = express.Router({ mergeParams: true });
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");
const authenticate = require("../middleware/authenticate");
const authorizeVm = require("../middleware/authorizeVm");
const requireAdmin = require("../middleware/requireAdmin");
const auditLog = require("../middleware/auditLog");
const vncSessions = require("../vncSessions");
const { cleanVmid } = require("../utils/vmid");

// ─── GET /api/vms (or /api/nodes/:node/vms) ───────────
// Lists only the VMs the caller owns (per vm_ownership), not every VM on
// the node — a node-wide listing would leak other tenants' VM IDs.
router.get("/", authenticate, async (req, res, next) => {
  try {
    const { data: owned, error } = await supabaseAdmin
      .from("vm_ownership")
      .select("vmid, node")
      .eq("user_id", req.user.id);

    if (error) throw error;

    const results = await Promise.all(
      (owned || []).map((o) =>
        proxmox
          .get(`/nodes/${o.node}/qemu/${o.vmid}/status/current`)
          .then((r) => ({ vmid: o.vmid, node: o.node, ...r.data.data }))
          .catch(() => ({ vmid: o.vmid, node: o.node, status: "unknown" }))
      )
    );

    res.json({ ok: true, data: results });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/vms/:vmid ────────────────────────────────
// VM config + status — vmid ownership enforced by authorizeVm
router.get("/:vmid", authenticate, authorizeVm, async (req, res, next) => {
  try {
    const vmid = cleanVmid(req.params.vmid);
    const [status, config] = await Promise.all([
      proxmox.get(`/nodes/${req.params.node}/qemu/${vmid}/status/current`),
      proxmox.get(`/nodes/${req.params.node}/qemu/${vmid}/config`),
    ]);
    res.json({
      ok: true,
      vmid,
      status: status.data.data,
      config: config.data.data,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/vms/:vmid/start ─────────────────────────
router.post(
  "/:vmid/start",
  authenticate,
  authorizeVm,
  auditLog("start"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/status/start`,
        {}
      );
      res.json({ ok: true, vmid, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/vms/:vmid/stop ──────────────────────────
router.post(
  "/:vmid/stop",
  authenticate,
  authorizeVm,
  auditLog("stop"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/status/stop`,
        {}
      );
      res.json({ ok: true, vmid, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/vms/:vmid/shutdown ──────────────────────
// Graceful shutdown (ACPI)
router.post(
  "/:vmid/shutdown",
  authenticate,
  authorizeVm,
  auditLog("shutdown"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/status/shutdown`,
        {}
      );
      res.json({ ok: true, vmid, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/vms/:vmid/reboot ────────────────────────
router.post(
  "/:vmid/reboot",
  authenticate,
  authorizeVm,
  auditLog("reboot"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/status/reboot`,
        {}
      );
      res.json({ ok: true, vmid, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/vms/:vmid ──────────────────────────────
// Terminate (destroy) VM — destructive, admin-only. Ownership is still
// checked (so req.params.node resolves correctly and the action is
// attributable), but requireAdmin is what actually gates the call.
router.delete(
  "/:vmid",
  authenticate,
  authorizeVm,
  requireAdmin,
  auditLog("delete"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.delete(`/nodes/${req.params.node}/qemu/${vmid}`);
      res.json({ ok: true, vmid, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/vms/:vmid/stats ──────────────────────────
// CPU / Memory / Disk / Network realtime stats
router.get("/:vmid/stats", authenticate, authorizeVm, async (req, res, next) => {
  try {
    const vmid = cleanVmid(req.params.vmid);
    const { timeframe = "hour" } = req.query; // hour | day | week | month | year
    const { data } = await proxmox.get(`/nodes/${req.params.node}/qemu/${vmid}/rrddata`, {
      params: { timeframe, cf: "AVERAGE" },
    });
    res.json({ ok: true, vmid, timeframe, data: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/vms/:vmid/console ────────────────────────
// Opens a VNC console session. Returns an opaque, short-lived sessionToken
// and a wsPath — never the raw Proxmox ticket, port, or host address. The
// client connects the noVNC websocket to Proxcy-API itself at that wsPath;
// see src/wsConsoleProxy.js for the proxied vncwebsocket connection.
router.get(
  "/:vmid/console",
  authenticate,
  authorizeVm,
  auditLog("console"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/vncproxy`,
        { websocket: 1 }
      );
      const ticket = data.data;

      const sessionToken = vncSessions.createSession({
        node: req.params.node,
        vmid,
        port: ticket.port,
        ticket: ticket.ticket,
      });

      res.json({ ok: true, vmid, sessionToken, wsPath: `/ws/console/${sessionToken}` });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/vms/:vmid/task/:upid ─────────────────────
// Check task status (whether start/stop task is completed)
router.get("/:vmid/task/:upid", authenticate, authorizeVm, async (req, res, next) => {
  try {
    const { upid } = req.params;
    const encodedUpid = encodeURIComponent(upid);
    const { data } = await proxmox.get(`/nodes/${req.params.node}/tasks/${encodedUpid}/status`);
    res.json({ ok: true, task: data.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
