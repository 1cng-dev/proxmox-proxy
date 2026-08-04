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
│   │   └── resolveNode.js     # Cluster-resources fallback to resolve a vmid's node
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
different node by editing the URL.

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
