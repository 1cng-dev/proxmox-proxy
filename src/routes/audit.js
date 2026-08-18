const express = require("express");
const router = express.Router();
const supabaseAdmin = require("../supabaseClient");
const authenticate = require("../middleware/authenticate");
const { isStaffUser } = require("../utils/isAdmin");

// GET /api/admin/audit-logs
// Staff-only endpoint to retrieve vm_action_audit records.
// Supports filtering by source, user, vmid, action, result, and date range.
router.get("/", authenticate, async (req, res, next) => {
  try {
    if (!(await isStaffUser(req.user.id))) {
      const err = new Error("Staff role required");
      err.status = 403;
      throw err;
    }

    const {
      user_id,
      vmid,
      node,
      action,
      result,
      source,
      actor,
      from,
      to,
      limit = "50",
      offset = "0",
    } = req.query;

    const pageLimit = parseInt(limit, 10);
    const pageOffset = parseInt(offset, 10);

    let query = supabaseAdmin
      .from("vm_action_audit")
      .select(
        "id, user_id, actor, source, vmid, node, action, result, ip_address, proxmox_task_id, started_at, created_at",
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(pageOffset, pageOffset + pageLimit - 1);

    if (user_id) query = query.eq("user_id", user_id);
    if (vmid) query = query.eq("vmid", parseInt(vmid, 10));
    if (node) query = query.ilike("node", `%${node}%`);
    if (action) query = query.eq("action", action);
    if (result) query = query.eq("result", result);
    if (source) query = query.eq("source", source);
    if (actor) query = query.ilike("actor", `%${actor}%`);
    if (from) query = query.gte("created_at", new Date(from).toISOString());
    if (to) query = query.lte("created_at", new Date(to).toISOString());

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      ok: true,
      total: count || 0,
      limit: pageLimit,
      offset: pageOffset,
      data: data || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
