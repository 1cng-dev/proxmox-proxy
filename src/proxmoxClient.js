const axios = require("axios");
const https = require("https");

// Agent to allow self-signed certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const proxmoxClient = axios.create({
  baseURL: `${process.env.PROXMOX_URL}/api2/json`,
  httpsAgent,
  headers: {
    Authorization: process.env.PROXMOX_TOKEN,
    "Content-Type": "application/json",
  },
  timeout: 15000,
  transformResponse: [function (data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      // If JSON parsing fails, return the raw data
      return data;
    }
  }],
});

// ─── Circuit breaker ───────────────────────────────────
// When Proxmox is genuinely unreachable, every caller (interactive requests
// from the portal, syncVmStatus's retries) was waiting out the full 15s
// timeout on every single request before failing — multiplied across every
// VM, every endpoint, every poll. This doesn't fix whatever the underlying
// reachability problem is (that's infra, not something this client can
// resolve), but it bounds the damage: after a few consecutive failures,
// short-circuit immediately (no network call at all) for a cooldown window
// instead of making every caller wait 15s to learn what the last caller
// already found out a moment ago. The first request after the cooldown is
// a real "trial" call — if it succeeds, the breaker fully resets; if it
// fails, it reopens for another cooldown. Shared across all callers of this
// client (interactive routes and the background sync job alike), since
// they're both talking to the same one Proxmox host.
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 20000;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let lastFailureMessage = null;

function circuitIsOpen() {
  return Date.now() < circuitOpenUntil;
}

function getCircuitState() {
  return {
    open: circuitIsOpen(),
    consecutiveFailures,
    lastFailureMessage,
    reopensAt: circuitOpenUntil ? new Date(circuitOpenUntil).toISOString() : null,
  };
}

proxmoxClient.interceptors.request.use((config) => {
  if (circuitIsOpen()) {
    const error = new Error(
      `Proxmox is currently unreachable (${consecutiveFailures} consecutive failures, last: ${lastFailureMessage}) — failing fast instead of waiting out another timeout`
    );
    error.status = 503;
    error.circuitOpen = true;
    return Promise.reject(error);
  }
  return config;
});

// Response interceptor — normalizes Proxmox errors, tracks circuit state
proxmoxClient.interceptors.response.use(
  (res) => {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    // Handle empty responses from Proxmox
    if (!res.data || res.data === '') {
      res.data = { data: null };
    }
    return res;
  },
  (err) => {
    // Already normalized by the request interceptor above (circuit was open) —
    // don't double-count it as a new failure, and don't re-log it.
    if (err.circuitOpen) {
      throw err;
    }

    const status = err.response?.status || 500;
    const proxmoxData = err.response?.data;
    // Proxmox reports "wrong node for this vmid" (e.g. right after a live
    // migration) via its HTTP reason phrase — e.g. "Configuration file
    // 'nodes/oldnode/qemu/100.conf' does not exist" — with an empty JSON
    // body, so statusText is often the only place that detail survives.
    // Preserved on the thrown error below for utils/nodeFailover.js to detect.
    const statusText = err.response?.statusText || null;
    const message =
      proxmoxData?.errors ||
      proxmoxData?.message ||
      (typeof proxmoxData === 'string' && proxmoxData ? proxmoxData : null) ||
      statusText ||
      err.message ||
      "Proxmox connection failed";

    console.error("[Proxmox Error]", {
      status,
      message,
      data: proxmoxData,
      url: err.config?.url
    });

    consecutiveFailures++;
    lastFailureMessage = message;
    if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      console.error(
        `[Proxmox Error] ${consecutiveFailures} consecutive failures — opening circuit for ${CIRCUIT_COOLDOWN_MS}ms`
      );
    }

    const error = new Error(message);
    error.status = status;
    error.proxmoxStatusText = statusText;
    throw error;
  }
);

module.exports = proxmoxClient;
module.exports.getCircuitState = getCircuitState;
