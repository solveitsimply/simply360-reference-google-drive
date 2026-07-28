import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('renders source-bound manifest, Blueprint package, and exact checksums', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reference-drive-artifacts-'));
  execFileSync(
    process.execPath,
    ['scripts/render-artifacts.mjs', '--source-commit', sourceCommit, '--output', directory],
    { cwd: root, stdio: 'pipe' },
  );
  const manifestText = await readFile(join(directory, 'app-manifest.json'), 'utf8');
  const blueprintText = await readFile(join(directory, 'drive-file-links.package.json'), 'utf8');
  const checksums = JSON.parse(await readFile(join(directory, 'checksums.json'), 'utf8'));
  const manifest = JSON.parse(manifestText);
  const blueprint = JSON.parse(blueprintText);

  assert.equal(manifest.schemaVersion, 'simply360.app-manifest/v1');
  assert.equal(manifest.provenance.sourceCommit, sourceCommit);
  assert.deepEqual(
    manifest.capabilities.map(({ capabilityKey }) => capabilityKey),
    ['FILE_SOURCE', 'FILE_DESTINATION', 'EXTERNAL_BLUEPRINT_PACKAGE'],
  );
  assert.deepEqual(manifest.oauth.clients[0].scopes, ['offline_access', 'files:read', 'files:write']);
  assert.equal(manifest.blueprintPackages[0].sha256, sha256(blueprintText));
  assert.equal(blueprint.provenance.sourceCommit, sourceCommit);
  assert.equal(blueprint.definitionSha256, sha256(JSON.stringify(canonicalize(blueprint.definition))));
  assert.equal(checksums.sourceCommit, sourceCommit);
  assert.equal(checksums.artifacts.find(({ path }) => path === 'app-manifest.json').sha256, sha256(manifestText));
  assert.doesNotMatch(`${manifestText}${blueprintText}`, /__[A-Z_]+__/u);
});

test('artifact rendering rejects non-SHA provenance', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/render-artifacts.mjs', '--source-commit', 'dev'], {
        cwd: root,
        stdio: 'pipe',
      }),
    /Command failed/u,
  );
});

test('templates stay declarative and contain no executable Blueprint nodes', async () => {
  const blueprint = JSON.parse(await readFile(join(root, 'blueprints/drive-file-links.package.template.json'), 'utf8'));
  const serialized = JSON.stringify(blueprint);
  for (const forbidden of ['automations', 'wizards', 'messageTemplates', 'actionTags', 'seedData', 'rawSql', 'javascript']) {
    assert.doesNotMatch(serialized, new RegExp(`"${forbidden}"`, 'iu'));
  }
  assert.deepEqual(blueprint.definition.lifecycle, [
    {
      resourceType: 'COLLECTION',
      collectionKey: 'drive-file-link',
      owner: 'INTEGRATION',
      uninstallBehavior: 'PROMPT_SOFT_DELETE',
    },
    {
      resourceType: 'DATA_VIEW',
      dataViewKey: 'drive-file-links',
      owner: 'INTEGRATION',
      uninstallBehavior: 'PROMPT_SOFT_DELETE',
    },
  ]);
});
