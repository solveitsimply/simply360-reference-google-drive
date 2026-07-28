import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DeterministicIdGenerator,
  FixedClock,
  GOOGLE_DRIVE_SCOPE,
  GoogleDriveDouble,
  GoogleDriveReferenceRuntime,
  InMemoryStateStore,
  InMemoryTelemetrySink,
  ReferenceRuntimeError,
  Simply360Double,
} from '../dist/index.js';

const bytes = (value) => new TextEncoder().encode(value);

const registration = (suffix = '0001') => ({
  installationSimplyId: `INST-TEST-${suffix}`,
  teamSimplyId: `TEAM-TEST-${suffix}`,
  appVersion: '1.0.0',
  credential: {
    accessToken: `simply-access-${suffix}`,
    refreshToken: `simply-refresh-${suffix}`,
    expiresAt: '2026-07-28T13:00:00.000Z',
    scopes: ['offline_access', 'files:read', 'files:write'],
  },
  setupCallbackUrl: `https://api.dev.simply360.app/v1/integration-installations/INST-TEST-${suffix}/setup`,
});

const pickerFile = (object) => ({
  action: 'PICKED',
  driveObjectId: object.driveObjectId,
  name: object.name,
  mimeType: object.mimeType,
  kind: 'FILE',
});

const pickerFolder = (object) => ({
  action: 'PICKED',
  driveObjectId: object.driveObjectId,
  name: object.name,
  mimeType: object.mimeType,
  kind: 'FOLDER',
});

const harness = () => {
  const clock = new FixedClock();
  const ids = new DeterministicIdGenerator();
  const google = new GoogleDriveDouble(clock);
  const simply360 = new Simply360Double();
  const state = new InMemoryStateStore();
  const telemetry = new InMemoryTelemetrySink();
  const runtime = new GoogleDriveReferenceRuntime(
    { clock, ids, google, simply360, state, telemetry },
    { uploadChunkBytes: 4, maximumTransferBytes: 1_024, notificationTtlSeconds: 600 },
  );
  return { clock, google, simply360, state, telemetry, runtime };
};

const connect = async (runtime, google, install = registration(), code = 'code-1') => {
  google.authorizeCode(code, { googleAccountSubject: `subject-${install.installationSimplyId}` });
  await runtime.registerInstallation(install);
  const started = await runtime.beginGoogleConnection(install.installationSimplyId);
  await runtime.connectGoogle(install.installationSimplyId, {
    authorizationCode: code,
    state: started.state,
  });
};

