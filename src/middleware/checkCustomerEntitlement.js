const supabaseAdmin = require("../supabaseClient");

async function checkCustomerEntitlement(req, res, next) {
  try {
    const customerId = req.vmOwnership?.customer_id;
    if (!customerId) {
      const err = new Error("Ownership record missing customer");
      err.status = 403;
      throw err;
    }

    const [{ data: customer }, { data: vmCount }] = await Promise.all([
      supabaseAdmin.from("customers").select("status, max_vms").eq("id", customerId).single(),
      supabaseAdmin.from("vm_ownership").select("id", { count: "exact" }).eq("customer_id", customerId),
    ]);

    const blockedStatuses = ["suspended", "inactive"];
    if (
      !customer ||
      blockedStatuses.includes(customer.status?.toString().toLowerCase())
    ) {
      const err = new Error("Customer account inactive or suspended");
      err.status = 403;
      throw err;
    }

    if (customer.max_vms != null && vmCount?.length >= customer.max_vms) {
      // Only block create/clone routes; for start/stop just warn or skip
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = checkCustomerEntitlement;