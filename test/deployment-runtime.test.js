import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  AwsJsonProtocolClient,
  AwsServiceError,
  AwsSignedHttpClient,
  ConcurrentStateUpdateError,
  DynamoDbAuthorityIndex,
  DynamoDbIdempotency,
  DynamoDbInstallationStateStore,
  DynamoDbOutbox,
  DeterministicIdGenerator,
  FixedClock,
  GOOGLE_DRIVE_SCOPE,
  GoogleDriveDouble,
  GoogleDriveReferenceRouter,
  GoogleDriveReferenceRuntime,
  GoogleDriveWorkHandler,
  InMemoryStateStore,
  InMemoryTelemetrySink,
  PUBLIC_LIFECYCLE_SOURCE_SHA256,
  PUBLIC_LIFECYCLE_VARIANTS_SHA256,
  SecretsManagerSecretReader,
  Simply360Double,
  awsCredentialsFromEnvironment,
  parseInstallationState,
  parseLifecycleOccurrence,
  verifyWebhookV2,
} from '../dist/index.js';

class MemoryAws {
  items = new Map();

  async call(_service, target, payload) {
    const key = payload.Key?.pk?.S ?? payload.Item?.pk?.S;
    if (target.endsWith('.GetItem')) {
      return this.items.has(key) ? { Item: structuredClone(this.items.get(key)) } : {};
    }
    if (target.endsWith('.PutItem')) {
      if (
        payload.ConditionExpression === 'attribute_not_exists(#pk)' &&
        this.items.has(key)
      ) {
        throw new AwsServiceError(
          'dynamodb',
          400,
          'ConditionalCheckFailedException',
        );
      }
      this.items.set(key, structuredClone(payload.Item));
      return {};
    }
    if (target.endsWith('.DeleteItem')) {
      const previous = this.items.get(key);
      if (!previous) {
        throw new AwsServiceError(
          'dynamodb',
          400,
          'ConditionalCheckFailedException',
        );
      }
      this.items.delete(key);
      return { Attributes: structuredClone(previous) };
    }
    if (target.endsWith('.UpdateItem')) {
      const found = this.items.get(key);
      if (!found) throw new Error('missing memory item');
      const values = payload.ExpressionAttributeValues ?? {};
      if (values[':complete']) {
        found.status = values[':complete'];
        found.resultJson = values[':result'] ?? found.resultJson;
        found.expiresAtEpoch = values[':expires'] ?? found.expiresAtEpoch;
        found.completedAt = values[':completedAt'] ?? found.completedAt;
        delete found.owner;
        delete found.leaseUntilEpoch;
      } else if (values[':dispatched']) {
        found.status = values[':dispatched'];
        found.dispatchedAt = values[':now'];
      }
      return {};
    }
    if (target.endsWith('.Query')) {
      return {
        Items: [...this.items.values()].filter(
          (item) => item.status?.S === 'PENDING',
        ),
      };
    }
    if (target === 'secretsmanager.GetSecretValue') {
      return { SecretString: '{"clientId":"client"}' };
    }
    throw new Error(`unsupported target ${target}`);
  }
}

const registration = {
  installationSimplyId: 'INST-TEST-0001',
  teamSimplyId: 'TEAM-TEST-0001',
  appVersion: '1.0.0',
  credential: {
    accessToken: 'simply-access-token-0001',
    refreshToken: 'simply-refresh-token-0001',
    expiresAt: '2026-07-28T13:00:00.000Z',
    scopes: ['offline_access', 'files:read', 'files:write'],
  },
  setupCallbackUrl:
    'https://api.dev.simply360.app/v1/integration-installations/INST-TEST-0001/setup',
};

const harness = async () => {
  const clock = new FixedClock();
  const google = new GoogleDriveDouble(clock);
  const state = new InMemoryStateStore();
  const runtime = new GoogleDriveReferenceRuntime(
    {
      clock,
      ids: new DeterministicIdGenerator(),
      google,
      simply360: new Simply360Double(),
      state,
      telemetry: new InMemoryTelemetrySink(),
    },
    { notificationTtlSeconds: 600 },
  );
  await runtime.registerInstallation(registration);
  return { clock, google, state, runtime };
};

