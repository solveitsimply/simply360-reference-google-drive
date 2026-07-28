import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_FOLDER_MIME_TYPE,
  type ExternalFileLink,
  type GoogleDriveObject,
  type InstallationRegistration,
  type InstallationSnapshot,
  type LinkDirection,
  type NotificationChannel,
  type NotificationHeaders,
  type PickerSelection,
  type PickerSession,
  type TelemetryEvent,
} from './contracts.js';
import { constantTimeEqual, sha256Base64, sha256Hex } from './crypto.js';
import type { ExplicitSelection, ReferenceRuntimePorts } from './ports.js';
import type { InstallationState, PendingExport, StoredNotification } from './state.js';

export interface ReferenceRuntimeOptions {
  readonly uploadChunkBytes?: number;
  readonly notificationTtlSeconds?: number;
}

export class ReferenceRuntimeError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'INVALID_STATE'
      | 'INVALID_CREDENTIAL'
      | 'INVALID_SELECTION'
      | 'NOT_AUTHORIZED'
      | 'RECONSENT_REQUIRED'
      | 'INVALID_NOTIFICATION',
    message: string,
  ) {
    super(message);
    this.name = 'ReferenceRuntimeError';
  }
}

const exactAuthorizedScopes = new Set(['offline_access', 'files:read', 'files:write']);

const assertSimply360Credential = (installation: InstallationRegistration): void => {
  if (!installation.credential.accessToken || !installation.credential.expiresAt) {
    throw new ReferenceRuntimeError('INVALID_CREDENTIAL', 'Simply360 installation credential is incomplete.');
  }
  const scopes = new Set(installation.credential.scopes);
  if (scopes.size !== exactAuthorizedScopes.size || [...scopes].some((scope) => !exactAuthorizedScopes.has(scope))) {
    throw new ReferenceRuntimeError(
      'NOT_AUTHORIZED',
      'The reference app requires exactly offline_access, files:read, and files:write.',
    );
  }
  const callback = new URL(installation.setupCallbackUrl);
  if (
    callback.protocol !== 'https:' ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search ||
    !callback.pathname.startsWith('/v1/')
  ) {
    throw new ReferenceRuntimeError('NOT_AUTHORIZED', 'The setup callback must be an exact public Simply360 HTTPS v1 URL.');
  }
};

const selectionKey = (selection: Pick<ExplicitSelection, 'driveObjectId' | 'kind'>): string =>
  `${selection.kind}:${selection.driveObjectId}`;

const linkKey = (direction: LinkDirection, driveObjectId: string, simply360FileSimplyId: string): string =>
  `${direction}:${driveObjectId}:${simply360FileSimplyId}`;

const operationKey = (...values: readonly string[]): string => sha256Hex(values.join('\u0000'));

const assertFinitePositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
};

export class GoogleDriveReferenceRuntime {
  private readonly uploadChunkBytes: number;
  private readonly notificationTtlSeconds: number;

  constructor(
    private readonly ports: ReferenceRuntimePorts<InstallationState>,
    options: ReferenceRuntimeOptions = {},
  ) {
    this.uploadChunkBytes = options.uploadChunkBytes ?? 8 * 1024 * 1024;
    this.notificationTtlSeconds = options.notificationTtlSeconds ?? 6 * 24 * 60 * 60;
    assertFinitePositiveInteger(this.uploadChunkBytes, 'uploadChunkBytes');
    assertFinitePositiveInteger(this.notificationTtlSeconds, 'notificationTtlSeconds');
  }

  async registerInstallation(installation: InstallationRegistration): Promise<InstallationSnapshot> {
    assertSimply360Credential(installation);
    const existing = await this.ports.state.load(installation.installationSimplyId);
    if (existing) {
      if (
        existing.installation.teamSimplyId !== installation.teamSimplyId ||
        existing.installation.appVersion !== installation.appVersion ||
        existing.installation.setupCallbackUrl !== installation.setupCallbackUrl
      ) {
        throw new ReferenceRuntimeError('INVALID_STATE', 'Installation Simply ID is already bound to different authority.');
      }
      return this.snapshot(existing);
    }
    const now = this.now();
    const state: InstallationState = {
      installation,
      status: 'PENDING_SETUP',
      selections: [],
      links: [],
      notifications: [],
      pendingExports: [],
      registeredAt: now,
      updatedAt: now,
    };
    await this.ports.state.save(installation.installationSimplyId, state);
    await this.emit(state, 'installation.registered');
    return this.snapshot(state);
  }

