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
│   │   ├── authenticate.js    # Verifies Supabase JWT → req.user
│   │   ├── authorizeVm.js     # Checks vm_ownership, resolves the real node
│   │   ├── requireAdmin.js    # Gates admin-only actions (VM destroy)
│   │   └── auditLog.js        # Writes vm_action_audit rows
│   ├── jobs/
│   │   └── syncVmStatus.js    # Cron: refreshes node/status_cache in vm_ownership
│   ├── utils/
│   │   └── vmid.js            # cleanVmid() shared helper
│   └── routes/
│       ├── nodes.js           # Node list / status
│       └── vms.js             # VM operations
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
#    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

# 4. Apply the Supabase schema (vm_ownership, vm_action_audit, RLS)
#    Run supabase/schema.sql against your Supabase project (SQL editor or `supabase db push`)

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
```

## Authentication & Authorization

Every route below requires:

```
Authorization: Bearer <supabase-access-token>
```

Requests without a valid, non-expired Supabase JWT get `401 Unauthorized`.

VM-scoped routes (anything under `/:vmid`) additionally check that the
authenticated user owns that `vmid` in the `vm_ownership` table — if not,
`403 Forbidden`. The `:node` segment in a URL is only used for routing to
this proxy; the actual Proxmox call always targets the node recorded in
`vm_ownership`, so a client cannot redirect an action to a different node by
editing the URL.

`DELETE /api/vms/:vmid` (VM destroy) additionally requires the caller's
Supabase JWT to carry `app_metadata.role = "admin"` — ownership alone is not
enough to destroy a VM.

## Security

- **`helmet`** — sets hardened default HTTP response headers.
- **`cors`** — only origins listed in `ALLOWED_ORIGINS` may call the API
  (falls back to `*` if unset); allowed methods are `GET`, `POST`, `DELETE`.
  Set this to your real production domain — don't rely on the wildcard
  fallback.
- **`express-rate-limit`** — 100 requests / 60s per client IP; over the limit
  returns `{ "ok": false, "error": "Too many requests" }`. This is IP-based
  only, not per-user.
- **JWT authentication + per-VM ownership authorization** — see above.
- **Audit logging** — every start/stop/shutdown/reboot/delete/console action
  is recorded to `vm_action_audit` with user, vmid, node, action, and result.
- **Proxmox credentials never reach the client** — `PROXMOX_TOKEN` is only
  attached server-side, in `src/proxmoxClient.js`.
- **Console/VNC does not leak the Proxmox host** — `GET /api/vms/:vmid/console`
  returns an opaque `sessionToken` and `wsPath`, never the raw Proxmox
  ticket, port, or host address (see `src/wsConsoleProxy.js`).
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

### VMs (default node)
```
GET    /api/vms                          → VM list (caller's owned VMs only)
GET    /api/vms/:vmid                    → VM status + config
POST   /api/vms/:vmid/start              → VM start
POST   /api/vms/:vmid/stop               → VM stop (force)
POST   /api/vms/:vmid/shutdown           → VM shutdown (graceful)
POST   /api/vms/:vmid/reboot             → VM reboot
DELETE /api/vms/:vmid                    → VM terminate (destroy) — admin role only
GET    /api/vms/:vmid/stats?timeframe=hour → CPU/RAM/Disk/Net stats
GET    /api/vms/:vmid/console            → VNC session token + ws path
GET    /api/vms/:vmid/task/:upid         → Task status check
```

### VMs (specific node)
```
GET  /api/nodes/:node/vms
GET  /api/nodes/:node/vms/:vmid
POST /api/nodes/:node/vms/:vmid/start
... (same pattern)
```

### Console websocket
```
WS /ws/console/:sessionToken   → obtained from GET /api/vms/:vmid/console
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
