import {
  DynamoDbAuthorityIndex,
  DynamoDbIdempotency,
  DynamoDbInstallationStateStore,
  DynamoDbOutbox,
  SecretsManagerSecretReader,
  configuredAwsClients,
  parseWorkEnvelope,
} from './aws-state.js';
import { loadReferenceAppConfig } from './config.js';
import { constantTimeEqual } from './crypto.js';
import { GoogleDriveHttpClient } from './google-http.js';
import type {
  Clock,
  Simply360Port,
  TelemetrySink,
} from './ports.js';
import {
  GoogleDriveReferenceRouter,
  GoogleDriveWorkHandler,
  type InstallationRequestAuthorizer,
} from './router.js';
import { GoogleDriveReferenceRuntime } from './runtime.js';
import { SecureIdGenerator } from './crypto.js';
import { Simply360PublicFilePort } from './simply360-http.js';
import type { InstallationState } from './state.js';
import type { TelemetryEvent } from './contracts.js';
import type { WebhookSigningKey } from './webhook-v2.js';

interface ApiGatewayV2Event {
  readonly version: string;
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly requestContext: { readonly http: { readonly method: string } };
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

interface SqsEvent {
  readonly Records: readonly {
    readonly messageId: string;
    readonly eventSource: string;
    readonly body: string;
  }[];
}

interface ScheduledEvent {
  readonly source: 'aws.events';
}

interface LambdaResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: false;
}

interface RuntimeComposition {
  readonly router: GoogleDriveReferenceRouter;
  readonly worker: GoogleDriveWorkHandler;
  readonly outbox: DynamoDbOutbox;
}

