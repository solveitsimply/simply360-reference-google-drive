import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeProof,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_FOLDER_MIME_TYPE,
  PROOF_SCENARIOS,
} from '../dist/index.js';

test('proof descriptor names the complete mock-ready lifecycle', () => {
  const info = describeProof();
  assert.deepEqual([...info.provenCapabilities].sort(), ['FILE_DESTINATION', 'FILE_SOURCE']);
  assert.deepEqual(info.scenarios, PROOF_SCENARIOS);
  assert.equal(info.primaryStorage, false);
});

test('proof is restricted to drive.file and distinguishes folders', () => {
  assert.equal(GOOGLE_DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(GOOGLE_FOLDER_MIME_TYPE, 'application/vnd.google-apps.folder');
});
