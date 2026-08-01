import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [runtime, roles] = await Promise.all([
  read('infra/dev.template.yaml'),
  read('infra/oidc-roles.template.yaml'),
]);

const requireText = (source, text, label) => {
  if (!source.includes(text)) throw new Error(`missing infrastructure invariant: ${label}`);
};
const forbidText = (source, text, label) => {
  if (source.includes(text)) throw new Error(`forbidden infrastructure configuration: ${label}`);
};

for (const [text, label] of [
  ['GoogleRuntimeSecret:', 'owner-managed Google secret container'],
  ['Simply360LifecycleSecret:', 'owner-managed lifecycle secret container'],
  ['DeletionPolicy: Retain', 'credential-preserving secret teardown'],
  ['DisableExecuteApiEndpoint: true', 'custom-origin-only API access'],
  ['RetentionInDays: 7', 'seven-day logs'],
  ['ReservedConcurrentExecutions: 4', 'bounded API concurrency'],
  ['ReservedConcurrentExecutions: 2', 'bounded worker concurrency'],
  ['MaximumConcurrency: 2', 'bounded SQS concurrency'],
  ['GoogleOAuthRedirectUri:', 'OAuth callback output'],
  ['GoogleNotificationEndpoint:', 'notification endpoint output'],
]) requireText(runtime, text, label);
forbidText(runtime, 'SecretString:', 'committed secret value');
for (const [text, label] of [
  ['repo:solveitsimply/simply360-reference-google-drive:environment:dev', 'exact GitHub environment subject'],
  ['StackExecutionRole:', 'separate CloudFormation execution role'],
  ['GitHubDeployRole:', 'GitHub deploy role'],
  ['simply360-reference-drive-dev-', 'repo-scoped artifact prefix'],
]) requireText(roles, text, label);

process.stdout.write('infrastructure invariants passed\n');
