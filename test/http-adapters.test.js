import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  FixedClock,
  GOOGLE_DRIVE_SCOPE,
  GoogleDriveHttpClient,
  Simply360PublicFilePort,
  sha256Base64,
} from '../dist/index.js';

const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

const installation = {
  installationSimplyId: 'INST-TEST-HTTP',
  teamSimplyId: 'TEAM-TEST-HTTP',
  appVersion: '1.0.0',
  credential: {
    accessToken: 'simply-access-http',
    expiresAt: '2026-07-28T13:00:00.000Z',
    scopes: ['offline_access', 'files:read', 'files:write'],
  },
  setupCallbackUrl: 'https://api.dev.simply360.app/v1/integration-installations/INST-TEST-HTTP/setup',
};

describe('Google public HTTP adapter', () => {
  test('constructs an exact state-bound, PKCE, least-privilege authorization request', () => {
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
    });
    const state = 's'.repeat(43);
    const authorization = new URL(
      client.createAuthorizationUrl({
        state,
        codeChallenge: 'c'.repeat(43),
        redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      }),
    );
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
    assert.equal(authorization.searchParams.get('client_id'), 'client-id');
    assert.equal(
      authorization.searchParams.get('redirect_uri'),
      'https://reference-drive.dev.example/oauth/google/callback',
    );
    assert.equal(authorization.searchParams.get('scope'), GOOGLE_DRIVE_SCOPE);
    assert.equal(authorization.searchParams.get('state'), state);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('access_type'), 'offline');
    assert.equal(authorization.searchParams.get('include_granted_scopes'), 'false');
    assert.equal(authorization.searchParams.get('prompt'), 'consent');
  });

  test('exchanges a PKCE code, checks the exact scope, and binds the account subject', async () => {
    const calls = [];
    const responses = [
      json({
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        expires_in: 3600,
        scope: GOOGLE_DRIVE_SCOPE,
        token_type: 'Bearer',
      }),
      json({ user: { permissionId: 'google-permission-subject' } }),
    ];
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      clock: new FixedClock(),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return responses.shift();
      },
    });
    const credential = await client.exchangeAuthorizationCode({
      authorizationCode: 'authorization-code',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      codeVerifier: 'x'.repeat(43),
    });
    assert.equal(credential.googleAccountSubject, 'google-permission-subject');
    assert.deepEqual(credential.grantedScopes, [GOOGLE_DRIVE_SCOPE]);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(calls[0].init.redirect, 'error');
    assert.match(String(calls[0].init.body), /grant_type=authorization_code/u);
    assert.match(String(calls[0].init.body), /code_verifier=/u);
    assert.equal(calls[1].init.headers.authorization, 'Bearer google-access');
  });

  test('revokes an over-scoped exchange before rejecting it', async () => {
    const calls = [];
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return json({
            access_token: 'google-access',
            expires_in: 3600,
            scope: `${GOOGLE_DRIVE_SCOPE} https://www.googleapis.com/auth/drive`,
            token_type: 'Bearer',
          });
        }
        return new Response(null, { status: 200 });
      },
    });
    await assert.rejects(
      client.exchangeAuthorizationCode({
        authorizationCode: 'authorization-code',
        redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
        codeVerifier: 'x'.repeat(43),
      }),
      /scope must be exactly/u,
    );
    assert.equal(calls[1].url, 'https://oauth2.googleapis.com/revoke');
    assert.match(String(calls[1].init.body), /token=google-access/u);
  });

  test('exports native Google documents and rejects an untrusted resumable upload location', async () => {
    const calls = [];
    const credential = {
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      expiresAt: '2099-01-01T00:00:00.000Z',
      grantedScopes: [GOOGLE_DRIVE_SCOPE],
      googleAccountSubject: 'subject',
    };
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return json({
            id: 'native-doc',
            name: 'Report',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '2026-07-28T12:00:00.000Z',
            trashed: false,
          });
        }
        if (calls.length === 2) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        return new Response(null, { status: 200, headers: { location: 'https://attacker.example/upload' } });
      },
    });
    const download = await client.downloadObject(credential, 'native-doc');
    assert.equal(download.name, 'Report.pdf');
    assert.equal(download.contentType, 'application/pdf');
    assert.match(calls[1].url, /\/export\?mimeType=application%2Fpdf$/u);

    await assert.rejects(
      client.beginResumableUpload(credential, {
        parentDriveObjectId: 'folder',
        name: 'file.txt',
        contentType: 'text/plain',
        sizeBytes: 3,
      }),
      /untrusted Location/u,
    );
  });

  test('isolates refreshed tokens by credential family even when account subjects match', async () => {
    const refreshes = [];
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      clock: new FixedClock(),
      fetch: async (_url, init) => {
        const refreshToken = new URLSearchParams(String(init.body)).get('refresh_token');
        refreshes.push(refreshToken);
        return json({
          access_token: `refreshed-${refreshToken}`,
          expires_in: 3600,
          scope: GOOGLE_DRIVE_SCOPE,
          token_type: 'Bearer',
        });
      },
    });
    const base = {
      accessToken: 'expired',
      expiresAt: '2026-07-28T11:00:00.000Z',
      grantedScopes: [GOOGLE_DRIVE_SCOPE],
      googleAccountSubject: 'same-subject',
    };
    const first = await client.createPickerSession({ ...base, refreshToken: 'refresh-one' });
    const second = await client.createPickerSession({ ...base, refreshToken: 'refresh-two' });
    assert.equal(first.oauthToken, 'refreshed-refresh-one');
    assert.equal(second.oauthToken, 'refreshed-refresh-two');
    assert.deepEqual(refreshes, ['refresh-one', 'refresh-two']);
  });

  test('bounds Google downloads and direct resumable-upload input', async () => {
    const credential = {
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      expiresAt: '2099-01-01T00:00:00.000Z',
      grantedScopes: [GOOGLE_DRIVE_SCOPE],
      googleAccountSubject: 'subject',
    };
    let call = 0;
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      maximumDownloadBytes: 2,
      maximumUploadChunkBytes: 2,
      maximumUploadBytes: 3,
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return json({
            id: 'file',
            name: 'file.bin',
            mimeType: 'application/octet-stream',
            size: '3',
            modifiedTime: '2026-07-28T12:00:00.000Z',
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    });
    await assert.rejects(client.downloadObject(credential, 'file'), /configured byte limit/u);
    await assert.rejects(
      client.uploadChunk(credential, 'https://www.googleapis.com/upload/session', {
        bytes: new Uint8Array([1, 2, 3]),
        offset: 0,
        totalBytes: 3,
      }),
      /configured byte and offset limits/u,
    );
    await assert.rejects(
      client.beginResumableUpload(credential, {
        parentDriveObjectId: 'folder',
        name: 'file.bin',
        contentType: 'application/octet-stream',
        sizeBytes: 4,
      }),
      /configured byte limit/u,
    );
  });

  test('pins notification authority and returns only a terminal Drive change cursor', async () => {
    const calls = [];
    const expiresAt = '2026-07-28T12:10:00.000Z';
    const responses = [
      json({ startPageToken: 'cursor-start' }),
      json({
        id: 'channel-one',
        resourceId: 'resource-one',
        expiration: String(new Date(expiresAt).getTime()),
      }),
      json({
        changes: [
          {
            fileId: 'drive-file-one',
            removed: false,
            file: {
              id: 'drive-file-one',
              name: 'file.txt',
              mimeType: 'text/plain',
              size: '4',
              modifiedTime: '2026-07-28T12:01:00.000Z',
              trashed: false,
            },
          },
        ],
        newStartPageToken: 'cursor-finish',
      }),
    ];
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
      redirectUri: 'https://reference-drive.dev.example/oauth/google/callback',
      clock: new FixedClock(),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return responses.shift();
      },
    });
    const credential = {
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      expiresAt: '2099-01-01T00:00:00.000Z',
      grantedScopes: [GOOGLE_DRIVE_SCOPE],
      googleAccountSubject: 'subject',
    };
    const channel = await client.startChangeNotifications(credential, {
      channelId: 'channel-one',
      channelToken: 'channel-secret',
      expiresAt,
    });
    assert.equal(channel.resourceId, 'resource-one');
    const watchBody = JSON.parse(String(calls[1].init.body));
    assert.equal(watchBody.address, 'https://reference-drive.dev.example/google/drive/notifications');
    assert.equal(watchBody.payload, false);

    const page = await client.listChanges(credential, 'cursor-start');
    assert.equal(page.nextCursor, 'cursor-finish');
    assert.equal(page.changes[0].driveObjectId, 'drive-file-one');
    assert.match(calls[2].url, /supportsAllDrives=false/u);
    assert.match(calls[2].url, /includeItemsFromAllDrives=false/u);
  });
});