  async connectGoogle(installationSimplyId: string, request: Parameters<typeof this.ports.google.exchangeAuthorizationCode>[0]) {
    return this.withFailureTelemetry(installationSimplyId, 'google.connect', async (state) => {
      this.assertUsableForSetup(state);
      const credential = await this.ports.google.exchangeAuthorizationCode(request);
      const granted = new Set(credential.grantedScopes);
      if (granted.size !== 1 || !granted.has(GOOGLE_DRIVE_SCOPE)) {
        await this.ports.google.revokeCredential(credential);
        throw new ReferenceRuntimeError('NOT_AUTHORIZED', `Google must grant exactly ${GOOGLE_DRIVE_SCOPE}.`);
      }
      const next = this.touch({ ...state, googleCredential: credential, googleConnectionStatus: 'ACTIVE' });
      await this.save(next);
      await this.emit(next, 'google.connected', { googleAccountSubjectHash: sha256Hex(credential.googleAccountSubject) });
      return this.snapshot(next);
    });
  }

  async createPickerSession(installationSimplyId: string): Promise<PickerSession> {
    const state = await this.requireState(installationSimplyId);
    this.assertUsableForSetup(state);
    const credential = this.requireGoogleCredential(state);
    return this.ports.google.createPickerSession(credential);
  }

  async recordPickerSelection(
    installationSimplyId: string,
    selection: PickerSelection,
    direction: LinkDirection,
  ): Promise<InstallationSnapshot> {
    return this.withFailureTelemetry(installationSimplyId, 'picker.selection', async (state) => {
      this.assertUsableForSetup(state);
      const credential = this.requireGoogleCredential(state);
      if (selection.action !== 'PICKED' || !selection.driveObjectId || !selection.name) {
        throw new ReferenceRuntimeError('INVALID_SELECTION', 'A single explicit Google Picker selection is required.');
      }
      if ('sharedDriveId' in selection) {
        throw new ReferenceRuntimeError('NOT_AUTHORIZED', 'Shared Drive selection is outside the v1 proof boundary.');
      }
      const object = await this.ports.google.getObject(credential, selection.driveObjectId);
      const expectedKind = object.mimeType === GOOGLE_FOLDER_MIME_TYPE ? 'FOLDER' : 'FILE';
      if (
        object.trashed ||
        selection.kind !== expectedKind ||
        selection.mimeType !== object.mimeType ||
        selection.name !== object.name
      ) {
        throw new ReferenceRuntimeError('INVALID_SELECTION', 'Picker selection does not match the accessible Drive object.');
      }
      if (direction === 'SOURCE' && expectedKind !== 'FILE') {
        throw new ReferenceRuntimeError('INVALID_SELECTION', 'FILE_SOURCE requires an explicitly selected file.');
      }
      if (direction === 'DESTINATION' && expectedKind !== 'FOLDER') {
        throw new ReferenceRuntimeError('INVALID_SELECTION', 'FILE_DESTINATION requires an explicitly selected folder.');
      }
      const selected: ExplicitSelection = { ...selection, selectedAt: this.now() };
      const selections = [
        ...state.selections.filter(
          (candidate) => !(selectionKey(candidate) === selectionKey(selected) && candidate.kind === selected.kind),
        ),
        selected,
      ];
      const next = this.touch({ ...state, selections });
      await this.save(next);
      await this.emit(next, 'picker.selection.recorded', {
        direction,
        driveObjectIdHash: sha256Hex(selection.driveObjectId),
        kind: selection.kind,
      });
      return this.snapshot(next);
    });
  }

