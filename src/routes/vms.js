const express = require("express");
const router = express.Router({ mergeParams: true });
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");
const authenticate = require("../middleware/authenticate");
const authorizeVm = require("../middleware/authorizeVm");
const authorizeVmByRecord = require("../middleware/authorizeVmByRecord");
const requireAdmin = require("../middleware/requireAdmin");
const auditLog = require("../middleware/auditLog");
const vmActionLimiter = require("../middleware/vmActionLimiter");
const vncSessions = require("../vncSessions");
const { cleanVmid } = require("../utils/vmid");
const { isAdminUser } = require("../utils/isAdmin");

// ─── GET /api/vms (or /api/nodes/:node/vms) ───────────
// Customers get only the VMs they own (per vm_ownership) — a node-wide
// listing would leak other tenants' VM IDs. Admins (per team_members) get
// every VM on the cluster, read-only, regardless of ownership.
router.get("/", authenticate, async (req, res, next) => {
  try {
    if (await isAdminUser(req.user.id)) {
      const { data } = await proxmox.get("/cluster/resources", { params: { type: "vm" } });
      const results = (data.data || []).map((r) => ({
        vmid: r.vmid,
        node: r.node,
        name: r.name,
        status: r.status,
        cpu: r.cpu,
        maxcpu: r.maxcpu,
        mem: r.mem,
        maxmem: r.maxmem,
        disk: r.disk,
        maxdisk: r.maxdisk,
        uptime: r.uptime,
        netin: r.netin,
        netout: r.netout,
      }));
      return res.json({ ok: true, scope: "all", data: results });
    }

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

    res.json({ ok: true, scope: "owned", data: results });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/vms/:vmid ────────────────────────────────
// VM config + status — vmid ownership enforced by authorizeVm; admins bypass
// ownership on this read-only route.
router.get("/:vmid", authenticate, authorizeVm({ allowAdminBypass: true }), async (req, res, next) => {
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
  authorizeVm(),
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
  authorizeVm(),
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
  authorizeVm(),
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
  authorizeVm(),
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

// ─── POST /api/vms/:vmid/reset ─────────────────────────
// Hard reset (like pressing the reset button — no ACPI, no graceful shutdown)
router.post(
  "/:vmid/reset",
  authenticate,
  authorizeVm(),
  auditLog("reset"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/status/reset`,
        {}
      );
      res.json({ ok: true, vmid, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/vms/:vmid/suspend ───────────────────────
router.post(
  "/:vmid/suspend",
  authenticate,
  authorizeVm(),
  auditLog("suspend"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/status/suspend`,
        {}
      );
      res.json({ ok: true, vmid, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/vms/:vmid/resume ────────────────────────
router.post(
  "/:vmid/resume",
  authenticate,
  authorizeVm(),
  auditLog("resume"),
  async (req, res, next) => {
    try {
      const vmid = cleanVmid(req.params.vmid);
      const { data } = await proxmox.post(
        `/nodes/${req.params.node}/qemu/${vmid}/status/resume`,
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
  authorizeVm(),
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
// CPU / Memory / Disk / Network realtime stats — admins bypass ownership here too.
router.get("/:vmid/stats", authenticate, authorizeVm({ allowAdminBypass: true }), async (req, res, next) => {
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
  authorizeVm(),
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
router.get("/:vmid/task/:upid", authenticate, authorizeVm(), async (req, res, next) => {
  try {
    const { upid } = req.params;
    const encodedUpid = encodeURIComponent(upid);
    const { data } = await proxmox.get(`/nodes/${req.params.node}/tasks/${encodedUpid}/status`);
    res.json({ ok: true, task: data.data });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════
// Customer-facing routes, keyed by vm_ownership.id (an opaque
// UUID — req.params.recordId) instead of the raw Proxmox vmid.
// The browser never holds or sends the real vmid for these.
// See src/middleware/authorizeVmByRecord.js.
// ═════════════════════════════════════════════════════════

// ─── GET /api/vms/by-record/:recordId ──────────────────
router.get("/by-record/:recordId", authenticate, authorizeVmByRecord, async (req, res, next) => {
  try {
    const vmid = cleanVmid(req.params.vmid);
    const [status, config] = await Promise.all([
      proxmox.get(`/nodes/${req.params.node}/qemu/${vmid}/status/current`),
      proxmox.get(`/nodes/${req.params.node}/qemu/${vmid}/config`),
    ]);
    res.json({
      ok: true,
      recordId: req.params.recordId,
      status: status.data.data,
      config: config.data.data,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/vms/by-record/:recordId/stats ────────────
router.get("/by-record/:recordId/stats", authenticate, authorizeVmByRecord, async (req, res, next) => {
  try {
    const vmid = cleanVmid(req.params.vmid);
    const { timeframe = "hour" } = req.query;
    const { data } = await proxmox.get(`/nodes/${req.params.node}/qemu/${vmid}/rrddata`, {
      params: { timeframe, cf: "AVERAGE" },
    });
    res.json({ ok: true, recordId: req.params.recordId, timeframe, data: data.data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/vms/by-record/:recordId/credentials ──────
// Decrypts and returns the VM's login username/password. Rate-limited (a
// tighter, per-customer limit than the rest of the API) and audit-logged —
// the portal's "Reveal" button promises this is logged, and now it is. Never
// logs the plaintext password itself, only that a reveal happened.
router.get(
  "/by-record/:recordId/credentials",
  authenticate,
  vmActionLimiter,
  authorizeVmByRecord,
  auditLog("credentials_reveal"),
  async (req, res, next) => {
    try {
      if (!process.env.VM_CREDENTIAL_KEY) {
        const err = new Error("Credential encryption is not configured");
        err.status = 500;
        throw err;
      }

      const { data: vm, error: vmError } = await supabaseAdmin
        .from("vms")
        .select("id, username")
        .eq("assigned_vmid", req.vmOwnership.vmid)
        .maybeSingle();

      if (vmError || !vm) {
        const err = new Error("Not found");
        err.status = 404;
        throw err;
      }

      const { data: password, error: pwError } = await supabaseAdmin.rpc("get_vm_password", {
        p_vm_id: vm.id,
        p_key: process.env.VM_CREDENTIAL_KEY,
      });

      if (pwError) throw pwError;

      res.json({ ok: true, username: vm.username || null, password: password || null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/vms/by-record/:recordId/{action} ────────
const POWER_ACTIONS = ["start", "stop", "shutdown", "reboot", "reset", "suspend", "resume"];
for (const action of POWER_ACTIONS) {
  router.post(
    `/by-record/:recordId/${action}`,
    authenticate,
    vmActionLimiter,
    authorizeVmByRecord,
    auditLog(action),
    async (req, res, next) => {
      try {
        const vmid = cleanVmid(req.params.vmid);
        const { data } = await proxmox.post(
          `/nodes/${req.params.node}/qemu/${vmid}/status/${action}`,
          {}
        );
        res.json({ ok: true, recordId: req.params.recordId, task: data.data });
      } catch (err) {
        next(err);
      }
    }
  );
}

// ─── GET /api/vms/by-record/:recordId/console ──────────
router.get(
  "/by-record/:recordId/console",
  authenticate,
  authorizeVmByRecord,
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

      res.json({
        ok: true,
        recordId: req.params.recordId,
        sessionToken,
        wsPath: `/ws/console/${sessionToken}`,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/vms/by-record/:recordId/task/:upid ───────
router.get(
  "/by-record/:recordId/task/:upid",
  authenticate,
  authorizeVmByRecord,
  async (req, res, next) => {
    try {
      const { upid } = req.params;
      const encodedUpid = encodeURIComponent(upid);
      const { data } = await proxmox.get(`/nodes/${req.params.node}/tasks/${encodedUpid}/status`);
      res.json({ ok: true, task: data.data });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
