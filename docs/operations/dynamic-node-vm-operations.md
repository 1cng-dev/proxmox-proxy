# Operating VMs on a dynamic multi-node cluster

A short reference for on-call/operator use — what a given error or log line
actually means and what to do about it. For the underlying mechanism, see
[architecture: dynamic multi-node](../architecture/dynamic-multi-node.md).

## Every VM operation, from a client's point of view

The client (the vmp-ui portal, or any admin/internal caller) never
specifies which Proxmox node a VM is on — it sends a vmid or an opaque
`vm_ownership.id`, and this service resolves the current node itself,
every time:

```
Client request (vmid or recordId)
  ↓
Ownership check (vm_ownership, unaffected by which node the VM is on)
  ↓
Cached node (vm_ownership.node)
  ↓
Proxmox call
  ↓ (if the cache was stale — VM migrated since the last sync)
Live re-resolution (/cluster/resources)
  ↓
Retry on the corrected node + self-heal the cache
  ↓
Response
```

## Reading the logs

| Log line | Means | Action needed |
| --- | --- | --- |
| `[NODE-DISCOVERY] nodes=a,b,c` | A client asked for the node list; this is what Proxmox reported, live. | None — informational. If it doesn't match what you expect in Proxmox's own UI, the problem is cluster-side (`pvecm status`), not this service. |
| `[VM-OPERATION] vmid=X node=Y operation=Z status=success` | A power action or delete completed. | None — this is the routine success log for mutating actions (status/stats reads are *not* logged this way — see the architecture doc's logging section for why). |
| `[VM-MIGRATION-DETECTED] vmid=X previousNode=A currentNode=B` | A request found `vm_ownership.node` stale and successfully retried on the VM's real current node. | None required — this is the system working as designed. If you see this *very* frequently for the same vmid in a short window, that VM may be flapping between nodes (HA instability) — worth investigating in Proxmox itself, not this service. |
| `[VM-MIGRATION-DETECTED] self-heal update failed for vmid=X ...` | The retry succeeded (client got a correct response) but writing the corrected node back to `vm_ownership` failed. | Check Supabase connectivity/permissions. Not urgent — the next `syncVmStatus` tick (within 2 minutes) will correct the row anyway; this only means one extra request might hit the same stale-node retry path before then. |
| `[VM-RESOLVE] vmid=X not found anywhere in the current cluster state` | A client operated on a vmid that Proxmox no longer reports at all. | Confirm whether the VM was deliberately deleted/decommissioned. If not, check whether the node it was on was removed from the cluster without migrating it first. |
| `[VM-RESOLVE] vmid=X cluster state still reports node "Y", but the operation failed there — the node may be offline` | The VM hasn't moved — node `Y` itself is unreachable or erroring. | Check node `Y`'s health directly (`pvecm status`, or SSH to it). This is a node-level incident, not a proxy bug. |
| `[VM-RESOLVE] vmid=X cluster lookup failed while re-resolving ...` | The `/cluster/resources` call itself failed during re-resolution — broader than one node. | Check overall Proxmox API reachability from this service. Also check `GET /health`'s `proxmoxCircuit` — if `open: true`, the circuit breaker is already handling this; see the main README's circuit breaker section. |
| `[Proxmox Error] ...` | Any Proxmox API call failure, pre-existing log (unrelated to this work specifically, but often the first sign of the above). | Read the attached `status`/`message`/`url` fields. |

## Client-visible error responses

| HTTP status | Response `error` field marker | What the client should do |
| --- | --- | --- |
| `404` | `err.vmNotFound` internally (client sees a plain 404 + message) | Treat as "this VM doesn't exist" — don't retry. |
| `503` | `err.nodeUnreachable` | Transient — safe to retry after a short delay; if it persists, the underlying node is down and needs operator attention, not a client-side fix. |
| `503` | `err.clusterUnreadable` | Transient, broader than one VM — same retry guidance, but check whether other VMs are affected too (a whole-cluster connectivity issue, not this one VM). |
| `503` | `err.circuitOpen` (pre-existing) | The circuit breaker has already given up retrying for the current cooldown window — wait for `GET /health`'s `proxmoxCircuit.reopensAt`. |

None of these responses ever include a Proxmox token, Supabase key, or any
other credential — see [architecture: dynamic multi-node](../architecture/dynamic-multi-node.md#logging-conventions).

## Adding or removing a node — operational impact

- **Adding a node**: no action needed on this service at all. The next
  `GET /api/nodes` call reflects it. VMs provisioned there work as soon as
  they're bound via `POST /api/admin/vms/:vmId/bindings` with that node
  name (free text, but the vmp-ui portal's binding forms autocomplete real
  node names live from this same endpoint — see that project's
  `docs/proxmox-integration.md`, Phase 3).
- **Removing a node**: migrate or shut down everything on it first. Once
  removed from the cluster, any still-cached `vm_ownership.node` row
  pointing at it will surface as the `vmNotFound` outcome on next use (see
  table above) — that's expected, not a bug to fix reactively; it's the
  signal that the corresponding `vm_ownership`/`vms` rows need cleanup if
  those VMs are genuinely gone for good.

## What this service does *not* do

- It does not initiate VM migrations, node additions/removals, or any other
  Proxmox cluster-topology change — it only *reacts* to the cluster state
  Proxmox already reports.
- It does not alert/page anyone — the `[VM-RESOLVE]`/`[Proxmox Error]` log
  lines and `GET /health` are the extent of the observability surface (see
  the main README's "Background jobs" section — no monitoring/alerting
  system exists elsewhere in this service to wire into).