describe('Simply360 public file adapter', () => {
  test('uses only the public upload intent, presigned body, and completion surfaces', async () => {
    const calls = [];
    const inputBytes = new TextEncoder().encode('hello');
    const lifecycle = {
      async completeSetup() {},
      async reportProviderHealth() {},
      async recordUpgrade() {},
      async completeUninstall() {},
    };
    const client = new Simply360PublicFilePort({
      apiBaseUrl: 'https://api.dev.simply360.app',
      trustedTransferOrigins: ['https://synthetic-upload.example'],
      lifecycle,
      completionPollDelayMs: 0,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return json(
            {
              data: {
                fileUploadSimplyId: 'UPLD-TEST-0001',
                status: 'PENDING_UPLOAD',
                upload: {
                  method: 'POST',
                  url: 'https://synthetic-upload.example/',
                  fields: { key: 'quarantine/object', policy: 'opaque-policy' },
                },
              },
            },
            { status: 201 },
          );
        }
        if (calls.length === 2) return new Response(null, { status: 204 });
        return json({
          data: {
            fileUploadSimplyId: 'UPLD-TEST-0001',
            status: 'COMPLETED',
            fileSimplyId: 'FILE-TEST-0001',
            versionNumber: 1,
          },
        });
      },
    });
    const result = await client.importFile(installation, {
      name: 'hello.txt',
      contentType: 'text/plain',
      bytes: inputBytes,
      checksumSha256Base64: sha256Base64(inputBytes),
      idempotencyKey: 'import-idempotency-key',
    });
    assert.equal(result.fileSimplyId, 'FILE-TEST-0001');
    assert.equal(calls[0].url, 'https://api.dev.simply360.app/v1/file-uploads');
    assert.equal(calls[0].init.headers.authorization, 'Bearer simply-access-http');
    assert.equal(calls[0].init.headers['idempotency-key'], 'import-idempotency-key');
    assert.equal(calls[1].url, 'https://synthetic-upload.example/');
    assert.equal(calls[1].init.headers, undefined);
    assert.ok(calls[1].init.body instanceof FormData);
    assert.equal(
      calls[2].url,
      'https://api.dev.simply360.app/v1/file-uploads/UPLD-TEST-0001/complete',
    );
  });

  test('downloads an exact public file version and does not forward the bearer token to its signed URL', async () => {
    const calls = [];
    const lifecycle = {
      async completeSetup() {},
      async reportProviderHealth() {},
      async recordUpgrade() {},
      async completeUninstall() {},
    };
    const client = new Simply360PublicFilePort({
      apiBaseUrl: 'https://api.dev.simply360.app',
      trustedTransferOrigins: ['https://synthetic-download.example'],
      lifecycle,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return json({ data: { url: 'https://synthetic-download.example/file', filename: 'file.txt' } });
        }
        return new Response(new TextEncoder().encode('body'), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      },
    });
    const file = await client.downloadFile(installation, 'FILE-TEST-0001', 3);
    assert.equal(file.versionNumber, 3);
    assert.equal(file.name, 'file.txt');
    assert.equal(new TextDecoder().decode(file.bytes), 'body');
    assert.equal(
      calls[0].url,
      'https://api.dev.simply360.app/v1/files/FILE-TEST-0001/versions/3/download',
    );
    assert.equal(calls[1].init.headers, undefined);
  });

  test('rejects signed transfer URLs outside the allowlist and bounds accepted downloads', async () => {
    const lifecycle = {
      async completeSetup() {},
      async reportProviderHealth() {},
      async recordUpgrade() {},
      async completeUninstall() {},
    };
    const untrusted = new Simply360PublicFilePort({
      apiBaseUrl: 'https://api.dev.simply360.app',
      trustedTransferOrigins: ['https://synthetic-download.example'],
      lifecycle,
      fetch: async () => json({ data: { url: 'https://attacker.example/file' } }),
    });
    await assert.rejects(
      untrusted.downloadFile(installation, 'FILE-TEST-0001'),
      /outside the trusted transfer origins/u,
    );

    let call = 0;
    const bounded = new Simply360PublicFilePort({
      apiBaseUrl: 'https://api.dev.simply360.app',
      trustedTransferOrigins: ['https://synthetic-download.example'],
      maximumTransferBytes: 3,
      lifecycle,
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return json({ data: { url: 'https://synthetic-download.example/file' } });
        }
        return new Response(new TextEncoder().encode('four'), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      },
    });
    await assert.rejects(
      bounded.downloadFile(installation, 'FILE-TEST-0001'),
      /configured byte limit/u,
    );
  });
});
