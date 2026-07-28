import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const sourceCommit = argument('--source-commit') ?? process.env.SOURCE_COMMIT;
const outputDirectory = resolve(repositoryRoot, argument('--output') ?? 'build/artifacts');

if (!sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
  throw new Error('--source-commit (or SOURCE_COMMIT) must be an exact lowercase 40-character Git SHA.');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

const packageTemplate = JSON.parse(
  await readFile(resolve(repositoryRoot, 'blueprints/drive-file-links.package.template.json'), 'utf8'),
);
const definitionSha256 = sha256(canonicalJson(packageTemplate.definition));
packageTemplate.definitionSha256 = definitionSha256;
packageTemplate.provenance.sourceCommit = sourceCommit;
const packageJson = pretty(packageTemplate);
const packageSha256 = sha256(packageJson);

const manifestTemplate = JSON.parse(await readFile(resolve(repositoryRoot, 'marketplace/app-manifest.template.json'), 'utf8'));
manifestTemplate.provenance.sourceCommit = sourceCommit;
manifestTemplate.blueprintPackages[0].sha256 = packageSha256;
const manifestJson = pretty(manifestTemplate);

if (manifestJson.includes('__') || packageJson.includes('__')) throw new Error('Rendered artifacts contain unresolved placeholders.');

await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, 'drive-file-links.package.json'), packageJson);
await writeFile(resolve(outputDirectory, 'app-manifest.json'), manifestJson);
await writeFile(
  resolve(outputDirectory, 'checksums.json'),
  pretty({
    schemaVersion: 'simply360.reference-artifact-checksums/v1',
    sourceCommit,
    artifacts: [
      { path: 'app-manifest.json', sha256: sha256(manifestJson) },
      { path: 'drive-file-links.package.json', sha256: packageSha256 },
    ],
  }),
);

process.stdout.write(`Rendered source ${sourceCommit} to ${outputDirectory}\n`);
