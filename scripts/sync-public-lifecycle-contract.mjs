import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const EVENT_TYPES = [
  'app.suspended',
  'app.grant.revoked',
  'app.uninstalled',
  'app.dataExport.requested',
  'app.dataDeletion.requested',
];

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error(
    'Usage: node scripts/sync-public-lifecycle-contract.mjs <event-occurrence-v1.schema.json>',
  );
}
const bytes = await readFile(resolve(sourcePath));
const source = JSON.parse(bytes.toString('utf8'));
if (
  source?.$id !==
    'https://schemas.simply360.app/app-platform/v1/event-occurrence-v1.schema.json' ||
  !Array.isArray(source.anyOf)
) {
  throw new Error('input is not the authoritative public event occurrence schema');
}
const variants = EVENT_TYPES.map((eventType) => {
  const matches = source.anyOf.filter(
    (variant) => variant?.properties?.eventType?.const === eventType,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one public variant for ${eventType}`);
  }
  return matches[0];
});
const snapshot = {
  schemaVersion: 'simply360.public-contract-snapshot/v1',
  source: {
    id: source.$id,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  },
  selectedEventTypes: EVENT_TYPES,
  selectedVariantsSha256: createHash('sha256')
    .update(JSON.stringify(variants))
    .digest('hex'),
  variants,
};
await writeFile(
  resolve('src/public-contracts/lifecycle-occurrence-v1.json'),
  `${JSON.stringify(snapshot, null, 2)}\n`,
);
