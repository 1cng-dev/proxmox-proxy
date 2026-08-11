#!/usr/bin/env node
// One-off backfill: encrypts any vms.password rows left over from before
// this service moved credential writes behind pgcrypto (see migration
// 20260803093000_vm_password_encryption_and_customer_safe_view.sql and
// 20260803094500_add_vm_password_rpc_functions.sql in the vmp-ui repo).
//
// Safe by default — run with no flags (or --dry-run) to see exactly what
// would change without writing anything. Only --apply actually writes.
//
// Usage:
//   node scripts/backfill-vm-passwords.js              # dry run (default)
//   node scripts/backfill-vm-passwords.js --dry-run     # same, explicit
//   node scripts/backfill-vm-passwords.js --apply       # actually encrypt + clear plaintext
//
// Never run --apply against a real project without checking the dry-run
// output first, and never without a fresh backup of the vms table.

require("dotenv").config();
const { assertVmCredentialKey } = require("../src/utils/assertEnv");
const supabaseAdmin = require("../src/supabaseClient");

const APPLY = process.argv.includes("--apply");

async function main() {
  assertVmCredentialKey();

  const { data: rows, error } = await supabaseAdmin
    .from("vms")
    .select("id, hostname, customer_id")
    .not("password", "is", null)
    .neq("password", "")
    .is("password_encrypted", null);

  if (error) {
    console.error("[backfill] Failed to query vms:", error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log("[backfill] No plaintext passwords found — nothing to do.");
    return;
  }

  console.log(
    `[backfill] ${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} row(s) with a ` +
      "plaintext password and no password_encrypted:"
  );
  for (const row of rows) {
    console.log(`  - vm ${row.id}  hostname=${row.hostname}  customer_id=${row.customer_id}`);
  }

  if (!APPLY) {
    console.log(
      "\n[backfill] Dry run only — no changes made. Re-run with --apply to " +
        "encrypt these and clear the plaintext column."
    );
    return;
  }

  const key = process.env.VM_CREDENTIAL_KEY;
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    // Fetch the plaintext password just-in-time per row, never held in the
    // `rows` list above or logged anywhere.
    const { data: full, error: fetchErr } = await supabaseAdmin
      .from("vms")
      .select("password")
      .eq("id", row.id)
      .maybeSingle();

    if (fetchErr || !full?.password) {
      console.error(`  ✗ vm ${row.id} (${row.hostname}): could not re-fetch password, skipping`);
      failed++;
      continue;
    }

    const { error: rpcErr } = await supabaseAdmin.rpc("set_vm_password", {
      p_vm_id: row.id,
      p_password: full.password,
      p_key: key,
    });

    if (rpcErr) {
      console.error(`  ✗ vm ${row.id} (${row.hostname}): ${rpcErr.message}`);
      failed++;
    } else {
      console.log(`  ✓ vm ${row.id} (${row.hostname}) encrypted`);
      succeeded++;
    }
  }

  console.log(`\n[backfill] Done — ${succeeded} encrypted, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill] Unexpected error:", err.message);
  process.exit(1);
});
