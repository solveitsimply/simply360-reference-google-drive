# Local conformance evidence

The local suite is deterministic and uses synthetic provider doubles. It is
repo-side acceptance evidence, not deployed or live-Google evidence.

| Requirement | Local evidence |
| --- | --- |
| Simply360 install and setup | `PENDING_SETUP` rejects ordinary file use; exact setup receipt activates the installation |
| Exact Google consent | single-use expiring state + PKCE + exact redirect; only `drive.file` with offline refresh; broad/incomplete grant revoked |
| Explicit Picker selection | exact accessible metadata; single file/folder; Shared Drive rejected |
| `FILE_SOURCE` import | checksum-bound upload intent, stable link, later version |
| `FILE_DESTINATION` export | selected folder, bounded resumable chunks, offset recovery, stable Drive object |
| Google-native files | Docs/Sheets/Slides/Drawings use bounded public export formats |
| Change notification | exact channel/resource/token, expiry, state, bounded message number, duplicate suppression, failed-message retry |
| Reconciliation | bounded cursor batch, idempotent re-import, remote-missing without local deletion |
| Failure | injected Simply360 and Google failures create no false completed link; export resumes |
| Isolation | two installations have separate credentials, link IDs, file IDs, cursors, health, and revocation; reconnect clears prior-account authority |
| Upgrade | unchanged scope succeeds; widened scope requires re-consent |
| Telemetry | success/failure events contain no credential or channel-secret values |
| Uninstall | stop channels, revoke credential, clear or retain disclosed metadata per explicit decision |
| Artifacts | exact source SHA, canonical Blueprint definition hash, package hash, manifest hash |
| Transfer trust | signed URLs use an exact-origin allowlist; redirects and bearer forwarding are disabled; JSON/files/chunks/totals are bounded |
| Public boundary | static scan rejects `@s360` imports, monorepo paths, internal persistence imports, broad Drive scope, and runtime dependencies |
| Deployable runtime | API router, raw-body lifecycle HMAC, strict state parser, SigV4 AWS transport, optimistic DynamoDB state, leased idempotency, durable outbox, sanitized notifications, and all worker operations |
| Infrastructure | SAM/CloudFormation lint validates the dev API/Lambda/DynamoDB/SQS/DLQ/log/alarms/custom-domain stack and protected-environment OIDC roles |

Run the exact gate:

```bash
npm ci
npm run verify
npm run artifacts -- --source-commit "$(git rev-parse HEAD)"
```

The gate enforces compiled-source minimums of 85% line, 65% branch, and 85%
function coverage with Node's built-in coverage collector. Exact measured
percentages are reported by each run rather than frozen in this document.

Live conformance must add the exact repository SHA, deployed SHA, Google Cloud
project/client identity, Simply360 app/release/installation Simply IDs,
synthetic Team/user identity, test timestamp, redacted telemetry export, and
cleanup evidence. Never store access/refresh tokens, authorization codes,
client secrets, Picker keys, file bodies, or signed URLs in evidence.
