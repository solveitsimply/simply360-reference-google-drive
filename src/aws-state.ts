import { randomUUID } from 'node:crypto';

import {
  AwsJsonProtocolClient,
  AwsServiceError,
  AwsSignedHttpClient,
} from './aws.js';
import { sha256Hex } from './crypto.js';
import type { StateStore } from './ports.js';
import {
  parseInstallationState,
  type InstallationState,
} from './state.js';

type AttributeValue = {
  readonly S?: string;
  readonly N?: string;
};

type AttributeMap = Readonly<Record<string, AttributeValue>>;

export interface AwsJsonCaller {
  call(
    service: 'dynamodb' | 'secretsmanager',
    target: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

const object = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
};

const item = (value: unknown, label: string): AttributeMap =>
  object(value, label) as AttributeMap;

const stringAttribute = (
  attributes: AttributeMap,
  key: string,
  label: string,
): string => {
  const value = attributes[key]?.S;
  if (typeof value !== 'string') {
    throw new Error(`${label} is missing string attribute ${key}`);
  }
  return value;
};

const numberAttribute = (
  attributes: AttributeMap,
  key: string,
  label: string,
): number => {
  const value = attributes[key]?.N;
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error(`${label} is missing integer attribute ${key}`);
  }
  return Number(value);
};

const optionalItem = (
  response: Record<string, unknown>,
  label: string,
): AttributeMap | undefined =>
  response.Item === undefined ? undefined : item(response.Item, label);

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof AwsServiceError &&
  error.code === 'ConditionalCheckFailedException';

const assertIdentifier = (value: string, label: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
};

const stateKey = (installationSimplyId: string): string => {
  assertIdentifier(installationSimplyId, 'installationSimplyId');
  return `INSTALLATION#${installationSimplyId}`;
};

export class ConcurrentStateUpdateError extends Error {
  public constructor() {
    super('installation state changed concurrently; retry from a fresh read');
    this.name = 'ConcurrentStateUpdateError';
  }
}

export class DynamoDbInstallationStateStore
  implements StateStore<InstallationState>
{
  private readonly revisions = new Map<string, number | undefined>();

  public constructor(
    private readonly tableName: string,
    private readonly client: AwsJsonCaller,
    private readonly maximumStateBytes = 350 * 1024,
  ) {
    if (!tableName) throw new Error('state table name is required');
    if (
      !Number.isSafeInteger(maximumStateBytes) ||
      maximumStateBytes < 1024 ||
      maximumStateBytes > 350 * 1024
    ) {
      throw new Error('maximumStateBytes must be between 1024 and 358400');
    }
  }

  public async load(
    installationSimplyId: string,
  ): Promise<InstallationState | undefined> {
    const response = await this.client.call(
      'dynamodb',
      'DynamoDB_20120810.GetItem',
      {
        TableName: this.tableName,
        Key: { pk: { S: stateKey(installationSimplyId) } },
        ConsistentRead: true,
      },
    );
    const found = optionalItem(response, 'DynamoDB state item');
    if (!found) {
      this.revisions.set(installationSimplyId, undefined);
      return undefined;
    }
    const revision = numberAttribute(found, 'revision', 'DynamoDB state item');
    const serialized = stringAttribute(
      found,
      'stateJson',
      'DynamoDB state item',
    );
    if (Buffer.byteLength(serialized) > this.maximumStateBytes) {
      throw new Error('persisted installation state exceeds the configured limit');
    }
    const parsed = parseInstallationState(
      JSON.parse(serialized) as unknown,
      installationSimplyId,
    );
    this.revisions.set(installationSimplyId, revision);
    return structuredClone(parsed);
  }

  public async save(
    installationSimplyId: string,
    state: InstallationState,
  ): Promise<void> {
    if (!this.revisions.has(installationSimplyId)) {
      throw new Error('state must be loaded before it can be saved');
    }
    const parsed = parseInstallationState(state, installationSimplyId);
    const serialized = JSON.stringify(parsed);
    if (Buffer.byteLength(serialized) > this.maximumStateBytes) {
      throw new Error('installation state exceeds the configured DynamoDB limit');
    }
    const expected = this.revisions.get(installationSimplyId);
    const nextRevision = (expected ?? 0) + 1;
    try {
      await this.client.call('dynamodb', 'DynamoDB_20120810.PutItem', {
        TableName: this.tableName,
        Item: {
          pk: { S: stateKey(installationSimplyId) },
          revision: { N: String(nextRevision) },
          stateJson: { S: serialized },
          updatedAt: { S: state.updatedAt },
        },
        ConditionExpression:
          expected === undefined
            ? 'attribute_not_exists(#pk)'
            : '#revision = :expectedRevision',
        ExpressionAttributeNames:
          expected === undefined
            ? { '#pk': 'pk' }
            : { '#revision': 'revision' },
        ...(expected === undefined
          ? {}
          : {
              ExpressionAttributeValues: {
                ':expectedRevision': { N: String(expected) },
              },
            }),
      });
    } catch (error) {
      if (isConditionalFailure(error)) {
        this.revisions.delete(installationSimplyId);
        throw new ConcurrentStateUpdateError();
      }
      throw error;
    }
    this.revisions.set(installationSimplyId, nextRevision);
  }
}

