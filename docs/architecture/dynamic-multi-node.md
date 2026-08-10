# Dynamic multi-node & VM migration architecture

## Purpose

A Proxmox cluster is dynamic on two independent axes: **which nodes exist**
(an operator can add or remove a node at any time) and **which node a given
VM currently runs on** (Proxmox — or its own HA manager — can live-migrate a
VM to a different node at any time, for any reason, including every VM on a
node at once if that node goes down). This proxy must never assume a fixed
topology or a fixed vmid→node mapping. This document describes how it
doesn't.

```
                 Proxmox Cluster
        ┌────────────┼────────────┐
        │            │            │
      node1        node2        node3
        │            │            │
       VMs          VMs          VMs
```

Nodes can appear or disappear. VMs can move between any of them, repeatedly,
without warning. The proxy's job is to always resolve **current** location,
never trust an **original** one:

```
VMID → current VM state → current node → Proxmox API operation
```

not

```
VMID → original/cached node → Proxmox API operation   (wrong)
```

## Node discovery — always live, never a list

`GET /api/nodes` (`src/routes/nodes.js`) calls Proxmox's own `/nodes`
endpoint directly, on every request. There is no cached node list, no
hard-coded `NODE_1`/`NODE_2`/`NODE_3` set, and no fixed node count anywhere
in this codebase. A node being added or removed on the cluster shows up on
the very next call to this route — no restart, no config change, no code
change. Every call logs `[NODE-DISCOVERY] nodes=<comma-separated list>` so
an operator can confirm what the proxy currently sees without querying
Proxmox directly.

The admin, cluster-wide `GET /api/vms` listing (`src/routes/vms.js`) is the
same pattern applied to VMs: it calls `/cluster/resources?type=vm` directly,
live, on every request — never a per-node loop, never a cached inventory.

## VM discovery and VM → current-node resolution

Two different call sites need "where is this VM right now," for two
different reasons, and use two different mechanisms on purpose:

1. **`src/utils/resolveNode.js`'s `resolveNodeForVmid(vmid)`** — a direct,
   uncached `/cluster/resources?type=vm` lookup, filtered to one vmid. This
   is the actual source of truth: whatever Proxmox's cluster state says
   *right now*. Used whenever the proxy needs to find a vmid's node from
   scratch (no cached row, or the cached row is known-stale — see below).
2. **`vm_ownership.node`** — a Postgres column, *not* itself authoritative.
   It's a cache of the result of (1), written once at bind time
   (`POST /api/admin/vms/:vmId/bindings`) and refreshed cluster-wide every 2
   minutes by `src/jobs/syncVmStatus.js`. Every per-VM route reads this
   column to avoid a live cluster call on every single request — but never
   trusts it blindly (next section).

## The self-healing failover: closing the gap between cache and reality

Between two `syncVmStatus` ticks (up to 2 minutes), a VM can migrate and
leave `vm_ownership.node` stale. Previously, any request in that window
failed outright — Proxmox rejects a node-scoped API call for a vmid that
isn't actually on that node — and stayed broken until the next sync tick
corrected the cache.

**`src/utils/nodeFailover.js`'s `withNodeFailover(vmid, cachedNode, run)`**
wraps every node-scoped Proxmox call in `src/routes/vms.js` (status, config,
every power action, delete, stats, console — 14 call sites total, both the
`:vmid`-keyed and customer-facing `by-record`-keyed route families) and
closes that gap **per request**, not per cron tick:

```
Request
  ↓
run(cachedNode)
  ↓ (Proxmox rejects: "Configuration file 'nodes/<cachedNode>/qemu/<vmid>.conf' does not exist")
looksLikeWrongNode(err)?
  ↓ yes
resolveNodeForVmid(vmid)   — live /cluster/resources lookup
  ↓
freshNode found, and different from cachedNode?
  ↓ yes
run(freshNode)              — retried exactly once
  ↓ success
self-heal: UPDATE vm_ownership SET node = freshNode WHERE vmid = vmid
  ↓
response, using the corrected node
```

`looksLikeWrongNode()` matches Proxmox's specific, distinctive error for
"valid vmid, wrong node" (a missing config-file lookup) — not a generic
catch-all. Any other failure (auth, permission, timeout, rate limit) is
rethrown completely unchanged; this mechanism only ever fires for the one
identifiable "stale node cache" case, so it can never mask an unrelated bug
as a phantom migration.

### The three possible outcomes of re-resolution, and why they're distinguished

Re-resolving after a wrong-node failure doesn't always mean "found it
somewhere else" — the cluster itself might be unreadable, the VM might
really be gone, or the VM might genuinely still be on the node that just
failed. Each is a different operational situation and gets a different,
explicit error class instead of collapsing into one opaque 500:

| Outcome | Meaning | `err.status` | Marker |
| --- | --- | --- | --- |
| **Migrated** | Fresh node differs from cached node | — (succeeds after retry) | `[VM-MIGRATION-DETECTED]` log, self-heal write |
| **Not found** | vmid isn't in `/cluster/resources` at all anymore | `404` | `err.vmNotFound = true` |
| **Unreachable** | Fresh lookup says the VM is *still* on the node that just failed — likely that node is offline, not migrated | `503` | `err.nodeUnreachable = true`, `err.node` |
| **Cluster unreadable** | The `/cluster/resources` re-resolution call itself threw | `503` | `err.clusterUnreadable = true` |

