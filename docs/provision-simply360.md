# Provision the Simply360 dev app

The Simply360 publisher/test-team control plane and public packages must exist
before live acceptance. These steps do not authorize stable npm publication,
production, `main`, customer data, or a public marketplace listing.

## 1. Complete interactive npm authentication

From a trusted terminal, the owner signs in with the account that belongs to
the `@simply360` organization and satisfies its 2FA policy:

```bash
npm login --scope=@simply360 --auth-type=web
npm whoami
npm access ls-packages @simply360
```

Then verify the required prerelease packages without publishing anything:

```bash
npm view @simply360/integration-sdk@beta version dist.integrity
npm view @simply360/blueprint-sdk@beta version dist.integrity
npm view @simply360/sdk@beta version dist.integrity
```

If a package is missing, npm returns `E404`; if authentication is missing, npm
returns `ENEEDAUTH`. Either result remains an exact external blocker. Stable
publication and provenance configuration are owned by the platform release
work and are not performed here.

Once available, bind this repository's structural ports to those public
packages in a reviewed commit and keep `npm run check:boundary` green. Do not
copy a monorepo tarball, internal package, SSM credential, or workspace path
into this public repository.

## 2. Create the private development app

Using the user-level Developer Console/CLI and publisher OAuth:

1. Select the verified Simply360 publisher.
2. Create a development app with slug
   `simply360-reference-google-drive`.
3. Distribution: private/development only.
4. App type: confidential server.
5. Grant mode: `teamInstallation`.
6. Account binding: Team.
7. Exact scopes:
   `offline_access files:read files:write`.
8. Exact capabilities:
   `FILE_SOURCE`, `FILE_DESTINATION`, and
   `EXTERNAL_BLUEPRINT_PACKAGE`.
9. Simply360 OAuth redirect:
   `https://reference-drive.dev.simply360.app/oauth/simply360/callback`.
10. Setup URL:
    `https://reference-drive.dev.simply360.app/setup`.
11. Lifecycle URL:
    `https://reference-drive.dev.simply360.app/simply360/lifecycle`.

Render the accepted artifact:

```bash
npm ci
npm run verify
npm run artifacts -- --source-commit "$(git rev-parse HEAD)"
```

Submit `build/artifacts/app-manifest.json` and the exact checksum manifest.
Record the app, version/release, publisher, and artifact Simply IDs plus
attestation hash.

## 3. Store the Simply360 confidential client

The client secret is revealed once. Enter it directly into the
repository-scoped AWS Secrets Manager secret with the corresponding public
client ID. Never put it in `.env`, GitHub Actions, an issue, CI output, or the
artifact bundle.

The app uses the existing Simply360 authorization server:

- authorization code + S256 PKCE;
- exact installation binding;
- `/oauth/token`;
- no `client_credentials`;
- no `/marketplace/oauth/token`;
- no API-key copying.

## 4. Install into the publisher test team

1. Use only an invite-only, expiring publisher test Team with synthetic data.
2. Start Team Admin private install and recent-auth consent.
3. Confirm `PENDING_SETUP` can access only its setup/status contract.
4. Complete Google OAuth and setup.
5. Confirm the installation becomes `ACTIVE` before ordinary file routes work.
6. Install a second isolated instance.
7. Record installation, Team Integration, operation, consent, grant, Team
   Role, and Blueprint-link Simply IDs.

## 5. Run live acceptance

For each accepted repository/deployment SHA:

1. Pick one synthetic Drive file and import it.
2. Modify it; deliver a valid notification; verify one new Simply360 version.
3. Replay the same notification; verify no additional version.
4. Pick one synthetic Drive folder and export one Simply360 file.
5. Inject an upload interruption; verify the exact session/offset resumes.
6. Export a later version; verify the same Drive object/link updates.
7. Revoke one Google connection; verify its operations fail and the sibling
   installation remains active.
8. Attempt scope widening; verify re-consent is required.
9. Suspend; verify ordinary use fails.
10. Upgrade with unchanged authority.
11. Uninstall once with delete and once with retain-disclosed-data decision.
12. Verify channels and credentials are revoked and no synthetic secret/file
    remains outside the chosen retention result.

Evidence must contain exact SHAs, public Simply IDs, timestamps, hashes, state
transitions, redacted logs, and cleanup—not credentials or file bodies.
