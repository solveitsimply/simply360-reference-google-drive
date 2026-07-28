# NonProd infrastructure and provisioning

No AWS resource is created by this repository. The reviewed, dev-only source
templates are [`dev.template.yaml`](./dev.template.yaml) and
[`oidc-roles.template.yaml`](./oidc-roles.template.yaml). Provisioning remains
blocked until the owner supplies the exact certificate, hosted-zone, secret,
artifact-bucket, and transfer-origin inputs and the public Simply360 lifecycle
client is published.

## Fixed ownership and names

| Setting | Value |
| --- | --- |
| Repository | `solveitsimply/simply360-reference-google-drive` |
| Active/default branch | protected `dev` |
| AWS region | `us-east-1` |
| Stack | `Simply360ReferenceGoogleDriveDev` |
| Runtime origin | `https://reference-drive.dev.simply360.app` |
| Google project | `simply360-reference-drive-dev-<globally-unique-suffix>` |
| Google brand | `Simply360 Reference Files (Dev)` |

Creating/promoting `main`, production trust, production resources, customer
data, paid provider services, or stable release is not authorized.

## GitHub OIDC deploy role

Reuse the organization's
`token.actions.githubusercontent.com` OIDC provider. The role trust must
require all of:

- audience `sts.amazonaws.com`;
- subject
  `repo:solveitsimply/simply360-reference-google-drive:ref:refs/heads/dev`;
- protected GitHub `dev` environment;
- no pull-request, tag, wildcard branch, or `main` subject.

The deploy role may update only
`Simply360ReferenceGoogleDriveDev` and explicitly named deployment artifacts.
It may pass only the stack's execution roles. It must not read provider/client
secret values or assume monorepo/evidence/production roles.

## Intended isolated stack

- API Gateway HTTPS custom origin;
- low-volume Lambda runtime with reserved concurrency;
- DynamoDB tables for installation state/idempotency and bounded Google
  notification/change cursors, point-in-time recovery, and TTL for transient
  OAuth/PKCE/upload state;
- SQS work queue plus DLQ for bounded reconciliation/transfer work;
- references to two owner-created repository-scoped Secrets Manager entries
  for Google OAuth/Picker material and Simply360 lifecycle HMAC keys;
- seven-day CloudWatch log retention with alarms for DLQ depth, error rate,
  throttles, and oldest work age;
- least-privilege runtime role for only its tables, queues, logs, and exact
  secret ARNs;
- no VPC, NAT gateway, database, SSM credential, public bucket, long-lived AWS
  key, or monorepo internal access.

Every state/outbox record and queue message is installation-scoped by the exact
public installation Simply ID. Provider client secrets and file bodies are
never written to DynamoDB, SQS, logs, telemetry, or queue attributes.
Installation OAuth credentials and resumable offsets are stored in the
encrypted, access-controlled state table because durable restart recovery
requires them. One-time OAuth state and Drive notification tokens are persisted
or queued only as SHA-256 digests.

The eventual handler must use `loadReferenceAppConfig` and supply, at minimum,
these non-secret values alongside secret-manager material:

```text
REFERENCE_ENVIRONMENT=dev
SIMPLY360_API_BASE_URL=https://api.dev.simply360.app
SIMPLY360_TRANSFER_ORIGINS=<comma-separated exact HTTPS object-transfer origins>
PUBLIC_ORIGIN=https://reference-drive.dev.simply360.app
GOOGLE_OAUTH_SCOPE=https://www.googleapis.com/auth/drive.file
```

`SIMPLY360_TRANSFER_ORIGINS` must come from the published Simply360 file API
contract or deployed-dev readback; do not guess a wildcard, accept arbitrary
HTTPS, or infer trust from a signed URL alone. The derived Google callback is
exactly `${PUBLIC_ORIGIN}/oauth/google/callback`. Google/Simply360 client
credentials, the restricted Picker key, and lifecycle HMAC keys remain
secret-manager inputs, not environment literals committed here. The Google
secret JSON requires `clientId`, `clientSecret`, `pickerAppId`, and
`pickerDeveloperKey`. The Simply360 secret requires one or two
`lifecycleWebhookKeys` entries with `keyId` and at least 32-byte `secret`.

## Cost guardrail

The approved total marketplace NonProd envelope remains $25/month. This
reference stack is expected to remain approximately $1–$5/month at synthetic
proof volume:

- two Secrets Manager secrets: about $0.80/month;
- low-volume Lambda/API Gateway/SQS/DynamoDB/logs: approximately $0–$3;
- DNS/alarms/headroom: approximately $0–$1.

The project-level combined estimate remains $2–$10/month. Recalculate from the
final template before creation. Stop and obtain fresh approval if the topology
changes materially, a paid Google service is required, or projected aggregate
spend exceeds $25/month.

## Provisioning sequence

1. Complete [Google Cloud provisioning](../docs/provision-google.md).
2. Complete the npm/public-package and private-app prerequisites in
   [Simply360 provisioning](../docs/provision-simply360.md).
3. Re-run `npm run verify` plus `sam validate --lint` for both source
   templates and review the packaged change set.
4. Create the dev-only OIDC role and GitHub `dev` environment only after the
   template's resource/cost review.
5. Deploy the exact accepted repository SHA through pinned GitHub Actions.
6. Enter secrets directly into Secrets Manager; do not expose them to the
   deploy workflow.
7. Read back stack outputs, role trust/policies, secret metadata, concurrency,
   TTL/PITR, queue/DLQ, log retention, alarms, and custom-origin TLS.
8. Execute live acceptance and record exact repo/deployed SHAs.
9. Remove synthetic files/installations and verify TTL/DLQ/queue cleanup.

The remaining lifecycle-client blocker is intentional: the handler throws
before any guessed Simply360 lifecycle endpoint can be called. Installation
bootstrap is disabled in the template. Bind the published public client and
its documented service-principal installation flow before live acceptance.

GitHub's OIDC subject changes to `repo:...:environment:dev` when a protected
environment is used, so it cannot simultaneously be the `ref:refs/heads/dev`
subject. The role therefore pins the protected `dev` environment; the
environment's deployment-branch rule must independently allow only `dev`.
