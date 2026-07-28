import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_FOLDER_MIME_TYPE,
  GOOGLE_PICKER_VIEW_ID,
  type GoogleAuthorizationRequest,
  type GoogleChange,
  type GoogleChangePage,
  type GoogleCredential,
  type GoogleDownload,
  type GoogleDriveObject,
  type ImportedFileResult,
  type InstallationRegistration,
  type NotificationChannel,
  type PickerSession,
  type ResumableUpload,
  type Simply360File,
  type TelemetryEvent,
} from './contracts.js';
import { sha256Base64 } from './crypto.js';
import type { Clock, GoogleDrivePort, IdGenerator, Simply360Port, TelemetrySink } from './ports.js';

export class FixedClock implements Clock {
  constructor(private current: Date = new Date('2026-07-28T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class DeterministicIdGenerator implements IdGenerator {
  private counter = 0;

  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${String(this.counter).padStart(8, '0')}`;
  }

  secret(bytes: number): string {
    this.counter += 1;
    return `secret-${bytes}-${String(this.counter).padStart(8, '0')}`;
  }
}

export class InMemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];

  async emit(event: TelemetryEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

interface StoredDriveObject {
  object: GoogleDriveObject;
  bytes: Uint8Array;
}

interface PendingDriveUpload {
  readonly uploadId: string;
  readonly parentDriveObjectId: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly existingDriveObjectId?: string;
  bytes: Uint8Array;
  nextOffset: number;
}

export class GoogleDriveDouble implements GoogleDrivePort {
  readonly objects = new Map<string, StoredDriveObject>();
  readonly channels = new Map<string, NotificationChannel>();
  readonly revokedSubjects = new Set<string>();
  readonly stoppedChannelIds: string[] = [];
  readonly changes: GoogleChange[] = [];
  readonly authorizationCodes = new Map<string, GoogleCredential>();
  readonly uploads = new Map<string, PendingDriveUpload>();
  failUploadOnceAtOffset?: number;
  private objectCounter = 100;
  private uploadCounter = 0;
  private channelCounter = 0;

  constructor(private readonly clock: Clock = new FixedClock()) {}

  authorizeCode(code: string, credential?: Partial<GoogleCredential>): GoogleCredential {
    const complete: GoogleCredential = {
      accessToken: credential?.accessToken ?? `google-access-${code}`,
      refreshToken: credential?.refreshToken ?? `google-refresh-${code}`,
      expiresAt: credential?.expiresAt ?? new Date(this.clock.now().getTime() + 60 * 60 * 1000).toISOString(),
      grantedScopes: credential?.grantedScopes ?? [GOOGLE_DRIVE_SCOPE],
      googleAccountSubject: credential?.googleAccountSubject ?? `google-subject-${code}`,
    };
    this.authorizationCodes.set(code, complete);
    return complete;
  }

  seedFile(input: { driveObjectId: string; name: string; mimeType: string; bytes: Uint8Array }): GoogleDriveObject {
    const object: GoogleDriveObject = {
      driveObjectId: input.driveObjectId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      modifiedAt: this.clock.now().toISOString(),
      trashed: false,
    };
    this.objects.set(input.driveObjectId, { object, bytes: new Uint8Array(input.bytes) });
    return object;
  }

  seedFolder(driveObjectId: string, name: string): GoogleDriveObject {
    return this.seedFile({ driveObjectId, name, mimeType: GOOGLE_FOLDER_MIME_TYPE, bytes: new Uint8Array() });
  }

  mutateFile(driveObjectId: string, bytes: Uint8Array): GoogleDriveObject {
    const stored = this.objects.get(driveObjectId);
    if (!stored) throw new Error('Drive object not found.');
    const object = {
      ...stored.object,
      sizeBytes: bytes.byteLength,
      modifiedAt: new Date(this.clock.now().getTime() + this.changes.length + 1).toISOString(),
    };
    this.objects.set(driveObjectId, { object, bytes: new Uint8Array(bytes) });
    this.changes.push({
      changeId: `change-${this.changes.length + 1}`,
      driveObjectId,
      removed: false,
      object,
    });
    return object;
  }

  removeFile(driveObjectId: string): void {
    const stored = this.objects.get(driveObjectId);
    if (stored) this.objects.set(driveObjectId, { ...stored, object: { ...stored.object, trashed: true } });
    this.changes.push({
      changeId: `change-${this.changes.length + 1}`,
      driveObjectId,
      removed: true,
    });
  }

  async exchangeAuthorizationCode(request: GoogleAuthorizationRequest): Promise<GoogleCredential> {
    if (!request.redirectUri.startsWith('https://') || request.codeVerifier.length < 43) {
      throw new Error('Invalid Google OAuth authorization-code request.');
    }
    const credential = this.authorizationCodes.get(request.authorizationCode);
    if (!credential) throw new Error('Unknown or spent Google authorization code.');
    this.authorizationCodes.delete(request.authorizationCode);
    return structuredClone(credential);
  }

  async createPickerSession(credential: GoogleCredential): Promise<PickerSession> {
    this.assertCredential(credential);
    return {
      appId: 'picker-app-id',
      developerKey: 'picker-developer-key',
      oauthToken: credential.accessToken,
      origin: 'https://reference-drive.dev.example',
      viewId: GOOGLE_PICKER_VIEW_ID,
      allowFolders: true,
      multiselect: false,
    };
  }

  async getObject(credential: GoogleCredential, driveObjectId: string): Promise<GoogleDriveObject> {
    this.assertCredential(credential);
    const stored = this.objects.get(driveObjectId);
    if (!stored) throw new Error('Drive object not found.');
    return structuredClone(stored.object);
  }

  async downloadObject(credential: GoogleCredential, driveObjectId: string): Promise<GoogleDownload> {
    this.assertCredential(credential);
    const stored = this.objects.get(driveObjectId);
    if (!stored || stored.object.trashed) throw new Error('Drive object unavailable.');
    return {
      bytes: new Uint8Array(stored.bytes),
      name: stored.object.name,
      contentType: stored.object.mimeType,
    };
  }

  async beginResumableUpload(
    credential: GoogleCredential,
    input: {
      parentDriveObjectId: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      existingDriveObjectId?: string;
    },
  ): Promise<ResumableUpload> {
    this.assertCredential(credential);
    const parent = this.objects.get(input.parentDriveObjectId);
    if (!parent || parent.object.mimeType !== GOOGLE_FOLDER_MIME_TYPE || parent.object.trashed) {
      throw new Error('Drive destination folder unavailable.');
    }
    this.uploadCounter += 1;
    const uploadId = `upload-${this.uploadCounter}`;
    this.uploads.set(uploadId, {
      uploadId,
      ...input,
      bytes: new Uint8Array(),
      nextOffset: 0,
    });
    return { uploadId, nextOffset: 0 };
  }

  async uploadChunk(
    credential: GoogleCredential,
    uploadId: string,
    input: { bytes: Uint8Array; offset: number; totalBytes: number },
  ): Promise<ResumableUpload | GoogleDriveObject> {
    this.assertCredential(credential);
    const upload = this.uploads.get(uploadId);
    if (!upload || input.offset !== upload.nextOffset || input.totalBytes !== upload.sizeBytes) {
      throw new Error('Invalid resumable upload coordinate.');
    }
    if (this.failUploadOnceAtOffset === input.offset) {
      this.failUploadOnceAtOffset = undefined;
      throw new Error('Injected Drive upload failure.');
    }
    const combined = new Uint8Array(upload.bytes.byteLength + input.bytes.byteLength);
    combined.set(upload.bytes);
    combined.set(input.bytes, upload.bytes.byteLength);
    upload.bytes = combined;
    upload.nextOffset = combined.byteLength;
    if (upload.nextOffset < upload.sizeBytes) return { uploadId, nextOffset: upload.nextOffset };
    if (upload.nextOffset !== upload.sizeBytes) throw new Error('Drive upload exceeded declared size.');

    this.objectCounter += 1;
    const driveObjectId = upload.existingDriveObjectId ?? `drive-export-${this.objectCounter}`;
    const object: GoogleDriveObject = {
      driveObjectId,
      name: upload.name,
      mimeType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      modifiedAt: this.clock.now().toISOString(),
      trashed: false,
    };
    this.objects.set(driveObjectId, { object, bytes: new Uint8Array(upload.bytes) });
    this.uploads.delete(uploadId);
    return structuredClone(object);
  }

  async startChangeNotifications(
    credential: GoogleCredential,
    input: { channelId: string; channelToken: string; expiresAt: string },
  ): Promise<NotificationChannel> {
    this.assertCredential(credential);
    this.channelCounter += 1;
    const channel: NotificationChannel = {
      ...input,
      resourceId: `drive-resource-${this.channelCounter}`,
    };
    this.channels.set(channel.channelId, channel);
    return structuredClone(channel);
  }

  async stopChangeNotifications(credential: GoogleCredential, channel: NotificationChannel): Promise<void> {
    this.assertCredential(credential);
    const existing = this.channels.get(channel.channelId);
    if (!existing || existing.resourceId !== channel.resourceId) throw new Error('Unknown notification channel.');
    this.channels.delete(channel.channelId);
    this.stoppedChannelIds.push(channel.channelId);
  }

  async listChanges(credential: GoogleCredential, cursor?: string): Promise<GoogleChangePage> {
    this.assertCredential(credential);
    const index = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(index) || index < 0 || index > this.changes.length) throw new Error('Invalid change cursor.');
    return {
      changes: structuredClone(this.changes.slice(index)),
      nextCursor: String(this.changes.length),
    };
  }

  async revokeCredential(credential: GoogleCredential): Promise<void> {
    this.revokedSubjects.add(credential.googleAccountSubject);
  }

  private assertCredential(credential: GoogleCredential): void {
    if (this.revokedSubjects.has(credential.googleAccountSubject)) throw new Error('Google credential revoked.');
    if (
      credential.grantedScopes.length !== 1 ||
      credential.grantedScopes[0] !== GOOGLE_DRIVE_SCOPE ||
      !credential.accessToken
    ) {
      throw new Error('Google credential does not have exact drive.file authority.');
    }
  }
}

export class Simply360Double implements Simply360Port {
  readonly files = new Map<string, Simply360File>();
  readonly setupCalls: Array<{ installationSimplyId: string; idempotencyKey: string }> = [];
  readonly healthCalls: Array<{ installationSimplyId: string; status: string }> = [];
  readonly upgrades: Array<{ installationSimplyId: string; fromVersion: string; toVersion: string }> = [];
  readonly uninstalls: Array<{ installationSimplyId: string; deletionDecision: string }> = [];
  readonly importIdempotency = new Map<string, ImportedFileResult>();
  failNextImport = false;
  private fileCounter = 0;

  seedFile(input: { fileSimplyId: string; name: string; contentType: string; bytes: Uint8Array; versionNumber?: number }): Simply360File {
    const file: Simply360File = {
      fileSimplyId: input.fileSimplyId,
      versionNumber: input.versionNumber ?? 1,
      name: input.name,
      contentType: input.contentType,
      bytes: new Uint8Array(input.bytes),
      checksumSha256Base64: sha256Base64(input.bytes),
    };
    this.files.set(input.fileSimplyId, file);
    return file;
  }

  async completeSetup(
    installation: InstallationRegistration,
    input: { idempotencyKey: string; providerAccountSubject: string },
  ): Promise<void> {
    this.assertCredential(installation);
    if (!input.providerAccountSubject || !input.idempotencyKey) throw new Error('Setup callback fields are required.');
    if (!this.setupCalls.some((call) => call.idempotencyKey === input.idempotencyKey)) {
      this.setupCalls.push({ installationSimplyId: installation.installationSimplyId, idempotencyKey: input.idempotencyKey });
    }
  }

  async importFile(
    installation: InstallationRegistration,
    input: {
      name: string;
      contentType: string;
      bytes: Uint8Array;
      checksumSha256Base64: string;
      idempotencyKey: string;
      newVersionOfFileSimplyId?: string;
    },
  ): Promise<ImportedFileResult> {
    this.assertCredential(installation);
    const cached = this.importIdempotency.get(input.idempotencyKey);
    if (cached) return structuredClone(cached);
    if (this.failNextImport) {
      this.failNextImport = false;
      throw new Error('Injected Simply360 import failure.');
    }
    if (sha256Base64(input.bytes) !== input.checksumSha256Base64) throw new Error('Import checksum mismatch.');
    const existing = input.newVersionOfFileSimplyId ? this.files.get(input.newVersionOfFileSimplyId) : undefined;
    this.fileCounter += 1;
    const fileSimplyId = existing?.fileSimplyId ?? `FILE-MOCK-${String(this.fileCounter).padStart(4, '0')}`;
    const versionNumber = existing ? existing.versionNumber + 1 : 1;
    const file = this.seedFile({
      fileSimplyId,
      versionNumber,
      name: input.name,
      contentType: input.contentType,
      bytes: input.bytes,
    });
    const result = {
      fileSimplyId: file.fileSimplyId,
      versionNumber: file.versionNumber,
      checksumSha256Base64: file.checksumSha256Base64,
    };
    this.importIdempotency.set(input.idempotencyKey, result);
    return structuredClone(result);
  }

  async downloadFile(
    installation: InstallationRegistration,
    fileSimplyId: string,
    versionNumber?: number,
  ): Promise<Simply360File> {
    this.assertCredential(installation);
    const file = this.files.get(fileSimplyId);
    if (!file || (versionNumber !== undefined && file.versionNumber !== versionNumber)) {
      throw new Error('Simply360 file version not found.');
    }
    return structuredClone(file);
  }

  async reportProviderHealth(
    installation: InstallationRegistration,
    input: { status: 'HEALTHY' | 'CREDENTIAL_REVOKED' | 'DEGRADED'; reason?: string },
  ): Promise<void> {
    this.assertCredential(installation);
    this.healthCalls.push({ installationSimplyId: installation.installationSimplyId, status: input.status });
  }

  async recordUpgrade(
    installation: InstallationRegistration,
    input: { fromVersion: string; toVersion: string; idempotencyKey: string },
  ): Promise<void> {
    this.assertCredential(installation);
    if (!input.idempotencyKey) throw new Error('Upgrade idempotency key is required.');
    this.upgrades.push({
      installationSimplyId: installation.installationSimplyId,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
    });
  }

  async completeUninstall(
    installation: InstallationRegistration,
    input: { idempotencyKey: string; deletionDecision: 'DELETE_APP_DATA' | 'RETAIN_DISCLOSED_DATA' },
  ): Promise<void> {
    this.assertCredential(installation);
    if (!input.idempotencyKey) throw new Error('Uninstall idempotency key is required.');
    this.uninstalls.push({
      installationSimplyId: installation.installationSimplyId,
      deletionDecision: input.deletionDecision,
    });
  }

  private assertCredential(installation: InstallationRegistration): void {
    if (!installation.credential.accessToken) throw new Error('Simply360 credential unavailable.');
  }
}
