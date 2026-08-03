import type {
  ExternalFileLink,
  GoogleCredential,
  InstallationRegistration,
  InstallationStatus,
  NotificationChannel,
} from './contracts.js';
import type { ExplicitSelection } from './ports.js';

export interface StoredNotification {
  readonly channel: Omit<NotificationChannel, 'channelToken'>;
  readonly channelTokenSha256: string;
  readonly lastMessageNumber?: string;
}

export interface PendingExport {
  readonly operationKey: string;
  readonly uploadId: string;
  readonly nextOffset: number;
  readonly destinationDriveFolderId: string;
  readonly simply360FileSimplyId: string;
  readonly simply360VersionNumber: number;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256Base64: string;
}

export interface PendingGoogleAuthorization {
  readonly stateSha256: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
}

export interface InstallationState {
  readonly installation: InstallationRegistration;
  readonly status: InstallationStatus;
  readonly googleCredential?: GoogleCredential;
  readonly googleConnectionStatus?: 'ACTIVE' | 'REVOKED';
  readonly pendingGoogleAuthorization?: PendingGoogleAuthorization;
  readonly selections: readonly ExplicitSelection[];
  readonly links: readonly ExternalFileLink[];
  readonly notifications: readonly StoredNotification[];
  readonly pendingExports: readonly PendingExport[];
  readonly changeCursor?: string;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export class InMemoryStateStore {
  readonly states = new Map<string, InstallationState>();

  async load(installationSimplyId: string): Promise<InstallationState | undefined> {
    return structuredClone(this.states.get(installationSimplyId));
  }

  async save(installationSimplyId: string, state: InstallationState): Promise<void> {
    this.states.set(installationSimplyId, structuredClone(state));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const requiredText = (
  value: Record<string, unknown>,
  key: string,
  label: string,
): string => {
  const found = value[key];
  if (typeof found !== 'string' || found.length < 1 || found.length > 4096) {
    throw new Error(`${label}.${key} is invalid`);
  }
  return found;
};

const validDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));

const assertCredential = (
  value: unknown,
  label: string,
  google: boolean,
): void => {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  exactKeys(
    value,
    google
      ? [
          'accessToken',
          'refreshToken',
          'expiresAt',
          'grantedScopes',
          'googleAccountSubject',
        ]
      : ['accessToken', 'refreshToken', 'expiresAt', 'scopes'],
    label,
  );
  requiredText(value, 'accessToken', label);
  if (
    value.refreshToken !== undefined &&
    (typeof value.refreshToken !== 'string' ||
      value.refreshToken.length < 1 ||
      value.refreshToken.length > 4096)
  ) {
    throw new Error(`${label}.refreshToken is invalid`);
  }
  if (!validDate(value.expiresAt)) throw new Error(`${label}.expiresAt is invalid`);
  const scopes = google ? value.grantedScopes : value.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > 16 ||
    scopes.some(
      (scope) =>
        typeof scope !== 'string' || scope.length < 1 || scope.length > 256,
    ) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new Error(`${label} scopes are invalid`);
  }
  if (google) requiredText(value, 'googleAccountSubject', label);
};

const assertInstallation = (
  value: unknown,
  expectedInstallationSimplyId: string,
): void => {
  if (!isRecord(value)) throw new Error('installation registration is invalid');
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
  if (
    requiredText(value, 'installationSimplyId', 'installation registration') !==
    expectedInstallationSimplyId
  ) {
    throw new Error('installation registration identity does not match its key');
  }
  requiredText(value, 'teamSimplyId', 'installation registration');
  requiredText(value, 'appVersion', 'installation registration');
  const callback = new URL(
    requiredText(value, 'setupCallbackUrl', 'installation registration'),
  );
  if (
    callback.protocol !== 'https:' ||
    callback.username ||
    callback.password ||
    callback.hash
  ) {
    throw new Error('installation setup callback is invalid');
  }
  assertCredential(value.credential, 'Simply360 credential', false);
};

const assertSelection = (value: unknown): void => {
  if (!isRecord(value)) throw new Error('stored selection is invalid');
  exactKeys(
    value,
    [
      'action',
      'driveObjectId',
      'name',
      'mimeType',
      'kind',
      'selectedAt',
    ],
    'stored selection',
  );
  if (
    value.action !== 'PICKED' ||
    !['FILE', 'FOLDER'].includes(value.kind as string) ||
    !validDate(value.selectedAt)
  ) {
    throw new Error('stored selection is invalid');
  }
  requiredText(value, 'driveObjectId', 'stored selection');
  requiredText(value, 'name', 'stored selection');
  requiredText(value, 'mimeType', 'stored selection');
};

const assertLink = (
  value: unknown,
  expectedInstallationSimplyId: string,
): void => {
  if (!isRecord(value)) throw new Error('external file link is invalid');
  exactKeys(
    value,
    [
      'linkSimplyId',
      'installationSimplyId',
      'direction',
      'driveObjectId',
      'simply360FileSimplyId',
      'simply360VersionNumber',
      'driveModifiedAt',
      'checksumSha256Base64',
      'status',
      'updatedAt',
    ],
    'external file link',
  );
  if (
    value.installationSimplyId !== expectedInstallationSimplyId ||
    !['SOURCE', 'DESTINATION'].includes(value.direction as string) ||
    !['ACTIVE', 'REMOTE_MISSING', 'REVOKED'].includes(value.status as string) ||
    !Number.isSafeInteger(value.simply360VersionNumber) ||
    (value.simply360VersionNumber as number) < 1 ||
    !validDate(value.driveModifiedAt) ||
    !validDate(value.updatedAt)
  ) {
    throw new Error('external file link is invalid');
  }
  for (const key of [
    'linkSimplyId',
    'driveObjectId',
    'simply360FileSimplyId',
    'checksumSha256Base64',
  ]) {
    requiredText(value, key, 'external file link');
  }
};