  async activateInstallation(installationSimplyId: string): Promise<InstallationSnapshot> {
    return this.withFailureTelemetry(installationSimplyId, 'installation.activate', async (state) => {
      if (state.status !== 'PENDING_SETUP') {
        throw new ReferenceRuntimeError('INVALID_STATE', 'Only a PENDING_SETUP installation can be activated.');
      }
      const credential = this.requireGoogleCredential(state);
      await this.ports.simply360.completeSetup(state.installation, {
        idempotencyKey: `setup-${operationKey(state.installation.installationSimplyId, credential.googleAccountSubject)}`,
        providerAccountSubject: credential.googleAccountSubject,
      });
      const next = this.touch({ ...state, status: 'ACTIVE' });
      await this.save(next);
      await this.emit(next, 'installation.activated');
      return this.snapshot(next);
    });
  }

  async importSelectedFile(installationSimplyId: string, driveObjectId: string): Promise<ExternalFileLink> {
    return this.withFailureTelemetry(installationSimplyId, 'file.import', async (state) => {
      this.assertActive(state);
      const credential = this.requireGoogleCredential(state);
      this.requireSelection(state, driveObjectId, 'FILE');
      const object = await this.ports.google.getObject(credential, driveObjectId);
      if (object.trashed || object.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
        throw new ReferenceRuntimeError('INVALID_SELECTION', 'The selected source file is unavailable.');
      }
      const download = await this.ports.google.downloadObject(credential, driveObjectId);
      const checksum = sha256Base64(download.bytes);
      const existing = state.links.find((link) => link.direction === 'SOURCE' && link.driveObjectId === driveObjectId);
      const imported = await this.ports.simply360.importFile(state.installation, {
        name: download.name,
        contentType: download.contentType,
        bytes: download.bytes,
        checksumSha256Base64: checksum,
        idempotencyKey: `drive-import-${operationKey(installationSimplyId, driveObjectId, object.modifiedAt, checksum)}`,
        ...(existing ? { newVersionOfFileSimplyId: existing.simply360FileSimplyId } : {}),
      });
      const link = this.makeLink(state, {
        direction: 'SOURCE',
        object,
        simply360FileSimplyId: imported.fileSimplyId,
        simply360VersionNumber: imported.versionNumber,
        checksumSha256Base64: imported.checksumSha256Base64,
        existing,
      });
      const next = this.touch({ ...state, links: this.upsertLink(state.links, link) });
      await this.save(next);
      await this.emit(next, 'file.imported', {
        linkSimplyId: link.linkSimplyId,
        fileSimplyId: link.simply360FileSimplyId,
        versionNumber: link.simply360VersionNumber,
      });
      return link;
    });
  }

