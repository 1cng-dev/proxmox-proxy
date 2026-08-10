# dev-zero validation checklist

Post-deploy verification for this change on the `dev-zero` environment.
`dev-zero` is a development/staging branch and environment — this checklist
never targets production.

## Before deploying

- [ ] On the correct branch (`dev-zero`), working tree clean:
  ```bash
  git status
  git branch --show-current
  ```
- [ ] No lint step exists in this project (`package.json` has no `lint`
  script) — `node --check` on every changed file is the practical
  equivalent used during development:
  ```bash
  for f in src/utils/nodeFailover.js src/utils/upid.js src/routes/vms.js \
           src/routes/nodes.js src/proxmoxClient.js; do
    node --check "$f" || echo "SYNTAX ERROR: $f"
  done
  ```
- [ ] Automated tests pass:
  ```bash
  SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=test npm test
  ```
  Expect `pass 18`, `fail 0` (see [multi-node-testing.md](multi-node-testing.md)
  for what each test covers).
- [ ] No integration test suite exists beyond the manual procedures in
  [multi-node-testing.md](multi-node-testing.md),
  [vm-migration-testing.md](vm-migration-testing.md), and
  [node-failure-testing.md](node-failure-testing.md) — this project has no
  live-cluster CI, so these stay manual, run against the actual dev-zero
  Proxmox target before/after this deploy.
- [ ] No build step — this is plain Node.js (`main: src/index.js`), nothing
  to compile.
- [ ] Environment variables present in dev-zero's `.env`: `PROXMOX_URL`,
  `PROXMOX_TOKEN`, `PROXMOX_DEFAULT_NODE`, `SUPABASE_URL` (or
  `SUPABASE_PUBLIC_URL`), `SUPABASE_SERVICE_ROLE_KEY` (or
  `SERVICE_ROLE_KEY`), `VM_CREDENTIAL_KEY` (32+ chars — the service refuses
  to boot without it, see `src/utils/assertEnv.js`).
- [ ] Proxmox connectivity from the dev-zero host:
  ```bash
  curl -k -H "Authorization: $PROXMOX_TOKEN" "$PROXMOX_URL/api2/json/version"
  ```
- [ ] Supabase connectivity — the service logs a clear warning at boot if
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are missing
  (`src/supabaseClient.js`); confirm no such warning appears in the startup
  log.
- [ ] Review the final diff:
  ```bash
  git diff origin/dev-zero..HEAD --stat
  ```

## Deploy

```bash
git push origin dev-zero
```

Then restart/redeploy the service per however dev-zero is actually run
(`npm start`, a process manager, a container — this project has no
Dockerfile or deploy script committed, so this step depends on the
dev-zero host's existing setup, out of scope for this checklist to specify).

## After deploying

- [ ] **Service starts successfully** — check process/container logs for
  the startup banner (`Proxmox Proxy running on port ...`) and no
  `[FATAL]` line from `assertEnv.js`.
- [ ] **Health endpoint**:
  ```bash
  curl http://<dev-zero-host>:<port>/health
  ```
  Expect `"ok": true`, `proxmoxCircuit.open: false`,
  `syncVmStatus.consecutiveFailures: 0` (or recovering, not stuck climbing).
- [ ] **Node discovery**:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" http://<dev-zero-host>:<port>/api/nodes
  ```
  Expect the real dev-zero cluster's node list, and a matching
  `[NODE-DISCOVERY]` log line.
- [ ] **VM discovery**:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" http://<dev-zero-host>:<port>/api/vms
  ```
  Expect owned (or, as admin, all) VMs with correct current status.
- [ ] **VM ownership lookup** — as a non-admin test account, confirm a VM
  *not* owned by that account returns `403` (`:vmid` route) or `404`
  (`by-record` route), unchanged from before this deploy.
- [ ] **VM operations** — one full round-trip on a real, non-production test
  VM: status → start/stop (or reboot) → task-status poll → confirm the
  power state actually changed in Proxmox's own UI too, not just this
  service's response.
- [ ] **Logs** — confirm the new tags appear where expected:
  `[NODE-DISCOVERY]` on node list calls, `[VM-OPERATION]` on the power
  action above, and (if a migration happens to occur or is deliberately
  tested per [vm-migration-testing.md](vm-migration-testing.md))
  `[VM-MIGRATION-DETECTED]`.
- [ ] **No regression in existing functionality** — spot-check something
  this change didn't touch: console session open
  (`GET .../console` → `sessionToken`/`wsPath`), credentials reveal
  (`GET .../by-record/:recordId/credentials`, confirm an audit row lands in
  `vm_action_audit` with no plaintext password), and the admin bindings
  write (`POST /api/admin/vms/:vmId/bindings`).

## If something fails

Roll back by redeploying the previous `dev-zero` commit
(`1f60ff2` — "Add circuit breaker to proxmoxClient to bound outage blast
radius" — is the commit immediately before this work). This change is
additive at the route level (every existing call still goes through the
same middleware chain; `withNodeFailover` only changes behavior on a
specific failure signature that previously just errored), so a rollback
carries no data-migration or schema concerns — nothing in
`supabase/schema.sql` changed as part of this work.
