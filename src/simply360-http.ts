import type {
  ImportedFileResult,
  InstallationRegistration,
  Simply360File,
} from './contracts.js';
import { sha256Base64 } from './crypto.js';
import type { Simply360Port } from './ports.js';

type Fetch = typeof fetch;

export type Simply360LifecyclePort = Pick<
  Simply360Port,
  'completeSetup' | 'reportProviderHealth' | 'recordUpgrade' | 'completeUninstall'
>;

export interface Simply360PublicFilePortOptions {
  readonly apiBaseUrl: string;
  readonly lifecycle: Simply360LifecyclePort;
  readonly fetch?: Fetch;
  readonly maximumCompletionPolls?: number;
}

interface UploadStatus {
  readonly fileUploadSimplyId: string;
  readonly status: 'PENDING_UPLOAD' | 'SCANNING' | 'PROMOTING' | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'EXPIRED';
  readonly fileSimplyId?: string;
  readonly versionNumber?: number;
  readonly rejectionReason?: string;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} was not an object.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${label} was not a non-empty string.`);
  return value;
};

const integer = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} was not a positive integer.`);
  return value;
};

const pathSegment = (value: string): string => encodeURIComponent(value);

const exactApiOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Simply360 API base URL must be an exact HTTPS origin.');
  }
  return url.origin;
};

const parseEnvelope = async (response: Response, label: string): Promise<Record<string, unknown>> => {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error(`${label} did not return JSON.`);
  const envelope = object(await response.json(), `${label} envelope`);
  return object(envelope.data, `${label} data`);
};

const parseUploadStatus = (value: Record<string, unknown>): UploadStatus => {
  const status = text(value.status, 'Upload status');
  if (!['PENDING_UPLOAD', 'SCANNING', 'PROMOTING', 'COMPLETED', 'REJECTED', 'FAILED', 'EXPIRED'].includes(status)) {
    throw new Error('Simply360 returned an unknown upload status.');
  }
  return {
    fileUploadSimplyId: text(value.fileUploadSimplyId, 'File upload Simply ID'),
    status: status as UploadStatus['status'],
    fileSimplyId: typeof value.fileSimplyId === 'string' ? value.fileSimplyId : undefined,
    versionNumber: typeof value.versionNumber === 'number' ? value.versionNumber : undefined,
    rejectionReason: typeof value.rejectionReason === 'string' ? value.rejectionReason : undefined,
  };
};

export class Simply360PublicFilePort implements Simply360Port {
  private readonly apiOrigin: string;
  private readonly fetcher: Fetch;
  private readonly maximumCompletionPolls: number;

