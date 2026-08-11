const MIN_CREDENTIAL_KEY_LENGTH = 32;

// Fails loudly at boot rather than letting the service start and only
// discover a missing/weak VM_CREDENTIAL_KEY on the first credential
// reveal/write — a silent failure there would look like a random 500 to
// customers with no clue why, potentially long after deploy.
function assertVmCredentialKey() {
  const key = process.env.VM_CREDENTIAL_KEY;

  if (!key) {
    console.error(
      "[FATAL] VM_CREDENTIAL_KEY is not set. This key encrypts/decrypts VM " +
        "login passwords (pgcrypto) and must be configured before this " +
        "service can start. Generate one with: openssl rand -base64 32"
    );
    process.exit(1);
  }

  if (key.length < MIN_CREDENTIAL_KEY_LENGTH) {
    console.error(
      `[FATAL] VM_CREDENTIAL_KEY is too short (${key.length} chars, ` +
        `minimum ${MIN_CREDENTIAL_KEY_LENGTH}). Generate a stronger one ` +
        "with: openssl rand -base64 32"
    );
    process.exit(1);
  }
}

module.exports = { assertVmCredentialKey };