This is also how node failure is handled: if `node1` goes down and Proxmox's
own HA manager migrates its VMs elsewhere, the "migrated" path picks that up
transparently on the next request per VM. If a VM has no HA policy and is
simply stuck on a dead node, the "unreachable" path returns a clear,
distinct 503 instead of a generic timeout — see
[Node failure testing](../testing/node-failure-testing.md) and
[Dynamic node/VM operations](../operations/dynamic-node-vm-operations.md).

### Task-status routes: exact, not resolved

`GET .../task/:upid` doesn't use any of the above. A Proxmox UPID encodes
the node a task ran on directly in its own string
(`UPID:{node}:{pid}:{pstart}:{starttime}:{type}:{id}:{user}:`) —
`src/utils/upid.js`'s `nodeFromUpid()` parses it out. This is exact by
construction and can never go stale, so there's nothing to cache, guess, or
retry for task polling specifically.

## Cache behavior summary

- **Authoritative source**: Proxmox's own `/cluster/resources`, always.
- **Cache**: `vm_ownership.node`, TTL enforced by `syncVmStatus`'s 2-minute
  cron cycle.
- **Invalidation**: `withNodeFailover`'s self-heal writes the corrected node
  back immediately on a detected migration — the cache is corrected by the
  first request that actually needs the right answer, not just by the next
  scheduled sync.
- **Retry safety**: exactly one retry, only for the one identifiable
  failure signature, and only for the request that hit it — never a loop,
  never applied to destructive operations blindly (a destroyed-VM retry is
  safe specifically *because* the failure signature means the delete never
  executed anywhere the first time).

## Customer ownership is independent of node

`vm_ownership` ties a customer to a **vmid**, not a node:

```
customer → vm_ownership (user_id, vmid) → current node (resolved, not stored as identity)
```

`node` is a routing detail cached alongside the ownership row, not part of
what defines ownership. A VM migrating from `node1` → `node2` → `node5`
never requires touching the ownership relationship itself — only the cached
`node` column, which `withNodeFailover` keeps correct automatically. See
`src/middleware/authorizeVm.js` / `authorizeVmByRecord.js`: both resolve
`(vmid, node)` from the ownership row and **overwrite** any client-supplied
`:node` URL segment before it ever reaches a Proxmox call — a client cannot
specify an arbitrary node to redirect an action or bypass the ownership
check. Node resolution is entirely server-side, always.

## API design: the client never specifies the real node

- **`/api/vms/by-record/:recordId/...`** (customer-facing): no node
  parameter exists in this route family at all. The real vmid and its
  current node are resolved entirely server-side from the opaque
  `vm_ownership.id`.
- **`/api/vms/:vmid/...`** and **`/api/nodes/:node/vms/:vmid/...`**
  (admin/internal): a `:node` segment can appear in the URL, but it is used
  only for Express routing to this proxy — `authorizeVm` immediately
  overwrites `req.params.node` with the value resolved from `vm_ownership`
  (or live cluster state, for the admin bypass). This route shape predates
  this work and is preserved for backward compatibility rather than removed,
  per the project's regression requirements — but functionally, the URL's
  node segment has never been authoritative.

No endpoint changed shape as part of this work — every response field and
route from before is unchanged. The dynamism described here is entirely
internal to how a route resolves its Proxmox target, not a new contract.

## Logging conventions

Structured, bracket-tagged, matching the project's existing convention
(`[Proxmox Error]`, `[syncVmStatus]`, `[authorizeVmByRecord]`):

- `[NODE-DISCOVERY]` — every `GET /api/nodes` call, the live node list.
- `[VM-RESOLVE]` — a re-resolution was attempted after a stale-node failure,
  and what it found (or didn't).
- `[VM-MIGRATION-DETECTED]` — a migration was confirmed and the cache
  self-healed (`previousNode` → `currentNode`).
- `[VM-OPERATION]` — a mutating VM action completed
  (`vmid=... node=... operation=... status=...`). Deliberately **not**
  emitted for status/stats reads, which the portal polls every 5–60 seconds
  — logging those at this volume would flood the log at odds with the
  project's existing minimal-logging-on-success convention (see
  `syncVmStatus.js`, `proxmoxClient.js`, both of which log failures/anomalies,
  not routine success).

None of these ever log a Proxmox token, Supabase service-role key, JWT, or
password — same as every other log line in this project.

## See also

- [Multi-node testing](../testing/multi-node-testing.md)
- [VM migration testing](../testing/vm-migration-testing.md)
- [Node failure testing](../testing/node-failure-testing.md)
- [dev-zero validation](../testing/dev-zero-validation.md)
- [Dynamic node/VM operations (runbook)](../operations/dynamic-node-vm-operations.md)
- [README.md](../../README.md) — full API reference, auth model, circuit
  breaker, background jobs (unchanged by this work, documented there).
