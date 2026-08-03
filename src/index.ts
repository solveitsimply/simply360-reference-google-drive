export * from './config.js';
export * from './aws.js';
export * from './aws-state.js';
export * from './contracts.js';
export * from './crypto.js';
export * from './doubles.js';
export * from './google-http.js';
export * from './ports.js';
export * from './runtime.js';
export * from './router.js';
export * from './public-lifecycle-contract.js';
export * from './webhook-v2.js';
export * from './simply360-http.js';
export * from './state.js';

import { GOOGLE_DRIVE_SCOPE, PROOF_SCENARIOS, type ReferenceAppInfo } from './contracts.js';

export const referenceApp: ReferenceAppInfo = {
  name: 'simply360-reference-google-drive',
  provenCapabilities: ['FILE_SOURCE', 'FILE_DESTINATION'],
  googleScope: GOOGLE_DRIVE_SCOPE,
  scenarios: PROOF_SCENARIOS,
  primaryStorage: false,
};

export function describeProof(): ReferenceAppInfo {
  return referenceApp;
}
