// A leading ":" has shown up in req.params.vmid from some callers — strip it
// defensively rather than reject the request. If you control the client,
// prefer fixing it at the source instead of relying on this.
const cleanVmid = (vmid) => String(vmid).replace(/^:/, "");

module.exports = { cleanVmid };