export class IdempotencyConflictError extends Error {
  public constructor() {
    super('idempotency key was already used for a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class OperationInProgressError extends Error {
  public constructor(readonly retryAfterSeconds: number) {
    super('operation is already in progress');
    this.name = 'OperationInProgressError';
  }
}

export class DynamoDbIdempotency {
  public constructor(
    private readonly tableName: string,
    private readonly client: AwsJsonCaller,
    private readonly options: {
      readonly now?: () => Date;
      readonly leaseSeconds?: number;
      readonly retentionSeconds?: number;
      readonly maximumResultBytes?: number;
    } = {},
  ) {
    if (!tableName) throw new Error('idempotency table name is required');
  }

  public async run<T>(
    namespace: string,
    key: string,
    requestFingerprint: string,
    operation: () => Promise<T>,
  ): Promise<{ readonly replayed: boolean; readonly value: T }> {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(namespace)) {
      throw new Error('idempotency namespace is invalid');
    }
    if (!key || key.length > 256) throw new Error('idempotency key is invalid');
    if (!/^[a-f0-9]{64}$/u.test(requestFingerprint)) {
      throw new Error('request fingerprint must be a SHA-256 digest');
    }
    const coordinate = `${namespace}#${sha256Hex(key)}`;
    const owner = randomUUID();
    const acquired = await this.acquire(
      coordinate,
      requestFingerprint,
      owner,
    );
    if (acquired.replayed) {
      return { replayed: true, value: acquired.value as T };
    }
    try {
      const value = await operation();
      const resultJson = JSON.stringify(value);
      if (
        Buffer.byteLength(resultJson) >
        (this.options.maximumResultBytes ?? 64 * 1024)
      ) {
        throw new Error('idempotency result exceeds the configured byte limit');
      }
      const nowSeconds = Math.floor(this.now().getTime() / 1000);
      await this.client.call('dynamodb', 'DynamoDB_20120810.UpdateItem', {
        TableName: this.tableName,
        Key: { pk: { S: coordinate } },
        UpdateExpression:
          'SET #status = :complete, #result = :result, #expires = :expires REMOVE #owner, #lease',
        ConditionExpression: '#owner = :owner AND #fingerprint = :fingerprint',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#result': 'resultJson',
          '#expires': 'expiresAtEpoch',
          '#owner': 'owner',
          '#lease': 'leaseUntilEpoch',
          '#fingerprint': 'requestFingerprint',
        },
        ExpressionAttributeValues: {
          ':complete': { S: 'COMPLETE' },
          ':result': { S: resultJson },
          ':expires': {
            N: String(nowSeconds + (this.options.retentionSeconds ?? 604_800)),
          },
          ':owner': { S: owner },
          ':fingerprint': { S: requestFingerprint },
        },
      });
      return { replayed: false, value };
    } catch (error) {
      try {
        await this.client.call('dynamodb', 'DynamoDB_20120810.DeleteItem', {
          TableName: this.tableName,
          Key: { pk: { S: coordinate } },
          ConditionExpression: '#owner = :owner',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':owner': { S: owner } },
        });
      } catch (cleanupError) {
        if (!isConditionalFailure(cleanupError)) throw cleanupError;
      }
      throw error;
    }
  }

  private async acquire(
    coordinate: string,
    requestFingerprint: string,
    owner: string,
  ): Promise<
    | { readonly replayed: false }
    | { readonly replayed: true; readonly value: unknown }
  > {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const leaseUntil =
      nowSeconds + (this.options.leaseSeconds ?? 2 * 60);
    const transientTtl = leaseUntil + 60 * 60;
    try {
      await this.client.call('dynamodb', 'DynamoDB_20120810.PutItem', {
        TableName: this.tableName,
        Item: {
          pk: { S: coordinate },
          status: { S: 'IN_PROGRESS' },
          owner: { S: owner },
          requestFingerprint: { S: requestFingerprint },
          leaseUntilEpoch: { N: String(leaseUntil) },
          expiresAtEpoch: { N: String(transientTtl) },
        },
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': 'pk' },
      });
      return { replayed: false };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    const existing = await this.get(coordinate);
    if (!existing) return this.acquire(coordinate, requestFingerprint, owner);
    const existingFingerprint = stringAttribute(
      existing,
      'requestFingerprint',
      'idempotency item',
    );
    if (existingFingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError();
    }
    const status = stringAttribute(existing, 'status', 'idempotency item');
    if (status === 'COMPLETE') {
      return {
        replayed: true,
        value: JSON.parse(
          stringAttribute(existing, 'resultJson', 'idempotency item'),
        ) as unknown,
      };
    }
    if (status !== 'IN_PROGRESS') throw new Error('idempotency status is invalid');
    const existingLease = numberAttribute(
      existing,
      'leaseUntilEpoch',
      'idempotency item',
    );
    if (existingLease >= nowSeconds) {
      throw new OperationInProgressError(
        Math.max(1, existingLease - nowSeconds),
      );
    }
    try {
      await this.client.call('dynamodb', 'DynamoDB_20120810.UpdateItem', {
        TableName: this.tableName,
        Key: { pk: { S: coordinate } },
        UpdateExpression:
          'SET #owner = :owner, #lease = :lease, #expires = :expires',
        ConditionExpression:
          '#fingerprint = :fingerprint AND #lease < :now AND #status = :inProgress',
        ExpressionAttributeNames: {
          '#owner': 'owner',
          '#lease': 'leaseUntilEpoch',
          '#expires': 'expiresAtEpoch',
          '#fingerprint': 'requestFingerprint',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':owner': { S: owner },
          ':lease': { N: String(leaseUntil) },
          ':expires': { N: String(transientTtl) },
          ':fingerprint': { S: requestFingerprint },
          ':now': { N: String(nowSeconds) },
          ':inProgress': { S: 'IN_PROGRESS' },
        },
      });
      return { replayed: false };
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new OperationInProgressError(1);
      }
      throw error;
    }
  }

  private async get(coordinate: string): Promise<AttributeMap | undefined> {
    const response = await this.client.call(
      'dynamodb',
      'DynamoDB_20120810.GetItem',
      {
        TableName: this.tableName,
        Key: { pk: { S: coordinate } },
        ConsistentRead: true,
      },
    );
    return optionalItem(response, 'idempotency item');
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export interface WorkEnvelope {
  readonly schemaVersion: 1;
  readonly outboxKey: string;
  readonly installationSimplyId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly operation:
    | 'IMPORT'
    | 'EXPORT'
    | 'RECONCILE'
    | 'NOTIFICATION'
    | 'REVOKE_GOOGLE'
    | 'UNINSTALL';
  readonly input: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export class SqsQueueClient {
  private readonly queueOrigin: string;

  public constructor(
    private readonly queueUrl: string,
    private readonly region: string,
    private readonly http: AwsSignedHttpClient = new AwsSignedHttpClient(),
  ) {
    const url = new URL(queueUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname.endsWith('.amazonaws.com')
    ) {
      throw new Error('SQS queue URL must be an exact AWS HTTPS URL');
    }
    this.queueOrigin = url.origin;
  }

  public async send(message: WorkEnvelope): Promise<void> {
    const messageBody = JSON.stringify(message);
    if (Buffer.byteLength(messageBody) > 64 * 1024) {
      throw new Error('work message exceeds the configured queue byte limit');
    }
    const body = new URLSearchParams({
      Action: 'SendMessage',
      Version: '2012-11-05',
      MessageBody: messageBody,
    }).toString();
    const response = await this.http.request({
      service: 'sqs',
      region: this.region,
      url: this.queueUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new AwsServiceError('sqs', response.status, 'SendMessageFailed');
    }
  }

  public assertSameQueueOrigin(candidate: string): void {
    if (new URL(candidate).origin !== this.queueOrigin) {
      throw new Error('queue origin changed unexpectedly');
    }
  }
}

export class DynamoDbOutbox {
  public constructor(
    private readonly tableName: string,
    private readonly client: AwsJsonCaller,
    private readonly queue: SqsQueueClient,
    private readonly options: {
      readonly now?: () => Date;
      readonly retentionSeconds?: number;
    } = {},
  ) {
    if (!tableName) throw new Error('outbox table name is required');
  }

  public async enqueue(input: {
    readonly installationSimplyId: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly operation: WorkEnvelope['operation'];
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly outboxKey: string; readonly replayed: boolean }> {
    assertIdentifier(input.installationSimplyId, 'installationSimplyId');
    if (!input.idempotencyKey || input.idempotencyKey.length > 256) {
      throw new Error('idempotency key is invalid');
    }
    if (!/^[a-f0-9]{64}$/u.test(input.requestFingerprint)) {
      throw new Error('request fingerprint is invalid');
    }
    const outboxKey = sha256Hex(
      `${input.installationSimplyId}\n${input.idempotencyKey}`,
    );
    const createdAt = this.now().toISOString();
    const envelope: WorkEnvelope = {
      schemaVersion: 1,
      outboxKey,
      installationSimplyId: input.installationSimplyId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      operation: input.operation,
      input: input.payload,
      createdAt,
    };
    const envelopeJson = JSON.stringify(envelope);
    if (Buffer.byteLength(envelopeJson) > 64 * 1024) {
      throw new Error('outbox envelope exceeds the configured byte limit');
    }
    let replayed = false;
    try {
      await this.client.call('dynamodb', 'DynamoDB_20120810.PutItem', {
        TableName: this.tableName,
        Item: {
          pk: { S: outboxKey },
          status: { S: 'PENDING' },
          createdAt: { S: createdAt },
          installationSimplyId: { S: input.installationSimplyId },
          requestFingerprint: { S: input.requestFingerprint },
          envelopeJson: { S: envelopeJson },
          expiresAtEpoch: {
            N: String(
              Math.floor(this.now().getTime() / 1000) +
                (this.options.retentionSeconds ?? 604_800),
            ),
          },
        },
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': 'pk' },
      });
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      replayed = true;
      const existing = await this.get(outboxKey);
      if (
        !existing ||
        stringAttribute(
          existing,
          'requestFingerprint',
          'outbox item',
        ) !== input.requestFingerprint
      ) {
        throw new IdempotencyConflictError();
      }
    }
    await this.dispatch(outboxKey);
    return { outboxKey, replayed };
  }

  public async dispatchPending(limit = 10): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new Error('outbox dispatch limit must be from 1 to 25');
    }
    const response = await this.client.call(
      'dynamodb',
      'DynamoDB_20120810.Query',
      {
        TableName: this.tableName,
        IndexName: 'StatusCreatedAtIndex',
        KeyConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': { S: 'PENDING' } },
        Limit: limit,
      },
    );
    const items = Array.isArray(response.Items) ? response.Items : [];
    for (const candidate of items) {
      const found = item(candidate, 'outbox query item');
      await this.dispatch(stringAttribute(found, 'pk', 'outbox query item'));
    }
    return items.length;
  }

  public async complete(outboxKey: string): Promise<void> {
    await this.client.call('dynamodb', 'DynamoDB_20120810.UpdateItem', {
      TableName: this.tableName,
      Key: { pk: { S: outboxKey } },
      UpdateExpression: 'SET #status = :complete, #completedAt = :completedAt',
      ConditionExpression:
        '#status = :dispatched OR #status = :complete',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#completedAt': 'completedAt',
      },
      ExpressionAttributeValues: {
        ':dispatched': { S: 'DISPATCHED' },
        ':complete': { S: 'COMPLETE' },
        ':completedAt': { S: this.now().toISOString() },
      },
    });
  }

  private async dispatch(outboxKey: string): Promise<void> {
    const existing = await this.get(outboxKey);
    if (!existing) throw new Error('outbox item disappeared before dispatch');
    const status = stringAttribute(existing, 'status', 'outbox item');
    if (status === 'COMPLETE') return;
    if (status !== 'PENDING' && status !== 'DISPATCHED') {
      throw new Error('outbox status is invalid');
    }
    const envelope = parseWorkEnvelope(
      JSON.parse(
        stringAttribute(existing, 'envelopeJson', 'outbox item'),
      ) as unknown,
    );
    await this.queue.send(envelope);
    await this.client.call('dynamodb', 'DynamoDB_20120810.UpdateItem', {
      TableName: this.tableName,
      Key: { pk: { S: outboxKey } },
      UpdateExpression: 'SET #status = :dispatched, #dispatchedAt = :now',
      ConditionExpression:
        '#status = :pending OR #status = :dispatched',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#dispatchedAt': 'dispatchedAt',
      },
      ExpressionAttributeValues: {
        ':pending': { S: 'PENDING' },
        ':dispatched': { S: 'DISPATCHED' },
        ':now': { S: this.now().toISOString() },
      },
    });
  }

  private async get(outboxKey: string): Promise<AttributeMap | undefined> {
    const response = await this.client.call(
      'dynamodb',
      'DynamoDB_20120810.GetItem',
      {
        TableName: this.tableName,
        Key: { pk: { S: outboxKey } },
        ConsistentRead: true,
      },
    );
    return optionalItem(response, 'outbox item');
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class DynamoDbAuthorityIndex {
  public constructor(
    private readonly tableName: string,
    private readonly client: AwsJsonCaller,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!tableName) throw new Error('authority table name is required');
  }

  public async putOAuthState(
    stateToken: string,
    installationSimplyId: string,
    expiresAt: string,
  ): Promise<void> {
    assertIdentifier(installationSimplyId, 'installationSimplyId');
    const expiresAtEpoch = Math.floor(new Date(expiresAt).getTime() / 1000);
    if (
      !Number.isSafeInteger(expiresAtEpoch) ||
      expiresAtEpoch <= Math.floor(this.now().getTime() / 1000)
    ) {
      throw new Error('OAuth state expiry is invalid');
    }
    await this.client.call('dynamodb', 'DynamoDB_20120810.PutItem', {
      TableName: this.tableName,
      Item: {
        pk: { S: `OAUTH#${sha256Hex(stateToken)}` },
        kind: { S: 'OAUTH' },
        installationSimplyId: { S: installationSimplyId },
        expiresAtEpoch: { N: String(expiresAtEpoch) },
      },
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    });
  }

  public async consumeOAuthState(stateToken: string): Promise<string> {
    const nowEpoch = Math.floor(this.now().getTime() / 1000);
    let response: Record<string, unknown>;
    try {
      response = await this.client.call(
        'dynamodb',
        'DynamoDB_20120810.DeleteItem',
        {
          TableName: this.tableName,
          Key: { pk: { S: `OAUTH#${sha256Hex(stateToken)}` } },
          ConditionExpression: '#expires > :now AND #kind = :oauth',
          ExpressionAttributeNames: {
            '#expires': 'expiresAtEpoch',
            '#kind': 'kind',
          },
          ExpressionAttributeValues: {
            ':now': { N: String(nowEpoch) },
            ':oauth': { S: 'OAUTH' },
          },
          ReturnValues: 'ALL_OLD',
        },
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new Error('OAuth state is missing, expired, or already consumed');
      }
      throw error;
    }
    const attributes = item(response.Attributes, 'consumed OAuth state');
    return stringAttribute(
      attributes,
      'installationSimplyId',
      'consumed OAuth state',
    );
  }

  public async putNotificationChannel(
    channelId: string,
    installationSimplyId: string,
    expiresAt: string,
  ): Promise<void> {
    assertIdentifier(installationSimplyId, 'installationSimplyId');
    const expiresAtEpoch = Math.floor(new Date(expiresAt).getTime() / 1000);
    if (
      !channelId ||
      channelId.length > 256 ||
      !Number.isSafeInteger(expiresAtEpoch) ||
      expiresAtEpoch <= Math.floor(this.now().getTime() / 1000)
    ) {
      throw new Error('notification channel authority is invalid');
    }
    await this.client.call('dynamodb', 'DynamoDB_20120810.PutItem', {
      TableName: this.tableName,
      Item: {
        pk: { S: `CHANNEL#${sha256Hex(channelId)}` },
        kind: { S: 'CHANNEL' },
        installationSimplyId: { S: installationSimplyId },
        expiresAtEpoch: { N: String(expiresAtEpoch) },
      },
    });
  }

  public async installationForNotificationChannel(
    channelId: string,
  ): Promise<string> {
    const response = await this.client.call(
      'dynamodb',
      'DynamoDB_20120810.GetItem',
      {
        TableName: this.tableName,
        Key: { pk: { S: `CHANNEL#${sha256Hex(channelId)}` } },
        ConsistentRead: true,
      },
    );
    const found = optionalItem(response, 'notification authority');
    if (
      !found ||
      stringAttribute(found, 'kind', 'notification authority') !== 'CHANNEL' ||
      numberAttribute(found, 'expiresAtEpoch', 'notification authority') <=
        Math.floor(this.now().getTime() / 1000)
    ) {
      throw new Error('notification channel authority is missing or expired');
    }
    return stringAttribute(
      found,
      'installationSimplyId',
      'notification authority',
    );
  }

  public async putRetentionDecision(
    installationSimplyId: string,
    decision: 'DELETE_APP_DATA' | 'RETAIN_DISCLOSED_DATA',
    idempotencyKey: string,
  ): Promise<void> {
    assertIdentifier(installationSimplyId, 'installationSimplyId');
    await this.client.call('dynamodb', 'DynamoDB_20120810.PutItem', {
      TableName: this.tableName,
      Item: {
        pk: { S: `RETENTION#${installationSimplyId}` },
        kind: { S: 'RETENTION' },
        installationSimplyId: { S: installationSimplyId },
        decision: { S: decision },
        idempotencyKey: { S: idempotencyKey },
        expiresAtEpoch: {
          N: String(Math.floor(this.now().getTime() / 1000) + 30 * 24 * 60 * 60),
        },
      },
      ConditionExpression:
        'attribute_not_exists(#pk) OR (#decision = :decision AND #idempotencyKey = :idempotencyKey)',
      ExpressionAttributeNames: {
        '#pk': 'pk',
        '#decision': 'decision',
        '#idempotencyKey': 'idempotencyKey',
      },
      ExpressionAttributeValues: {
        ':decision': { S: decision },
        ':idempotencyKey': { S: idempotencyKey },
      },
    });
  }

  public async retentionDecision(
    installationSimplyId: string,
  ): Promise<'DELETE_APP_DATA' | 'RETAIN_DISCLOSED_DATA' | undefined> {
    const response = await this.client.call(
      'dynamodb',
      'DynamoDB_20120810.GetItem',
      {
        TableName: this.tableName,
        Key: { pk: { S: `RETENTION#${installationSimplyId}` } },
        ConsistentRead: true,
      },
    );
    const found = optionalItem(response, 'retention decision');
    if (!found) return undefined;
    const decision = stringAttribute(found, 'decision', 'retention decision');
    if (decision !== 'DELETE_APP_DATA' && decision !== 'RETAIN_DISCLOSED_DATA') {
      throw new Error('retention decision is invalid');
    }
    return decision;
  }
}

export const parseWorkEnvelope = (input: unknown): WorkEnvelope => {
  const value = object(input, 'work envelope');
  const allowed = new Set([
    'schemaVersion',
    'outboxKey',
    'installationSimplyId',
    'idempotencyKey',
    'requestFingerprint',
    'operation',
    'input',
    'createdAt',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('work envelope contains an unknown property');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.outboxKey !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.outboxKey) ||
    typeof value.installationSimplyId !== 'string' ||
    typeof value.idempotencyKey !== 'string' ||
    typeof value.requestFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.requestFingerprint) ||
    ![
      'IMPORT',
      'EXPORT',
      'RECONCILE',
      'NOTIFICATION',
      'REVOKE_GOOGLE',
      'UNINSTALL',
    ].includes(value.operation as string) ||
    !value.input ||
    typeof value.input !== 'object' ||
    Array.isArray(value.input) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('work envelope is invalid');
  }
  assertIdentifier(value.installationSimplyId, 'installationSimplyId');
  return value as unknown as WorkEnvelope;
};

