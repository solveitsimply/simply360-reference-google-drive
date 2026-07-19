/**
 * Simply360 Reference App — Google Drive
 * FILE_SOURCE / FILE_DESTINATION proof (Proof B).
 *
 * SCAFFOLD ONLY — no proof behavior is implemented yet. This file establishes
 * the typed surface and the integration points that MKT-11 will build on.
 *
 * Architecture sketch (per plan Proof B):
 *
 *   Google Picker (drive.file)          Simply360 public platform
 *   ─────────────────────────           ─────────────────────────
 *   user selects file/folder  ──▶  installedApp OAuth (service principal)
 *   resumable upload / download ◀─▶  FILE_SOURCE  capability  (import → Simply360)
 *   change notifications        ──▶  FILE_DESTINATION capability (export → Drive)
 *   reconciliation / revocation ◀─▶  webhooks + uninstall lifecycle
 *
 * Boundary rules (Ratified Direction 9 / 21):
 *   - Only public boundaries: the future `@simply360/integration-sdk` and
 *     `@simply360/blueprint-sdk` packages, Simply360 OAuth, webhooks, and
 *     manifests.
 *   - No Simply360 internal package imports, database access, VPC access, or
 *     SSM/E2E credentials. No secrets are committed to this repository.
 *   - `drive.file` only: do NOT request broad Drive scopes and do NOT treat
 *     arbitrary personal Drive files as authoritative primary storage in v1.
 */

/** The two mandatory file capabilities this reference app must prove. */
export type ProvenFileCapability = 'FILE_SOURCE' | 'FILE_DESTINATION';

/** Google OAuth scope this proof is restricted to (non-sensitive). */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file' as const;

/** Acceptance scenarios V1 must demonstrate (see README "Proof scope"). */
export const PROOF_SCENARIOS = [
  'simply360-oauth-install',
  'google-oauth-connect',
  'picker-file-selection',
  'import-file-source',
  'export-file-destination',
  'change-reconciliation',
  'revocation',
  'uninstall',
] as const;

export type ProofScenario = (typeof PROOF_SCENARIOS)[number];

export interface ReferenceAppInfo {
  readonly name: string;
  readonly provenCapabilities: readonly ProvenFileCapability[];
  readonly googleScope: typeof GOOGLE_DRIVE_SCOPE;
  readonly scenarios: readonly ProofScenario[];
}

export const referenceApp: ReferenceAppInfo = {
  name: 'simply360-reference-google-drive',
  provenCapabilities: ['FILE_SOURCE', 'FILE_DESTINATION'],
  googleScope: GOOGLE_DRIVE_SCOPE,
  scenarios: PROOF_SCENARIOS,
};

/**
 * Placeholder entry point. Returns the static proof descriptor so the scaffold
 * type-checks, builds, and tests green before any runtime is wired.
 */
export function describeProof(): ReferenceAppInfo {
  // TODO(MKT-11): construct the Simply360 client from the public
  //   `@simply360/integration-sdk` surface (OAuth service-principal token
  //   exchange, webhook signature verification, manifest capabilities) once
  //   that package is published. Do not import Simply360 internal modules.
  // TODO(MKT-11): register the Google Picker flow (drive.file) and wire the
  //   FILE_SOURCE import + FILE_DESTINATION export handlers.
  // TODO(MKT-11): implement resumable upload, change-notification
  //   reconciliation, credential revocation, and uninstall cleanup.
  return referenceApp;
}
