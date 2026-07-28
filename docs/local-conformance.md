# Local conformance evidence

The local suite is deterministic and uses synthetic provider doubles. It is
repo-side acceptance evidence, not deployed or live-Google evidence.

| Requirement | Local evidence |
| --- | --- |
| Simply360 install and setup | `PENDING_SETUP` rejects ordinary file use; exact setup receipt activates the installation |
| Exact Google consent | authorization-code + PKCE; only `drive.file`; broad grant revoked |
| Explicit Picker selection | exact accessible metadata; single file/folder; Shared Drive rejected |
| `FILE_SOURCE` import | checksum-bound upload intent, stable link, later version |
| `FILE_DESTINATION` export | selected folder, bounded resumable chunks, offset recovery, stable Drive object |
| Google-native files | Docs/Sheets/Slides/Drawings use bounded public export formats |
| Change notification | exact channel/resource/token, expiry, state, bounded message number, duplicate suppression |
| Reconciliation | bounded cursor batch, idempotent re-import, remote-missing without local deletion |
| Failure | injected Simply360 and Google failures create no false completed link; export resumes |
| Isolation | two installations have separate credentials, link IDs, file IDs, cursors, health, and revocation |
| Upgrade | unchanged scope succeeds; widened scope requires re-consent |
| Telemetry | success/failure events contain no credential or channel-secret values |
| Uninstall | stop channels, revoke credential, clear or retain disclosed metadata per explicit decision |
| Artifacts | exact source SHA, canonical Blueprint definition hash, package hash, manifest hash |
| Public boundary | static scan rejects `@s360` imports, monorepo paths, internal persistence imports, broad Drive scope, and runtime dependencies |

Run the exact gate:

```bash
npm ci
npm run verify
npm run artifacts -- --source-commit "$(git rev-parse HEAD)"
```

Live conformance must add the exact repository SHA, deployed SHA, Google Cloud
project/client identity, Simply360 app/release/installation Simply IDs,
synthetic Team/user identity, test timestamp, redacted telemetry export, and
cleanup evidence. Never store access/refresh tokens, authorization codes,
client secrets, Picker keys, file bodies, or signed URLs in evidence.
