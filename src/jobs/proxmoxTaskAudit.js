const cron = require("node-cron");
const proxmox = require("../proxmoxClient");
const supabaseAdmin = require("../supabaseClient");

const POLL_INTERVAL = process.env.PROXMOX_TASK_AUDIT_CRON || "*/5 * * * *";
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const ACTION_MAP = {
  qmstart: "start",
  qmstop: "stop",
  qmshutdown: "shutdown",
  qmreboot: "reboot",
  qmreset: "reset",
  qmsuspend: "suspend",
  qmresume: "resume",
  qmdestroy: "delete",
  vncproxy: "console",
};

let running = false;
let consecutiveFailures = 0;
let lastError = null;
let lastAttemptAt = null;
let lastSuccessAt = null;
let lastPollAt = Date.now() - INITIAL_LOOKBACK_MS;

function getHealth() {
  return {
    running,
    consecutiveFailures,
    lastError,
    lastAttemptAt: lastAttemptAt ? lastAttemptAt.toISOString() : null,
    lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
  };
}

async function pollOnce() {
  const { data } = await proxmox.get("/cluster/tasks");
  const tasks = data?.data || [];

  let latestEndAt = lastPollAt;
  let inserted = 0;

  for (const task of tasks) {
    if (!task.endtime) continue;

    const endAt = task.endtime * 1000;
    if (endAt <= lastPollAt) continue;

    const action = ACTION_MAP[task.type];
    if (!action) continue;

    const vmid = parseInt(task.id, 10);
    if (!Number.isInteger(vmid) || vmid <= 0) continue;

    const { error } = await supabaseAdmin
      .from("vm_action_audit")
      .upsert(
        {
          source: "proxmox",
          actor: task.user,
          proxmox_task_id: task.upid,
          vmid,
          node: task.node,
          action,
          result: task.status === "OK" ? "success" : "error",
          started_at: task.starttime ? new Date(task.starttime * 1000).toISOString() : null,
        },
        { onConflict: "proxmox_task_id" }
      );

    if (error) {
      if (error.message?.includes("proxmox_task_id")) {
        console.warn("[proxmoxTaskAudit] duplicate task", task.upid);
      } else {
        console.error("[proxmoxTaskAudit] insert failed", error);
      }
    } else {
      inserted++;
    }

    if (endAt > latestEndAt) latestEndAt = endAt;
  }

  lastPollAt = latestEndAt;
  console.log(`[proxmoxTaskAudit] inserted ${inserted} task(s)`);
}

async function runGuarded() {
  if (running) {
    console.warn("[proxmoxTaskAudit] previous run still active — skipping");
    return;
  }
  running = true;
  lastAttemptAt = new Date();
  try {
    await pollOnce();
    consecutiveFailures = 0;
    lastError = null;
    lastSuccessAt = new Date();
  } catch (err) {
    consecutiveFailures++;
    lastError = err.message;
    console.error("[proxmoxTaskAudit] failed:", err.message);
  } finally {
    running = false;
  }
}

function start() {
  cron.schedule(POLL_INTERVAL, runGuarded);
  console.log(`[proxmoxTaskAudit] scheduled ${POLL_INTERVAL}`);
}

module.exports = { start, getHealth };
