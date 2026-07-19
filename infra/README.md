# Infrastructure — intended provisioning (placeholder)

This document records the **intended** AWS/GitHub OIDC provisioning for this
reference proof. **No AWS resources are created by this repository.** Everything
below is a later provisioning step, owned and rotated by the platform owner.

## GitHub OIDC deploy role

Deployments use short-lived credentials via GitHub OIDC — no long-lived AWS
keys. The IAM role trust must be scoped to **this repository and the `dev`
branch only**:

- Repository: `solveitsimply/simply360-reference-google-drive`
- Trusted subject: `repo:solveitsimply/simply360-reference-google-drive:ref:refs/heads/dev`
- OIDC provider: `token.actions.githubusercontent.com` (the org's existing
  provider is reused)

> Creating or promoting a `main` branch — and any `main`-scoped trust — is
> reserved for the Production/GA plan under fresh explicit authorization.

## NonProd stack and region

| Setting            | Value                              |
| ------------------ | ---------------------------------- |
| Region             | `us-east-1`                        |
| Dedicated stack    | `Simply360ReferenceGoogleDriveDev` |
| Cost profile       | Low-volume Lambda / API Gateway / DynamoDB / SQS, bounded concurrency, 7-day log retention |

The monorepo-owned dev evidence stack (`Simply360IntegrationMarketplaceEvidenceDev`)
is separate and not provisioned here. Deployment roles and Secrets Manager paths
are repository-scoped and owned/rotated by the platform owner.

## Google Cloud (owned by the platform owner)

- OAuth brand / display name: `Simply360 Reference Files (Dev)`
- Project ID: `simply360-reference-drive-dev-<globally-unique-suffix>`
- Scope restricted to non-sensitive `drive.file`; Picker/API quotas and
  approved dev origins/redirects are owner-managed.

## Cost guardrail

Ratified Direction 40: NonProd recurring cost is capped at **$25/month**
(expected $2–$10/month). Re-estimate before provisioning and stop above the cap.

## What is NOT here

No credentials, secret values, SSM references, or Simply360 internal
configuration are stored in this repository (Ratified Direction 9 / 21).
