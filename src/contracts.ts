/**
 * Public wire shapes used by the reference application.
 *
 * These are intentionally small structural contracts. They contain no
 * Simply360 implementation types and can be replaced by the matching exports
 * from @simply360/integration-sdk / @simply360/sdk once those packages are
 * published.
 */

export type ProvenFileCapability = 'FILE_SOURCE' | 'FILE_DESTINATION';
export type InstallationStatus = 'PENDING_SETUP' | 'ACTIVE' | 'SUSPENDED' | 'UNINSTALLED';
export type GoogleConnectionStatus = 'ACTIVE' | 'REVOKED';
export type LinkDirection = 'SOURCE' | 'DESTINATION';
export type LinkStatus = 'ACTIVE' | 'REMOTE_MISSING' | 'REVOKED';
export type PickerObjectKind = 'FILE' | 'FOLDER';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file' as const;
export const GOOGLE_PICKER_VIEW_ID = 'DOCS' as const;
export const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder' as const;

export const PROOF_SCENARIOS = [
  'simply360-oauth-install',
  'google-oauth-connect',
  'picker-file-selection',
  'import-file-source',
  'export-file-destination',
  'change-reconciliation',
  'failure-recovery',
  'credential-revocation',
  'upgrade',
  'telemetry',
  'uninstall',
] as const;

export type ProofScenario = (typeof PROOF_SCENARIOS)[number];

export interface ReferenceAppInfo {
  readonly name: string;
  readonly provenCapabilities: readonly ProvenFileCapability[];
  readonly googleScope: typeof GOOGLE_DRIVE_SCOPE;
  readonly scenarios: readonly ProofScenario[];
  readonly primaryStorage: false;
}

export interface Simply360InstallationCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: string;
  readonly scopes: readonly ('offline_access' | 'files:read' | 'files:write')[];
}

export interface InstallationRegistration {
  readonly installationSimplyId: string;
  readonly teamSimplyId: string;
  readonly appVersion: string;
  readonly credential: Simply360InstallationCredential;
  /**
   * The setup callback is an opaque public URL issued by Simply360 for this
   * exact operation. The reference app never constructs an internal route.
   */
  readonly setupCallbackUrl: string;
}

export interface GoogleCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: string;
  readonly grantedScopes: readonly string[];
  readonly googleAccountSubject: string;
}

export interface GoogleAuthorizationRequest {
  readonly authorizationCode: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface PickerSession {
  readonly appId: string;
  readonly developerKey: string;
  readonly oauthToken: string;
  readonly origin: string;
  readonly viewId: typeof GOOGLE_PICKER_VIEW_ID;
  readonly allowFolders: true;
  readonly multiselect: false;
}

export interface PickerSelection {
  readonly action: 'PICKED';
  readonly driveObjectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly kind: PickerObjectKind;
  readonly sharedDriveId?: never;
}

export interface GoogleDriveObject {
  readonly driveObjectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly md5Checksum?: string;
  readonly trashed: boolean;
}

export interface GoogleChange {
  readonly changeId: string;
  readonly driveObjectId: string;
  readonly removed: boolean;
  readonly object?: GoogleDriveObject;
}

export interface GoogleChangePage {
  readonly changes: readonly GoogleChange[];
  readonly nextCursor: string;
}

export interface GoogleDownload {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly contentType: string;
}

export interface Simply360File {
  readonly fileSimplyId: string;
  readonly versionNumber: number;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly checksumSha256Base64: string;
}

export interface ImportedFileResult {
  readonly fileSimplyId: string;
  readonly versionNumber: number;
  readonly checksumSha256Base64: string;
}

export interface ResumableUpload {
  readonly uploadId: string;
  readonly nextOffset: number;
}

export interface NotificationChannel {
  readonly channelId: string;
  readonly resourceId: string;
  readonly channelToken: string;
  readonly expiresAt: string;
}

export interface NotificationHeaders {
  readonly channelId: string;
  readonly resourceId: string;
  readonly channelToken: string;
  readonly messageNumber: string;
  readonly resourceState: string;
}

export interface ExternalFileLink {
  readonly linkSimplyId: string;
  readonly installationSimplyId: string;
  readonly direction: LinkDirection;
  readonly driveObjectId: string;
  readonly simply360FileSimplyId: string;
  readonly simply360VersionNumber: number;
  readonly driveModifiedAt: string;
  readonly checksumSha256Base64: string;
  readonly status: LinkStatus;
  readonly updatedAt: string;
}

export interface TelemetryEvent {
  readonly eventName:
    | 'installation.registered'
    | 'google.connected'
    | 'picker.selection.recorded'
    | 'installation.activated'
    | 'file.imported'
    | 'file.exported'
    | 'notification.started'
    | 'notification.duplicate'
    | 'reconciliation.completed'
    | 'google.revoked'
    | 'app.upgraded'
    | 'installation.suspended'
    | 'installation.uninstalled'
    | 'operation.failed';
  readonly installationSimplyId: string;
  readonly occurredAt: string;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface InstallationSnapshot {
  readonly installationSimplyId: string;
  readonly teamSimplyId: string;
  readonly appVersion: string;
  readonly status: InstallationStatus;
  readonly googleConnectionStatus?: GoogleConnectionStatus;
  readonly selectionCount: number;
  readonly linkCount: number;
  readonly notificationCount: number;
  readonly changeCursor?: string;
}
