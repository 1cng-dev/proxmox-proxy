# Node failure testing

See [architecture: dynamic multi-node](../architecture/dynamic-multi-node.md)
for the three re-resolution outcomes (migrated / not found / unreachable /
cluster unreadable) before running these.

Node failure is deliberately **not** the same code path as VM migration
(see [vm-migration-testing.md](vm-migration-testing.md)) — a node going
offline can look like either "VM migrated" (if HA moved it before you
noticed) or "VM stuck on a dead node" (if it didn't), and this service
distinguishes them rather than guessing.

## Automated

`test/nodeFailover.test.js` covers the two failure-classification cases
directly, with a mocked cluster response (no live cluster needed):

```bash
cd proxmox-proxy
SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=test npm test
```

- `"withNodeFailover: cluster still reports the same node (likely offline)
  -> 503, nodeUnreachable"` — simulates a VM stuck on a node that both the
  stale cache *and* a fresh cluster lookup agree it's on, yet the operation
  still fails there. Asserts `err.status === 503` and
  `err.nodeUnreachable === true`.
- `"withNodeFailover: cluster lookup itself fails -> 503,
  clusterUnreadable"` — simulates `/cluster/resources` itself being
  unreachable during re-resolution (e.g. the whole Proxmox API is down, not
  just one node). Asserts `err.status === 503` and
  `err.clusterUnreadable === true`.
- `"withNodeFailover: vmid not found anywhere in the cluster -> 404,
  vmNotFound"` — simulates a node (and everything on it) having been
  removed from the cluster entirely, so the vmid no longer appears in
  `/cluster/resources` at all. Asserts `err.status === 404` and
  `err.vmNotFound === true`.

## Manual: a node goes offline (VM has HA / gets migrated)

1. Pick a test VM with an HA policy configured (or manually migrate it once
   the source node is unreachable, if your Proxmox setup supports that).
2. Take the source node offline (stop the `pve-cluster`/`pvedaemon`
   services, or a controlled `qm shutdown` of the whole hypervisor host if
   it's a real test box — **do not do this against a production node**).
3. Once Proxmox's HA manager (or your manual intervention) has moved the VM
   to a different node, call this service:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<vmid>
   ```
4. Expect the same outcome as
   [vm-migration-testing.md](vm-migration-testing.md) step 3 —
   `[VM-MIGRATION-DETECTED]`, self-heal, success. From this service's
   point of view, "node failed and HA moved the VM" and "someone manually
   migrated the VM" are the identical scenario.

## Manual: a node goes offline (VM has no HA, stays put)

1. Pick a test VM with **no** HA policy.
2. Take its node offline the same way.
3. Call this service for that VM:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<vmid>
   ```
4. Expect a `503` with `"This VM's node (\"<node>\") could not be reached.
   It may be temporarily offline."` in the response body, and
   `[VM-RESOLVE] vmid=<vmid> cluster state still reports node "<node>", but
   the operation failed there — the node may be offline` in the logs — not
   a generic timeout or an unhandled 500. This is `err.nodeUnreachable`.
5. Bring the node back online and repeat the same call — expect it to
   succeed normally again, no manual cache fix needed (the cached
   `vm_ownership.node` was correct the whole time; only the node itself was
   briefly unreachable).

## Manual: the whole Proxmox API is unreachable

This exercises both the pre-existing circuit breaker (`proxmoxClient.js` —
see the main [README.md](../../README.md#circuit-breaker)) and the new
`clusterUnreadable` outcome, since a `/cluster/resources` re-resolution call
made *during* an outage is itself what fails.

1. Block network access from this service to `PROXMOX_URL` entirely (e.g.
   firewall rule, or point `PROXMOX_URL` at an unreachable address
   temporarily in a non-production `.env`).
2. Call any VM route enough times to trip the circuit breaker (3 consecutive
   failures — see `GET /health`'s `proxmoxCircuit` field).
3. Once the circuit is open, further calls fail fast with `503` and
   `error.circuitOpen: true` — this is the pre-existing breaker, not the
   new failover logic (the request interceptor rejects before any call is
   even attempted).
4. Restore connectivity and wait for the breaker's cooldown
   (`GET /health` → `proxmoxCircuit.reopensAt`), then confirm normal
   operation resumes without a restart.

## Node removed from the cluster entirely

Covered in [multi-node-testing.md](multi-node-testing.md#remove-a-node) —
the "not found" outcome (`404`, `err.vmNotFound`) is what a VM that was on a
since-removed node looks like once someone tries to operate on it.

## Expected results summary

| Scenario | HTTP status | Error marker | Log tag |
| --- | --- | --- | --- |
| VM migrated (HA or manual) | 200 (after 1 retry) | — | `[VM-MIGRATION-DETECTED]` |
| VM stuck on offline node | 503 | `nodeUnreachable` | `[VM-RESOLVE]` |
| Whole Proxmox API unreachable during re-resolution | 503 | `clusterUnreadable` | `[VM-RESOLVE]` |
| Whole Proxmox API unreachable, circuit already open | 503 | `circuitOpen` | `[Proxmox Error]` |
| VM/node removed from cluster entirely | 404 | `vmNotFound` | `[VM-RESOLVE]` |

## Troubleshooting

- **Getting a generic 500 instead of one of the above**: check
  `looksLikeWrongNode()` (`src/utils/nodeFailover.js`) actually matched the
  real error text your Proxmox version returned — log the raw
  `[Proxmox Error]` line and compare. If your Proxmox version phrases the
  "wrong node" error differently than
  `Configuration file '...' does not exist`, the regex needs widening; this
  is the one part of the mechanism that depends on Proxmox's exact wording
  and couldn't be confirmed against a real server from this project's
  development environment (see
  [vm-migration-testing.md](vm-migration-testing.md)'s closing section).
