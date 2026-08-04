const cron = require("node-cron");
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");

// Keeps vm_ownership.node / status_cache aligned with reality so the
// authorizeVm middleware routes to the node a VM actually lives on after a
// migration, and so a VM list can be rendered without a live Proxmox call
// per row. Never touches user_id — ownership is only ever set by the
// provisioning workflow, not by this job.

// /cluster/resources does real work proportional to cluster size (every
// node/VM/container gets serialized), unlike an interactive request for one
// VM's status — this background job isn't blocking any user-facing request,
// so it can afford a longer timeout than proxmoxClient's 15s default (which
// stays as-is for everything else). 45s is a deliberately generous ceiling
// chosen without a real observed success-case timing sample to calibrate
// against (this sandbox has no credentialed access to the live cluster to
// measure that) — tighten it once real success-case timings are visible in
// production logs via the health signal this file now exposes.
const SYNC_TIMEOUT_MS = 45000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000; // 2s, 4s, 8s

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 4xx from Proxmox (bad/expired token, permission) won't fix itself on
// retry — fail fast instead of masking a real config problem behind 14+
// extra seconds of doomed retries. Timeouts and network failures have no
// response, and proxmoxClient's interceptor normalizes those (and any 5xx)
// to status 500 — both are worth retrying.
function isRetryable(err) {
  return !err.status || err.status >= 500;
}

async function fetchClusterResources() {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await proxmox.get("/cluster/resources", {
        params: { type: "vm" },
        timeout: SYNC_TIMEOUT_MS,
      });
    } catch (err) {
      if (attempt > MAX_RETRIES || !isRetryable(err)) throw err;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[syncVmStatus] attempt ${attempt}/${MAX_RETRIES + 1} failed (${err.message}) — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}

async function syncOnce() {
  const { data } = await fetchClusterResources();

  for (const vm of data.data || []) {
    const { error } = await supabaseAdmin
      .from("vm_ownership")
      .update({ node: vm.node, status_cache: vm.status, updated_at: new Date().toISOString() })
      .eq("vmid", vm.vmid);

    if (error) console.error("[syncVmStatus] update failed", vm.vmid, error);
  }
}

// Health/observability state — no monitoring/alerting system exists
// elsewhere in this service to wire into, so this is exposed via GET
// /health (see index.js) as the minimal signal: an operator (or an external
// uptime check hitting /health) can see staleness/failure without grepping
// logs.
let running = false;
let consecutiveFailures = 0;
let lastError = null;
let lastAttemptAt = null;
let lastSuccessAt = null;

// cron's interval (2 min) has no built-in guarantee the previous run has
// finished — under real slowness (retries alone can take up to
// 3 * 45s + backoff), an overlapping run would compete for the same
// connections and make every individual request slower, compounding the
// original problem. This guard makes overlap structurally impossible.
async function runGuarded() {
  if (running) {
    console.warn("[syncVmStatus] previous run still in progress — skipping this tick");
    return;
  }
  running = true;
  lastAttemptAt = new Date();
  try {
    await syncOnce();
    if (consecutiveFailures > 0) {
      console.log(`[syncVmStatus] recovered after ${consecutiveFailures} consecutive failure(s)`);
    }
    consecutiveFailures = 0;
    lastError = null;
    lastSuccessAt = new Date();
  } catch (err) {
    consecutiveFailures++;
    lastError = err.message;
    // Full detail on the first failure of a new episode (useful for
    // diagnosing what changed), then a terse "still failing" heartbeat
    // every 5th run after that — not a full stack trace on every attempt,
    // which is what buried this the first time.
    if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
      console.error(
        `[syncVmStatus] failing (${consecutiveFailures} consecutive failure${consecutiveFailures > 1 ? "s" : ""}), ` +
          `last success ${lastSuccessAt ? lastSuccessAt.toISOString() : "never"}: ${err.message}`
      );
    }
  } finally {
    running = false;
  }
}

function start() {
  cron.schedule("*/2 * * * *", runGuarded);
  console.log("[syncVmStatus] scheduled every 2 minutes");
}

function getHealth() {
  return {
    running,
    consecutiveFailures,
    lastError,
    lastAttemptAt: lastAttemptAt ? lastAttemptAt.toISOString() : null,
    lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
  };
}

module.exports = { start, syncOnce, getHealth, runGuarded };
