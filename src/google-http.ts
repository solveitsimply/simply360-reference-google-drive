import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_FOLDER_MIME_TYPE,
  GOOGLE_PICKER_VIEW_ID,
  type GoogleAuthorizationRequest,
  type GoogleChange,
  type GoogleChangePage,
  type GoogleCredential,
  type GoogleDownload,
  type GoogleDriveObject,
  type NotificationChannel,
  type PickerSession,
  type ResumableUpload,
} from './contracts.js';
import { sha256Hex } from './crypto.js';
import type { Clock, GoogleDrivePort } from './ports.js';

type Fetch = typeof fetch;

export interface GoogleDriveHttpOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pickerAppId: string;
  readonly pickerDeveloperKey: string;
  readonly publicOrigin: string;
  readonly redirectUri: string;
  readonly fetch?: Fetch;
  readonly clock?: Clock;
  readonly maximumChangePages?: number;
  readonly maximumDownloadBytes?: number;
  readonly maximumJsonBytes?: number;
  readonly maximumUploadChunkBytes?: number;
  readonly maximumUploadBytes?: number;
}

const GOOGLE_API_ORIGIN = 'https://www.googleapis.com';
const GOOGLE_UPLOAD_ORIGIN = 'https://www.googleapis.com';
const GOOGLE_OAUTH_ORIGIN = 'https://oauth2.googleapis.com';
const GOOGLE_REVOKE_ORIGIN = 'https://oauth2.googleapis.com';

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} was not an object.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${label} was not a non-empty string.`);
  return value;
};

const optionalText = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const nonNegativeInteger = (value: unknown, label: string, fallback?: number): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  if (fallback !== undefined) return fallback;
  throw new Error(`${label} was not a non-negative integer.`);
};

const pathSegment = (value: string): string => encodeURIComponent(value);

const parseDriveObject = (input: unknown): GoogleDriveObject => {
  const value = object(input, 'Google Drive object');
  return {
    driveObjectId: text(value.id, 'Google Drive object id'),
    name: text(value.name, 'Google Drive object name'),
    mimeType: text(value.mimeType, 'Google Drive object mimeType'),
    sizeBytes: nonNegativeInteger(value.size, 'Google Drive object size', 0),
    modifiedAt: optionalText(value.modifiedTime) ?? new Date(0).toISOString(),
    md5Checksum: optionalText(value.md5Checksum),
    trashed: value.trashed === true,
  };
};

const readBoundedBytes = async (response: Response, maximumBytes: number, label: string): Promise<Uint8Array> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength && nonNegativeInteger(contentLength, `${label} content length`) > maximumBytes) {
    throw new Error(`${label} exceeded the configured byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeded the configured byte limit.`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

const parseJson = async (response: Response, label: string, maximumBytes = 1024 * 1024): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error(`${label} did not return JSON.`);
  const body = await readBoundedBytes(response, maximumBytes, label);
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
};

const assertResponse = async (response: Response, label: string, allowed: readonly number[] = []): Promise<void> => {
  if (response.ok || allowed.includes(response.status)) return;
  // Keep provider bodies out of errors because OAuth/API responses can contain
  // sensitive diagnostic fields.
  throw new Error(`${label} failed with HTTP ${response.status}.`);
};

const exactOrigin = (value: string, label: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an exact HTTPS origin.`);
  }
  return url.origin;
};

const googleNativeExport = (mimeType: string, name: string): { mimeType: string; name: string } | undefined => {
  const exports: Record<string, { mimeType: string; extension: string }> = {
    'application/vnd.google-apps.document': { mimeType: 'application/pdf', extension: '.pdf' },
    'application/vnd.google-apps.spreadsheet': {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: '.xlsx',
    },
    'application/vnd.google-apps.presentation': {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: '.pptx',
    },
    'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: '.png' },
  };
  const selected = exports[mimeType];
  return selected ? { mimeType: selected.mimeType, name: `${name}${selected.extension}` } : undefined;
};

interface CachedAccess {
  readonly accessToken: string;
  readonly expiresAt: string;
}

export class GoogleDriveHttpClient implements GoogleDrivePort {
  private readonly fetcher: Fetch;
  private readonly now: () => Date;
  private readonly publicOrigin: string;
  private readonly redirectUri: string;
  private readonly maximumChangePages: number;
  private readonly maximumDownloadBytes: number;
  private readonly maximumJsonBytes: number;
  private readonly maximumUploadChunkBytes: number;
  private readonly maximumUploadBytes: number;
  private readonly refreshed = new Map<string, CachedAccess>();

