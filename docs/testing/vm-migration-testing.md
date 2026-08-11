# VM migration testing

See [architecture: dynamic multi-node](../architecture/dynamic-multi-node.md)
for the full mechanism (`withNodeFailover`, the three re-resolution
outcomes) before running these — this document is the "how to verify it"
companion, not a repeat of the design rationale.

## Automated (no live migration needed)

`test/multiNodeScale.test.js` and `test/nodeFailover.test.js` (see
[multi-node testing](multi-node-testing.md)) exercise the exact retry/
self-heal sequence a real migration triggers, using a mocked Proxmox
response instead of a live cluster:

```bash
cd proxmox-proxy
SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=test npm test
```

The test `"withNodeFailover: migration detected — retries once on the
resolved node and self-heals"` is the direct proof of the mechanism: a
vmid cached on `pve1`, a call that fails there with Proxmox's real
"Configuration file ... does not exist" error text, a retry against the
node `resolveNodeForVmid` reports, and a verified single write of the
corrected node back to `vm_ownership`.

This is sufficient to trust the *logic*. It cannot substitute for step 3
below, which is the one thing this project's sandboxed development
environment cannot verify: whether a real Proxmox server's actual error
response for a live migration matches the signature `looksLikeWrongNode()`
expects.

## Manual, against a real multi-node cluster

Needs a Proxmox cluster with at least 2 nodes and a test VM already bound
via `vm_ownership` (not a production customer's VM).

### 1. Confirm the starting state

```sql
select vmid, node from vm_ownership where vmid = <test-vmid>;
```

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<test-vmid>
```

Both should agree on the current node.

### 2. Migrate the VM

Either through the Proxmox web UI (Datacenter → node → VM → Migrate) or:

```bash
qm migrate <vmid> <target-node>
```

on the source node.

### 3. Immediately call this service — before the next `syncVmStatus` tick

Within roughly 2 minutes (sooner is a stronger test — try immediately after
the migrate command returns):

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<test-vmid>
```

**Expected**: the request still succeeds, with no manual intervention. In
the service's logs, look for:

```
[VM-MIGRATION-DETECTED] vmid=<vmid> previousNode=<old> currentNode=<new> (...)
[VM-MIGRATION-DETECTED] self-healed vm_ownership.node for vmid=<vmid>: "<old>" -> "<new>"
```

### 4. Confirm the self-heal actually persisted

```sql
select vmid, node from vm_ownership where vmid = <test-vmid>;
```

Expect the new node, immediately — not after waiting for the next
`syncVmStatus` cron tick.

### 5. Repeat for a power action and its task-status poll

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<test-vmid>/reboot
# note the returned task upid, then:
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/<test-vmid>/task/<upid>
```

Expect both to succeed. The task-status call in particular should work
regardless of exactly when the migration happened relative to the poll,
since it resolves its node from the UPID itself
(`src/utils/upid.js`), not the (possibly still catching up) cache — see the
architecture doc's "Task-status routes: exact, not resolved" section. Look
for `[VM-OPERATION] vmid=<vmid> node=<new> operation=reboot status=success`
in the logs.

### 6. Repeat via the customer-facing `by-record` route

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/vms/by-record/<record-id>
```

Same expectation — the by-record path goes through the identical
`withNodeFailover` mechanism, just reached via
`authorizeVmByRecord` instead of `authorizeVm`.

### 7. Simulate repeated migrations (node1 → node2 → node5)

Repeat steps 2–4 migrating the same VM again, to a third node. Confirm each
migration is independently detected and self-healed — there's no special
handling or accumulated state for "this VM has moved before"; every request
is evaluated fresh against current cluster state.

## Faking a migration without touching the VM's actual running state

If you don't want to trigger a real live migration (e.g. no maintenance
window), you can reproduce the exact same failure signature directly:

```sql
update vm_ownership set node = '<a-different-real-node-in-your-cluster>'
where vmid = <test-vmid>;
```

Then call any status/power-action route for that vmid. Proxmox will reject
the call with the same "config file does not exist" error a real migration
produces, and `withNodeFailover` will re-resolve, retry on the *actual*
correct node, and self-heal the row back — exercising the identical code
path as steps 3–4 above, without moving the VM at all.

## What "verified" actually means here

The retry/self-heal *logic* is proven by the automated tests above,
independent of any live cluster. The specific claim that **cannot** be
verified from a sandboxed development environment with no network path to a
real Proxmox server is: does a real Proxmox VE instance's HTTP response for
"valid vmid, wrong node" actually match the text
`looksLikeWrongNode()` (`src/utils/nodeFailover.js`) checks for
(`/configuration file .* does not exist|no such (vm|guest|resource)/i`)?
This pattern is based on Proxmox's documented/observed error format, but
step 3 above is the one manual test that closes that gap for real — treat
it as the highest-priority item on the
[dev-zero validation](dev-zero-validation.md) checklist.