  async exportFile(
    installationSimplyId: string,
    input: { fileSimplyId: string; versionNumber?: number; destinationDriveFolderId: string; name?: string },
  ): Promise<ExternalFileLink> {
    return this.withFailureTelemetry(installationSimplyId, 'file.export', async (state) => {
      this.assertActive(state);
      const credential = this.requireGoogleCredential(state);
      this.requireSelection(state, input.destinationDriveFolderId, 'FOLDER');
      const destination = await this.ports.google.getObject(credential, input.destinationDriveFolderId);
      if (destination.trashed || destination.mimeType !== GOOGLE_FOLDER_MIME_TYPE) {
        throw new ReferenceRuntimeError('INVALID_SELECTION', 'The selected destination folder is unavailable.');
      }
      const file = await this.ports.simply360.downloadFile(state.installation, input.fileSimplyId, input.versionNumber);
      const checksum = sha256Base64(file.bytes);
      if (checksum !== file.checksumSha256Base64) {
        throw new ReferenceRuntimeError('INVALID_STATE', 'Simply360 download checksum did not match its public metadata.');
      }
      const key = operationKey(
        installationSimplyId,
        input.fileSimplyId,
        String(file.versionNumber),
        input.destinationDriveFolderId,
        checksum,
      );
      let pending = state.pendingExports.find((candidate) => candidate.operationKey === key);
      let workingState = state;
      if (!pending) {
        const started = await this.ports.google.beginResumableUpload(credential, {
          parentDriveObjectId: input.destinationDriveFolderId,
          name: input.name ?? file.name,
          contentType: file.contentType,
          sizeBytes: file.bytes.byteLength,
        });
        pending = {
          operationKey: key,
          uploadId: started.uploadId,
          nextOffset: started.nextOffset,
          destinationDriveFolderId: input.destinationDriveFolderId,
          simply360FileSimplyId: file.fileSimplyId,
          simply360VersionNumber: file.versionNumber,
          name: input.name ?? file.name,
          contentType: file.contentType,
          sizeBytes: file.bytes.byteLength,
          checksumSha256Base64: checksum,
        };
        workingState = this.touch({ ...state, pendingExports: [...state.pendingExports, pending] });
        await this.save(workingState);
      }
      const uploaded = await this.finishUpload(workingState, pending, credential, file.bytes);
      const refreshed = await this.requireState(installationSimplyId);
      const existing = refreshed.links.find(
        (link) => link.direction === 'DESTINATION' && link.simply360FileSimplyId === input.fileSimplyId,
      );
      const link = this.makeLink(refreshed, {
        direction: 'DESTINATION',
        object: uploaded,
        simply360FileSimplyId: file.fileSimplyId,
        simply360VersionNumber: file.versionNumber,
        checksumSha256Base64: checksum,
        existing,
      });
      const next = this.touch({
        ...refreshed,
        links: this.upsertLink(refreshed.links, link),
        pendingExports: refreshed.pendingExports.filter((candidate) => candidate.operationKey !== key),
      });
      await this.save(next);
      await this.emit(next, 'file.exported', {
        linkSimplyId: link.linkSimplyId,
        fileSimplyId: link.simply360FileSimplyId,
        versionNumber: link.simply360VersionNumber,
      });
      return link;
    });
  }

  async startChangeNotifications(installationSimplyId: string): Promise<NotificationChannel> {
    return this.withFailureTelemetry(installationSimplyId, 'notification.start', async (state) => {
      this.assertActive(state);
      const credential = this.requireGoogleCredential(state);
      const expiresAt = new Date(this.ports.clock.now().getTime() + this.notificationTtlSeconds * 1000).toISOString();
      const channel = await this.ports.google.startChangeNotifications(credential, {
        channelId: this.ports.ids.next('drive-channel'),
        channelToken: this.ports.ids.secret(32),
        expiresAt,
      });
      const next = this.touch({ ...state, notifications: [...state.notifications, { channel }] });
      await this.save(next);
      await this.emit(next, 'notification.started', { channelIdHash: sha256Hex(channel.channelId) });
      return channel;
    });
  }

  async handleChangeNotification(installationSimplyId: string, headers: NotificationHeaders): Promise<InstallationSnapshot> {
    return this.withFailureTelemetry(installationSimplyId, 'notification.handle', async (state) => {
      this.assertActive(state);
      const stored = state.notifications.find(
        ({ channel }) =>
          channel.channelId === headers.channelId &&
          channel.resourceId === headers.resourceId &&
          constantTimeEqual(channel.channelToken, headers.channelToken),
      );
      if (!stored || !/^\d+$/u.test(headers.messageNumber)) {
        throw new ReferenceRuntimeError('INVALID_NOTIFICATION', 'Google notification authority is invalid.');
      }
      if (new Date(stored.channel.expiresAt).getTime() <= this.ports.clock.now().getTime()) {
        throw new ReferenceRuntimeError('INVALID_NOTIFICATION', 'Google notification channel has expired.');
      }
      if (stored.lastMessageNumber !== undefined && BigInt(headers.messageNumber) <= BigInt(stored.lastMessageNumber)) {
        await this.emit(state, 'notification.duplicate', { messageNumber: headers.messageNumber });
        return this.snapshot(state);
      }
      const updatedNotification: StoredNotification = { channel: stored.channel, lastMessageNumber: headers.messageNumber };
      const withMessage = this.touch({
        ...state,
        notifications: state.notifications.map((candidate) => (candidate === stored ? updatedNotification : candidate)),
      });
      await this.save(withMessage);
      return this.reconcile(installationSimplyId);
    });
  }

