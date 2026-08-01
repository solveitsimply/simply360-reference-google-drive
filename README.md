# Simply360 reference app for Google Drive

Public-boundary reference implementation of Simply360 `FILE_SOURCE` and
`FILE_DESTINATION` using Google Picker and Google's non-sensitive
`drive.file` scope.

Status: **deployable-dev source complete; live provider acceptance blocked on
owner provisioning and the unpublished Simply360 lifecycle client.**
The complete lifecycle passes against deterministic local Google Drive and
Simply360 doubles. The real Google REST adapter and Simply360 public file API
adapter are implemented. No Google project, OAuth client, deployed runtime, or
published `@simply360` lifecycle package is available yet, so this repository
does not claim live Google or deployed-dev conformance.

## What the proof covers

- Simply360 service-principal installation starts `PENDING_SETUP`; ordinary
  file operations remain denied until the Google connection completes and the
  public setup callback succeeds.
- Google OAuth authorization-code + PKCE uses an app-owned, expiring,
  single-use state value and an exact redirect URI, and requests exactly
  `https://www.googleapis.com/auth/drive.file` with offline refresh
  authority. Any broader or online-only grant is revoked and rejected.
- Google Picker records one explicit file for import or one explicit folder
  for export. Shared Drives are rejected.
- Imports use checksum-bound Simply360 `/v1/file-uploads` intents. Re-imports
  add a version while retaining the stable external link.
- Exports use Google resumable uploads, persist the exact next offset after
  each chunk, resume after failure, and update the same Drive object on later
  Simply360 versions.
- Change notifications require the exact channel, resource, secret token,
  bounded message number, known resource state, and unexpired channel.
  Duplicate messages do not reconcile twice.
- Reconciliation is cursor-bound and bounded. A missing Drive source marks the
  link `REMOTE_MISSING`; it never deletes the imported Simply360 file.
- Google credential revocation is installation-scoped. Sibling installations
  retain independent credentials, links, cursors, and authority. Reconnection
  requires explicit revocation first and clears the prior account's
  selections, cursors, notification channels, and pending uploads.
- Upgrades with the same authority proceed; scope widening fails with
  `RECONSENT_REQUIRED`.
- Suspension blocks ordinary behavior. Uninstall stops channels, revokes
  Google authority, reports the public lifecycle receipt, and applies the
  explicit data-retention decision.
- Telemetry contains public identifiers, hashes, counts, and outcomes—not
  access tokens, refresh tokens, Picker channel secrets, file bodies, or
  provider response bodies.

This proof never implements `PRIMARY_FILE_STORAGE`. Arbitrary personal Drive
files are not authoritative Simply360 storage.

## Public-boundary architecture

```text
Google Picker / Drive REST           Reference runtime             Simply360 public platform
--------------------------           -----------------             -------------------------
authorization code + PKCE  ------->  exact-scope connection
explicit file/folder       ------->  selection custody
download / changes         <------>  stable link + cursor  <---->  /v1/file-uploads
resumable upload           <------>  persisted offset       <----  /v1/files/.../download
watch channel              ------->  verified notification
token revocation           <------  revoke/uninstall       <----> public lifecycle SDK seam
```

The runtime depends on small structural ports in
[`src/ports.ts`](./src/ports.ts). `GoogleDriveHttpClient` implements Google
OAuth, Picker session configuration, Drive download/export, resumable upload,
changes, watch channels, token refresh, and revocation using public HTTPS
APIs. `Simply360PublicFilePort` implements only documented public file
surfaces, pins signed transfer URLs to an operator-provided exact-origin
allowlist, and bounds JSON and file response bodies before buffering.
Lifecycle receipts are delegated to `Simply360LifecyclePort`;
that seam will bind to `@simply360/integration-sdk` when the package is
published rather than guessing an internal route.

There are no runtime dependencies, Simply360 internal imports, database/VPC
access, SSM credentials, or monorepo filesystem references.

The deployable seam uses Node's built-in HTTPS and cryptography for AWS
Signature V4, a strict API Gateway router, optimistic DynamoDB installation
state, leased idempotency, a durable outbox, and SQS worker batches. OAuth
state and Drive notification tokens are represented durably only by SHA-256
digests. The handler intentionally fails closed for setup receipts, provider
health, upgrade receipts, and uninstall receipts until the public Simply360
lifecycle package is published; it does not invent private endpoints.

## Local proof

Node 22 is required.

```bash
npm ci
npm run verify
```

`verify` runs:

1. the no-internal-boundary and exact-scope scan;
2. strict TypeScript checking;
3. a clean build;
4. lifecycle, failure, isolation, security, HTTP-adapter, configuration, and
   artifact tests, with source thresholds of 85% lines, 65% branches, and 85%
   functions.

The local suite uses only synthetic bytes and deterministic doubles. See
[`docs/local-conformance.md`](./docs/local-conformance.md) for the acceptance
matrix.

## Marketplace artifacts

- [`marketplace/app-manifest.template.json`](./marketplace/app-manifest.template.json)
  declares `FILE_SOURCE`, `FILE_DESTINATION`, least-privilege OAuth, lifecycle
  callbacks, data handling, and optional structural Blueprint provenance.
- [`blueprints/drive-file-links.package.template.json`](./blueprints/drive-file-links.package.template.json)
  is an optional non-executable, uninstall-aware structural package.
- [`marketplace/listing.json`](./marketplace/listing.json) and
  [`marketplace/media/icon.svg`](./marketplace/media/icon.svg) provide closed
  listing copy and media.

Render immutable source-bound artifacts from the exact accepted commit:

```bash
npm run artifacts -- --source-commit "$(git rev-parse HEAD)"
```

This writes `build/artifacts/app-manifest.json`, the Blueprint package, and an
exact checksum manifest. The command rejects an abbreviated or mismatched
commit and refuses to publish from a dirty worktree. `build/` is intentionally
ignored.

## Provisioning and live acceptance

Owner-interactive steps are explicit:

- [Google Cloud project, OAuth brand, Picker, APIs, quotas, and secret custody](./docs/provision-google.md)
- [Simply360 publisher app, npm auth/package prerequisite, private install, and acceptance](./docs/provision-simply360.md)
- [AWS/GitHub OIDC NonProd topology and cost guardrail](./infra/README.md)

Until those steps are completed, the truthful remaining blockers are:

1. `simply360-reference-drive-dev-<globally-unique-suffix>` and the
   `Simply360 Reference Files (Dev)` Google OAuth brand/client do not exist;
2. no approved synthetic Google test user or Google OAuth/Picker credential is
   available;
3. `@simply360/integration-sdk`, `@simply360/blueprint-sdk`, and the public SDK
   are unpublished and npm authentication is interactive;
4. the reviewed dev stack and OIDC roles in [`infra/`](./infra/) have not been
   provisioned or deployed;
5. therefore live consent, Drive/Picker, credential-revocation, deployed-dev
   telemetry, upgrade, and uninstall evidence cannot yet bind an accepted SHA.

## Security and support

Read [Security](./docs/security.md), [Privacy](./docs/privacy.md), and
[Support and deprecation](./docs/support-and-deprecation.md). Report
vulnerabilities privately through GitHub Security Advisories; do not open a
public issue containing credentials, file content, or customer data.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
