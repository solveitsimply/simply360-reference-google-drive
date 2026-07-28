# Privacy

This development reference app processes only synthetic data in approved
publisher test Teams and approved synthetic Google accounts.

It accesses only files and folders a user explicitly selects through Google
Picker under `drive.file`. It transfers file bytes for the requested import or
export and retains installation-scoped link metadata needed for
reconciliation: public Simply360 IDs, opaque Google object IDs, direction,
version, checksum, modified time, cursor, and health state.

It does not request broad Drive access, enumerate unrelated personal files,
use Shared Drives, make Google Drive primary Simply360 storage, sell data, use
file content for advertising or model training, or move customer data during
the dev proof.

Credentials, authorization codes, signed URLs, notification tokens, and file
bodies are excluded from telemetry and evidence. Credentials live only in the
approved secret/state stores. Uninstall requires an explicit export/deletion
decision; delete clears app-managed link/selection state, while retain keeps
only the disclosed metadata marked revoked.

This file is developer-proof documentation, not published legal terms.
Production use and legal publication require separate approval.
