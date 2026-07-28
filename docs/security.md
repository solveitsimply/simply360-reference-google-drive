# Security model

## Trust boundaries

- Simply360 installation OAuth and Google OAuth are independent credentials.
- Every state, selection, link, upload, cursor, notification channel, and
  telemetry event is installation-scoped.
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

## Input and resource controls

- exact HTTPS origins and no URL credentials;
- redirects disabled in server-to-server requests;
- Google resumable `Location` pinned to the expected Google origin;
- public signed upload/download calls never receive provider bearer tokens;
- bounded transfer bytes, upload chunks, completion polls, change pages,
  reconciliation items, channel lifetime, and message-number length;
- exact checksums before Simply360 upload and after Simply360 download;
- constant-time comparison for notification channel tokens;
- scope widening fails closed.

## Failure and cleanup

Imports create a durable link only after Simply360 reports completion. Exports
persist the next accepted offset before continuing. Reconciliation advances
its cursor only after the bounded page completes; repeated imports use a
content/version-bound idempotency key. Remote source deletion never cascades to
the Simply360 copy.

Uninstall is driven by an explicit export/deletion decision. Provider
credentials and notification channels are revoked; pending uploads are
discarded; retained metadata is marked revoked and contains no credential.

## Reporting

Use the repository's private GitHub Security Advisory flow. Include a minimal
synthetic reproduction and affected commit. Do not include tokens, secrets,
authorization codes, signed URLs, real Team/file names, or customer content.
