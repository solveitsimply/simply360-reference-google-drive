// Scaffold smoke test — verifies the placeholder descriptor is well-formed.
// Runs against the compiled ESM output in dist/ (npm test builds first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProof, GOOGLE_DRIVE_SCOPE } from '../dist/index.js';

test('proof descriptor names both mandatory file capabilities', () => {
  const info = describeProof();
  assert.deepEqual([...info.provenCapabilities].sort(), ['FILE_DESTINATION', 'FILE_SOURCE']);
});

test('proof is restricted to the non-sensitive drive.file scope', () => {
  assert.equal(GOOGLE_DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
});
