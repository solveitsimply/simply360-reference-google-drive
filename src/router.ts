import {
  ConcurrentStateUpdateError,
  IdempotencyConflictError,
  OperationInProgressError,
  type DynamoDbAuthorityIndex,
  type DynamoDbIdempotency,
  type DynamoDbOutbox,
  type WorkEnvelope,
} from './aws-state.js';
import { AwsServiceError } from './aws.js';
import type {
  InstallationRegistration,
  NotificationHeaders,
  PickerSelection,
} from './contracts.js';
import { sha256Hex } from './crypto.js';
import {
  parseLifecycleOccurrence,
  type LifecycleOccurrence,
} from './public-lifecycle-contract.js';
import {
  GoogleDriveReferenceRuntime,
  ReferenceRuntimeError,
  type AuthorizedNotification,
} from './runtime.js';
import {
  verifyWebhookV2,
  type WebhookSigningKey,
} from './webhook-v2.js';

const MAXIMUM_BODY_BYTES = 512 * 1024;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new Error(`${label} contains an unknown property`);
  }
};

const text = (
  value: Record<string, unknown>,
  key: string,
  label = 'request',
): string => {
  const found = value[key];
  if (typeof found !== 'string' || found.length < 1 || found.length > 4096) {
    throw new Error(`${label}.${key} is required`);
  }
  return found;
};

const jsonResponse = (status: number, value: unknown): Response =>
  new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const readJson = async (
  request: Request,
): Promise<{ readonly raw: string; readonly value: Record<string, unknown> }> => {
  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new Error('content type must be application/json');
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAXIMUM_BODY_BYTES) {
    throw new Error('request body exceeds the configured byte limit');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!record(parsed)) throw new Error('request body must be a JSON object');
  return { raw, value: parsed };
};

const idempotencyKey = (request: Request): string => {
  const value = request.headers.get('idempotency-key');
  if (!value || !/^[A-Za-z0-9._:-]{16,256}$/u.test(value)) {
    throw new Error('a valid idempotency-key header is required');
  }
  return value;
};

const pathSegments = (pathname: string): string[] =>
  pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

const parseRegistration = (
  value: Record<string, unknown>,
): InstallationRegistration => {
  exactKeys(
    value,
    [
      'installationSimplyId',
      'teamSimplyId',
      'appVersion',
      'credential',
      'setupCallbackUrl',
    ],
    'installation registration',
  );
  if (!record(value.credential)) {
    throw new Error('installation registration credential is invalid');
  }
  exactKeys(
    value.credential,
    ['accessToken', 'refreshToken', 'expiresAt', 'scopes'],
    'installation credential',
  );
  if (
    !Array.isArray(value.credential.scopes) ||
    value.credential.scopes.some((scope) => typeof scope !== 'string')
  ) {
    throw new Error('installation credential scopes are invalid');
  }
  return {
    installationSimplyId: text(value, 'installationSimplyId'),
    teamSimplyId: text(value, 'teamSimplyId'),
    appVersion: text(value, 'appVersion'),
    credential: {
      accessToken: text(value.credential, 'accessToken', 'credential'),
      ...(typeof value.credential.refreshToken === 'string'
        ? { refreshToken: value.credential.refreshToken }
        : {}),
      expiresAt: text(value.credential, 'expiresAt', 'credential'),
      scopes: value.credential.scopes as InstallationRegistration['credential']['scopes'],
    },
    setupCallbackUrl: text(value, 'setupCallbackUrl'),
  };
};

export interface InstallationRequestAuthorizer {
  authorize(
    installationSimplyId: string,
    authorizationHeader: string,
  ): Promise<void>;
}

export interface ReferenceRouterDependencies {
  readonly runtime: GoogleDriveReferenceRuntime;
  readonly authority: DynamoDbAuthorityIndex;
  readonly idempotency: DynamoDbIdempotency;
  readonly outbox: DynamoDbOutbox;
  readonly installationAuthorizer: InstallationRequestAuthorizer;
  readonly lifecycleSigningKeys: readonly WebhookSigningKey[];
  readonly enableBootstrap?: boolean;
}

export class GoogleDriveReferenceRouter {
  public constructor(private readonly dependencies: ReferenceRouterDependencies) {}