describe('Google Drive reference lifecycle', () => {
  test('runs install, consent, import, export, notifications, upgrade, revocation, and uninstall', async () => {
    const { google, simply360, state, telemetry, runtime } = harness();
    const install = registration();
    const source = google.seedFile({
      driveObjectId: 'drive-source-1',
      name: 'source.txt',
      mimeType: 'text/plain',
      bytes: bytes('source-v1'),
    });
    const destination = google.seedFolder('drive-folder-1', 'Exports');
    simply360.seedFile({
      fileSimplyId: 'FILE-TEST-0001',
      name: 'export.txt',
      contentType: 'text/plain',
      bytes: bytes('export-body'),
    });

    await connect(runtime, google, install);
    const picker = await runtime.createPickerSession(install.installationSimplyId);
    assert.equal(picker.multiselect, false);
    assert.equal(picker.oauthToken, 'google-access-code-1');

    await runtime.recordPickerSelection(install.installationSimplyId, pickerFile(source), 'SOURCE');
    await runtime.recordPickerSelection(install.installationSimplyId, pickerFolder(destination), 'DESTINATION');
    await assert.rejects(
      runtime.importSelectedFile(install.installationSimplyId, source.driveObjectId),
      (error) => error instanceof ReferenceRuntimeError && error.code === 'INVALID_STATE',
    );

    const activated = await runtime.activateInstallation(install.installationSimplyId);
    assert.equal(activated.status, 'ACTIVE');
    assert.equal(simply360.setupCalls.length, 1);

    const imported = await runtime.importSelectedFile(install.installationSimplyId, source.driveObjectId);
    assert.equal(imported.direction, 'SOURCE');
    assert.equal(imported.simply360VersionNumber, 1);

    const exported = await runtime.exportFile(install.installationSimplyId, {
      fileSimplyId: 'FILE-TEST-0001',
      destinationDriveFolderId: destination.driveObjectId,
    });
    assert.equal(exported.direction, 'DESTINATION');
    assert.equal(google.objects.get(exported.driveObjectId).object.name, 'export.txt');

    const channel = await runtime.startChangeNotifications(install.installationSimplyId);
    google.mutateFile(source.driveObjectId, bytes('source-v2'));
    const reconciled = await runtime.handleChangeNotification(install.installationSimplyId, {
      channelId: channel.channelId,
      resourceId: channel.resourceId,
      channelToken: channel.channelToken,
      messageNumber: '1',
      resourceState: 'change',
    });
    assert.equal(reconciled.changeCursor, '1');
    const sourceLink = state.states
      .get(install.installationSimplyId)
      .links.find((link) => link.direction === 'SOURCE');
    assert.equal(sourceLink.simply360VersionNumber, 2);
    assert.equal(sourceLink.linkSimplyId, imported.linkSimplyId);

    const duplicate = await runtime.handleChangeNotification(install.installationSimplyId, {
      channelId: channel.channelId,
      resourceId: channel.resourceId,
      channelToken: channel.channelToken,
      messageNumber: '1',
      resourceState: 'change',
    });
    assert.equal(duplicate.changeCursor, '1');
    assert.equal(
      telemetry.events.filter((event) => event.eventName === 'notification.duplicate').length,
      1,
    );

    const upgraded = await runtime.upgrade(install.installationSimplyId, {
      toVersion: '1.1.0',
      requestedScopes: ['offline_access', 'files:read', 'files:write'],
    });
    assert.equal(upgraded.appVersion, '1.1.0');

    const revoked = await runtime.revokeGoogleConnection(install.installationSimplyId);
    assert.equal(revoked.googleConnectionStatus, 'REVOKED');
    assert.equal(simply360.healthCalls.at(-1).status, 'CREDENTIAL_REVOKED');
    assert.equal(google.channels.size, 0);

    const removed = await runtime.uninstall(install.installationSimplyId, 'DELETE_APP_DATA');
    assert.equal(removed.status, 'UNINSTALLED');
    assert.equal(removed.linkCount, 0);
    assert.equal(removed.selectionCount, 0);
    assert.equal(simply360.uninstalls.length, 1);

    const serializedTelemetry = JSON.stringify(telemetry.events);
    assert.doesNotMatch(serializedTelemetry, /google-access|google-refresh|simply-access|simply-refresh|secret-32/u);
  });

  test('resumes an interrupted Google upload without creating a second session', async () => {
    const { google, simply360, state, runtime } = harness();
    const install = registration();
    const destination = google.seedFolder('drive-folder-resume', 'Exports');
    simply360.seedFile({
      fileSimplyId: 'FILE-RESM-0001',
      name: 'resumable.txt',
      contentType: 'text/plain',
      bytes: bytes('0123456789'),
    });
    await connect(runtime, google, install);
    await runtime.recordPickerSelection(install.installationSimplyId, pickerFolder(destination), 'DESTINATION');
    await runtime.activateInstallation(install.installationSimplyId);

    google.failUploadOnceAtOffset = 4;
    await assert.rejects(
      runtime.exportFile(install.installationSimplyId, {
        fileSimplyId: 'FILE-RESM-0001',
        destinationDriveFolderId: destination.driveObjectId,
      }),
      /Injected Drive upload failure/u,
    );
    assert.equal(google.uploads.size, 1);
    assert.equal(state.states.get(install.installationSimplyId).pendingExports[0].nextOffset, 4);

    const link = await runtime.exportFile(install.installationSimplyId, {
      fileSimplyId: 'FILE-RESM-0001',
      destinationDriveFolderId: destination.driveObjectId,
    });
    assert.equal(google.uploads.size, 0);
    assert.equal(state.states.get(install.installationSimplyId).pendingExports.length, 0);
    assert.deepEqual(google.objects.get(link.driveObjectId).bytes, bytes('0123456789'));

    simply360.seedFile({
      fileSimplyId: 'FILE-RESM-0001',
      versionNumber: 2,
      name: 'resumable.txt',
      contentType: 'text/plain',
      bytes: bytes('replacement'),
    });
    const updated = await runtime.exportFile(install.installationSimplyId, {
      fileSimplyId: 'FILE-RESM-0001',
      versionNumber: 2,
      destinationDriveFolderId: destination.driveObjectId,
    });
    assert.equal(updated.linkSimplyId, link.linkSimplyId);
    assert.equal(updated.driveObjectId, link.driveObjectId);
    assert.equal(state.states.get(install.installationSimplyId).links.length, 1);
    assert.deepEqual(google.objects.get(link.driveObjectId).bytes, bytes('replacement'));
  });

  test('keeps two installation credential, link, cursor, and revocation boundaries isolated', async () => {
    const { google, simply360, state, runtime } = harness();
    const first = registration('0001');
    const second = registration('0002');
    const source = google.seedFile({
      driveObjectId: 'drive-shared-visible-object',
      name: 'source.txt',
      mimeType: 'text/plain',
      bytes: bytes('source'),
    });
    await connect(runtime, google, first, 'code-first');
    await connect(runtime, google, second, 'code-second');
    for (const install of [first, second]) {
      await runtime.recordPickerSelection(install.installationSimplyId, pickerFile(source), 'SOURCE');
      await runtime.activateInstallation(install.installationSimplyId);
      await runtime.importSelectedFile(install.installationSimplyId, source.driveObjectId);
    }
    assert.notEqual(
      state.states.get(first.installationSimplyId).links[0].linkSimplyId,
      state.states.get(second.installationSimplyId).links[0].linkSimplyId,
    );
    assert.notEqual(
      state.states.get(first.installationSimplyId).links[0].simply360FileSimplyId,
      state.states.get(second.installationSimplyId).links[0].simply360FileSimplyId,
    );

    await runtime.revokeGoogleConnection(first.installationSimplyId);
    await assert.rejects(runtime.importSelectedFile(first.installationSimplyId, source.driveObjectId), /not active/u);
    const siblingLink = await runtime.importSelectedFile(second.installationSimplyId, source.driveObjectId);
    assert.equal(siblingLink.status, 'ACTIVE');
    assert.equal(simply360.healthCalls.length, 1);
  });
});

