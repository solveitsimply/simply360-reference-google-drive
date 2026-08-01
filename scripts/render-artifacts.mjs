import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const assertSourceCommit = (sourceCommit) => {
  if (!sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error('--source-commit (or SOURCE_COMMIT) must be an exact lowercase 40-character Git SHA.');
  }
};

export const assertExactArtifactSource = ({ sourceCommit, checkedOutCommit, worktreeIsClean }) => {
  assertSourceCommit(sourceCommit);
  if (sourceCommit !== checkedOutCommit) {
    throw new Error('Artifact source commit must match the checked-out Git commit.');
  }
  if (!worktreeIsClean) {
    throw new Error('Artifacts must be rendered from a clean Git worktree.');
  }
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const renderReferenceArtifacts = async ({ sourceCommit, outputDirectory }) => {
  assertSourceCommit(sourceCommit);
  const resolvedOutputDirectory = resolve(repositoryRoot, outputDirectory);
  const packageTemplate = JSON.parse(
    await readFile(resolve(repositoryRoot, 'blueprints/drive-file-links.package.template.json'), 'utf8'),
  );
  const definitionSha256 = sha256(canonicalJson(packageTemplate.definition));
  packageTemplate.definitionSha256 = definitionSha256;
  packageTemplate.provenance.sourceCommit = sourceCommit;
  const packageJson = pretty(packageTemplate);
  const packageSha256 = sha256(packageJson);

  const manifestTemplate = JSON.parse(
    await readFile(resolve(repositoryRoot, 'marketplace/app-manifest.template.json'), 'utf8'),
  );
  manifestTemplate.provenance.sourceCommit = sourceCommit;
  manifestTemplate.blueprintPackages[0].sha256 = packageSha256;
  const manifestJson = pretty(manifestTemplate);

  if (manifestJson.includes('__') || packageJson.includes('__')) {
    throw new Error('Rendered artifacts contain unresolved placeholders.');
  }

  await mkdir(resolvedOutputDirectory, { recursive: true });
  await writeFile(resolve(resolvedOutputDirectory, 'drive-file-links.package.json'), packageJson);
  await writeFile(resolve(resolvedOutputDirectory, 'app-manifest.json'), manifestJson);
  await writeFile(
    resolve(resolvedOutputDirectory, 'checksums.json'),
    pretty({
      schemaVersion: 'simply360.reference-artifact-checksums/v1',
      sourceCommit,
      artifacts: [
        { path: 'app-manifest.json', sha256: sha256(manifestJson) },
        { path: 'drive-file-links.package.json', sha256: packageSha256 },
      ],
    }),
  );
  return resolvedOutputDirectory;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceCommit = argument('--source-commit') ?? process.env.SOURCE_COMMIT;
  const [{ stdout: checkedOutCommit }, { stdout: worktreeStatus }] = await Promise.all([
    execute('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }),
    execute('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }),
  ]);
  assertExactArtifactSource({
    sourceCommit,
    checkedOutCommit: checkedOutCommit.trim(),
    worktreeIsClean: worktreeStatus.length === 0,
  });
  const outputDirectory = await renderReferenceArtifacts({
    sourceCommit,
    outputDirectory: argument('--output') ?? 'build/artifacts',
  });
  process.stdout.write(`Rendered source ${sourceCommit} to ${outputDirectory}\n`);
}