export const configuredAwsClients = (environment: NodeJS.ProcessEnv): {
  readonly json: AwsJsonProtocolClient;
  readonly queue: SqsQueueClient;
} => {
  const region = environment.AWS_REGION;
  const queueUrl = environment.WORK_QUEUE_URL;
  if (!region || !queueUrl) {
    throw new Error('AWS_REGION and WORK_QUEUE_URL are required');
  }
  const http = new AwsSignedHttpClient();
  return {
    json: new AwsJsonProtocolClient(region, http),
    queue: new SqsQueueClient(queueUrl, region, http),
  };
};

export class SecretsManagerSecretReader {
  public constructor(private readonly client: AwsJsonCaller) {}

  public async json(secretId: string): Promise<Record<string, unknown>> {
    if (!secretId || secretId.length > 2048) {
      throw new Error('secret identifier is invalid');
    }
    const response = await this.client.call(
      'secretsmanager',
      'secretsmanager.GetSecretValue',
      { SecretId: secretId },
    );
    if (typeof response.SecretString !== 'string') {
      throw new Error('binary secrets are not supported');
    }
    if (Buffer.byteLength(response.SecretString) > 64 * 1024) {
      throw new Error('secret exceeds the configured byte limit');
    }
    const parsed = JSON.parse(response.SecretString) as unknown;
    return object(parsed, 'secret value');
  }
}