const required = (environment: NodeJS.ProcessEnv, key: string): string => {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${key}.`);
  return value;
};

const secretText = (
  value: Record<string, unknown>,
  key: string,
  label: string,
): string => {
  const found = value[key];
  if (typeof found !== 'string' || found.length < 1 || found.length > 8192) {
    throw new Error(`${label}.${key} is required`);
  }
  return found;
};

const lifecycleKeys = (
  secret: Record<string, unknown>,
): readonly WebhookSigningKey[] => {
  const found = secret.lifecycleWebhookKeys;
  if (!Array.isArray(found) || found.length < 1 || found.length > 2) {
    throw new Error('Simply360 secret requires one or two lifecycleWebhookKeys');
  }
  const keys = found.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('lifecycle webhook key is invalid');
    }
    const value = candidate as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => key !== 'keyId' && key !== 'secret')
    ) {
      throw new Error('lifecycle webhook key contains an unknown property');
    }
    return {
      kid: secretText(value, 'keyId', 'lifecycle webhook key'),
      secret: secretText(value, 'secret', 'lifecycle webhook key'),
    };
  });
  if (
    new Set(keys.map(({ kid }) => kid)).size !== keys.length ||
    keys.some(({ secret }) => Buffer.byteLength(secret) < 32)
  ) {
    throw new Error('lifecycle webhook keys are duplicate or undersized');
  }
  return keys;
};

class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

class StructuredTelemetry implements TelemetrySink {
  public async emit(event: TelemetryEvent): Promise<void> {
    // Runtime telemetry contracts contain only public identifiers, hashes,
    // counts, and outcomes. Provider bodies and credential material never
    // reach this sink.
    process.stdout.write(`${JSON.stringify({ kind: 'telemetry', ...event })}\n`);
  }
}

class UnavailableLifecycleClient
  implements Pick<
    Simply360Port,
    'completeSetup' | 'reportProviderHealth' | 'recordUpgrade' | 'completeUninstall'
  >
{
  private unavailable(): never {
    throw new Error(
      'Simply360 public lifecycle client is not yet published; operation fails closed',
    );
  }

  public async completeSetup(): Promise<void> {
    this.unavailable();
  }

  public async reportProviderHealth(): Promise<void> {
    this.unavailable();
  }

  public async recordUpgrade(): Promise<void> {
    this.unavailable();
  }

  public async completeUninstall(): Promise<void> {
    this.unavailable();
  }
}

class BearerInstallationAuthorizer implements InstallationRequestAuthorizer {
  public constructor(
    private readonly state: DynamoDbInstallationStateStore,
  ) {}

  public async authorize(
    installationSimplyId: string,
    authorizationHeader: string,
  ): Promise<void> {
    if (!authorizationHeader.startsWith('Bearer ')) {
      throw new Error('installation bearer authorization is required');
    }
    const token = authorizationHeader.slice('Bearer '.length);
    const installation = await this.state.load(installationSimplyId);
    if (
      !installation ||
      token.length < 16 ||
      new Date(installation.installation.credential.expiresAt).getTime() <=
        Date.now() ||
      !constantTimeEqual(installation.installation.credential.accessToken, token)
    ) {
      throw new Error('installation bearer authorization is invalid');
    }
  }
}

let compositionPromise: Promise<RuntimeComposition> | undefined;

const compose = async (
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeComposition> => {
  const clients = configuredAwsClients(environment);
  const secrets = new SecretsManagerSecretReader(clients.json);
  const [googleSecret, simplySecret] = await Promise.all([
    secrets.json(required(environment, 'GOOGLE_SECRET_ARN')),
    secrets.json(required(environment, 'SIMPLY360_SECRET_ARN')),
  ]);
  const config = loadReferenceAppConfig({
    ...environment,
    GOOGLE_CLIENT_ID: secretText(googleSecret, 'clientId', 'Google secret'),
    GOOGLE_CLIENT_SECRET: secretText(
      googleSecret,
      'clientSecret',
      'Google secret',
    ),
    GOOGLE_PICKER_APP_ID: secretText(
      googleSecret,
      'pickerAppId',
      'Google secret',
    ),
    GOOGLE_PICKER_DEVELOPER_KEY: secretText(
      googleSecret,
      'pickerDeveloperKey',
      'Google secret',
    ),
  });
  const state = new DynamoDbInstallationStateStore(
    required(environment, 'STATE_TABLE_NAME'),
    clients.json,
  );
  const idempotency = new DynamoDbIdempotency(
    required(environment, 'IDEMPOTENCY_TABLE_NAME'),
    clients.json,
  );
  const authority = new DynamoDbAuthorityIndex(
    required(environment, 'AUTHORITY_TABLE_NAME'),
    clients.json,
  );
  const outbox = new DynamoDbOutbox(
    required(environment, 'OUTBOX_TABLE_NAME'),
    clients.json,
    clients.queue,
  );
  const simply = new Simply360PublicFilePort({
    apiBaseUrl: config.simply360ApiBaseUrl,
    trustedTransferOrigins: config.simply360TransferOrigins,
    maximumTransferBytes: config.maximumTransferBytes,
    lifecycle: new UnavailableLifecycleClient(),
  });
  const runtime = new GoogleDriveReferenceRuntime(
    {
      clock: new SystemClock(),
      ids: new SecureIdGenerator(),
      google: new GoogleDriveHttpClient({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        pickerAppId: config.googlePickerAppId,
        pickerDeveloperKey: config.googlePickerDeveloperKey,
        publicOrigin: config.publicOrigin,
        redirectUri: config.googleRedirectUri,
        maximumDownloadBytes: config.maximumTransferBytes,
        maximumUploadBytes: config.maximumTransferBytes,
        maximumUploadChunkBytes: config.uploadChunkBytes,
      }),
      simply360: simply,
      state,
      telemetry: new StructuredTelemetry(),
    },
    {
      uploadChunkBytes: config.uploadChunkBytes,
      maximumTransferBytes: config.maximumTransferBytes,
      notificationTtlSeconds: config.notificationTtlSeconds,
      googleRedirectUri: config.googleRedirectUri,
    },
  );
  return {
    router: new GoogleDriveReferenceRouter({
      runtime,
      authority,
      idempotency,
      outbox,
      installationAuthorizer: new BearerInstallationAuthorizer(state),
      lifecycleSigningKeys: lifecycleKeys(simplySecret),
      enableBootstrap: environment.ENABLE_INSTALLATION_BOOTSTRAP === 'true',
    }),
    worker: new GoogleDriveWorkHandler(runtime, idempotency, outbox),
    outbox,
  };
};

const isApiEvent = (event: unknown): event is ApiGatewayV2Event =>
  Boolean(
    event &&
      typeof event === 'object' &&
      (event as { version?: unknown }).version === '2.0',
  );

const isSqsEvent = (event: unknown): event is SqsEvent =>
  Boolean(
    event &&
      typeof event === 'object' &&
      Array.isArray((event as { Records?: unknown }).Records),
  );

const isScheduledEvent = (event: unknown): event is ScheduledEvent =>
  Boolean(
    event &&
      typeof event === 'object' &&
      (event as { source?: unknown }).source === 'aws.events',
  );

const apiRequest = (
  event: ApiGatewayV2Event,
  publicOrigin: string,
): Request => {
  if (!event.rawPath.startsWith('/') || event.rawPath.length > 4096) {
    throw new Error('API path is invalid');
  }
  const body =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
  return new Request(
    `${publicOrigin}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`,
    {
      method: event.requestContext.http.method,
      headers: Object.entries(event.headers ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]],
      ),
      ...(body === undefined ? {} : { body }),
    },
  );
};

const apiResponse = async (response: Response): Promise<LambdaResponse> => ({
  statusCode: response.status,
  headers: Object.fromEntries(response.headers.entries()),
  body: await response.text(),
  isBase64Encoded: false,
});

export const handler = async (event: unknown): Promise<unknown> => {
  const composition = await (compositionPromise ??= compose());
  if (isApiEvent(event)) {
    return apiResponse(
      await composition.router.handle(
        apiRequest(event, required(process.env, 'PUBLIC_ORIGIN')),
      ),
    );
  }
  if (isScheduledEvent(event)) {
    return { dispatched: await composition.outbox.dispatchPending(25) };
  }
  if (isSqsEvent(event)) {
    const failures: { itemIdentifier: string }[] = [];
    for (const message of event.Records) {
      if (message.eventSource !== 'aws:sqs') {
        throw new Error('unsupported record source');
      }
      try {
        if (Buffer.byteLength(message.body) > 64 * 1024) {
          throw new Error('work message exceeds the configured byte limit');
        }
        await composition.worker.handle(
          parseWorkEnvelope(JSON.parse(message.body) as unknown),
        );
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            kind: 'work-failure',
            messageId: message.messageId,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { name: 'UnknownError', message: 'work failed' },
          })}\n`,
        );
        failures.push({ itemIdentifier: message.messageId });
      }
    }
    return { batchItemFailures: failures };
  }
  throw new Error('unsupported Lambda event');
};
