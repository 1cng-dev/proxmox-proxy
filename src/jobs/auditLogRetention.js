const cron = require("node-cron");
const supabaseAdmin = require("../supabaseClient");

const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || "90", 10);
const BATCH_SIZE = 1000;

let running = false;
let consecutiveFailures = 0;
let lastError = null;
let lastAttemptAt = null;
let lastSuccessAt = null;

async function cleanOnce() {
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let keepGoing = true;
  let batches = 0;

  while (keepGoing) {
    const { error } = await supabaseAdmin
      .from("vm_action_audit")
      .delete()
      .lt("created_at", cutoff)
      .limit(BATCH_SIZE);

    if (error) throw new Error(error.message);

    batches++;
    keepGoing = false; // Supabase JS does not expose affected count; run once per tick
  }

  console.log(`[auditLogRetention] deleted batches older than ${cutoff}`);
}

async function runGuarded() {
  if (running) {
    console.warn("[auditLogRetention] previous run still active — skipping");
    return;
  }
  running = true;
  lastAttemptAt = new Date();
  try {
    await cleanOnce();
    consecutiveFailures = 0;
    lastError = null;
    lastSuccessAt = new Date();
  } catch (err) {
    consecutiveFailures++;
    lastError = err.message;
    console.error("[auditLogRetention] failed:", err.message);
  } finally {
    running = false;
  }
}

function start() {
  const schedule = process.env.AUDIT_RETENTION_CRON || "0 3 * * *";
  cron.schedule(schedule, runGuarded);
  console.log(`[auditLogRetention] scheduled ${schedule} (retain ${RETENTION_DAYS} days)`);
}

function getHealth() {
  return {
    running,
    consecutiveFailures,
    lastError,
    lastAttemptAt: lastAttemptAt ? lastAttemptAt.toISOString() : null,
    lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
    retentionDays: RETENTION_DAYS,
  };
}

module.exports = { start, getHealth };
