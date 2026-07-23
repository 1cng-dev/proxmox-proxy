const { randomUUID } = require("crypto");

// In-memory VNC console session store, keyed by opaque session token.
// A session maps a short-lived, client-facing token to the real Proxmox
// node/vmid/ticket/port so neither the Proxmox host address nor the raw
// ticket is ever sent to the browser. Single-process only — swap for Redis
// (or similar) before running Proxcy-API behind more than one instance.
const sessions = new Map();

const ttlMs = () => (parseInt(process.env.VNC_TOKEN_TTL_SECONDS, 10) || 60) * 1000;

function createSession({ node, vmid, port, ticket }) {
  const token = randomUUID();
  sessions.set(token, {
    node,
    vmid,
    port,
    ticket,
    expiresAt: Date.now() + ttlMs(),
  });
  return token;
}

// Consumes the session — a token is valid for exactly one websocket connect.
function takeSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  sessions.delete(token);
  if (Date.now() > session.expiresAt) return null;
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}, 30 * 1000).unref();

module.exports = { createSession, takeSession };