  public async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const segments = pathSegments(url.pathname);
      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse(200, { status: 'ok' });
      }
      if (request.method === 'POST' && url.pathname === '/installations') {
        if (!this.dependencies.enableBootstrap) {
          return jsonResponse(404, { error: 'NOT_FOUND' });
        }
        const body = await readJson(request);
        const registration = parseRegistration(body.value);
        const result = await this.dependencies.idempotency.run(
          'registration',
          idempotencyKey(request),
          sha256Hex(body.raw),
          () => this.dependencies.runtime.registerInstallation(registration),
        );
        return jsonResponse(result.replayed ? 200 : 201, {
          ...result.value,
          replayed: result.replayed,
        });
      }
      if (request.method === 'GET' && url.pathname === '/setup') {
        const installationSimplyId =
          url.searchParams.get('installationSimplyId') ?? '';
        await this.authorize(request, installationSimplyId);
        return jsonResponse(
          200,
          await this.dependencies.runtime.getSnapshot(installationSimplyId),
        );
      }
      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'installations' &&
        segments[2] === 'google' &&
        segments[3] === 'start'
      ) {
        const installationSimplyId = segments[1] as string;
        await this.authorize(request, installationSimplyId);
        const started =
          await this.dependencies.runtime.beginGoogleConnection(
            installationSimplyId,
          );
        await this.dependencies.authority.putOAuthState(
          started.state,
          installationSimplyId,
          started.expiresAt,
        );
        // One-time OAuth state is returned once and never copied into the
        // general idempotency result table.
        return jsonResponse(200, started);
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/oauth/google/callback'
      ) {
        const state = url.searchParams.get('state') ?? '';
        const authorizationCode = url.searchParams.get('code') ?? '';
        if (!state || !authorizationCode) {
          throw new Error('Google OAuth state and code are required');
        }
        const installationSimplyId =
          await this.dependencies.authority.consumeOAuthState(state);
        await this.dependencies.runtime.connectGoogle(installationSimplyId, {
          state,
          authorizationCode,
        });
        const snapshot =
          await this.dependencies.runtime.activateInstallation(
            installationSimplyId,
          );
        return jsonResponse(200, snapshot);
      }
      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'installations' &&
        segments[2] === 'picker' &&
        segments[3] === 'session'
      ) {
        const installationSimplyId = segments[1] as string;
        await this.authorize(request, installationSimplyId);
        return jsonResponse(
          200,
          await this.dependencies.runtime.createPickerSession(
            installationSimplyId,
          ),
        );
      }
      if (
        request.method === 'POST' &&
        segments.length === 3 &&
        segments[0] === 'installations' &&
        segments[2] === 'selections'
      ) {
        const installationSimplyId = segments[1] as string;
        await this.authorize(request, installationSimplyId);
        const body = await readJson(request);
        exactKeys(body.value, ['selection', 'direction'], 'selection request');
        if (
          !record(body.value.selection) ||
          (body.value.direction !== 'SOURCE' &&
            body.value.direction !== 'DESTINATION')
        ) {
          throw new Error('selection request is invalid');
        }
        const result = await this.dependencies.idempotency.run(
          'selection',
          idempotencyKey(request),
          sha256Hex(body.raw),
          () =>
            this.dependencies.runtime.recordPickerSelection(
              installationSimplyId,
              body.value.selection as unknown as PickerSelection,
              body.value.direction as 'SOURCE' | 'DESTINATION',
            ),
        );
        return jsonResponse(200, {
          ...result.value,
          replayed: result.replayed,
        });
      }
      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'installations' &&
        segments[2] === 'notifications' &&
        segments[3] === 'start'
      ) {
        const installationSimplyId = segments[1] as string;
        await this.authorize(request, installationSimplyId);
        const key = idempotencyKey(request);
        const result = await this.dependencies.idempotency.run(
          'notification-start',
          key,
          sha256Hex(`${installationSimplyId}\n${key}`),
          async () => {
            const channel =
              await this.dependencies.runtime.startChangeNotifications(
                installationSimplyId,
              );
            await this.dependencies.authority.putNotificationChannel(
              channel.channelId,
              installationSimplyId,
              channel.expiresAt,
            );
            return {
              channelId: channel.channelId,
              resourceId: channel.resourceId,
              expiresAt: channel.expiresAt,
            };
          },
        );
        return jsonResponse(200, { ...result.value, replayed: result.replayed });
      }
      if (
        request.method === 'POST' &&
        segments.length === 3 &&
        segments[0] === 'installations' &&
        ['imports', 'exports', 'reconcile'].includes(segments[2] as string)
      ) {
        const installationSimplyId = segments[1] as string;
        await this.authorize(request, installationSimplyId);
        const body = await readJson(request);
        const operation =
          segments[2] === 'imports'
            ? 'IMPORT'
            : segments[2] === 'exports'
              ? 'EXPORT'
              : 'RECONCILE';
        const key = idempotencyKey(request);
        const fingerprint = sha256Hex(body.raw);
        const queued = await this.dependencies.outbox.enqueue({
          installationSimplyId,
          idempotencyKey: key,
          requestFingerprint: fingerprint,
          operation,
          payload: body.value,
        });
        return jsonResponse(202, queued);
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/google/drive/notifications'
      ) {
        const headers = this.notificationHeaders(request);
        const installationSimplyId =
          await this.dependencies.authority.installationForNotificationChannel(
            headers.channelId,
          );
        const authorized =
          await this.dependencies.runtime.authorizeChangeNotification(
            installationSimplyId,
            headers,
          );
        const fingerprint = sha256Hex(JSON.stringify(authorized));
        const queued = await this.dependencies.outbox.enqueue({
          installationSimplyId,
          idempotencyKey: `google-notification:${headers.channelId}:${headers.messageNumber}`,
          requestFingerprint: fingerprint,
          operation: 'NOTIFICATION',
          payload: { ...authorized },
        });
        return jsonResponse(202, queued);
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/simply360/lifecycle'
      ) {
        return this.lifecycle(request);
      }
      return jsonResponse(404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonResponse(409, {
          error: 'IDEMPOTENCY_CONFLICT',
          message: error.message,
        });
      }
      if (error instanceof OperationInProgressError) {
        return new Response(
          `${JSON.stringify({
            error: 'OPERATION_IN_PROGRESS',
            message: error.message,
          })}\n`,
          {
            status: 409,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'retry-after': String(error.retryAfterSeconds),
            },
          },
        );
      }
      if (error instanceof ConcurrentStateUpdateError) {
        return new Response(
          `${JSON.stringify({
            error: 'CONCURRENT_STATE_UPDATE',
            message: error.message,
          })}\n`,
          {
            status: 409,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'retry-after': '1',
            },
          },
        );
      }
      if (error instanceof AwsServiceError) {
        return new Response(
          `${JSON.stringify({
            error: 'DEPENDENCY_UNAVAILABLE',
            message: 'A required AWS service is temporarily unavailable',
          })}\n`,
          {
            status: 503,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'retry-after': '1',
            },
          },
        );
      }
      if (error instanceof ReferenceRuntimeError) {
        const status =
          error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'NOT_AUTHORIZED'
              ? 403
              : 409;
        return jsonResponse(status, { error: error.code, message: error.message });
      }
      return jsonResponse(400, {
        error: 'REQUEST_REJECTED',
        message: error instanceof Error ? error.message : 'request failed',
      });
    }
  }

  private async lifecycle(request: Request): Promise<Response> {
    const contentType = request.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      throw new Error('lifecycle content type must be application/json');
    }
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAXIMUM_BODY_BYTES) {
      throw new Error('lifecycle body exceeds the configured byte limit');
    }
    const verified = verifyWebhookV2({
      rawBody,
      signatureHeader: request.headers.get('x-s360-signature') ?? '',
      keys: this.dependencies.lifecycleSigningKeys,
    });
    const occurrence = parseLifecycleOccurrence(
      JSON.parse(rawBody) as unknown,
    );
    if (verified.eventId !== occurrence.eventSimplyId) {
      throw new Error('signed event identity does not match the occurrence');
    }
    const snapshot = await this.dependencies.runtime.getSnapshot(
      occurrence.teamIntegrationSimplyId,
    );
    if (snapshot.teamSimplyId !== occurrence.teamSimplyId) {
      throw new Error('lifecycle occurrence does not belong to the installation');
    }
    const dedupeKey = `${verified.eventId}:${verified.deliveryId}`;
    const result = await this.dependencies.idempotency.run(
      'lifecycle',
      dedupeKey,
      verified.bodySha256Hex,
      () => this.applyLifecycle(occurrence),
    );
    return jsonResponse(200, { ...result.value, replayed: result.replayed });
  }

  private async applyLifecycle(
    occurrence: LifecycleOccurrence,
  ): Promise<Record<string, unknown>> {
    const installationSimplyId = occurrence.teamIntegrationSimplyId;
    if (occurrence.eventType === 'app.suspended') {
      return {
        ...(await this.dependencies.runtime.suspend(installationSimplyId)),
      };
    }
    if (occurrence.eventType === 'app.grant.revoked') {
      const queued = await this.dependencies.outbox.enqueue({
        installationSimplyId,
        idempotencyKey: occurrence.payload.idempotencyKey,
        requestFingerprint: sha256Hex(JSON.stringify(occurrence.payload)),
        operation: 'REVOKE_GOOGLE',
        payload: {},
      });
      return { outcome: 'ACCEPTED', ...queued };
    }
    if (occurrence.eventType === 'app.dataDeletion.requested') {
      await this.dependencies.authority.putRetentionDecision(
        installationSimplyId,
        'DELETE_APP_DATA',
        occurrence.payload.idempotencyKey,
      );
      return { outcome: 'DELETION_DECISION_RECORDED' };
    }
    if (occurrence.eventType === 'app.dataExport.requested') {
      throw new ReferenceRuntimeError(
        'NOT_AUTHORIZED',
        'Data export delivery is not available until the public lifecycle client is published',
      );
    }
    const decision =
      await this.dependencies.authority.retentionDecision(
        installationSimplyId,
      );
    if (!decision) {
      throw new ReferenceRuntimeError(
        'INVALID_STATE',
        'Uninstall requires a prior signed retention decision',
      );
    }
    const queued = await this.dependencies.outbox.enqueue({
      installationSimplyId,
      idempotencyKey: occurrence.payload.idempotencyKey,
      requestFingerprint: sha256Hex(JSON.stringify(occurrence.payload)),
      operation: 'UNINSTALL',
      payload: { deletionDecision: decision },
    });
    return { outcome: 'ACCEPTED', ...queued };
  }

  private async authorize(
    request: Request,
    installationSimplyId: string,
  ): Promise<void> {
    if (!installationSimplyId) throw new Error('installationSimplyId is required');
    await this.dependencies.installationAuthorizer.authorize(
      installationSimplyId,
      request.headers.get('authorization') ?? '',
    );
  }

  private notificationHeaders(request: Request): NotificationHeaders {
    const headers = {
      channelId: request.headers.get('x-goog-channel-id') ?? '',
      resourceId: request.headers.get('x-goog-resource-id') ?? '',
      channelToken: request.headers.get('x-goog-channel-token') ?? '',
      messageNumber: request.headers.get('x-goog-message-number') ?? '',
      resourceState: request.headers.get('x-goog-resource-state') ?? '',
    };
    if (Object.values(headers).some((value) => value.length < 1 || value.length > 4096)) {
      throw new Error('Google notification headers are incomplete or oversized');
    }
    return headers;
  }
}

