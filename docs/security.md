# Security model

## Trust boundaries

- Simply360 installation OAuth and Google OAuth are independent credentials.
- Google authorization starts with a cryptographically random state and PKCE
  verifier. State is stored only as a hash, expires after ten minutes, is
  compared in constant time, and is consumed before the code exchange so
  mix-up and replay fail closed.
- Every state, selection, link, upload, cursor, notification channel, and
  telemetry event is installation-scoped.
- The API's OAuth lookup table stores only a state digest. OAuth start
  responses are deliberately excluded from the general idempotency result
  table. Drive channel tokens are compared at ingress and only their digest is
  stored or sent to the worker.
- A Google Picker result is not trusted by itself; the runtime reads the exact
  object under the granted credential and compares ID, name, MIME type, kind,
  and trash state.
- `PENDING_SETUP`, suspended, revoked, and uninstalled states cannot perform
  ordinary file operations.
- Simply360 file bytes cross the documented quarantine/upload-intent boundary.
  Google files never become primary-storage coordinates.

## Least privilege

- Google: exactly `drive.file`; no Shared Drives or domain-wide delegation.
- Simply360: `offline_access`, `files:read`, and `files:write`.
- No record, schema, identity, messaging, billing, primary-storage, AWS
  control-plane, database, VPC, or SSM authority.
- The Picker key is browser/referrer and API restricted; OAuth and Simply360
  client secrets stay in the reference stack's secret manager.
- Per-installation Google and Simply360 OAuth credentials require durable,
  encrypted DynamoDB state for restart-safe work. IAM limits that table to the
  two exact functions; state is never logged or emitted as telemetry.

## Input and resource controls

- exact HTTPS origins and no URL credentials;
- exact Google redirect URI and an explicit exact-origin allowlist for
  Simply360-issued signed transfer URLs;
- redirects disabled in server-to-server requests;
- Google resumable `Location` pinned to the expected Google origin;
- public signed upload/download calls never receive provider bearer tokens;
- bounded JSON bodies, transfer bytes, upload totals/chunks, completion polls,
  change pages, reconciliation items, channel lifetime, and message-number
  length;
- exact checksums before Simply360 upload and after Simply360 download;
- constant-time comparison for OAuth state and notification channel tokens;
- refreshed Google tokens are cached by a hash of their credential family,
  never by the possibly shared Google account subject;
- replacing a Google account requires explicit revocation; stale selections,
  cursors, channels, and pending uploads are cleared before another account
  can be connected;
- scope widening fails closed.

The public lifecycle occurrence variants are vendored byte-for-byte from the
authoritative generated public schema with pinned source and selected-variant
SHA-256 digests. HMAC v2 verification authenticates the raw body before schema
parsing and accepts at most two explicitly named rotation keys.

## Failure and cleanup

Imports create a durable link only after Simply360 reports completion. Exports
persist the next accepted offset before continuing. Reconciliation advances
its cursor only after the bounded page completes; repeated imports use a
content/version-bound idempotency key. A notification message number is
checkpointed only after reconciliation succeeds, so the same provider message
remains retryable after a transfer failure. Remote source deletion never
cascades to the Simply360 copy.

Uninstall is driven by an explicit export/deletion decision. Provider
credentials and notification channels are revoked; pending uploads are
discarded; retained metadata is marked revoked and contains no credential.

## Reporting

Use the repository's private GitHub Security Advisory flow. Include a minimal
synthetic reproduction and affected commit. Do not include tokens, secrets,
authorization codes, signed URLs, real Team/file names, or customer content.
