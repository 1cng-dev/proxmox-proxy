const express = require("express");
const router = express.Router();
const supabaseAdmin = require("../supabaseClient");
const authenticate = require("../middleware/authenticate");
const { isStaffUser } = require("../utils/isAdmin");

// Staff-only audit log endpoint. Returns rows from vm_action_audit with
// optional filtering and pagination. Customers and non-staff are rejected.
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
      from,
      to,
      limit: rawLimit,
      offset: rawOffset,
    } = req.query;

    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10), 1), 500);
    const offset = Math.max(parseInt(rawOffset || "0", 10), 0);

    let query = supabaseAdmin
      .from("vm_action_audit")
      .select("id, user_id, vmid, node, action, result, ip_address, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (user_id) query = query.eq("user_id", user_id);
    if (node) query = query.eq("node", node);
    if (action) query = query.eq("action", action.toLowerCase());
    if (result) query = query.eq("result", result.toLowerCase());
    if (vmid) {
      const n = parseInt(vmid, 10);
      if (!Number.isNaN(n)) query = query.eq("vmid", n);
    }
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data, error, count } = await query;

    if (error) throw error;

    res.json({
      ok: true,
      total: count || 0,
      limit,
      offset,
      data: data || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
