# Multi-node testing

See [architecture: dynamic multi-node](../architecture/dynamic-multi-node.md)
for how this all works before running these. This project has no test
framework dependency — `npm test` runs Node's own built-in test runner
(`node --test`, stable since Node 18), so there's nothing extra to install.

## Automated tests (no Proxmox, no Supabase, no network)

```bash
cd proxmox-proxy
npm install   # first time only
npm test
```

This runs `test/*.test.js`:

- **`test/upid.test.js`** — `nodeFromUpid()` parsing correctness.
- **`test/nodeFailover.test.js`** — `looksLikeWrongNode()` classification,
  and `withNodeFailover()`'s full behavior matrix: happy path (no failover),
  migration detected + retry + self-heal, self-heal write failing without
  failing the request, an unrelated error (e.g. permission) passing through
  untouched with zero retries, and all three re-resolution outcomes (not
  found / node unreachable / cluster unreadable — see the architecture doc's
  outcome table).
- **`test/multiNodeScale.test.js`** — the specific "1 node + 1 VM", "1 node +
  many VMs", "many nodes + many VMs" progression, including the exact 40-VM
  redistribution scenario from this project's task spec: 40 VMs cached on a
  dead node, each independently resolving to its correct (different) real
  node concurrently, with per-VM self-heal writes verified to not
  cross-contaminate between VMs running in parallel.

Both `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` need to be *set* (to any
value) for `nodeFailover.test.js`/`multiNodeScale.test.js` to run at all —
`src/supabaseClient.js` throws at `require()` time if they're missing, and
the test helper (`test/helpers/loadNodeFailover.js`) needs that module to
exist in the require cache before it substitutes a mock into it. No real
Supabase project is ever contacted; if you don't already have a `.env`
loaded, run tests with:

```bash
SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=test npm test
```

Expected: `pass 18`, `fail 0`. All of the above is pure logic — no live
Proxmox cluster required for any of it, which is what makes it possible to
exercise a 40-VM/5-node redistribution scenario in a test that runs in
milliseconds.

## Manual, against a real cluster — basic progression

Requires a Proxmox cluster reachable via this service's `PROXMOX_URL`/
`PROXMOX_TOKEN`, and at least one VM bound via `vm_ownership`
(`POST /api/admin/vms/:vmId/bindings` or an existing row).

### 1. Single node, single VM

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/nodes
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<vmid>
```

Expect: `GET /api/nodes` returns exactly the nodes in your cluster (check
against Proxmox's own Datacenter view) and logs
`[NODE-DISCOVERY] nodes=<your node>`. `GET /api/vms/<vmid>` returns status +
config with no errors.

### 2. Single node, multiple VMs

Repeat the vmid status call for several VMs bound to the same node, and hit
the owned list:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms
```

Expect: every owned VM appears with correct `status`, and no
`[nodeFailover]`/`[VM-MIGRATION-DETECTED]` log lines fire (nothing has
moved).

### 3. Multiple nodes, multiple VMs

Bind VMs across at least two different real nodes (or use existing
production bindings, read-only routes only), then repeat the calls above.
Expect: `GET /api/vms` (admin scope) shows VMs with their correct,
differing `node` values, matching Proxmox's own cluster view exactly —
compare against:

```bash
curl -H "Authorization: Bearer $TOKEN" "https://YOUR_PROXMOX:8006/api2/json/cluster/resources?type=vm" \
  -H "Authorization: $PROXMOX_TOKEN" -k
```

## Node add / remove

### Add a node

1. Note the current list: `GET /api/nodes`.
2. Add a node to the Proxmox cluster (`pvecm add ...` on the new node, or
   however your cluster is normally grown) — this is a Proxmox-side
   operation, not something this proxy does.
3. Re-call `GET /api/nodes` — **no restart of this service is needed**.
   Expect the new node to appear immediately, and
   `[NODE-DISCOVERY] nodes=...` in the logs to include it.
4. If a VM is provisioned on the new node, confirm
   `POST /api/admin/vms/:vmId/bindings` with that node name succeeds (the
   portal's node picker — see the vmp-ui side of this integration — will
   also autocomplete it, since it calls this same live endpoint).

### Remove a node

1. Note the current list: `GET /api/nodes`.
2. Cleanly remove a node from the cluster (`pvecm delnode ...`), after
   migrating or shutting down anything that was on it — a hard/unclean
   removal is really the "node failure" scenario, see
   [node failure testing](node-failure-testing.md) instead.
3. Re-call `GET /api/nodes` — expect the removed node to be gone, again with
   no restart.
4. Confirm this service does not crash and other nodes' VMs continue to work
   normally (`GET /api/vms/<vmid>` for a VM on a still-present node).
5. For any VM that *was* on the removed node and wasn't migrated first,
   expect the "not found" outcome (`404`, `err.vmNotFound`) the next time an
   operation is attempted against it — see the architecture doc's outcome
   table.

## Troubleshooting

- **`GET /api/nodes` doesn't reflect a change you just made in Proxmox**:
  this route has no cache — if the list is stale, the problem is on the
  Proxmox side (cluster quorum, `pvecm status`), not this proxy.
- **No `[NODE-DISCOVERY]`/`[VM-...]` log lines at all**: confirm `morgan`
  request logging is showing the request reached this service, and that
  `console.log`/`console.warn`/`console.error` output isn't being filtered
  by whatever process manager runs this in your environment.
