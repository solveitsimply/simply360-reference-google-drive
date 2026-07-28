import type {
  GoogleAuthorizationRequest,
  GoogleChangePage,
  GoogleCredential,
  GoogleDownload,
  GoogleDriveObject,
  ImportedFileResult,
  InstallationRegistration,
  NotificationChannel,
  PickerSelection,
  PickerSession,
  ResumableUpload,
  Simply360File,
  TelemetryEvent,
} from './contracts.js';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
  secret(bytes: number): string;
}

export interface GoogleDrivePort {
  createAuthorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchangeAuthorizationCode(request: GoogleAuthorizationRequest): Promise<GoogleCredential>;
  createPickerSession(credential: GoogleCredential): Promise<PickerSession>;
  getObject(credential: GoogleCredential, driveObjectId: string): Promise<GoogleDriveObject>;
  downloadObject(credential: GoogleCredential, driveObjectId: string): Promise<GoogleDownload>;
  beginResumableUpload(
    credential: GoogleCredential,
    input: {
      parentDriveObjectId: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      existingDriveObjectId?: string;
    },
  ): Promise<ResumableUpload>;
  uploadChunk(
    credential: GoogleCredential,
    uploadId: string,
    input: { bytes: Uint8Array; offset: number; totalBytes: number },
  ): Promise<ResumableUpload | GoogleDriveObject>;
  startChangeNotifications(
    credential: GoogleCredential,
    input: { channelId: string; channelToken: string; expiresAt: string },
  ): Promise<NotificationChannel>;
  stopChangeNotifications(credential: GoogleCredential, channel: NotificationChannel): Promise<void>;
  listChanges(credential: GoogleCredential, cursor?: string): Promise<GoogleChangePage>;
  revokeCredential(credential: GoogleCredential): Promise<void>;
}

export interface Simply360Port {
  completeSetup(
    installation: InstallationRegistration,
    input: { idempotencyKey: string; providerAccountSubject: string },
  ): Promise<void>;
  importFile(
    installation: InstallationRegistration,
    input: {
      name: string;
      contentType: string;
      bytes: Uint8Array;
      checksumSha256Base64: string;
      idempotencyKey: string;
      newVersionOfFileSimplyId?: string;
    },
  ): Promise<ImportedFileResult>;
  downloadFile(installation: InstallationRegistration, fileSimplyId: string, versionNumber?: number): Promise<Simply360File>;
  reportProviderHealth(
    installation: InstallationRegistration,
    input: { status: 'HEALTHY' | 'CREDENTIAL_REVOKED' | 'DEGRADED'; reason?: string },
  ): Promise<void>;
  recordUpgrade(
    installation: InstallationRegistration,
    input: { fromVersion: string; toVersion: string; idempotencyKey: string },
  ): Promise<void>;
  completeUninstall(
    installation: InstallationRegistration,
    input: { idempotencyKey: string; deletionDecision: 'DELETE_APP_DATA' | 'RETAIN_DISCLOSED_DATA' },
  ): Promise<void>;
}

export interface StateStore<T> {
  load(installationSimplyId: string): Promise<T | undefined>;
  save(installationSimplyId: string, state: T): Promise<void>;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): Promise<void>;
}

export interface ReferenceRuntimePorts<T> {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly google: GoogleDrivePort;
  readonly simply360: Simply360Port;
  readonly state: StateStore<T>;
  readonly telemetry: TelemetrySink;
}

export type ExplicitSelection = PickerSelection & { readonly selectedAt: string };