export class GoogleDriveWorkHandler {
  public constructor(
    private readonly runtime: GoogleDriveReferenceRuntime,
    private readonly idempotency: DynamoDbIdempotency,
    private readonly outbox: DynamoDbOutbox,
  ) {}

  public async handle(work: WorkEnvelope): Promise<void> {
    const result = await this.idempotency.run(
      'work',
      work.idempotencyKey,
      work.requestFingerprint,
      () => this.perform(work),
    );
    void result;
    await this.outbox.complete(work.outboxKey);
  }

  private async perform(work: WorkEnvelope): Promise<unknown> {
    const input = work.input;
    switch (work.operation) {
      case 'IMPORT':
        exactKeys(input as Record<string, unknown>, ['driveObjectId'], 'import work');
        return this.runtime.importSelectedFile(
          work.installationSimplyId,
          text(input as Record<string, unknown>, 'driveObjectId', 'import work'),
        );
      case 'EXPORT': {
        exactKeys(
          input as Record<string, unknown>,
          [
            'fileSimplyId',
            'versionNumber',
            'destinationDriveFolderId',
            'name',
          ],
          'export work',
        );
        const versionNumber = input.versionNumber;
        if (
          versionNumber !== undefined &&
          (!Number.isSafeInteger(versionNumber) || (versionNumber as number) < 1)
        ) {
          throw new Error('export versionNumber is invalid');
        }
        return this.runtime.exportFile(work.installationSimplyId, {
          fileSimplyId: text(
            input as Record<string, unknown>,
            'fileSimplyId',
            'export work',
          ),
          destinationDriveFolderId: text(
            input as Record<string, unknown>,
            'destinationDriveFolderId',
            'export work',
          ),
          ...(versionNumber === undefined
            ? {}
            : { versionNumber: versionNumber as number }),
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
        });
      }
      case 'RECONCILE':
        exactKeys(input as Record<string, unknown>, [], 'reconcile work');
        return this.runtime.reconcile(work.installationSimplyId);
      case 'NOTIFICATION':
        exactKeys(
          input as Record<string, unknown>,
          [
            'channelId',
            'resourceId',
            'channelTokenSha256',
            'messageNumber',
            'resourceState',
          ],
          'notification work',
        );
        return this.runtime.handleAuthorizedChangeNotification(
          work.installationSimplyId,
          input as unknown as AuthorizedNotification,
        );
      case 'REVOKE_GOOGLE':
        exactKeys(input as Record<string, unknown>, [], 'revocation work');
        return this.runtime.revokeGoogleConnection(work.installationSimplyId);
      case 'UNINSTALL': {
        exactKeys(
          input as Record<string, unknown>,
          ['deletionDecision'],
          'uninstall work',
        );
        if (
          input.deletionDecision !== 'DELETE_APP_DATA' &&
          input.deletionDecision !== 'RETAIN_DISCLOSED_DATA'
        ) {
          throw new Error('uninstall deletion decision is invalid');
        }
        return this.runtime.uninstall(
          work.installationSimplyId,
          input.deletionDecision,
        );
      }
    }
  }
}
