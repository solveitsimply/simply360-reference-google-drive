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
import type { Clock, GoogleDrivePort } from './ports.js';

type Fetch = typeof fetch;

export interface GoogleDriveHttpOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pickerAppId: string;
  readonly pickerDeveloperKey: string;
  readonly publicOrigin: string;
  readonly fetch?: Fetch;
  readonly clock?: Clock;
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

const parseJson = async (response: Response, label: string): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error(`${label} did not return JSON.`);
  return response.json();
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
  private readonly refreshed = new Map<string, CachedAccess>();

  constructor(private readonly options: GoogleDriveHttpOptions) {
    if (!options.clientId || !options.clientSecret || !options.pickerAppId || !options.pickerDeveloperKey) {
      throw new Error('Google OAuth and Picker configuration is incomplete.');
    }
    this.publicOrigin = exactOrigin(options.publicOrigin, 'publicOrigin');
    this.fetcher = options.fetch ?? fetch;
    this.now = () => options.clock?.now() ?? new Date();
  }

  async exchangeAuthorizationCode(request: GoogleAuthorizationRequest): Promise<GoogleCredential> {
    if (request.codeVerifier.length < 43 || request.codeVerifier.length > 128) {
      throw new Error('Google PKCE verifier must contain 43 to 128 characters.');
    }
    const redirect = new URL(request.redirectUri);
    if (redirect.protocol !== 'https:' || redirect.origin !== this.publicOrigin || redirect.search || redirect.hash) {
      throw new Error('Google redirect URI must use the configured public origin.');
    }
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
    const body = object(await parseJson(response, 'Google OAuth exchange'), 'Google OAuth exchange');
    const accessToken = text(body.access_token, 'Google access token');
    const refreshToken = optionalText(body.refresh_token);
    const expiresIn = nonNegativeInteger(body.expires_in, 'Google token expiry');
    const scope = text(body.scope, 'Google granted scope').trim().split(/\s+/u);
    if (scope.length !== 1 || scope[0] !== GOOGLE_DRIVE_SCOPE) {
      await this.revokeRaw(accessToken);
      throw new Error(`Google granted scope must be exactly ${GOOGLE_DRIVE_SCOPE}.`);
    }
    const aboutResponse = await this.authorizedRaw(
      accessToken,
      `${GOOGLE_API_ORIGIN}/drive/v3/about?fields=user(permissionId)`,
    );
    const about = object(await parseJson(aboutResponse, 'Google Drive about'), 'Google Drive about');
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
    return parseDriveObject(await parseJson(response, 'Google Drive metadata'));
  }

  async downloadObject(credential: GoogleCredential, driveObjectId: string): Promise<GoogleDownload> {
    const metadata = await this.getObject(credential, driveObjectId);
    if (metadata.trashed || metadata.mimeType === GOOGLE_FOLDER_MIME_TYPE) throw new Error('Google Drive object is not downloadable.');
    const exported = googleNativeExport(metadata.mimeType, metadata.name);
    const url = exported
      ? `${GOOGLE_API_ORIGIN}/drive/v3/files/${pathSegment(driveObjectId)}/export?mimeType=${encodeURIComponent(exported.mimeType)}`
      : `${GOOGLE_API_ORIGIN}/drive/v3/files/${pathSegment(driveObjectId)}?alt=media&supportsAllDrives=false`;
    const response = await this.authorized(credential, url);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      bytes: buffer,
      name: exported?.name ?? metadata.name,
      contentType: exported?.mimeType ?? metadata.mimeType,
    };
  }

  async beginResumableUpload(
    credential: GoogleCredential,
    input: { parentDriveObjectId: string; name: string; contentType: string; sizeBytes: number },
  ): Promise<ResumableUpload> {
    const response = await this.authorized(
      credential,
      `${GOOGLE_UPLOAD_ORIGIN}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=false&fields=id,name,mimeType,size,modifiedTime,md5Checksum,trashed`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-upload-content-type': input.contentType,
          'x-upload-content-length': String(input.sizeBytes),
        },
        body: JSON.stringify({
          name: input.name,
          mimeType: input.contentType,
          parents: [input.parentDriveObjectId],
        }),
      },
    );
    const location = response.headers.get('location');
    if (!location) throw new Error('Google resumable upload omitted its Location header.');
    const uploadUrl = new URL(location);
    if (uploadUrl.protocol !== 'https:' || uploadUrl.origin !== GOOGLE_UPLOAD_ORIGIN || uploadUrl.username || uploadUrl.password) {
      throw new Error('Google resumable upload returned an untrusted Location.');
    }
    return { uploadId: uploadUrl.toString(), nextOffset: 0 };
  }

  async uploadChunk(
    credential: GoogleCredential,
    uploadId: string,
    input: { bytes: Uint8Array; offset: number; totalBytes: number },
  ): Promise<ResumableUpload | GoogleDriveObject> {
    const uploadUrl = new URL(uploadId);
    if (uploadUrl.protocol !== 'https:' || uploadUrl.origin !== GOOGLE_UPLOAD_ORIGIN || uploadUrl.username || uploadUrl.password) {
      throw new Error('Google resumable upload URL is untrusted.');
    }
    const end = input.bytes.byteLength === 0 ? input.offset : input.offset + input.bytes.byteLength - 1;
    const response = await this.fetcher(uploadUrl, {
      method: 'PUT',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${await this.accessToken(credential)}`,
        'content-length': String(input.bytes.byteLength),
        'content-range': `bytes ${input.offset}-${end}/${input.totalBytes}`,
      },
      body: input.bytes,
    });
    await assertResponse(response, 'Google resumable upload', [308]);
    if (response.status !== 308) return parseDriveObject(await parseJson(response, 'Google resumable upload'));
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
    const tokenResponse = await this.authorized(credential, `${GOOGLE_API_ORIGIN}/drive/v3/changes/startPageToken`);
    const tokenBody = object(await parseJson(tokenResponse, 'Google change start token'), 'Google change start token');
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
    const body = object(await parseJson(response, 'Google change notification'), 'Google change notification');
    return {
      channelId: text(body.id, 'Google channel id'),
      resourceId: text(body.resourceId, 'Google channel resource id'),
      channelToken: input.channelToken,
      expiresAt: new Date(nonNegativeInteger(body.expiration, 'Google channel expiration')).toISOString(),
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
      const body = object(await parseJson(response, 'Google change start token'), 'Google change start token');
      return { changes: [], nextCursor: text(body.startPageToken, 'Google change start page token') };
    }
    const fields =
      'changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,md5Checksum,trashed)),newStartPageToken,nextPageToken';
    let pageToken: string | undefined = cursor;
    const changes: GoogleChange[] = [];
    let nextCursor = cursor;
    do {
      const response = await this.authorized(
        credential,
        `${GOOGLE_API_ORIGIN}/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&spaces=drive&supportsAllDrives=false&includeItemsFromAllDrives=false&fields=${encodeURIComponent(fields)}`,
      );
      const body = object(await parseJson(response, 'Google changes'), 'Google changes');
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
      if (newStart) nextCursor = newStart;
      pageToken = nextPage;
    } while (pageToken);
    return { changes, nextCursor };
  }

  async revokeCredential(credential: GoogleCredential): Promise<void> {
    await this.revokeRaw(credential.refreshToken ?? credential.accessToken);
    this.refreshed.delete(credential.googleAccountSubject);
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
    const cached = this.refreshed.get(credential.googleAccountSubject);
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
    const body = object(await parseJson(response, 'Google token refresh'), 'Google token refresh');
    const scope = optionalText(body.scope)?.trim().split(/\s+/u) ?? [...credential.grantedScopes];
    if (scope.length !== 1 || scope[0] !== GOOGLE_DRIVE_SCOPE) {
      throw new Error('Refreshed Google token no longer has exact drive.file authority.');
    }
    const refreshed = {
      accessToken: text(body.access_token, 'Refreshed Google access token'),
      expiresAt: new Date(this.now().getTime() + nonNegativeInteger(body.expires_in, 'Google token expiry') * 1000).toISOString(),
    };
    this.refreshed.set(credential.googleAccountSubject, refreshed);
    return refreshed.accessToken;
  }

  private async revokeRaw(token: string): Promise<void> {
    const response = await this.fetcher(`${GOOGLE_REVOKE_ORIGIN}/revoke`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    await assertResponse(response, 'Google token revocation', [400]);
  }
}
