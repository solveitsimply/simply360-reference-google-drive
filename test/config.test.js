import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GOOGLE_DRIVE_SCOPE, loadReferenceAppConfig } from '../dist/index.js';

const valid = () => ({
  REFERENCE_ENVIRONMENT: 'test',
  SIMPLY360_API_BASE_URL: 'https://api.dev.simply360.app',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_PICKER_APP_ID: 'picker-app-id',
  GOOGLE_PICKER_DEVELOPER_KEY: 'picker-developer-key',
  PUBLIC_ORIGIN: 'https://reference-drive.dev.example',
});

test('loads an exact dev/test configuration with conservative defaults', () => {
  const config = loadReferenceAppConfig(valid());
  assert.equal(config.googleScope, GOOGLE_DRIVE_SCOPE);
  assert.equal(config.uploadChunkBytes, 8 * 1024 * 1024);
  assert.equal(config.notificationTtlSeconds, 6 * 24 * 60 * 60);
});

test('rejects production, broader scopes, URL credentials, and non-origin URLs', () => {
  assert.throws(() => loadReferenceAppConfig({ ...valid(), REFERENCE_ENVIRONMENT: 'production' }), /dev or test/u);
  assert.throws(
    () => loadReferenceAppConfig({ ...valid(), GOOGLE_OAUTH_SCOPE: 'https://www.googleapis.com/auth/drive' }),
    /Only .*drive\.file/u,
  );
  assert.throws(
    () => loadReferenceAppConfig({ ...valid(), SIMPLY360_API_BASE_URL: 'https://user:pass@api.dev.simply360.app' }),
    /exact HTTPS origin/u,
  );
  assert.throws(
    () => loadReferenceAppConfig({ ...valid(), PUBLIC_ORIGIN: 'https://reference-drive.dev.example/path' }),
    /exact HTTPS origin/u,
  );
});

test('fails closed when any credential-bearing setting is absent', () => {
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_PICKER_APP_ID', 'GOOGLE_PICKER_DEVELOPER_KEY']) {
    const environment = valid();
    delete environment[key];
    assert.throws(() => loadReferenceAppConfig(environment), new RegExp(`Missing required configuration: ${key}`));
  }
});
