# Proxmox API Proxy Server (Proxcy-API)

VMP Web UI + Proxmox VE + Backend Proxy Server

A multi-tenant Express proxy in front of Proxmox VE. It authenticates
callers with a Supabase-issued JWT, authorizes every VM-scoped request
against a `vm_ownership` table (so one tenant can never reach another
tenant's VM), and hides Proxmox's token, self-signed TLS, and raw error
shapes behind a consistent JSON contract. For request-flow diagrams and
design rationale, see
[Proxcy-API ↔ Proxmox VE — Architecture & Request Flow.md](Proxcy-API%20↔%20Proxmox%20VE%20—%20Architecture%20&%20Request%20Flow.md).

## Project Structure

```
proxmox-proxy/
├── src/
│   ├── index.js               # Express + http server entry point, ws upgrade wiring
│   ├── proxmoxClient.js       # Axios client (Proxmox connection)
│   ├── supabaseClient.js      # Supabase service-role client
│   ├── errorHandler.js        # Central error handler
│   ├── vncSessions.js         # In-memory VNC console session store (TTL)
│   ├── wsConsoleProxy.js      # Proxies /ws/console/:token → Proxmox vncwebsocket
│   ├── middleware/
│   │   ├── authenticate.js         # Verifies Supabase JWT → req.user
│   │   ├── authorizeVm.js          # Ownership check keyed by the real vmid (admin/internal use)
│   │   ├── authorizeVmByRecord.js  # Ownership check keyed by vm_ownership.id (customer-facing, hides the real vmid)
│   │   ├── requireAdmin.js         # Gates admin-only actions (VM destroy)
│   │   ├── requireVMProvisioner.js # Gates VM bindings writes (Admin or Engineer)
│   │   ├── vmActionLimiter.js      # Per-customer rate limit for power actions/credential reveals
│   │   └── auditLog.js             # Writes vm_action_audit rows
│   ├── jobs/
│   │   └── syncVmStatus.js    # Cron: refreshes node/status_cache in vm_ownership
│   ├── utils/
│   │   ├── vmid.js            # cleanVmid() shared helper
│   │   ├── isAdmin.js         # getActiveTeamRole()/isAdminUser()/isVMProvisioner() — team_members-backed role checks
│   │   ├── resolveNode.js     # Cluster-resources lookup to resolve a vmid's current node
│   │   ├── nodeFailover.js    # withNodeFailover() — retries a Proxmox call on the right node after a migration, self-heals vm_ownership
│   │   └── upid.js            # nodeFromUpid() — the node a task ran on, parsed from the UPID itself
│   └── routes/
│       ├── nodes.js           # Node list / status
│       ├── vms.js             # VM operations (both :vmid- and by-record-keyed)
│       └── admin.js           # POST /api/admin/vms/:vmId/bindings
├── supabase/
│   └── schema.sql             # vm_ownership + vm_action_audit tables, RLS
├── .env.example
├── .gitignore
└── package.json
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. .env file create
cp .env.example .env

# 3. Insert values in .env
#    PROXMOX_URL, PROXMOX_TOKEN, PROXMOX_DEFAULT_NODE,
#    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VM_CREDENTIAL_KEY

# 4. Apply the Supabase schema (vm_ownership, vm_action_audit, RLS)
#    Run supabase/schema.sql against your Supabase project (SQL editor or `supabase db push`)
#    Also apply the vmp-ui portal's own migrations under apps/portal/supabase/migrations —
#    that's where vms_customer_safe, set_vm_password/get_vm_password, and the
#    jwt_role() security fix live (this repo and the portal share one Supabase project).

# 5. Start
npm run dev    # development (nodemon)
npm start      # production
```

Ownership rows in `vm_ownership` are meant to be created by your
provisioning/billing workflow (using the Supabase service-role key), not by
end users — there is intentionally no API endpoint in this proxy to create
one.

## .env Config

```env
# Proxmox Connection — use a least-privilege API token (VM.Audit, VM.PowerMgmt,
# VM.Console), not root@pam
PROXMOX_URL=https://YOUR_PROXMOX_IP:8006
PROXMOX_TOKEN=PVEAPIToken=proxcy-api@pve!YOUR_TOKEN_NAME=YOUR_TOKEN_SECRET
PROXMOX_DEFAULT_NODE=node1

# Server Config
PORT=3000
ALLOWED_ORIGINS=http://localhost:5173,https://your-vmp-domain.com

# Supabase — JWT auth, VM ownership authorization, audit logging
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY   # server-side only, never ship to a client

# VNC console session token TTL (seconds)
VNC_TOKEN_TTL_SECONDS=60

# Symmetric key for VM login-credential encryption — server-side only, never
# in the database or sent to a client. Generate with `openssl rand -base64 32`.
VM_CREDENTIAL_KEY=YOUR_LONG_RANDOM_SECRET
```

## Authentication & Authorization

Every route below requires:

```
Authorization: Bearer <supabase-access-token>
```

Requests without a valid, non-expired Supabase JWT get `401 Unauthorized`.

VM-scoped routes under `/:vmid` (admin/internal use — see below) additionally
check that the authenticated user owns that `vmid` in the `vm_ownership`
table — if not, `403 Forbidden`. The `:node` segment in a URL is only used
for routing to this proxy; the actual Proxmox call always targets the node
recorded in `vm_ownership`, so a client cannot redirect an action to a
different node by editing the URL. That recorded node is a cache, not a live
lookup — see [Multi-node & VM migration handling](#multi-node--vm-migration-handling)
for how a request still succeeds if the VM has moved since the cache was last
refreshed.

**Two ways to identify a VM in a request:**

- **`/api/vms/:vmid`** — keyed by the *real* Proxmox vmid. Admin/internal use
  only; nothing in the portal's customer-facing UI ever sends this.
- **`/api/vms/by-record/:recordId`** — keyed by `vm_ownership.id`, an opaque
  UUID. This is what the customer-facing portal actually calls — the browser
  never holds or transmits the real Proxmox vmid. `authorizeVmByRecord`
  resolves `(vmid, node)` server-side from that UUID + the caller's
  `user_id`, and returns `404` (never `403`) on any mismatch, so probing
  record IDs can't even confirm one exists. Both identifier schemes support
  the same operations: status, stats, credentials reveal, start/stop/
  shutdown/reboot/reset/suspend/resume, console, task status.

`DELETE /api/vms/:vmid` (VM destroy) requires the caller to be an admin —
checked via `requireAdmin` → `isAdminUser()` against the `team_members`
table (`role = 'Admin'`, `status = 'Active'`), never from a client-supplied
JWT claim.

`POST /api/admin/vms/:vmId/bindings` (writes a VM's real vmid/node/
credentials) requires Admin **or** Engineer — checked via
`requireVMProvisioner` → `getActiveTeamRole()`, same `team_members` source
of truth. This is deliberately narrower than a general admin/engineer role
merge: `requireVMProvisioner` is only ever applied to this one route;
everything else that requires Admin (VM destroy, admin read-bypass) still
uses `requireAdmin`/`isAdminUser` unchanged. The audit row for this action
records `performed_by_role` at insert time, so "was this bound by an admin
or an engineer" stays answerable even if the user's role changes later.

**Admin read bypass** — `GET /api/vms`, `GET /api/vms/:vmid`/`by-record/:recordId`,
and their `/stats` routes let an admin through without an ownership check
(same `isAdminUser()` check as above), so staff can monitor any tenant's VM.
This bypass is intentionally read-only: power actions, console, credentials,
delete, and task-status still require the caller to own the VM in
`vm_ownership`, admin or not.

**VM login credentials** are encrypted at rest (`vms.password_encrypted`, via
`pgp_sym_encrypt`/`pgp_sym_decrypt` and `VM_CREDENTIAL_KEY`, never the
database). `GET /api/vms/by-record/:recordId/credentials` is the only way to
read them back — rate-limited tighter than the rest of the API
(`vmActionLimiter`, 20/min per customer) and audit-logged on every reveal.

## Background jobs

**`syncVmStatus`** (`src/jobs/syncVmStatus.js`) runs every 2 minutes, pulling
`/cluster/resources` and refreshing `vm_ownership.node`/`status_cache`. This
endpoint does real work proportional to cluster size, so it gets its own 45s
timeout (vs. the 15s default `proxmoxClient` uses for interactive requests)
plus up to 3 retries with exponential backoff (2s/4s/8s) on timeouts/network
errors/5xx — but not on 4xx (an expired/bad token won't fix itself on retry,
so those fail immediately instead of wasting 14+ seconds). A concurrency
guard makes overlapping runs structurally impossible (a slow/retrying run
skips the next cron tick rather than piling up). Failure logging is throttled
to the first failure of a new episode plus every 5th afterward, not a full
stack trace per attempt.

No monitoring/alerting system exists elsewhere in this service to wire this
into — the minimal signal is `syncVmStatus` in the `GET /health` response
(`running`, `consecutiveFailures`, `lastError`, `lastAttemptAt`,
`lastSuccessAt`), for an operator or external uptime check to read without
grepping logs.

## Multi-node & VM migration handling

A Proxmox cluster is dynamic on two axes, independently of anything this
service does: which nodes exist (an operator can add or remove a node at any
time), and which node a given vmid currently runs on (Proxmox — or its own HA
manager — can live-migrate a VM to a different node at any time, for any
reason, including all VMs on a node at once if that node goes down). Nothing
in this service assumes a fixed topology or a fixed vmid→node mapping:

- **`GET /api/nodes`** and the admin, cluster-wide `GET /api/vms` listing call
  Proxmox's own `/nodes` and `/cluster/resources` endpoints directly on every
  request — there's no cached node list or node count anywhere, so a node
  being added or removed shows up on the very next request with no code
  change or restart needed.
- **Per-VM routing** (every `:vmid`/`by-record/:recordId` route — status,
  stats, power actions, console, delete) is keyed off `vm_ownership.node`,
  which is a *cache*: written once when a VM is bound
  (`POST /api/admin/vms/:vmId/bindings`) and refreshed cluster-wide every 2
  minutes by `syncVmStatus` (see above). A VM that migrates in between those
  refreshes has a stale cached node for up to that window — previously, any
  action request in that window would fail outright with whatever error
  Proxmox gives for "this vmid isn't on this node," and stay broken until the
  next sync tick corrected it.
- **`utils/nodeFailover.js`'s `withNodeFailover()`** closes that window per
  request instead of waiting on the clock: every per-VM route now runs its
  Proxmox call through it. On success, nothing changes. If the call fails
  with Proxmox's specific "config file not found on this node" signature
  (`utils/nodeFailover.js`'s `looksLikeWrongNode()` — distinct from a
  permission error, timeout, or a vmid that doesn't exist anywhere), it
  re-resolves the vmid's real current node from a live `/cluster/resources`
  call (`utils/resolveNode.js`, the same lookup `syncVmStatus` and the
  admin-bypass-with-no-ownership-row path already used), retries the original
  call once against the corrected node, and — on that retry succeeding —
  writes the corrected node back to `vm_ownership` immediately, so every other
  in-flight or subsequent request for that vmid is right away, not after the
  next cron tick. This is retried exactly once and only for that one specific
  failure signature; any other error (auth, permission, a vmid that's really
  gone) is rethrown unchanged, un-retried.
- **Task-status routes** (`GET .../task/:upid`) don't use `vm_ownership.node`
  or the failover above at all — a Proxmox UPID encodes the node a task ran
  on directly in its own string (`UPID:{node}:...`, parsed by
  `utils/upid.js`'s `nodeFromUpid()`), which is exact by construction and
  can't go stale, so there's nothing to guess or retry there.
- **Audit logging stays accurate through a failover.** Each route updates
  `req.params.node` to the corrected node before responding, so
  `auditLog` (which reads `req.params.node` at response time — see
  `middleware/auditLog.js`) records the node the action actually ran on, not
  the stale one the request started with.

**What this doesn't cover, by design:** a vmid that's been destroyed or
truly doesn't exist on the cluster still fails normally (`looksLikeWrongNode`
plus a `resolveNodeForVmid` miss falls straight through to the original
error) — this is a migration-detection mechanism, not a general-purpose
retry-everything layer.

### Testing this

There's no automated test framework in this project (`package.json` has no
test runner or test script) — the checks below are meant to be run by hand,
in increasing order of how much real infrastructure they need.

**1. Pure-logic checks — no Proxmox, no Supabase, no network.** Verify
`looksLikeWrongNode()` and `nodeFromUpid()` classify things correctly in
isolation:

```bash
cd proxmox-proxy
SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=test node -e '
const { looksLikeWrongNode } = require("./src/utils/nodeFailover.js");
const { nodeFromUpid } = require("./src/utils/upid.js");

console.log(looksLikeWrongNode({ status: 500, message: "Configuration file '\''nodes/old/qemu/100.conf'\'' does not exist" })); // true
console.log(looksLikeWrongNode({ status: 403, message: "Forbidden" })); // false
console.log(nodeFromUpid("UPID:pve2:00001234:0002ABCD:6614A1B2:qmstart:100:user@pve:")); // "pve2"
console.log(nodeFromUpid("not-a-upid")); // null
'
```

(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are only set here because
`nodeFailover.js` requires `supabaseClient.js` at load time, which throws if
they're missing — no real Supabase project is contacted by this check.)

**2. Failover retry + self-heal, with Proxmox and Supabase mocked.** Confirms
the actual retry-once-and-self-heal sequence, without needing a live cluster:

```bash
cd proxmox-proxy
SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=test node -e '
const path = require("path");
const Module = require("module");

// Stand in for supabaseClient.js so the self-heal write is observable instead
// of hitting a real database.
const supaPath = path.resolve("./src/supabaseClient.js");
let updateCalls = [];
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: {
  from: () => ({ update: (fields) => ({ eq: (col, val) => { updateCalls.push({ fields, col, val }); return Promise.resolve({ error: null }); } }) }),
}};

// Stand in for resolveNode.js so no live /cluster/resources call is needed.
const resolvePath = path.resolve("./src/utils/resolveNode.js");
require.cache[resolvePath] = { id: resolvePath, filename: resolvePath, loaded: true, exports: { resolveNodeForVmid: async () => "pve3" } };

const { withNodeFailover } = require("./src/utils/nodeFailover.js");

(async () => {
  const calls = [];
  const { node, result } = await withNodeFailover(200, "pve1", async (n) => {
    calls.push(n);
    if (n === "pve1") { const e = new Error("Configuration file '\''nodes/pve1/qemu/200.conf'\'' does not exist"); e.status = 500; throw e; }
    return "ok";
  });
  console.log("resolved node:", node);       // expect "pve3"
  console.log("call sequence:", calls);      // expect ["pve1", "pve3"] — one retry, not a loop
  console.log("self-heal write:", updateCalls); // expect one vm_ownership update to node "pve3"
})();
'
```

**3. Manual end-to-end, against a real multi-node cluster.** Needs a Proxmox
cluster with at least 2 nodes and a test VM already bound via
`vm_ownership`.

1. Confirm the VM's current cached node:
   `select node from vm_ownership where vmid = <test-vmid>;`
2. Migrate the VM to a *different* node — either through the Proxmox web UI
   (Datacenter → node → VM → Migrate) or `qm migrate <vmid> <target-node>` on
   the source node.
3. **Immediately** (before the next `syncVmStatus` tick — within ~2 minutes,
   sooner the better) call a status or power-action route through this
   service for that VM, e.g.
   `curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<vmid>`.
4. Expect: the request still succeeds (no error, no manual DB fix needed),
   and this service's logs show
   `[nodeFailover] vmid=<vmid> not on cached node "<old>" ... — retrying on "<new>"`
   followed by
   `[nodeFailover] self-healed vm_ownership.node for vmid=<vmid>: "<old>" -> "<new>"`.
5. Re-check `vm_ownership.node` in the database — it should already read the
   new node, not the old one, without waiting for the next cron tick.
6. Repeat step 3 for a power action (e.g. `.../reboot`) and its
   `.../task/:upid` route — confirm the task-status call succeeds too (this
   one uses the UPID's own embedded node, not the cache, so it should work
   regardless of exactly when the migration happened relative to the poll).

**4. Simulating "stale node" without waiting for a real migration.** If you
don't want to trigger an actual live migration, you can fake the same
condition directly: manually set `vm_ownership.node` to any *other* real node
name in the cluster that the VM is *not* currently on
(`update vm_ownership set node = '<wrong-node>' where vmid = <test-vmid>;`),
then call any status/power-action route for that vmid. This reproduces
exactly the error Proxmox would give after a real migration and exercises
the same failover/self-heal path as step 3 above, without touching the VM's
actual running state.

## Circuit breaker

`src/proxmoxClient.js` trips a circuit breaker after 3 consecutive failures
from Proxmox (any caller — interactive routes and `syncVmStatus` share the
same client/breaker, since they talk to the same one Proxmox host). Once
open, every request fails immediately with a `503` (`error.circuitOpen =
true`) instead of waiting out the full per-request timeout — this bounds the
blast radius of a genuine Proxmox/network outage (every caller previously
paid the full 15s, or 45s for `syncVmStatus`, on every single request during
an outage). The circuit stays open for a 20s cooldown, then the next request
is let through as a trial: success fully resets the breaker, failure reopens
it for another cooldown. This is a mitigation, not a fix — it does not
diagnose or resolve *why* Proxmox is unreachable, only stops every caller
from independently rediscovering that fact the slow way. Current state is
exposed at `proxmoxCircuit` in the `GET /health` response (`open`,
`consecutiveFailures`, `lastFailureMessage`, `reopensAt`).

## Security

- **`helmet`** — sets hardened default HTTP response headers.
- **`cors`** — only origins listed in `ALLOWED_ORIGINS` may call the API
  (falls back to `*` if unset); allowed methods are `GET`, `POST`, `DELETE`.
  Set this to your real production domain — don't rely on the wildcard
  fallback.
- **`express-rate-limit`** — 100 requests / 60s per client IP; over the limit
  returns `{ "ok": false, "error": "Too many requests" }`. This is IP-based
  only, not per-user. A second, tighter limiter (`vmActionLimiter`, 20/min,
  keyed by `req.user.id`) additionally applies to power actions and
  credential reveals specifically, so one compromised/abusive account can't
  hide a rapid start/stop loop or credential-scraping behind shared-IP
  traffic (or get blocked by punishing everyone on that IP).
- **JWT authentication + per-VM ownership authorization** — see above.
- **Audit logging** — every start/stop/shutdown/reboot/reset/suspend/resume/
  delete/console/credentials-reveal/admin-bindings-write action is recorded
  to `vm_action_audit` with user, vmid, node, action, and result. Credential
  reveals and writes never log the plaintext password itself.
- **Proxmox credentials never reach the client** — `PROXMOX_TOKEN` is only
  attached server-side, in `src/proxmoxClient.js`.
- **Console/VNC does not leak the Proxmox host or port** — the console routes
  return an opaque, single-use `sessionToken` and `wsPath`; the Proxmox host
  and port are never sent to the client (see `src/wsConsoleProxy.js`). The
  by-record route additionally returns the VNC `ticket` itself — required by
  the noVNC RFB handshake tunneled inside that websocket (the same way
  Proxmox's own web console works) — scoped to that one already-authorized
  session, never reused.
- **Self-signed TLS** — outbound requests to Proxmox VE accept self-signed
  certificates via a dedicated HTTPS agent scoped to the Proxmox client only.

## API Endpoints

### Multi-node support

```
/api/nodes/:node/vms/:vmid/start
```

### Health (no auth required)
```
GET /health
```

### Nodes
```
GET /api/nodes              → all nodes in cluster
GET /api/nodes/:node        → status of a node
```

### VMs (default node, keyed by the real vmid — admin/internal use)
```
GET    /api/vms                          → VM list (owned VMs only; every VM on the cluster for admins)
GET    /api/vms/:vmid                    → VM status + config
POST   /api/vms/:vmid/start              → VM start
POST   /api/vms/:vmid/stop               → VM stop (force)
POST   /api/vms/:vmid/shutdown           → VM shutdown (graceful)
POST   /api/vms/:vmid/reboot             → VM reboot
POST   /api/vms/:vmid/reset              → VM hard reset
POST   /api/vms/:vmid/suspend            → VM suspend
POST   /api/vms/:vmid/resume             → VM resume
DELETE /api/vms/:vmid                    → VM terminate (destroy) — admin role only
GET    /api/vms/:vmid/stats?timeframe=hour → CPU/RAM/Disk/Net stats
GET    /api/vms/:vmid/console            → VNC session token + ws path
GET    /api/vms/:vmid/task/:upid         → Task status check
```

### VMs (keyed by vm_ownership.id — what the customer-facing portal calls)
```
GET    /api/vms/by-record/:recordId
GET    /api/vms/by-record/:recordId/stats?timeframe=hour
GET    /api/vms/by-record/:recordId/credentials   → decrypted {username, password}, audit-logged
POST   /api/vms/by-record/:recordId/start|stop|shutdown|reboot|reset|suspend|resume
GET    /api/vms/by-record/:recordId/console
GET    /api/vms/by-record/:recordId/task/:upid
```

### VMs (specific node)
```
GET  /api/nodes/:node/vms
GET  /api/nodes/:node/vms/:vmid
POST /api/nodes/:node/vms/:vmid/start
... (same pattern)
```

### Admin
```
POST /api/admin/vms/:vmId/bindings  → writes assigned_vmid/node/pmx_type/public_ip/
                                       private_ip/username/password for a VM record
                                       (vmId is the vms.id UUID). Encrypts password
                                       server-side; admin role required.
```

### Console websocket
```
WS /ws/console/:sessionToken   → obtained from a .../console route above
```

### Stats timeframe options
```
hour | day | week | month | year
```

## Example API Requests

```bash
# Health check (no auth)
curl http://localhost:3000/health

# List your VMs
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms

# Get VM status (replace 100 with a VM ID you own)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/100

# Start VM
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/100/start

# Stop VM (force)
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/100/stop

# Shutdown VM (graceful)
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/100/shutdown

# Reboot VM
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/100/reboot

# Get VM stats
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/100/stats?timeframe=hour

# Get a VNC console session (returns sessionToken + wsPath, not a raw ticket)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/100/console

# Destroy VM — requires an admin-role token
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/vms/100

# Multi-node: Start VM on specific node
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/nodes/node1/vms/100/start

# Customer-facing: status/usage/credentials/power actions by opaque record ID
# (recordId is vm_ownership.id, not the real Proxmox vmid)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/by-record/$RECORD_ID
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/by-record/$RECORD_ID/credentials
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/by-record/$RECORD_ID/reset

# Admin: write a VM's real vmid/node/credentials binding
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"assigned_vmid":1001,"node":"pve1","username":"root","password":"..."}' \
  http://localhost:3000/api/admin/vms/$VM_RECORD_UUID/bindings
```

## Response Format

### Success
```json
{
  "ok": true,
  "data": { ... }
}
```

### Error
```json
{
  "ok": false,
  "error": "error message",
  "path": "/api/vms/101/start"
}
```