describe('scope, selection, notification, and lifecycle fences', () => {
  test('rejects broad Google scope and revokes the over-scoped credential', async () => {
    const { google, runtime } = harness();
    const install = registration();
    google.authorizeCode('broad', {
      grantedScopes: [GOOGLE_DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive'],
      googleAccountSubject: 'broad-subject',
    });
    await runtime.registerInstallation(install);
    const started = await runtime.beginGoogleConnection(install.installationSimplyId);
    await assert.rejects(
      runtime.connectGoogle(install.installationSimplyId, {
        authorizationCode: 'broad',
        state: started.state,
      }),
      (error) => error instanceof ReferenceRuntimeError && error.code === 'NOT_AUTHORIZED',
    );
    assert.equal(google.revokedSubjects.has('broad-subject'), true);
  });

  test('requires offline refresh authority and revokes an incomplete Google grant', async () => {
    const { google, runtime } = harness();
    const install = registration();
    const credential = google.authorizeCode('online-only', {
      refreshToken: undefined,
      googleAccountSubject: 'online-only-subject',
    });
    credential.refreshToken = undefined;
    await runtime.registerInstallation(install);
    const started = await runtime.beginGoogleConnection(install.installationSimplyId);
    await assert.rejects(
      runtime.connectGoogle(install.installationSimplyId, {
        authorizationCode: 'online-only',
        state: started.state,
      }),
      /offline refresh authority/u,
    );
    assert.equal(google.revokedSubjects.has('online-only-subject'), true);
  });

  test('rejects OAuth state mix-up, expiry, and replay before exchanging the code', async () => {
    const { clock, google, runtime } = harness();
    const install = registration();
    google.authorizeCode('state-code');
    await runtime.registerInstallation(install);
    const started = await runtime.beginGoogleConnection(install.installationSimplyId);
    const authorizationUrl = new URL(started.authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get('scope'), GOOGLE_DRIVE_SCOPE);
    assert.equal(authorizationUrl.searchParams.get('state'), started.state);
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    await assert.rejects(
      runtime.connectGoogle(install.installationSimplyId, {
        authorizationCode: 'state-code',
        state: `${started.state}-forged`,
      }),
      /state is missing, expired, or invalid/u,
    );
    clock.advance(601_000);
    await assert.rejects(
      runtime.connectGoogle(install.installationSimplyId, {
        authorizationCode: 'state-code',
        state: started.state,
      }),
      /state is missing, expired, or invalid/u,
    );

    const restarted = await runtime.beginGoogleConnection(install.installationSimplyId);
    await runtime.connectGoogle(install.installationSimplyId, {
      authorizationCode: 'state-code',
      state: restarted.state,
    });
    await assert.rejects(
      runtime.connectGoogle(install.installationSimplyId, {
        authorizationCode: 'state-code',
        state: restarted.state,
      }),
      /state is missing, expired, or invalid/u,
    );
  });

  test('requires explicit revocation before reconnecting and clears old account authority', async () => {
    const { google, runtime } = harness();
    const install = registration();
    const oldFile = google.seedFile({
      driveObjectId: 'drive-old-account-file',
      name: 'old.txt',
      mimeType: 'text/plain',
      bytes: bytes('old'),
    });
    await connect(runtime, google, install, 'old-account');
    await runtime.recordPickerSelection(install.installationSimplyId, pickerFile(oldFile), 'SOURCE');
    await runtime.activateInstallation(install.installationSimplyId);
    await assert.rejects(
      runtime.beginGoogleConnection(install.installationSimplyId),
      /Revoke the active Google connection/u,
    );
    const revoked = await runtime.revokeGoogleConnection(install.installationSimplyId);
    assert.equal(revoked.selectionCount, 0);
    assert.equal(revoked.changeCursor, undefined);

    google.authorizeCode('new-account', { googleAccountSubject: 'new-account-subject' });
    const restarted = await runtime.beginGoogleConnection(install.installationSimplyId);
    const reconnected = await runtime.connectGoogle(install.installationSimplyId, {
      authorizationCode: 'new-account',
      state: restarted.state,
    });
    assert.equal(reconnected.googleConnectionStatus, 'ACTIVE');
    await assert.rejects(
      runtime.importSelectedFile(install.installationSimplyId, oldFile.driveObjectId),
      /explicit file selection/u,
    );
  });

  test('rejects shared-drive, folder-as-source, file-as-destination, and unselected objects', async () => {
    const { google, runtime } = harness();
    const install = registration();
    const file = google.seedFile({
      driveObjectId: 'drive-file',
      name: 'file.txt',
      mimeType: 'text/plain',
      bytes: bytes('file'),
    });
    const folder = google.seedFolder('drive-folder', 'Folder');
    await connect(runtime, google, install);
    await assert.rejects(
      runtime.recordPickerSelection(install.installationSimplyId, { ...pickerFile(file), sharedDriveId: 'shared' }, 'SOURCE'),
      /Shared Drive/u,
    );
    await assert.rejects(
      runtime.recordPickerSelection(install.installationSimplyId, pickerFolder(folder), 'SOURCE'),
      /FILE_SOURCE/u,
    );
    await assert.rejects(
      runtime.recordPickerSelection(install.installationSimplyId, pickerFile(file), 'DESTINATION'),
      /FILE_DESTINATION/u,
    );
    await runtime.activateInstallation(install.installationSimplyId);
    await assert.rejects(runtime.importSelectedFile(install.installationSimplyId, file.driveObjectId), /explicit file selection/u);
  });

  test('rejects forged and expired notifications without advancing the cursor', async () => {
    const { clock, google, runtime } = harness();
    const install = registration();
    await connect(runtime, google, install);
    await runtime.activateInstallation(install.installationSimplyId);
    const channel = await runtime.startChangeNotifications(install.installationSimplyId);
    await assert.rejects(
      runtime.handleChangeNotification(install.installationSimplyId, {
        channelId: channel.channelId,
        resourceId: channel.resourceId,
        channelToken: `${channel.channelToken}-forged`,
        messageNumber: '1',
        resourceState: 'change',
      }),
      (error) => error instanceof ReferenceRuntimeError && error.code === 'INVALID_NOTIFICATION',
    );
    clock.advance(601_000);
    await assert.rejects(
      runtime.handleChangeNotification(install.installationSimplyId, {
        channelId: channel.channelId,
        resourceId: channel.resourceId,
        channelToken: channel.channelToken,
        messageNumber: '1',
        resourceState: 'change',
      }),
      /expired/u,
    );
    assert.equal((await runtime.getSnapshot(install.installationSimplyId)).changeCursor, undefined);
  });

  test('leaves a failed notification message retryable until reconciliation succeeds', async () => {
    const { google, simply360, state, runtime } = harness();
    const install = registration();
    const source = google.seedFile({
      driveObjectId: 'drive-notification-retry',
      name: 'retry.txt',
      mimeType: 'text/plain',
      bytes: bytes('v1'),
    });
    await connect(runtime, google, install);
    await runtime.recordPickerSelection(install.installationSimplyId, pickerFile(source), 'SOURCE');
    await runtime.activateInstallation(install.installationSimplyId);
    await runtime.importSelectedFile(install.installationSimplyId, source.driveObjectId);
    const channel = await runtime.startChangeNotifications(install.installationSimplyId);
    google.mutateFile(source.driveObjectId, bytes('v2'));
    simply360.failNextImport = true;
    const notification = {
      channelId: channel.channelId,
      resourceId: channel.resourceId,
      channelToken: channel.channelToken,
      messageNumber: '7',
      resourceState: 'change',
    };
    await assert.rejects(
      runtime.handleChangeNotification(install.installationSimplyId, notification),
      /Injected Simply360 import failure/u,
    );
    assert.equal(state.states.get(install.installationSimplyId).notifications[0].lastMessageNumber, undefined);
    assert.equal(state.states.get(install.installationSimplyId).changeCursor, undefined);

    const recovered = await runtime.handleChangeNotification(install.installationSimplyId, notification);
    assert.equal(recovered.changeCursor, '1');
    assert.equal(state.states.get(install.installationSimplyId).notifications[0].lastMessageNumber, '7');
    assert.equal(state.states.get(install.installationSimplyId).links[0].simply360VersionNumber, 2);
  });

  test('requires re-consent for widening and blocks ordinary use while suspended', async () => {
    const { google, runtime } = harness();
    const install = registration();
    await connect(runtime, google, install);
    await runtime.activateInstallation(install.installationSimplyId);
    await assert.rejects(
      runtime.upgrade(install.installationSimplyId, {
        toVersion: '2.0.0',
        requestedScopes: ['offline_access', 'files:read', 'files:write', 'records:read'],
      }),
      (error) => error instanceof ReferenceRuntimeError && error.code === 'RECONSENT_REQUIRED',
    );
    const suspended = await runtime.suspend(install.installationSimplyId);
    assert.equal(suspended.status, 'SUSPENDED');
    await assert.rejects(runtime.startChangeNotifications(install.installationSimplyId), /ACTIVE/u);
    const uninstalled = await runtime.uninstall(install.installationSimplyId, 'RETAIN_DISCLOSED_DATA');
    assert.equal(uninstalled.status, 'UNINSTALLED');
    assert.equal((await runtime.uninstall(install.installationSimplyId, 'RETAIN_DISCLOSED_DATA')).status, 'UNINSTALLED');
  });

  test('marks a removed remote source without deleting the Simply360 copy', async () => {
    const { google, simply360, state, runtime } = harness();
    const install = registration();
    const source = google.seedFile({
      driveObjectId: 'drive-delete',
      name: 'source.txt',
      mimeType: 'text/plain',
      bytes: bytes('source'),
    });
    await connect(runtime, google, install);
    await runtime.recordPickerSelection(install.installationSimplyId, pickerFile(source), 'SOURCE');
    await runtime.activateInstallation(install.installationSimplyId);
    const imported = await runtime.importSelectedFile(install.installationSimplyId, source.driveObjectId);
    google.removeFile(source.driveObjectId);
    await runtime.reconcile(install.installationSimplyId);
    assert.equal(state.states.get(install.installationSimplyId).links[0].status, 'REMOTE_MISSING');
    assert.equal(simply360.files.has(imported.simply360FileSimplyId), true);
  });

  test('bounds transfer size and reconciliation work before retaining data', async () => {
    const { google, state, runtime } = harness();
    const install = registration();
    const large = google.seedFile({
      driveObjectId: 'drive-large',
      name: 'large.bin',
      mimeType: 'application/octet-stream',
      bytes: new Uint8Array(1_025),
    });
    await connect(runtime, google, install);
    await runtime.recordPickerSelection(install.installationSimplyId, pickerFile(large), 'SOURCE');
    await runtime.activateInstallation(install.installationSimplyId);
    await assert.rejects(runtime.importSelectedFile(install.installationSimplyId, large.driveObjectId), /transfer limit/u);
    assert.equal(state.states.get(install.installationSimplyId).links.length, 0);
  });
});
