const express = require("express");
const router = express.Router({ mergeParams: true });
const proxmox = require("../proxmoxClient");
const supabase = require("../supabaseClient");
const authorize = require("../middleware/authorize");

// ─── Helper ───────────────────────────────────────────
const node = (req) => req.params.node || process.env.PROXMOX_DEFAULT_NODE;
const cleanVmid = (vmid) => vmid.replace(/^:/, "");

// ─── POST /api/vms/request ──────────────────────────
// Customer submits a VM request (stored in DB, status=pending)
router.post("/request", async (req, res, next) => {
  try {
    const { hostname, os, cpu, ram, storage } = req.body;

    if (!hostname || !os || !cpu || !ram || !storage) {
      return res.status(400).json({
        ok: false,
        error: "hostname, os, cpu, ram, and storage are required",
      });
    }

    const { data, error } = await supabase
      .from("vms")
      .insert([{
        user_id:  req.user.id,
        hostname,
        os,
        cpu,
        ram,
        storage,
        status:   "pending",
      }])
      .select("id, hostname, os, cpu, ram, storage, status, created_at")
      .single();

    if (error) throw error;

    res.status(201).json({ ok: true, request: data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/vms/my ────────────────────────────────
// Customer: list only their own VMs
router.get("/my", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("vms")
      .select("id, hostname, os, cpu, ram, storage, status, proxmox_vmid, proxmox_node, public_ip, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ ok: true, vms: data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/vms/requests ───────────────────────────
// Admin: list all VM requests with requester info
router.get("/requests", authorize("admin"), async (req, res, next) => {
  try {
    const { status } = req.query;

    let query = supabase
      .from("vms")
      .select("id, hostname, os, cpu, ram, storage, status, proxmox_vmid, proxmox_node, reject_reason, created_at, updated_at, profiles(id, name, username, email)")
      .order("created_at", { ascending: false });

    if (status) query = query.eq("status", status);

    const { data, error } = await query;

    if (error) throw error;

    res.json({ ok: true, requests: data });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/vms/requests/:id/approve ─────────────
// Admin: approve a pending request → create VM on Proxmox
router.patch("/requests/:id/approve", authorize("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { vmid, proxmox_node } = req.body;

    if (!vmid) {
      return res.status(400).json({ ok: false, error: "vmid is required" });
    }

    const targetNode = proxmox_node || process.env.PROXMOX_DEFAULT_NODE;

    const { data: vmRequest, error: fetchError } = await supabase
      .from("vms")
      .select("*")
      .eq("id", id)
      .eq("status", "pending")
      .single();

    if (fetchError || !vmRequest) {
      return res.status(404).json({ ok: false, error: "pending request not found" });
    }

    const proxmoxPayload = {
      vmid,
      name:     vmRequest.hostname,
      memory:   vmRequest.ram,
      cores:    vmRequest.cpu,
      sockets:  1,
      ostype:   "l26",
      net0:     "virtio,bridge=vmbr0",
      scsi0:    `local-lvm:${vmRequest.storage}`,
      scsihw:   "virtio-scsi-pci",
      bootdisk: "scsi0",
    };

    const { data: proxmoxData } = await proxmox.post(
      `/nodes/${targetNode}/qemu`,
      proxmoxPayload
    );

    const { data: updated, error: updateError } = await supabase
      .from("vms")
      .update({
        status:       "approved",
        proxmox_vmid: vmid,
        proxmox_node: targetNode,
      })
      .eq("id", id)
      .select("id, hostname, status, proxmox_vmid, proxmox_node, updated_at")
      .single();

    if (updateError) throw updateError;

    res.json({ ok: true, vm: updated, task: proxmoxData.data });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/vms/requests/:id/reject ──────────────
// Admin: reject a pending request
router.patch("/requests/:id/reject", authorize("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data, error } = await supabase
      .from("vms")
      .update({
        status:        "declined",
        reject_reason: reason || null,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select("id, hostname, status, reject_reason, updated_at")
      .single();

    if (error || !data) {
      return res.status(404).json({ ok: false, error: "pending request not found" });
    }

    res.json({ ok: true, vm: data });
  } catch (err) {
    next(err);
  }
});

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

// ─── POST /api/nodes/:node/vms ───────────────────────
// Create a new VM
router.post("/", async (req, res, next) => {
  try {
    const {
      vmid, name, memory = 2048, cores = 2, sockets = 1,
      ostype = "l26", iso, storage = "local-lvm", diskSize = "20G",
      net0 = "virtio,bridge=vmbr0",
    } = req.body;

    if (!vmid) {
      return res.status(400).json({ ok: false, error: "vmid is required" });
    }

    const payload = {
      vmid,
      name,
      memory,
      cores,
      sockets,
      ostype,
      net0,
      scsi0: `${storage}:${diskSize}`,
      scsihw: "virtio-scsi-pci",
      bootdisk: "scsi0",
      ...(iso && { ide2: `${iso},media=cdrom` }),
    };

    const { data } = await proxmox.post(
      `/nodes/${node(req)}/qemu`,
      payload
    );
    res.status(201).json({ ok: true, vmid, task: data.data });
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
