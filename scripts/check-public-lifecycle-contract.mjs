import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const EXPECTED_SOURCE =
  '3ea2dc53020c00720446a5c86867e3d78e05328b9849e4dfbf05669288268a98';
const EXPECTED_VARIANTS =
  'a8a2059cd54b649fd2a16967d7b64a41e7e9554ad144ffadeb0210e5df3a428b';
const snapshot = JSON.parse(
  await readFile('src/public-contracts/lifecycle-occurrence-v1.json', 'utf8'),
);
if (
  snapshot?.schemaVersion !== 'simply360.public-contract-snapshot/v1' ||
  snapshot?.source?.id !==
    'https://schemas.simply360.app/app-platform/v1/event-occurrence-v1.schema.json' ||
  snapshot?.source?.sha256 !== EXPECTED_SOURCE ||
  !Array.isArray(snapshot.variants) ||
  !Array.isArray(snapshot.selectedEventTypes)
) {
  throw new Error('public lifecycle snapshot provenance is invalid');
}
const eventTypes = snapshot.variants.map(
  (variant) => variant?.properties?.eventType?.const,
);
const digest = createHash('sha256')
  .update(JSON.stringify(snapshot.variants))
  .digest('hex');
if (
  JSON.stringify(eventTypes) !== JSON.stringify(snapshot.selectedEventTypes) ||
  digest !== snapshot.selectedVariantsSha256 ||
  digest !== EXPECTED_VARIANTS
) {
  throw new Error('public lifecycle snapshot differs from the reviewed variants');
}
console.log(
  `Public lifecycle contract passed (${eventTypes.length} variants, source ${EXPECTED_SOURCE}).`,
);