  async reconcile(installationSimplyId: string): Promise<InstallationSnapshot> {
    return this.withFailureTelemetry(installationSimplyId, 'reconciliation', async (state) => {
      this.assertActive(state);
      const credential = this.requireGoogleCredential(state);
      const page = await this.ports.google.listChanges(credential, state.changeCursor);
      let working = state;
      let imported = 0;
      let missing = 0;
      for (const change of page.changes) {
        const link = working.links.find(
          (candidate) => candidate.direction === 'SOURCE' && candidate.driveObjectId === change.driveObjectId,
        );
        if (!link) continue;
        if (change.removed || change.object?.trashed) {
          const replacement: ExternalFileLink = { ...link, status: 'REMOTE_MISSING', updatedAt: this.now() };
          working = this.touch({ ...working, links: this.upsertLink(working.links, replacement) });
          missing += 1;
          continue;
        }
        if (change.object && change.object.modifiedAt !== link.driveModifiedAt) {
          await this.save(working);
          await this.importSelectedFile(installationSimplyId, change.driveObjectId);
          working = await this.requireState(installationSimplyId);
          imported += 1;
        }
      }
      const next = this.touch({ ...working, changeCursor: page.nextCursor });
      await this.save(next);
      await this.emit(next, 'reconciliation.completed', { imported, missing, changeCount: page.changes.length });
      return this.snapshot(next);
    });
  }

  async revokeGoogleConnection(installationSimplyId: string): Promise<InstallationSnapshot> {
    return this.withFailureTelemetry(installationSimplyId, 'google.revoke', async (state) => {
      if (state.status === 'UNINSTALLED') {
        throw new ReferenceRuntimeError('INVALID_STATE', 'Uninstalled installation has no revocable credential.');
      }
      const credential = this.requireGoogleCredential(state);
      for (const { channel } of state.notifications) {
        await this.ports.google.stopChangeNotifications(credential, channel);
      }
      await this.ports.google.revokeCredential(credential);
      await this.ports.simply360.reportProviderHealth(state.installation, {
        status: 'CREDENTIAL_REVOKED',
        reason: 'Google OAuth credential was revoked.',
      });
      const next = this.touch({
        ...state,
        googleCredential: undefined,
        googleConnectionStatus: 'REVOKED',
        notifications: [],
        links: state.links.map((link) => ({ ...link, status: 'REVOKED' as const, updatedAt: this.now() })),
      });
      await this.save(next);
      await this.emit(next, 'google.revoked');
      return this.snapshot(next);
    });
  }

  async upgrade(
    installationSimplyId: string,
    input: { toVersion: string; requestedScopes: readonly string[] },
  ): Promise<InstallationSnapshot> {
    return this.withFailureTelemetry(installationSimplyId, 'app.upgrade', async (state) => {
      this.assertActive(state);
      const requested = new Set(input.requestedScopes);
      if (
        requested.size !== exactAuthorizedScopes.size ||
        [...requested].some((scope) => !exactAuthorizedScopes.has(scope))
      ) {
        throw new ReferenceRuntimeError('RECONSENT_REQUIRED', 'Scope widening requires a new Simply360 consent operation.');
      }
      await this.ports.simply360.recordUpgrade(state.installation, {
        fromVersion: state.installation.appVersion,
        toVersion: input.toVersion,
        idempotencyKey: `upgrade-${operationKey(installationSimplyId, state.installation.appVersion, input.toVersion)}`,
      });
      const next = this.touch({
        ...state,
        installation: { ...state.installation, appVersion: input.toVersion },
      });
      await this.save(next);
      await this.emit(next, 'app.upgraded', { fromVersion: state.installation.appVersion, toVersion: input.toVersion });
      return this.snapshot(next);
    });
  }