const lifecycleOccurrence = {
  eventSimplyId: 'EVNT-TEST-0001',
  teamSimplyId: 'TEAM-TEST-0001',
  teamIntegrationSimplyId: 'INST-TEST-0001',
  eventType: 'app.suspended',
  protocolVersion: 1,
  payloadSchemaId: 'simply360.event.app-lifecycle/v1',
  payloadSchemaVersion: 1,
  occurredAt: '2026-07-28T12:00:00.000Z',
  payload: {
    eventType: 'app.suspended',
    integrationInstallationOperationSimplyId: 'OPER-TEST-0001',
    appSlug: 'google-drive',
    appVersion: '1.0.0',
    idempotencyKey: 'lifecycle-suspension-0001',
  },
};

const sign = (body, now = new Date('2026-07-28T12:00:00.000Z')) => {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', 's'.repeat(32))
    .update(
      [
        'S360-HMAC-V2',
        timestamp,
        'EVNT-TEST-0001',
        'DELV-TEST-0001',
        'ATMP-TEST-0001',
        digest,
      ].join('\n'),
    )
    .digest('hex');
  return `v2;kid=dev-1;t=${timestamp};e=EVNT-TEST-0001;d=DELV-TEST-0001;a=ATMP-TEST-0001;h=${signature}`;
};

describe('public lifecycle and webhook snapshots', () => {
  test('accepts only the exact vendored lifecycle occurrence shape', () => {
    assert.match(PUBLIC_LIFECYCLE_SOURCE_SHA256, /^[a-f0-9]{64}$/u);
    assert.match(PUBLIC_LIFECYCLE_VARIANTS_SHA256, /^[a-f0-9]{64}$/u);
    assert.equal(
      parseLifecycleOccurrence(lifecycleOccurrence).eventType,
      'app.suspended',
    );
    assert.throws(
      () =>
        parseLifecycleOccurrence({
          ...lifecycleOccurrence,
          unexpected: true,
        }),
      /unknown property/u,
    );
    assert.throws(
      () =>
        parseLifecycleOccurrence({
          ...lifecycleOccurrence,
          eventType: 'app.unknown',
        }),
      /not declared/u,
    );
  });

  test('verifies exact HMAC v2 fields, key rotation, and replay time', () => {
    const body = JSON.stringify(lifecycleOccurrence);
    const verified = verifyWebhookV2({
      rawBody: body,
      signatureHeader: sign(body),
      keys: [
        { kid: 'old', secret: 'o'.repeat(32) },
        { kid: 'dev-1', secret: 's'.repeat(32) },
      ],
      now: new Date('2026-07-28T12:00:00.000Z'),
    });
    assert.equal(verified.eventId, lifecycleOccurrence.eventSimplyId);
    assert.throws(
      () =>
        verifyWebhookV2({
          rawBody: `${body} `,
          signatureHeader: sign(body),
          keys: [{ kid: 'dev-1', secret: 's'.repeat(32) }],
          now: new Date('2026-07-28T12:00:00.000Z'),
        }),
      /does not match/u,
    );
    assert.throws(
      () =>
        verifyWebhookV2({
          rawBody: body,
          signatureHeader: sign(body),
          keys: [{ kid: 'dev-1', secret: 's'.repeat(32) }],
          now: new Date('2026-07-28T12:06:00.000Z'),
        }),
      /replay window/u,
    );
    assert.throws(
      () =>
        verifyWebhookV2({
          rawBody: body,
          signatureHeader: `${sign(body)};kid=duplicate`,
          keys: [{ kid: 'dev-1', secret: 's'.repeat(32) }],
        }),
      /fields/u,
    );
  });
});