  constructor(private readonly options: GoogleDriveHttpOptions) {
    if (!options.clientId || !options.clientSecret || !options.pickerAppId || !options.pickerDeveloperKey) {
      throw new Error('Google OAuth and Picker configuration is incomplete.');
    }
    this.publicOrigin = exactOrigin(options.publicOrigin, 'publicOrigin');
    const redirect = new URL(options.redirectUri);
    if (
      redirect.protocol !== 'https:' ||
      redirect.origin !== this.publicOrigin ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    ) {
      throw new Error('redirectUri must be an exact HTTPS URL on publicOrigin.');
    }
    this.redirectUri = redirect.toString();
    this.fetcher = options.fetch ?? fetch;
    this.now = () => options.clock?.now() ?? new Date();
    this.maximumChangePages = options.maximumChangePages ?? 10;
    this.maximumDownloadBytes = options.maximumDownloadBytes ?? 100 * 1024 * 1024;
    this.maximumJsonBytes = options.maximumJsonBytes ?? 1024 * 1024;
    this.maximumUploadChunkBytes = options.maximumUploadChunkBytes ?? 16 * 1024 * 1024;
    this.maximumUploadBytes = options.maximumUploadBytes ?? 100 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumChangePages) || this.maximumChangePages < 1) {
      throw new Error('maximumChangePages must be a positive integer.');
    }
    for (const [label, value] of [
      ['maximumDownloadBytes', this.maximumDownloadBytes],
      ['maximumJsonBytes', this.maximumJsonBytes],
      ['maximumUploadChunkBytes', this.maximumUploadChunkBytes],
      ['maximumUploadBytes', this.maximumUploadBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
    }
  }

  createAuthorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    if (input.redirectUri !== this.redirectUri) throw new Error('Google authorization redirect URI is not exact.');
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(input.codeChallenge)) throw new Error('Google PKCE challenge is invalid.');
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(input.state)) throw new Error('Google OAuth state is invalid.');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GOOGLE_DRIVE_SCOPE,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'false',
      prompt: 'consent',
    }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode(request: GoogleAuthorizationRequest): Promise<GoogleCredential> {
    if (request.codeVerifier.length < 43 || request.codeVerifier.length > 128) {
      throw new Error('Google PKCE verifier must contain 43 to 128 characters.');
    }
    if (request.redirectUri !== this.redirectUri) throw new Error('Google redirect URI is not exact.');
    const response = await this.fetcher(`${GOOGLE_OAUTH_ORIGIN}/token`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: request.authorizationCode,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        redirect_uri: request.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: request.codeVerifier,
      }),
    });
    await assertResponse(response, 'Google OAuth exchange');
    const body = object(await parseJson(response, 'Google OAuth exchange', this.maximumJsonBytes), 'Google OAuth exchange');
    const accessToken = text(body.access_token, 'Google access token');
    if (text(body.token_type, 'Google token type').toLowerCase() !== 'bearer') throw new Error('Google token type must be Bearer.');
    const refreshToken = optionalText(body.refresh_token);
    const expiresIn = nonNegativeInteger(body.expires_in, 'Google token expiry');
    if (expiresIn === 0) throw new Error('Google token expiry must be positive.');
    const scope = text(body.scope, 'Google granted scope').trim().split(/\s+/u);
    if (scope.length !== 1 || scope[0] !== GOOGLE_DRIVE_SCOPE) {
      await this.revokeRaw(accessToken);
      throw new Error(`Google granted scope must be exactly ${GOOGLE_DRIVE_SCOPE}.`);
    }
    const aboutResponse = await this.authorizedRaw(
      accessToken,
      `${GOOGLE_API_ORIGIN}/drive/v3/about?fields=user(permissionId)`,
    );
    const about = object(
      await parseJson(aboutResponse, 'Google Drive about', this.maximumJsonBytes),
      'Google Drive about',
    );
    const user = object(about.user, 'Google Drive user');
    const googleAccountSubject = text(user.permissionId, 'Google Drive permissionId');
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
      grantedScopes: [GOOGLE_DRIVE_SCOPE],
      googleAccountSubject,
    };
  }

  async createPickerSession(credential: GoogleCredential): Promise<PickerSession> {
    const oauthToken = await this.accessToken(credential);
    return {
      appId: this.options.pickerAppId,
      developerKey: this.options.pickerDeveloperKey,
      oauthToken,
      origin: this.publicOrigin,
      viewId: GOOGLE_PICKER_VIEW_ID,
      allowFolders: true,
      multiselect: false,
    };
  }

  async getObject(credential: GoogleCredential, driveObjectId: string): Promise<GoogleDriveObject> {
    const fields = 'id,name,mimeType,size,modifiedTime,md5Checksum,trashed';
    const response = await this.authorized(
      credential,
      `${GOOGLE_API_ORIGIN}/drive/v3/files/${pathSegment(driveObjectId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=false`,
    );
    return parseDriveObject(await parseJson(response, 'Google Drive metadata', this.maximumJsonBytes));
  }

  async downloadObject(credential: GoogleCredential, driveObjectId: string): Promise<GoogleDownload> {
    const metadata = await this.getObject(credential, driveObjectId);
    if (metadata.trashed || metadata.mimeType === GOOGLE_FOLDER_MIME_TYPE) throw new Error('Google Drive object is not downloadable.');
    const exported = googleNativeExport(metadata.mimeType, metadata.name);
    const url = exported
      ? `${GOOGLE_API_ORIGIN}/drive/v3/files/${pathSegment(driveObjectId)}/export?mimeType=${encodeURIComponent(exported.mimeType)}`
      : `${GOOGLE_API_ORIGIN}/drive/v3/files/${pathSegment(driveObjectId)}?alt=media&supportsAllDrives=false`;
    const response = await this.authorized(credential, url);
    const buffer = await readBoundedBytes(response, this.maximumDownloadBytes, 'Google Drive download');
    return {
      bytes: buffer,
      name: exported?.name ?? metadata.name,
      contentType: exported?.mimeType ?? metadata.mimeType,
    };
  }

  async beginResumableUpload(
    credential: GoogleCredential,
    input: {
      parentDriveObjectId: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      existingDriveObjectId?: string;
    },
  ): Promise<ResumableUpload> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > this.maximumUploadBytes) {
      throw new Error('Google upload size is outside the configured byte limit.');
    }
    const path = input.existingDriveObjectId
      ? `/upload/drive/v3/files/${pathSegment(input.existingDriveObjectId)}`
      : '/upload/drive/v3/files';
    const response = await this.authorized(
      credential,
      `${GOOGLE_UPLOAD_ORIGIN}${path}?uploadType=resumable&supportsAllDrives=false&fields=id,name,mimeType,size,modifiedTime,md5Checksum,trashed`,
      {
        method: input.existingDriveObjectId ? 'PATCH' : 'POST',
        headers: {
          'content-type': 'application/json',
          'x-upload-content-type': input.contentType,
          'x-upload-content-length': String(input.sizeBytes),
        },
        body: JSON.stringify(
          input.existingDriveObjectId
            ? { name: input.name, mimeType: input.contentType }
            : {
                name: input.name,
                mimeType: input.contentType,
                parents: [input.parentDriveObjectId],
              },
        ),
      },
    );
    const location = response.headers.get('location');
    if (!location) throw new Error('Google resumable upload omitted its Location header.');
    const uploadUrl = new URL(location);
    if (
      uploadUrl.protocol !== 'https:' ||
      uploadUrl.origin !== GOOGLE_UPLOAD_ORIGIN ||
      uploadUrl.username ||
      uploadUrl.password ||
      uploadUrl.hash
    ) {
      throw new Error('Google resumable upload returned an untrusted Location.');
    }
    return { uploadId: uploadUrl.toString(), nextOffset: 0 };
  }

  async uploadChunk(
    credential: GoogleCredential,
    uploadId: string,
    input: { bytes: Uint8Array; offset: number; totalBytes: number },
  ): Promise<ResumableUpload | GoogleDriveObject> {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.totalBytes) ||
      input.totalBytes < 0 ||
      input.totalBytes > this.maximumUploadBytes ||
      input.bytes.byteLength > this.maximumUploadChunkBytes ||
      (input.totalBytes === 0
        ? input.offset !== 0 || input.bytes.byteLength !== 0
        : input.bytes.byteLength === 0 || input.offset + input.bytes.byteLength > input.totalBytes)
    ) {
      throw new Error('Google upload chunk is outside the configured byte and offset limits.');
    }
    const uploadUrl = new URL(uploadId);
    if (
      uploadUrl.protocol !== 'https:' ||
      uploadUrl.origin !== GOOGLE_UPLOAD_ORIGIN ||
      uploadUrl.username ||
      uploadUrl.password ||
      uploadUrl.hash
    ) {
      throw new Error('Google resumable upload URL is untrusted.');
    }
    const end = input.offset + input.bytes.byteLength - 1;
    const response = await this.fetcher(uploadUrl, {
      method: 'PUT',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${await this.accessToken(credential)}`,
        'content-length': String(input.bytes.byteLength),
        'content-range':
          input.totalBytes === 0 ? 'bytes */0' : `bytes ${input.offset}-${end}/${input.totalBytes}`,
      },
      body: input.bytes,
    });
    await assertResponse(response, 'Google resumable upload', [308]);
    if (response.status !== 308) {
      return parseDriveObject(await parseJson(response, 'Google resumable upload', this.maximumJsonBytes));
    }
    const range = response.headers.get('range');
    const match = range?.match(/^bytes=0-(\d+)$/u);
    const nextOffset = match ? Number(match[1]) + 1 : input.offset;
    if (!Number.isSafeInteger(nextOffset) || nextOffset < input.offset || nextOffset > input.totalBytes) {
      throw new Error('Google resumable upload returned an invalid Range.');
    }
    return { uploadId, nextOffset };
  }

  async startChangeNotifications(
    credential: GoogleCredential,
    input: { channelId: string; channelToken: string; expiresAt: string },
  ): Promise<NotificationChannel> {
    const requestedExpiration = new Date(input.expiresAt).getTime();
    if (
      !input.channelId ||
      !input.channelToken ||
      !Number.isFinite(requestedExpiration) ||
      requestedExpiration <= this.now().getTime()
    ) {
      throw new Error('Google change notification input is invalid or expired.');
    }
    const tokenResponse = await this.authorized(credential, `${GOOGLE_API_ORIGIN}/drive/v3/changes/startPageToken`);
    const tokenBody = object(
      await parseJson(tokenResponse, 'Google change start token', this.maximumJsonBytes),
      'Google change start token',
    );
    const pageToken = text(tokenBody.startPageToken, 'Google change start page token');
    const response = await this.authorized(
      credential,
      `${GOOGLE_API_ORIGIN}/drive/v3/changes/watch?pageToken=${encodeURIComponent(pageToken)}&supportsAllDrives=false`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: input.channelId,
          type: 'web_hook',
          address: `${this.publicOrigin}/google/drive/notifications`,
          token: input.channelToken,
          expiration: String(new Date(input.expiresAt).getTime()),
          payload: false,
        }),
      },
    );
    const body = object(
      await parseJson(response, 'Google change notification', this.maximumJsonBytes),
      'Google change notification',
    );
    const channelId = text(body.id, 'Google channel id');
    const expiration = nonNegativeInteger(body.expiration, 'Google channel expiration');
    if (
      channelId !== input.channelId ||
      expiration <= this.now().getTime() ||
      expiration > requestedExpiration
    ) {
      throw new Error('Google change notification response exceeded the requested channel authority.');
    }
    return {
      channelId,
      resourceId: text(body.resourceId, 'Google channel resource id'),
      channelToken: input.channelToken,
      expiresAt: new Date(expiration).toISOString(),
    };
  }

  async stopChangeNotifications(credential: GoogleCredential, channel: NotificationChannel): Promise<void> {
    await this.authorized(credential, `${GOOGLE_API_ORIGIN}/drive/v3/channels/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: channel.channelId, resourceId: channel.resourceId }),
    });
  }

  async listChanges(credential: GoogleCredential, cursor?: string): Promise<GoogleChangePage> {
    if (!cursor) {
      const response = await this.authorized(credential, `${GOOGLE_API_ORIGIN}/drive/v3/changes/startPageToken`);
      const body = object(
        await parseJson(response, 'Google change start token', this.maximumJsonBytes),
        'Google change start token',
      );
      return { changes: [], nextCursor: text(body.startPageToken, 'Google change start page token') };
    }
    const fields =
      'changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,md5Checksum,trashed)),newStartPageToken,nextPageToken';
    let pageToken: string | undefined = cursor;
    const changes: GoogleChange[] = [];
    let nextCursor = cursor;
    let receivedNewStart = false;
    let pageCount = 0;
    do {
      pageCount += 1;
      if (pageCount > this.maximumChangePages) throw new Error('Google change listing exceeded the configured page limit.');
      const response = await this.authorized(
        credential,
        `${GOOGLE_API_ORIGIN}/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&spaces=drive&supportsAllDrives=false&includeItemsFromAllDrives=false&fields=${encodeURIComponent(fields)}`,
      );
      const body = object(await parseJson(response, 'Google changes', this.maximumJsonBytes), 'Google changes');
      if (!Array.isArray(body.changes)) throw new Error('Google changes did not contain an array.');
      for (const item of body.changes) {
        const change = object(item, 'Google change');
        const driveObjectId = text(change.fileId, 'Google change file id');
        changes.push({
          changeId: `${pageToken}:${changes.length}`,
          driveObjectId,
          removed: change.removed === true,
          ...(change.file ? { object: parseDriveObject(change.file) } : {}),
        });
      }
      const nextPage = optionalText(body.nextPageToken);
      const newStart = optionalText(body.newStartPageToken);
      if (newStart) {
        nextCursor = newStart;
        receivedNewStart = true;
      }
      pageToken = nextPage;
    } while (pageToken);
    if (!receivedNewStart) throw new Error('Google change listing omitted its new start page token.');
    return { changes, nextCursor };
  }

  async revokeCredential(credential: GoogleCredential): Promise<void> {
    await this.revokeRaw(credential.refreshToken ?? credential.accessToken);
    this.refreshed.delete(this.credentialCacheKey(credential));
  }

  private async authorized(credential: GoogleCredential, url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.origin !== GOOGLE_API_ORIGIN || target.username || target.password) {
      throw new Error('Google API target is untrusted.');
    }
    const response = await this.fetcher(target, {
      ...init,
      redirect: 'error',
      headers: {
        ...init.headers,
        authorization: `Bearer ${await this.accessToken(credential)}`,
      },
    });
    await assertResponse(response, 'Google Drive API');
    return response;
  }

  private async authorizedRaw(accessToken: string, url: string): Promise<Response> {
    const response = await this.fetcher(url, {
      redirect: 'error',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await assertResponse(response, 'Google Drive API');
    return response;
  }

  private async accessToken(credential: GoogleCredential): Promise<string> {
    if (credential.grantedScopes.length !== 1 || credential.grantedScopes[0] !== GOOGLE_DRIVE_SCOPE) {
      throw new Error('Google credential does not have exact drive.file authority.');
    }
    const cacheKey = this.credentialCacheKey(credential);
    const cached = this.refreshed.get(cacheKey);
    if (cached && new Date(cached.expiresAt).getTime() - this.now().getTime() > 60_000) return cached.accessToken;
    if (new Date(credential.expiresAt).getTime() - this.now().getTime() > 60_000) return credential.accessToken;
    if (!credential.refreshToken) throw new Error('Google access token expired without refresh authority.');
    const response = await this.fetcher(`${GOOGLE_OAUTH_ORIGIN}/token`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        refresh_token: credential.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    await assertResponse(response, 'Google token refresh');
    const body = object(await parseJson(response, 'Google token refresh', this.maximumJsonBytes), 'Google token refresh');
    const tokenType = optionalText(body.token_type);
    if (tokenType && tokenType.toLowerCase() !== 'bearer') throw new Error('Refreshed Google token type must be Bearer.');
    const scope = optionalText(body.scope)?.trim().split(/\s+/u) ?? [...credential.grantedScopes];
    if (scope.length !== 1 || scope[0] !== GOOGLE_DRIVE_SCOPE) {
      const accessToken = optionalText(body.access_token);
      if (accessToken) await this.revokeRaw(accessToken);
      throw new Error('Refreshed Google token no longer has exact drive.file authority.');
    }
    const expiresIn = nonNegativeInteger(body.expires_in, 'Google token expiry');
    if (expiresIn === 0) throw new Error('Refreshed Google token expiry must be positive.');
    const refreshed = {
      accessToken: text(body.access_token, 'Refreshed Google access token'),
      expiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
    };
    this.refreshed.set(cacheKey, refreshed);
    return refreshed.accessToken;
  }

  private credentialCacheKey(credential: GoogleCredential): string {
    return sha256Hex(credential.refreshToken ?? credential.accessToken);
  }

  private async revokeRaw(token: string): Promise<void> {
    const response = await this.fetcher(`${GOOGLE_REVOKE_ORIGIN}/revoke`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    await assertResponse(response, 'Google token revocation');
  }
}
