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
  readonly completionPollDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly trustedTransferOrigins: readonly string[];
  readonly maximumTransferBytes?: number;
  readonly maximumJsonBytes?: number;
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

const exactHttpsOrigin = (value: string, label: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an exact HTTPS origin.`);
  }
  return url.origin;
};

const readBoundedBytes = async (response: Response, maximumBytes: number, label: string): Promise<Uint8Array> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} returned an invalid content length.`);
    if (parsed > maximumBytes) throw new Error(`${label} exceeded the configured byte limit.`);
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

const parseEnvelope = async (
  response: Response,
  label: string,
  maximumJsonBytes: number,
): Promise<Record<string, unknown>> => {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error(`${label} did not return JSON.`);
  const raw = await readBoundedBytes(response, maximumJsonBytes, label);
  const envelope = object(JSON.parse(new TextDecoder().decode(raw)) as unknown, `${label} envelope`);
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
  private readonly completionPollDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly trustedTransferOrigins: ReadonlySet<string>;
  private readonly maximumTransferBytes: number;
  private readonly maximumJsonBytes: number;

  constructor(private readonly options: Simply360PublicFilePortOptions) {
    this.apiOrigin = exactHttpsOrigin(options.apiBaseUrl, 'Simply360 API base URL');
    this.fetcher = options.fetch ?? fetch;
    this.maximumCompletionPolls = options.maximumCompletionPolls ?? 300;
    this.completionPollDelayMs = options.completionPollDelayMs ?? 2_000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.trustedTransferOrigins = new Set(
      options.trustedTransferOrigins.map((origin) => exactHttpsOrigin(origin, 'Simply360 transfer origin')),
    );
    this.maximumTransferBytes = options.maximumTransferBytes ?? 100 * 1024 * 1024;
    this.maximumJsonBytes = options.maximumJsonBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumCompletionPolls) || this.maximumCompletionPolls < 1) {
      throw new Error('maximumCompletionPolls must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.completionPollDelayMs) || this.completionPollDelayMs < 0) {
      throw new Error('completionPollDelayMs must be a non-negative integer.');
    }
    if (this.trustedTransferOrigins.size === 0) throw new Error('At least one trusted transfer origin is required.');
    if (!Number.isSafeInteger(this.maximumTransferBytes) || this.maximumTransferBytes < 1) {
      throw new Error('maximumTransferBytes must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.maximumJsonBytes) || this.maximumJsonBytes < 1) {
      throw new Error('maximumJsonBytes must be a positive integer.');
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
    if (input.bytes.byteLength > this.maximumTransferBytes) {
      throw new Error('Simply360 import exceeds the configured transfer limit.');
    }
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
    this.assertTransferUrl(uploadUrl, 'upload');
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
      if (poll + 1 < this.maximumCompletionPolls && this.completionPollDelayMs > 0) {
        await this.sleep(this.completionPollDelayMs);
      }
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
    if (!fileSimplyId) throw new Error('Simply360 file Simply ID is required.');
    if (versionNumber !== undefined && (!Number.isSafeInteger(versionNumber) || versionNumber < 1)) {
      throw new Error('Simply360 file version must be a positive integer.');
    }
    const path =
      versionNumber === undefined
        ? `/v1/files/${pathSegment(fileSimplyId)}/download`
        : `/v1/files/${pathSegment(fileSimplyId)}/versions/${pathSegment(String(versionNumber))}/download`;
    const download = await this.json(installation, path, { method: 'GET' });
    const url = new URL(text(download.url, 'Simply360 download URL'));
    this.assertTransferUrl(url, 'download');
    const response = await this.fetcher(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`Simply360 file download failed with HTTP ${response.status}.`);
    const bytes = await readBoundedBytes(response, this.maximumTransferBytes, 'Simply360 file download');
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
    return parseEnvelope(response, `Simply360 ${input.method} ${path}`, this.maximumJsonBytes);
  }

  private assertTransferUrl(url: URL, label: string): void {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !this.trustedTransferOrigins.has(url.origin)
    ) {
      throw new Error(`Simply360 ${label} URL is outside the trusted transfer origins.`);
    }
  }
}
