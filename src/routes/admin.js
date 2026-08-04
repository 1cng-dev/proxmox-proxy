const express = require("express");
const router = express.Router();
const supabaseAdmin = require("../supabaseClient");
const authenticate = require("../middleware/authenticate");
const requireVMProvisioner = require("../middleware/requireVMProvisioner");

// ─── POST /api/admin/vms/:vmId/bindings ────────────────
// Writes the "Engineer Provisioning Data" for a VM record already created
// (non-sensitive fields only) via the portal's direct-insert flow: the real
// Proxmox vmid/node, and the VM's login credentials. This is the only path
// that ever writes assigned_vmid/node/username/password — it exists here,
// not as a client-side Supabase insert, because encrypting the password
// requires VM_CREDENTIAL_KEY, which lives only in this service's env and
// must never reach the browser. Upserts vm_ownership (keyed by vmid, which
// is unique per the schema) and updates the matching vms row.
//
// Admin or Engineer — engineers are the ones actually provisioning VMs in
// Proxmox, so they can record the result themselves. requireVMProvisioner
// is scoped to exactly this route; every other admin-gated action in this
// service (VM destroy, admin read-bypass) still requires Admin specifically.
router.post("/vms/:vmId/bindings", authenticate, requireVMProvisioner, async (req, res, next) => {
  try {
    const { vmId } = req.params;
    const {
      assigned_vmid,
      node,
      pmx_type = "qemu",
      public_ip,
      private_ip,
      username,
      password,
    } = req.body || {};

    const vmid = parseInt(assigned_vmid, 10);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      const err = new Error("assigned_vmid must be a positive integer");
      err.status = 400;
      throw err;
    }
    if (!node || typeof node !== "string") {
      const err = new Error("node is required");
      err.status = 400;
      throw err;
    }

    const { data: vm, error: vmError } = await supabaseAdmin
      .from("vms")
      .select("id, customer_id")
      .eq("id", vmId)
      .maybeSingle();

    if (vmError || !vm) {
      const err = new Error("VM record not found");
      err.status = 404;
      throw err;
    }
    if (!vm.customer_id) {
      const err = new Error("VM record has no customer assigned");
      err.status = 400;
      throw err;
    }

    const vmUpdate = { assigned_vmid: vmid, node, pmx_type };
    if (public_ip !== undefined) vmUpdate.public_ip = public_ip;
    if (private_ip !== undefined) vmUpdate.private_ip = private_ip;
    if (username !== undefined) vmUpdate.username = username;

    const { error: updateError } = await supabaseAdmin
      .from("vms")
      .update(vmUpdate)
      .eq("id", vmId);
    if (updateError) throw updateError;

    if (password) {
      if (!process.env.VM_CREDENTIAL_KEY) {
        const err = new Error("Credential encryption is not configured");
        err.status = 500;
        throw err;
      }
      const { error: pwError } = await supabaseAdmin.rpc("set_vm_password", {
        p_vm_id: vmId,
        p_password: password,
        p_key: process.env.VM_CREDENTIAL_KEY,
      });
      if (pwError) throw pwError;
    }

    const { error: ownershipError } = await supabaseAdmin.from("vm_ownership").upsert(
      {
        user_id: vm.customer_id,
        customer_id: vm.customer_id,
        vmid,
        node,
        pmx_type,
      },
      { onConflict: "vmid" }
    );
    if (ownershipError) throw ownershipError;

    // Never log the password — only that a binding was written, by whom,
    // and in which role (Admin or Engineer) — captured at insert time so
    // this stays accurate even if the user's role changes later.
    await supabaseAdmin.from("vm_action_audit").insert({
      user_id: req.user.id,
      vmid,
      node,
      action: "admin_bindings_set",
      result: "success",
      ip_address: req.ip,
      performed_by_role: req.teamRole,
    });

    res.json({ ok: true, vmId, vmid, node });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
