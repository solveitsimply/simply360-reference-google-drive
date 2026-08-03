# Provision the dev Google Cloud boundary

These are owner-interactive NonProd steps. They create a free Google Cloud
project and credentials, so they must be performed by the platform owner in
the intended Google account. Do not paste credential values into GitHub,
Simply360 records, tickets, chat, CI logs, or this repository.

## 1. Create and identify the project

1. Sign in to Google Cloud Console with the platform-owner account.
2. Create a project named `Simply360 Reference Files (Dev)`.
3. Use project ID
   `simply360-reference-files-dev` (the available ID Google generated and the
   owner accepted on 2026-07-31).
4. Do not link a paid service or enable a paid Marketplace product. If Google
   requires billing or projected recurring spend is non-zero beyond normal
   free quotas, stop and re-authorize the cost.
5. Record the non-secret project number and final project ID in the
   Simply360 execution ledger.

## 2. Enable only the required APIs

Enable:

- Google Drive API
- Google Picker API

Do not enable Admin SDK, service-account domain-wide delegation, Shared Drive
administration, or another data API for this proof.

## 3. Configure the OAuth consent screen

1. Configure Google Auth Platform for an external app in testing mode.
2. App name: `Simply360 Reference Files (Dev)`.
3. User support and developer contact:
   `developers@simply360.app`.
4. Add the owner-controlled Simply360 application domain when the deployed
   dev origin exists.
5. Add exactly one data scope:
   `https://www.googleapis.com/auth/drive.file`.
6. Do not add broad `drive`, `drive.readonly`, metadata-wide, Activity, Admin,
   Gmail, Calendar, OpenID, profile, or email scopes.
7. Add only approved synthetic Google accounts as test users. Never use a real
   customer account or customer Drive content.

Google verification/publication is not part of this dev proof.

## 4. Create the web OAuth client

Create a Web application client.

Authorized JavaScript origin:

```text
https://reference-drive.dev.simply360.app
```

Authorized redirect URI:

```text
https://reference-drive.dev.simply360.app/oauth/google/callback
```

No localhost, wildcard, staging, production, alternate-domain, or path variant
belongs on the dev client. Record the non-secret client ID; treat the client
secret as sensitive.

## 5. Create and restrict the Picker key

1. Create a separate API key for Google Picker.
2. Application restriction: HTTP referrers.
3. Exact allowed referrer:
   `https://reference-drive.dev.simply360.app/*`.
4. API restriction: Google Picker API only.
5. Record the key identifier and restrictions. The browser key is not a
   server secret, but it remains configuration and must not be broadened.

## 6. Store credentials in the reference stack

After the NonProd AWS role and secret exist, store one JSON value in the
repository-scoped Secrets Manager path selected by the platform owner. These
four key names are read verbatim by the runtime (`src/lambda.ts`) — a renamed
key fails config loading at deploy time rather than at review:

```json
{
  "clientId": "<web-client-id>",
  "clientSecret": "<web-client-secret>",
  "pickerAppId": "<numeric-project-number>",
  "pickerDeveloperKey": "<restricted-picker-key>"
}
```

Use the console or an approved secret-entry session. Do not put the JSON in a
shell history. The runtime role gets only `secretsmanager:GetSecretValue` for
that exact secret; the GitHub deploy role must not read the secret value.

## 7. Quotas and alerts

Set conservative Drive and Picker quotas for the synthetic proof:

- bound requests per minute per user;
- retain default daily quotas unless a lower bound is practical;
- add a budget/usage notification where the account supports it;
- do not request quota increases for this proof.

## 8. Readback before acceptance

Record redacted screenshots or API readback showing:

- project ID/number and enabled APIs;
- consent app name, testing status, exact scope, and synthetic test users;
- OAuth client type and exact origin/redirect (never the secret);
- Picker key application/API restrictions (never the full key);
- secret ARN/path and last-updated metadata (never the value);
- quota settings.

Then follow [Simply360 provisioning](./provision-simply360.md) and run the live
acceptance matrix from [local conformance](./local-conformance.md).
