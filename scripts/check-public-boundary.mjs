import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tracked = (await import('node:child_process'))
  .execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n');
const sourceFiles = tracked.filter(
  (file) =>
    file.startsWith('src/') ||
    file.startsWith('marketplace/') ||
    file.startsWith('blueprints/') ||
    file === 'package.json',
);
const forbidden = [
  { pattern: /(?:from\s*|import\s*\()['"]@s360\//u, label: 'internal @s360 package import' },
  { pattern: /simply360-2\/simply360/u, label: 'monorepo filesystem reference' },
  {
    pattern: /(?:from\s*|import\s*\()['"](?:mysql2?|sequelize|@aws-sdk\/client-(?:dynamodb|ssm))/iu,
    label: 'internal persistence/credential dependency',
  },
  { pattern: /https:\/\/www\.googleapis\.com\/auth\/drive(?:\s|["'`,\]])/u, label: 'broad Google Drive scope' },
];

const violations = [];
for (const file of sourceFiles) {
  const contents = await readFile(resolve(root, file), 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(contents)) violations.push(`${file}: ${rule.label}`);
  }
}

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
if (runtimeDependencies.length > 0) violations.push(`package.json: unexpected runtime dependencies: ${runtimeDependencies.join(', ')}`);

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public-boundary scan passed for ${sourceFiles.length} tracked files.\n`);
}
