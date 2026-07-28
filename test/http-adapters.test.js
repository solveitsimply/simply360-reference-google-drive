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
  test('exchanges a PKCE code, checks the exact scope, and binds the account subject', async () => {
    const calls = [];
    const responses = [
      json({
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        expires_in: 3600,
        scope: GOOGLE_DRIVE_SCOPE,
      }),
      json({ user: { permissionId: 'google-permission-subject' } }),
    ];
    const client = new GoogleDriveHttpClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      pickerAppId: 'picker-app',
      pickerDeveloperKey: 'picker-key',
      publicOrigin: 'https://reference-drive.dev.example',
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
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return json({
            access_token: 'google-access',
            expires_in: 3600,
            scope: `${GOOGLE_DRIVE_SCOPE} https://www.googleapis.com/auth/drive`,
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
});
