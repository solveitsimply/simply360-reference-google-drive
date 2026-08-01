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
  [
    'repo:solveitsimply@67548625/simply360-reference-google-drive@1305919039:environment:dev',
    'immutable GitHub environment subject',
  ],
  ['StackExecutionRole:', 'separate CloudFormation execution role'],
  ['GitHubDeployRole:', 'GitHub deploy role'],
  ['simply360-reference-drive-dev-', 'repo-scoped artifact prefix'],
]) requireText(roles, text, label);
forbidText(
  roles,
  'repo:solveitsimply/simply360-reference-google-drive:environment:dev',
  'mutable GitHub environment subject',
);

const workerPolicy = runtime.slice(
  runtime.indexOf('  WorkerFunction:'),
  runtime.indexOf('  ApiLogGroup:'),
);
for (const [text, label] of [
  ['Resource: !GetAtt StateTable.Arn', 'worker installation-state boundary'],
  ['Resource: !GetAtt IdempotencyTable.Arn', 'worker idempotency boundary'],
  ['Resource: !GetAtt OutboxTable.Arn', 'worker outbox completion boundary'],
  ['Resource: !GetAtt WorkQueue.Arn', 'worker source-queue boundary'],
]) requireText(workerPolicy, text, label);
for (const [text, label] of [
  ['AuthorityTable', 'worker authority-table access'],
  ['DeadLetterQueue', 'worker dead-letter-queue access'],
  ['dynamodb:Query', 'worker table query access'],
  ['sqs:SendMessage', 'worker queue-send access'],
  ['sqs:ChangeMessageVisibility', 'worker message-visibility access'],
]) forbidText(workerPolicy, text, label);

process.stdout.write('infrastructure invariants passed\n');