  constructor(private readonly options: Simply360PublicFilePortOptions) {
    this.apiOrigin = exactApiOrigin(options.apiBaseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.maximumCompletionPolls = options.maximumCompletionPolls ?? 300;
    if (!Number.isSafeInteger(this.maximumCompletionPolls) || this.maximumCompletionPolls < 1) {
      throw new Error('maximumCompletionPolls must be a positive integer.');
    }
  }

  completeSetup: Simply360LifecyclePort['completeSetup'] = (...arguments_) => this.options.lifecycle.completeSetup(...arguments_);
  reportProviderHealth: Simply360LifecyclePort['reportProviderHealth'] = (...arguments_) =>
    this.options.lifecycle.reportProviderHealth(...arguments_);
  recordUpgrade: Simply360LifecyclePort['recordUpgrade'] = (...arguments_) => this.options.lifecycle.recordUpgrade(...arguments_);
  completeUninstall: Simply360LifecyclePort['completeUninstall'] = (...arguments_) =>
    this.options.lifecycle.completeUninstall(...arguments_);

  async importFile(
    installation: InstallationRegistration,
    input: {
      name: string;
      contentType: string;
      bytes: Uint8Array;
      checksumSha256Base64: string;
      idempotencyKey: string;
      newVersionOfFileSimplyId?: string;
    },
  ): Promise<ImportedFileResult> {
    if (sha256Base64(input.bytes) !== input.checksumSha256Base64) throw new Error('Simply360 import checksum mismatch.');
    const created = await this.json(installation, '/v1/file-uploads', {
      method: 'POST',
      headers: { 'idempotency-key': input.idempotencyKey },
      body: {
        filename: input.name,
        contentType: input.contentType,
        fileSizeBytes: input.bytes.byteLength,
        checksumSha256: input.checksumSha256Base64,
        ...(input.newVersionOfFileSimplyId ? { isNewVersionOfFileSimplyId: input.newVersionOfFileSimplyId } : {}),
      },
    });
    const status = parseUploadStatus(created);
    const upload = object(created.upload, 'Simply360 upload');
    if (text(upload.method, 'Simply360 upload method') !== 'POST') throw new Error('Simply360 upload method was not POST.');
    const uploadUrl = new URL(text(upload.url, 'Simply360 upload URL'));
    if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password) {
      throw new Error('Simply360 upload URL must be credential-free HTTPS.');
    }
    const fields = object(upload.fields, 'Simply360 upload fields');
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== 'string') throw new Error('Simply360 upload field was not a string.');
      form.append(key, value);
    }
    form.append('file', new Blob([input.bytes], { type: input.contentType }), input.name);
    const uploadResponse = await this.fetcher(uploadUrl, { method: 'POST', body: form, redirect: 'error' });
    if (!uploadResponse.ok) throw new Error(`Simply360 presigned upload failed with HTTP ${uploadResponse.status}.`);

    let completed: UploadStatus = status;
    for (let poll = 0; poll < this.maximumCompletionPolls; poll += 1) {
      const result = await this.json(installation, `/v1/file-uploads/${pathSegment(status.fileUploadSimplyId)}/complete`, {
        method: 'POST',
        body: {},
      });
      completed = parseUploadStatus(result);
      if (!['SCANNING', 'PROMOTING', 'PENDING_UPLOAD'].includes(completed.status)) break;
    }
    if (completed.status !== 'COMPLETED' || !completed.fileSimplyId || !completed.versionNumber) {
      throw new Error(completed.rejectionReason ?? `Simply360 upload ended in ${completed.status}.`);
    }
    return {
      fileSimplyId: completed.fileSimplyId,
      versionNumber: completed.versionNumber,
      checksumSha256Base64: input.checksumSha256Base64,
    };
  }

  async downloadFile(
    installation: InstallationRegistration,
    fileSimplyId: string,
    versionNumber?: number,
  ): Promise<Simply360File> {
    const path =
      versionNumber === undefined
        ? `/v1/files/${pathSegment(fileSimplyId)}/download`
        : `/v1/files/${pathSegment(fileSimplyId)}/versions/${pathSegment(String(versionNumber))}/download`;
    const download = await this.json(installation, path, { method: 'GET' });
    const url = new URL(text(download.url, 'Simply360 download URL'));
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Simply360 download URL must be credential-free HTTPS.');
    const response = await this.fetcher(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`Simply360 file download failed with HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
    const filename =
      (typeof download.filename === 'string' && download.filename) ||
      response.headers.get('content-disposition')?.match(/filename="?([^"]+)"?/iu)?.[1] ||
      fileSimplyId;
    return {
      fileSimplyId,
      versionNumber: versionNumber ?? integer(download.versionNumber ?? 1, 'Simply360 file version'),
      name: filename,
      contentType,
      bytes,
      checksumSha256Base64: sha256Base64(bytes),
    };
  }

  private async json(
    installation: InstallationRegistration,
    path: string,
    input: { method: 'GET' | 'POST'; body?: Record<string, unknown>; headers?: Record<string, string> },
  ): Promise<Record<string, unknown>> {
    if (!path.startsWith('/v1/')) throw new Error('Simply360 public paths must start with /v1/.');
    const response = await this.fetcher(`${this.apiOrigin}${path}`, {
      method: input.method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${installation.credential.accessToken}`,
        ...(input.body ? { 'content-type': 'application/json' } : {}),
        ...input.headers,
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
    return parseEnvelope(response, `Simply360 ${input.method} ${path}`);
  }
}
