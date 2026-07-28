# NonProd infrastructure and provisioning

No AWS resource is created by this repository today. The topology below is the
approved target for the live proof; provisioning remains blocked until the
Google and Simply360 credentials/packages exist and a deployable handler/state
adapter is reviewed.

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
- repository-scoped Secrets Manager entries for Google OAuth/Picker and the
  Simply360 confidential client;
- seven-day CloudWatch log retention with alarms for DLQ depth, error rate,
  throttles, and oldest work age;
- least-privilege runtime role for only its tables, queues, logs, and exact
  secret ARNs;
- no VPC, NAT gateway, database, SSM credential, public bucket, long-lived AWS
  key, or monorepo internal access.

Every table record and queue message is keyed by the exact public installation
Simply ID. Secrets and file bodies are never written to logs, DynamoDB,
telemetry, or queue attributes.

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
3. Review a source-controlled infrastructure template and deployable handler;
   this repository currently has neither and must not claim deploy readiness.
4. Create the dev-only OIDC role and GitHub `dev` environment only after the
   template's resource/cost review.
5. Deploy the exact accepted repository SHA through pinned GitHub Actions.
6. Enter secrets directly into Secrets Manager; do not expose them to the
   deploy workflow.
7. Read back stack outputs, role trust/policies, secret metadata, concurrency,
   TTL/PITR, queue/DLQ, log retention, alarms, and custom-origin TLS.
8. Execute live acceptance and record exact repo/deployed SHAs.
9. Remove synthetic files/installations and verify TTL/DLQ/queue cleanup.

The absent infrastructure template/handler is an implementation blocker—not a
credential-only configuration step—and is intentionally called out rather
than hidden by a placeholder deployment.