describe('durable state and bounded router seam', () => {
  test('round-trips strict state and persists only a channel-token hash', async () => {
    const { google, state, runtime } = await harness();
    google.authorizeCode('code', {
      googleAccountSubject: 'google-subject-1',
      grantedScopes: [GOOGLE_DRIVE_SCOPE],
    });
    const start = await runtime.beginGoogleConnection(
      registration.installationSimplyId,
    );
    await runtime.connectGoogle(registration.installationSimplyId, {
      state: start.state,
      authorizationCode: 'code',
    });
    await runtime.activateInstallation(registration.installationSimplyId);
    const channel = await runtime.startChangeNotifications(
      registration.installationSimplyId,
    );
    const stored = state.states.get(registration.installationSimplyId);
    const parsed = parseInstallationState(
      structuredClone(stored),
      registration.installationSimplyId,
    );
    assert.equal(parsed.notifications[0].channel.channelToken, undefined);
    assert.equal(
      parsed.notifications[0].channelTokenSha256,
      createHash('sha256').update(channel.channelToken).digest('hex'),
    );
    const completeShape = {
      ...structuredClone(stored),
      pendingGoogleAuthorization: {
        stateSha256: 'a'.repeat(64),
        codeVerifier: 'pkce-verifier',
        redirectUri:
          'https://reference-drive.dev.simply360.app/oauth/google/callback',
        expiresAt: '2026-07-28T12:10:00.000Z',
      },
      selections: [
        {
          action: 'PICKED',
          driveObjectId: 'drive-file',
          name: 'file.txt',
          mimeType: 'text/plain',
          kind: 'FILE',
          selectedAt: '2026-07-28T12:00:00.000Z',
        },
      ],
      links: [
        {
          linkSimplyId: 'LINK-TEST-0001',
          installationSimplyId: registration.installationSimplyId,
          direction: 'SOURCE',
          driveObjectId: 'drive-file',
          simply360FileSimplyId: 'FILE-TEST-0001',
          simply360VersionNumber: 1,
          driveModifiedAt: '2026-07-28T12:00:00.000Z',
          checksumSha256Base64: 'checksum',
          status: 'ACTIVE',
          updatedAt: '2026-07-28T12:00:00.000Z',
        },
      ],
      pendingExports: [
        {
          operationKey: 'operation',
          uploadId: 'upload',
          nextOffset: 4,
          destinationDriveFolderId: 'folder',
          simply360FileSimplyId: 'FILE-TEST-0001',
          simply360VersionNumber: 1,
          name: 'file.txt',
          contentType: 'text/plain',
          sizeBytes: 8,
          checksumSha256Base64: 'checksum',
        },
      ],
      changeCursor: 'cursor',
    };
    assert.equal(
      parseInstallationState(
        completeShape,
        registration.installationSimplyId,
      ).links.length,
      1,
    );
    assert.throws(
      () =>
        parseInstallationState(
          { ...structuredClone(stored), unknown: true },
          registration.installationSimplyId,
        ),
      /unknown property/u,
    );
  });

  test('routes health, setup auth, OAuth starts, bounded work, and fail-closed errors', async () => {
    const { runtime } = await harness();
    const oauth = new Map();
    const work = [];
    const router = new GoogleDriveReferenceRouter({
      runtime,
      authority: {
        async putOAuthState(state, installation, expiresAt) {
          oauth.set(state, { installation, expiresAt });
        },
      },
      idempotency: {
        async run(_namespace, _key, _fingerprint, operation) {
          return { replayed: false, value: await operation() };
        },
      },
      outbox: {
        async enqueue(input) {
          work.push(input);
          return { outboxKey: 'a'.repeat(64), replayed: false };
        },
      },
      installationAuthorizer: {
        async authorize(installation, header) {
          assert.equal(installation, registration.installationSimplyId);
          if (header === 'Bearer aws-unavailable-token') {
            throw new AwsServiceError('dynamodb', 503, 'Unavailable');
          }
          if (header === 'Bearer concurrent-update-token') {
            throw new ConcurrentStateUpdateError();
          }
          if (header !== `Bearer ${registration.credential.accessToken}`) {
            throw new Error('denied');
          }
        },
      },
      lifecycleSigningKeys: [{ kid: 'dev-1', secret: 's'.repeat(32) }],
    });
    assert.equal(
      (await router.handle(new Request('https://example.test/health'))).status,
      200,
    );
    const setup = await router.handle(
      new Request(
        `https://example.test/setup?installationSimplyId=${registration.installationSimplyId}`,
        { headers: { authorization: `Bearer ${registration.credential.accessToken}` } },
      ),
    );
    assert.equal(setup.status, 200);
    const started = await router.handle(
      new Request(
        `https://example.test/installations/${registration.installationSimplyId}/google/start`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${registration.credential.accessToken}` },
        },
      ),
    );
    assert.equal(started.status, 200);
    assert.equal(oauth.size, 1);
    const queued = await router.handle(
      new Request(
        `https://example.test/installations/${registration.installationSimplyId}/reconcile`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${registration.credential.accessToken}`,
            'content-type': 'application/json',
            'idempotency-key': 'reconcile-request-0001',
          },
          body: '{}',
        },
      ),
    );
    assert.equal(queued.status, 202);
    assert.equal(work[0].operation, 'RECONCILE');
    assert.equal(
      (
        await router.handle(
          new Request('https://example.test/installations', {
            method: 'POST',
          }),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await router.handle(
          new Request(
            `https://example.test/setup?installationSimplyId=${registration.installationSimplyId}`,
          ),
        )
      ).status,
      400,
    );
    const rejected = await router.handle(
      new Request(
        `https://example.test/installations/${registration.installationSimplyId}/reconcile`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${registration.credential.accessToken}`,
            'content-type': 'application/json',
            'idempotency-key': 'malformed-request-0001',
          },
          body: '{"refreshToken":"must-not-leak",',
        },
      ),
    );
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: 'REQUEST_REJECTED',
      message: 'The request was rejected.',
    });
    for (const [token, expectedStatus] of [
      ['aws-unavailable-token', 503],
      ['concurrent-update-token', 409],
    ]) {
      assert.equal(
        (
          await router.handle(
            new Request(
              `https://example.test/setup?installationSimplyId=${registration.installationSimplyId}`,
              { headers: { authorization: `Bearer ${token}` } },
            ),
          )
        ).status,
        expectedStatus,
      );
    }
  });

  test('routes the remaining management, provider, lifecycle, and worker operations', async () => {
    const calls = [];
    const fakeRuntime = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'getSnapshot') {
            return async () => ({
              installationSimplyId: registration.installationSimplyId,
              teamSimplyId: registration.teamSimplyId,
              status: 'ACTIVE',
            });
          }
          if (property === 'beginGoogleConnection') {
            return async () => ({
              authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
              state: 'oauth-state',
              expiresAt: '2026-07-28T12:10:00.000Z',
            });
          }
          if (property === 'startChangeNotifications') {
            return async () => ({
              channelId: 'channel',
              resourceId: 'resource',
              channelToken: 'secret',
              expiresAt: '2026-07-28T12:10:00.000Z',
            });
          }
          if (property === 'authorizeChangeNotification') {
            return async (_installation, headers) => ({
              ...headers,
              channelToken: undefined,
              channelTokenSha256: 'd'.repeat(64),
            });
          }
          return async (...args) => {
            calls.push([property, ...args]);
            return {
              installationSimplyId: registration.installationSimplyId,
              teamSimplyId: registration.teamSimplyId,
              status: 'ACTIVE',
            };
          };
        },
      },
    );
    const queued = [];
    const authority = {
      async putOAuthState() {},
      async consumeOAuthState() {
        return registration.installationSimplyId;
      },
      async putNotificationChannel() {},
      async installationForNotificationChannel() {
        return registration.installationSimplyId;
      },
      async putRetentionDecision() {},
      async retentionDecision() {
        return 'DELETE_APP_DATA';
      },
    };
    const outbox = {
      async enqueue(input) {
        queued.push(input);
        return { outboxKey: 'e'.repeat(64), replayed: false };
      },
      async complete(key) {
        calls.push(['complete', key]);
      },
    };
    const idempotency = {
      async run(_namespace, _key, _fingerprint, operation) {
        return { replayed: false, value: await operation() };
      },
    };
    const router = new GoogleDriveReferenceRouter({
      runtime: fakeRuntime,
      authority,
      idempotency,
      outbox,
      installationAuthorizer: { async authorize() {} },
      lifecycleSigningKeys: [{ kid: 'dev-1', secret: 's'.repeat(32) }],
      enableBootstrap: true,
    });
    const json = (path, body, headers = {}) =>
      router.handle(
        new Request(`https://example.test${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'request-identifier-0001',
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
    assert.equal(
      (
        await json('/installations', registration)
      ).status,
      201,
    );
    assert.equal(
      (
        await router.handle(
          new Request(
            'https://example.test/oauth/google/callback?state=oauth-state&code=code',
          ),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await json(
          `/installations/${registration.installationSimplyId}/picker/session`,
          {},
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await json(
          `/installations/${registration.installationSimplyId}/selections`,
          {
            selection: {
              action: 'PICKED',
              driveObjectId: 'drive-file',
              name: 'file.txt',
              mimeType: 'text/plain',
              kind: 'FILE',
            },
            direction: 'SOURCE',
          },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await json(
          `/installations/${registration.installationSimplyId}/notifications/start`,
          {},
        )
      ).status,
      200,
    );
    for (const [route, body] of [
      ['imports', { driveObjectId: 'drive-file' }],
      [
        'exports',
        {
          fileSimplyId: 'FILE-TEST-0001',
          destinationDriveFolderId: 'folder',
        },
      ],
      ['reconcile', {}],
    ]) {
      assert.equal(
        (
          await json(
            `/installations/${registration.installationSimplyId}/${route}`,
            body,
          )
        ).status,
        202,
      );
    }
    assert.equal(
      (
        await router.handle(
          new Request('https://example.test/google/drive/notifications', {
            method: 'POST',
            headers: {
              'x-goog-channel-id': 'channel',
              'x-goog-resource-id': 'resource',
              'x-goog-channel-token': 'secret',
              'x-goog-message-number': '1',
              'x-goog-resource-state': 'change',
            },
          }),
        )
      ).status,
      202,
    );
    assert.equal(queued.at(-1).payload.channelToken, undefined);
    assert.equal(queued.at(-1).payload.channelTokenSha256, 'd'.repeat(64));

    const body = JSON.stringify(lifecycleOccurrence);
    const now = new Date();
    assert.equal(
      (
        await router.handle(
          new Request('https://example.test/simply360/lifecycle', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-s360-signature': sign(body, now),
            },
            body,
          }),
        )
      ).status,
      200,
    );

    const worker = new GoogleDriveWorkHandler(
      fakeRuntime,
      idempotency,
      outbox,
    );
    for (const [operation, input] of [
      ['IMPORT', { driveObjectId: 'drive-file' }],
      [
        'EXPORT',
        {
          fileSimplyId: 'FILE-TEST-0001',
          versionNumber: 2,
          destinationDriveFolderId: 'folder',
          name: 'export.txt',
        },
      ],
      ['RECONCILE', {}],
      [
        'NOTIFICATION',
        {
          channelId: 'channel',
          resourceId: 'resource',
          channelTokenSha256: 'd'.repeat(64),
          messageNumber: '1',
          resourceState: 'change',
        },
      ],
      ['REVOKE_GOOGLE', {}],
      ['UNINSTALL', { deletionDecision: 'DELETE_APP_DATA' }],
    ]) {
      await worker.handle({
        schemaVersion: 1,
        outboxKey: 'f'.repeat(64),
        installationSimplyId: registration.installationSimplyId,
        idempotencyKey: `worker-${operation}`,
        requestFingerprint: 'a'.repeat(64),
        operation,
        input,
        createdAt: '2026-07-28T12:00:00.000Z',
      });
    }
    assert.ok(calls.some(([name]) => name === 'suspend'));
    assert.ok(calls.some(([name]) => name === 'uninstall'));
  });
});

describe('dependency-free AWS transport', () => {
  test('signs exact endpoints and parses bounded JSON protocol responses', async () => {
    const calls = [];
    const http = new AwsSignedHttpClient({
      credentials: () => ({
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret',
        sessionToken: 'session',
      }),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('{"Item":{"pk":{"S":"ok"}}}', {
          headers: { 'content-type': 'application/x-amz-json-1.0' },
        });
      },
    });
    const client = new AwsJsonProtocolClient('us-east-1', http);
    const result = await client.call(
      'dynamodb',
      'DynamoDB_20120810.GetItem',
      { TableName: 'table', Key: { pk: { S: 'key' } } },
    );
    assert.equal(result.Item.pk.S, 'ok');
    assert.equal(calls[0].url, 'https://dynamodb.us-east-1.amazonaws.com/');
    assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 /u);
    assert.equal(calls[0].init.headers['x-amz-security-token'], 'session');
    assert.throws(
      () => awsCredentialsFromEnvironment({}),
      /unavailable/u,
    );
    await assert.rejects(
      new AwsSignedHttpClient({
        credentials: () => ({
          accessKeyId: 'key',
          secretAccessKey: 'secret',
        }),
        fetch: async () =>
          new Response('{"__type":"x#ConditionalCheckFailedException"}', {
            status: 400,
          }),
      }).json({
        service: 'dynamodb',
        region: 'us-east-1',
        url: 'https://dynamodb.us-east-1.amazonaws.com/',
      }),
      (error) =>
        error instanceof AwsServiceError &&
        error.code === 'ConditionalCheckFailedException',
    );
  });

  test('persists state, idempotency, authority, secrets, and outbox work', async () => {
    const client = new MemoryAws();
    const { state, runtime } = await harness();
    const durable = new DynamoDbInstallationStateStore('state', client);
    const snapshot = state.states.get(registration.installationSimplyId);
    assert.equal(
      await durable.load(registration.installationSimplyId),
      undefined,
    );
    await durable.save(registration.installationSimplyId, snapshot);
    assert.equal(
      (await durable.load(registration.installationSimplyId)).status,
      'PENDING_SETUP',
    );

    const idempotency = new DynamoDbIdempotency('idempotency', client, {
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    const fingerprint = 'b'.repeat(64);
    const first = await idempotency.run(
      'test',
      'idempotency-key',
      fingerprint,
      async () => ({ ok: true }),
    );
    const replay = await idempotency.run(
      'test',
      'idempotency-key',
      fingerprint,
      async () => {
        throw new Error('must not run');
      },
    );
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.value, { ok: true });

    const authority = new DynamoDbAuthorityIndex(
      'authority',
      client,
      () => new Date('2026-07-28T12:00:00.000Z'),
    );
    await authority.putOAuthState(
      'oauth-secret-state',
      registration.installationSimplyId,
      '2026-07-28T12:10:00.000Z',
    );
    assert.equal(
      await authority.consumeOAuthState('oauth-secret-state'),
      registration.installationSimplyId,
    );
    await authority.putNotificationChannel(
      'channel-id',
      registration.installationSimplyId,
      '2026-07-28T12:10:00.000Z',
    );
    assert.equal(
      await authority.installationForNotificationChannel('channel-id'),
      registration.installationSimplyId,
    );
    await authority.putRetentionDecision(
      registration.installationSimplyId,
      'DELETE_APP_DATA',
      'delete-request',
    );
    assert.equal(
      await authority.retentionDecision(registration.installationSimplyId),
      'DELETE_APP_DATA',
    );

    const sent = [];
    const outbox = new DynamoDbOutbox(
      'outbox',
      client,
      { async send(work) { sent.push(work); } },
      { now: () => new Date('2026-07-28T12:00:00.000Z') },
    );
    const queued = await outbox.enqueue({
      installationSimplyId: registration.installationSimplyId,
      idempotencyKey: 'queue-request',
      requestFingerprint: 'c'.repeat(64),
      operation: 'RECONCILE',
      payload: {},
    });
    assert.equal(queued.replayed, false);
    assert.equal(sent.length, 1);
    await outbox.complete(queued.outboxKey);
    assert.equal(await outbox.dispatchPending(), 0);

    assert.deepEqual(
      await new SecretsManagerSecretReader(client).json('secret-arn'),
      { clientId: 'client' },
    );
    void runtime;
  });
});
