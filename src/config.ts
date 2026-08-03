import { GOOGLE_DRIVE_SCOPE } from './contracts.js';

export interface ReferenceAppConfig {
  readonly environment: 'dev' | 'test';
  readonly simply360ApiBaseUrl: string;
  readonly simply360TransferOrigins: readonly string[];
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly googlePickerAppId: string;
  readonly googlePickerDeveloperKey: string;
  readonly publicOrigin: string;
  readonly googleRedirectUri: string;
  readonly googleScope: typeof GOOGLE_DRIVE_SCOPE;
  readonly uploadChunkBytes: number;
  readonly maximumTransferBytes: number;
  readonly notificationTtlSeconds: number;
}

const required = (environment: NodeJS.ProcessEnv, key: string): string => {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${key}.`);
  return value;
};

const exactHttpsOrigin = (value: string, label: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label} must be an exact HTTPS origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
};

const positiveInteger = (value: string | undefined, fallback: number, label: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
};

const transferOrigins = (value: string): readonly string[] => {
  const origins = value
    .split(',')
    .map((candidate) => exactHttpsOrigin(candidate.trim(), 'SIMPLY360_TRANSFER_ORIGINS'))
    .filter(Boolean);
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new Error('SIMPLY360_TRANSFER_ORIGINS must contain unique exact HTTPS origins.');
  }
  return origins;
};

export const loadReferenceAppConfig = (environment: NodeJS.ProcessEnv): ReferenceAppConfig => {
  const runtimeEnvironment = required(environment, 'REFERENCE_ENVIRONMENT');
  if (runtimeEnvironment !== 'dev' && runtimeEnvironment !== 'test') {
    throw new Error('REFERENCE_ENVIRONMENT must be dev or test; production is not authorized by this proof.');
  }
  const configuredScope = environment.GOOGLE_OAUTH_SCOPE?.trim() ?? GOOGLE_DRIVE_SCOPE;
  if (configuredScope !== GOOGLE_DRIVE_SCOPE) {
    throw new Error(`Only ${GOOGLE_DRIVE_SCOPE} is authorized.`);
  }

  const publicOrigin = exactHttpsOrigin(required(environment, 'PUBLIC_ORIGIN'), 'PUBLIC_ORIGIN');
  return {
    environment: runtimeEnvironment,
    simply360ApiBaseUrl: exactHttpsOrigin(required(environment, 'SIMPLY360_API_BASE_URL'), 'SIMPLY360_API_BASE_URL'),
    simply360TransferOrigins: transferOrigins(required(environment, 'SIMPLY360_TRANSFER_ORIGINS')),
    googleClientId: required(environment, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: required(environment, 'GOOGLE_CLIENT_SECRET'),
    googlePickerAppId: required(environment, 'GOOGLE_PICKER_APP_ID'),
    googlePickerDeveloperKey: required(environment, 'GOOGLE_PICKER_DEVELOPER_KEY'),
    publicOrigin,
    googleRedirectUri: `${publicOrigin}/oauth/google/callback`,
    googleScope: GOOGLE_DRIVE_SCOPE,
    uploadChunkBytes: positiveInteger(environment.UPLOAD_CHUNK_BYTES, 8 * 1024 * 1024, 'UPLOAD_CHUNK_BYTES'),
    maximumTransferBytes: positiveInteger(environment.MAXIMUM_TRANSFER_BYTES, 100 * 1024 * 1024, 'MAXIMUM_TRANSFER_BYTES'),
    notificationTtlSeconds: positiveInteger(environment.NOTIFICATION_TTL_SECONDS, 6 * 24 * 60 * 60, 'NOTIFICATION_TTL_SECONDS'),
  };
};