const assertNotification = (value: unknown): void => {
  if (!isRecord(value)) throw new Error('stored notification is invalid');
  exactKeys(
    value,
    ['channel', 'channelTokenSha256', 'lastMessageNumber'],
    'stored notification',
  );
  if (!isRecord(value.channel)) throw new Error('notification channel is invalid');
  exactKeys(
    value.channel,
    ['channelId', 'resourceId', 'expiresAt'],
    'notification channel',
  );
  for (const key of ['channelId', 'resourceId']) {
    requiredText(value.channel, key, 'notification channel');
  }
  if (
    typeof value.channelTokenSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.channelTokenSha256) ||
    !validDate(value.channel.expiresAt) ||
    (value.lastMessageNumber !== undefined &&
      (typeof value.lastMessageNumber !== 'string' ||
        !/^\d{1,30}$/u.test(value.lastMessageNumber)))
  ) {
    throw new Error('stored notification is invalid');
  }
};

const assertPendingExport = (value: unknown): void => {
  if (!isRecord(value)) throw new Error('pending export is invalid');
  exactKeys(
    value,
    [
      'operationKey',
      'uploadId',
      'nextOffset',
      'destinationDriveFolderId',
      'simply360FileSimplyId',
      'simply360VersionNumber',
      'name',
      'contentType',
      'sizeBytes',
      'checksumSha256Base64',
    ],
    'pending export',
  );
  for (const key of [
    'operationKey',
    'uploadId',
    'destinationDriveFolderId',
    'simply360FileSimplyId',
    'name',
    'contentType',
    'checksumSha256Base64',
  ]) {
    requiredText(value, key, 'pending export');
  }
  if (
    !Number.isSafeInteger(value.nextOffset) ||
    (value.nextOffset as number) < 0 ||
    !Number.isSafeInteger(value.simply360VersionNumber) ||
    (value.simply360VersionNumber as number) < 1 ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    (value.nextOffset as number) > (value.sizeBytes as number)
  ) {
    throw new Error('pending export offsets are invalid');
  }
};

export const parseInstallationState = (
  input: unknown,
  expectedInstallationSimplyId: string,
): InstallationState => {
  if (!isRecord(input)) throw new Error('installation state is invalid');
  exactKeys(
    input,
    [
      'installation',
      'status',
      'googleCredential',
      'googleConnectionStatus',
      'pendingGoogleAuthorization',
      'selections',
      'links',
      'notifications',
      'pendingExports',
      'changeCursor',
      'registeredAt',
      'updatedAt',
    ],
    'installation state',
  );
  assertInstallation(input.installation, expectedInstallationSimplyId);
  if (
    !['PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'UNINSTALLED'].includes(
      input.status as string,
    ) ||
    !Array.isArray(input.selections) ||
    input.selections.length > 2_000 ||
    !Array.isArray(input.links) ||
    input.links.length > 5_000 ||
    !Array.isArray(input.notifications) ||
    input.notifications.length > 100 ||
    !Array.isArray(input.pendingExports) ||
    input.pendingExports.length > 100 ||
    !validDate(input.registeredAt) ||
    !validDate(input.updatedAt)
  ) {
    throw new Error('installation state shape is invalid');
  }
  if (input.googleCredential !== undefined) {
    assertCredential(input.googleCredential, 'Google credential', true);
  }
  if (
    input.googleConnectionStatus !== undefined &&
    !['ACTIVE', 'REVOKED'].includes(input.googleConnectionStatus as string)
  ) {
    throw new Error('Google connection status is invalid');
  }
  if (input.pendingGoogleAuthorization !== undefined) {
    const pending = input.pendingGoogleAuthorization;
    if (!isRecord(pending)) throw new Error('pending Google authorization is invalid');
    exactKeys(
      pending,
      ['stateSha256', 'codeVerifier', 'redirectUri', 'expiresAt'],
      'pending Google authorization',
    );
    if (
      !/^[a-f0-9]{64}$/u.test(
        requiredText(pending, 'stateSha256', 'pending Google authorization'),
      ) ||
      !validDate(pending.expiresAt)
    ) {
      throw new Error('pending Google authorization is invalid');
    }
    requiredText(pending, 'codeVerifier', 'pending Google authorization');
    const redirect = new URL(
      requiredText(pending, 'redirectUri', 'pending Google authorization'),
    );
    if (
      redirect.protocol !== 'https:' ||
      redirect.username ||
      redirect.password ||
      redirect.hash
    ) {
      throw new Error('pending Google redirect is invalid');
    }
  }
  if (
    input.changeCursor !== undefined &&
    (typeof input.changeCursor !== 'string' ||
      input.changeCursor.length > 4096)
  ) {
    throw new Error('change cursor is invalid');
  }
  input.selections.forEach(assertSelection);
  input.links.forEach((link) =>
    assertLink(link, expectedInstallationSimplyId),
  );
  input.notifications.forEach(assertNotification);
  input.pendingExports.forEach(assertPendingExport);
  return input as unknown as InstallationState;
};