  async suspend(installationSimplyId: string): Promise<InstallationSnapshot> {
    const state = await this.requireState(installationSimplyId);
    if (state.status !== 'ACTIVE') throw new ReferenceRuntimeError('INVALID_STATE', 'Only an ACTIVE installation can be suspended.');
    const next = this.touch({ ...state, status: 'SUSPENDED' });
    await this.save(next);
    await this.emit(next, 'installation.suspended');
    return this.snapshot(next);
  }

  async uninstall(
    installationSimplyId: string,
    deletionDecision: 'DELETE_APP_DATA' | 'RETAIN_DISCLOSED_DATA',
  ): Promise<InstallationSnapshot> {
    return this.withFailureTelemetry(installationSimplyId, 'installation.uninstall', async (state) => {
      if (state.status === 'UNINSTALLED') return this.snapshot(state);
      if (state.googleCredential) {
        for (const { channel } of state.notifications) {
          await this.ports.google.stopChangeNotifications(state.googleCredential, channel);
        }
        await this.ports.google.revokeCredential(state.googleCredential);
      }
      await this.ports.simply360.completeUninstall(state.installation, {
        idempotencyKey: `uninstall-${operationKey(installationSimplyId, deletionDecision)}`,
        deletionDecision,
      });
      const now = this.now();
      const next: InstallationState = {
        ...state,
        status: 'UNINSTALLED',
        googleCredential: undefined,
        googleConnectionStatus: state.googleConnectionStatus ? 'REVOKED' : undefined,
        selections: deletionDecision === 'DELETE_APP_DATA' ? [] : state.selections,
        links:
          deletionDecision === 'DELETE_APP_DATA'
            ? []
            : state.links.map((link) => ({ ...link, status: 'REVOKED', updatedAt: now })),
        notifications: [],
        pendingExports: [],
        updatedAt: now,
      };
      await this.save(next);
      await this.emit(next, 'installation.uninstalled', { deletionDecision });
      return this.snapshot(next);
    });
  }

  async getSnapshot(installationSimplyId: string): Promise<InstallationSnapshot> {
    return this.snapshot(await this.requireState(installationSimplyId));
  }

  private async finishUpload(
    state: InstallationState,
    pending: PendingExport,
    credential: NonNullable<InstallationState['googleCredential']>,
    bytes: Uint8Array,
  ): Promise<GoogleDriveObject> {
    let offset = pending.nextOffset;
    while (offset < bytes.byteLength) {
      const chunk = bytes.slice(offset, Math.min(offset + this.uploadChunkBytes, bytes.byteLength));
      const result = await this.ports.google.uploadChunk(credential, pending.uploadId, {
        bytes: chunk,
        offset,
        totalBytes: bytes.byteLength,
      });
      if ('driveObjectId' in result) return result;
      if (result.uploadId !== pending.uploadId || result.nextOffset <= offset || result.nextOffset > bytes.byteLength) {
        throw new ReferenceRuntimeError('INVALID_STATE', 'Google returned an invalid resumable-upload offset.');
      }
      offset = result.nextOffset;
      const updatedPending: PendingExport = { ...pending, nextOffset: offset };
      state = this.touch({
        ...state,
        pendingExports: state.pendingExports.map((candidate) =>
          candidate.operationKey === pending.operationKey ? updatedPending : candidate,
        ),
      });
      await this.save(state);
    }
    throw new ReferenceRuntimeError('INVALID_STATE', 'Google upload finished without committed object metadata.');
  }

  private makeLink(
    state: InstallationState,
    input: {
      direction: LinkDirection;
      object: GoogleDriveObject;
      simply360FileSimplyId: string;
      simply360VersionNumber: number;
      checksumSha256Base64: string;
      existing?: ExternalFileLink;
    },
  ): ExternalFileLink {
    const now = this.now();
    return {
      linkSimplyId: input.existing?.linkSimplyId ?? this.ports.ids.next('GDLK'),
      installationSimplyId: state.installation.installationSimplyId,
      direction: input.direction,
      driveObjectId: input.object.driveObjectId,
      simply360FileSimplyId: input.simply360FileSimplyId,
      simply360VersionNumber: input.simply360VersionNumber,
      driveModifiedAt: input.object.modifiedAt,
      checksumSha256Base64: input.checksumSha256Base64,
      status: 'ACTIVE',
      updatedAt: now,
    };
  }

