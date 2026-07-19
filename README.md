# simply360-reference-google-drive

Public **reference proof** for the Simply360 Integration Marketplace:
`FILE_SOURCE` and `FILE_DESTINATION` via **Google Picker** and Google's
non-sensitive **`drive.file`** scope.

> Status: **scaffold only.** No proof behavior is implemented yet. This
> repository is the foundation that **MKT-11** (Public Google Drive reference
> app/runtime) builds on. See the plan's "Autonomous Proof Integrations —
> Proof B" for the authoritative requirements.

## Purpose

Prove that an external app, running entirely **outside the Simply360
monorepo** on **public platform boundaries only**, can:

- install into a Simply360 team via Simply360 OAuth (service-principal
  installation);
- own its own Google OAuth connection;
- let a user pick a specific file/folder through **Google Picker**
  (`drive.file` — no broad Drive access);
- **import** selected content into Simply360 (`FILE_SOURCE`) and **export**
  Simply360 content to an app-managed/selected Drive location
  (`FILE_DESTINATION`);
- keep stable external links, reconcile changes, handle credential revocation,
  and clean up on uninstall — all using **resumable upload** and change
  notifications.

Non-goals for v1: broad Google scopes, shared-drive/team ownership, and
treating arbitrary personal Drive files as authoritative primary storage.
Those require a separate product and verification decision.

## Boundary rules (non-negotiable)

- **Only public boundaries** (Ratified Direction 9 / 21): the future
  `@simply360/integration-sdk` and `@simply360/blueprint-sdk` packages,
  Simply360 OAuth, webhooks, manifests, and extension protocols.
- **No** Simply360 internal package imports, database/VPC access, or SSM/E2E
  credentials. **No secrets** are committed here.
- The `@simply360/*` SDKs are **not yet published**; integration points are
  marked with `TODO(MKT-11)` in `src/index.ts` and will bind to the published
  package surface when it is available.

## Layout

```
.
├── .github/
│   ├── dependabot.yml          # npm + github-actions weekly updates (dev branch)
│   └── workflows/
│       ├── ci.yml              # build + test (pinned action SHAs)
│       └── security.yml        # dependency-review + SBOM + build provenance
├── infra/
│   └── README.md               # intended OIDC role + NonProd stack (no AWS resources created)
├── src/
│   └── index.ts                # typed placeholder entry point + architecture sketch
├── test/
│   └── proof.test.js           # scaffold smoke test (node --test)
├── LICENSE                     # Apache-2.0
├── NOTICE
├── package.json                # public (private:false), Apache-2.0, Node 22, dev tooling only
└── tsconfig.json
```

## Develop

```bash
npm install      # dev tooling only (typescript, @types/node)
npm run type-check
npm run build
npm test
```

## CI / security posture

- `ci.yml` (build + test) and `security.yml` (dependency review, SPDX SBOM,
  build-provenance attestation) are committed with **all third-party actions
  pinned to a full commit SHA**.
- GitHub Actions is currently **billing-blocked account-wide**, so no run has
  executed yet. `dev` branch protection therefore does **not** require status
  checks until these workflows have a green baseline.
- Secret scanning and push protection are enabled on the repository.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