  private upsertLink(links: readonly ExternalFileLink[], link: ExternalFileLink): readonly ExternalFileLink[] {
    const key = linkKey(link.direction, link.driveObjectId, link.simply360FileSimplyId);
    return [...links.filter((candidate) => linkKey(candidate.direction, candidate.driveObjectId, candidate.simply360FileSimplyId) !== key), link];
  }

  private requireSelection(state: InstallationState, driveObjectId: string, kind: 'FILE' | 'FOLDER'): ExplicitSelection {
    const selection = state.selections.find(
      (candidate) => candidate.driveObjectId === driveObjectId && candidate.kind === kind,
    );
    if (!selection) throw new ReferenceRuntimeError('INVALID_SELECTION', `An explicit ${kind.toLowerCase()} selection is required.`);
    return selection;
  }

  private requireGoogleCredential(state: InstallationState): NonNullable<InstallationState['googleCredential']> {
    if (!state.googleCredential || state.googleConnectionStatus !== 'ACTIVE') {
      throw new ReferenceRuntimeError('INVALID_CREDENTIAL', 'Google OAuth connection is not active.');
    }
    return state.googleCredential;
  }

  private assertUsableForSetup(state: InstallationState): void {
    if (state.status !== 'PENDING_SETUP' && state.status !== 'ACTIVE') {
      throw new ReferenceRuntimeError('INVALID_STATE', `Installation ${state.status} cannot perform setup operations.`);
    }
  }

  private assertActive(state: InstallationState): void {
    if (state.status !== 'ACTIVE') {
      throw new ReferenceRuntimeError('INVALID_STATE', 'Ordinary file operations require an ACTIVE installation.');
    }
  }

  private async requireState(installationSimplyId: string): Promise<InstallationState> {
    const state = await this.ports.state.load(installationSimplyId);
    if (!state) throw new ReferenceRuntimeError('NOT_FOUND', 'Installation was not found.');
    return state;
  }

  private snapshot(state: InstallationState): InstallationSnapshot {
    return {
      installationSimplyId: state.installation.installationSimplyId,
      teamSimplyId: state.installation.teamSimplyId,
      appVersion: state.installation.appVersion,
      status: state.status,
      googleConnectionStatus: state.googleConnectionStatus,
      selectionCount: state.selections.length,
      linkCount: state.links.length,
      notificationCount: state.notifications.length,
      changeCursor: state.changeCursor,
    };
  }

  private touch(state: InstallationState): InstallationState {
    return { ...state, updatedAt: this.now() };
  }

  private now(): string {
    return this.ports.clock.now().toISOString();
  }

  private async save(state: InstallationState): Promise<void> {
    await this.ports.state.save(state.installation.installationSimplyId, state);
  }

  private async emit(
    state: InstallationState,
    eventName: TelemetryEvent['eventName'],
    attributes: TelemetryEvent['attributes'] = {},
  ): Promise<void> {
    await this.ports.telemetry.emit({
      eventName,
      installationSimplyId: state.installation.installationSimplyId,
      occurredAt: this.now(),
      outcome: 'SUCCESS',
      attributes,
    });
  }

  private async withFailureTelemetry<T>(
    installationSimplyId: string,
    operation: string,
    execute: (state: InstallationState) => Promise<T>,
  ): Promise<T> {
    const state = await this.requireState(installationSimplyId);
    try {
      return await execute(state);
    } catch (error) {
      await this.ports.telemetry.emit({
        eventName: 'operation.failed',
        installationSimplyId,
        occurredAt: this.now(),
        outcome: 'FAILURE',
        attributes: {
          operation,
          code: error instanceof ReferenceRuntimeError ? error.code : 'PROVIDER_ERROR',
        },
      });
      throw error;
    }
  }
}
