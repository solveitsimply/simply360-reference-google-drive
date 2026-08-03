import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface AwsSignedRequestOptions {
  readonly service: string;
  readonly region: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export class AwsServiceError extends Error {
  public constructor(
    readonly service: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`${service} request failed with ${code} (HTTP ${status})`);
    this.name = 'AwsServiceError';
  }
}

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const hmac = (
  key: string | Uint8Array,
  value: string,
): Buffer => createHmac('sha256', key).update(value).digest();

const awsSigningKey = (
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer => {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
};

const encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const canonicalPath = (url: URL): string =>
  url.pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/') || '/';

const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

const canonicalHeaderValue = (value: string): string =>
  value.trim().replace(/\s+/gu, ' ');

const readBoundedText = async (
  response: Response,
  maximumBytes: number,
): Promise<string> => {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength &&
    (!/^(0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > maximumBytes)
  ) {
    throw new Error('AWS response exceeded the configured byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('AWS response exceeded the configured byte limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

export const awsCredentialsFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): AwsCredentials => {
  const accessKeyId = environment.AWS_ACCESS_KEY_ID;
  const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS execution credentials are unavailable');
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(environment.AWS_SESSION_TOKEN
      ? { sessionToken: environment.AWS_SESSION_TOKEN }
      : {}),
  };
};

export class AwsSignedHttpClient {
  public constructor(
    private readonly options: {
      readonly credentials?: () => AwsCredentials;
      readonly fetch?: typeof fetch;
      readonly now?: () => Date;
      readonly maximumResponseBytes?: number;
      readonly timeoutMs?: number;
    } = {},
  ) {}

  public async request(input: AwsSignedRequestOptions): Promise<Response> {
    if (!/^[a-z0-9-]+$/u.test(input.service)) {
      throw new Error('AWS service name is invalid');
    }
    if (!/^[a-z]{2}-[a-z]+-\d$/u.test(input.region)) {
      throw new Error('AWS region is invalid');
    }
    const url = new URL(input.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error('AWS endpoint must be credential-free HTTPS');
    }
    const credentials =
      this.options.credentials?.() ?? awsCredentialsFromEnvironment();
    const now = this.options.now?.() ?? new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]|\.\d{3}/gu, '');
    const shortDate = amzDate.slice(0, 8);
    const method = input.method?.toUpperCase() ?? 'POST';
    const body = input.body ?? '';
    const bodyHash = sha256(body);
    const headers = new Map<string, string>();
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      const normalized = key.toLowerCase();
      if (normalized === 'authorization' || normalized === 'host') {
        throw new Error(`caller may not set AWS ${normalized} header`);
      }
      headers.set(normalized, canonicalHeaderValue(value));
    }
    headers.set('host', url.host);
    headers.set('x-amz-date', amzDate);
    headers.set('x-amz-content-sha256', bodyHash);
    if (credentials.sessionToken) {
      headers.set('x-amz-security-token', credentials.sessionToken);
    }
    const sortedHeaders = [...headers.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const signedHeaders = sortedHeaders.map(([key]) => key).join(';');
    const canonicalHeaders = `${sortedHeaders
      .map(([key, value]) => `${key}:${value}`)
      .join('\n')}\n`;
    const canonicalRequest = [
      method,
      canonicalPath(url),
      canonicalQuery(url),
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join('\n');
    const scope = `${shortDate}/${input.region}/${input.service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256(canonicalRequest),
    ].join('\n');
    const signature = createHmac(
      'sha256',
      awsSigningKey(
        credentials.secretAccessKey,
        shortDate,
        input.region,
        input.service,
      ),
    )
      .update(stringToSign)
      .digest('hex');
    headers.set(
      'authorization',
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 10_000,
    );
    try {
      return await (this.options.fetch ?? fetch)(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: Object.fromEntries(headers),
        ...(typeof body === 'string' && body.length === 0 ? {} : { body }),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public async json(
    input: AwsSignedRequestOptions,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(input);
    const text = await readBoundedText(
      response,
      this.options.maximumResponseBytes ?? 1024 * 1024,
    );
    let parsed: Record<string, unknown> = {};
    if (text) {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('AWS JSON response was not an object');
      }
      parsed = value as Record<string, unknown>;
    }
    if (!response.ok) {
      const rawCode =
        typeof parsed.__type === 'string'
          ? parsed.__type
          : typeof parsed.code === 'string'
            ? parsed.code
            : 'UnknownServiceError';
      throw new AwsServiceError(
        input.service,
        response.status,
        rawCode.split('#').at(-1) ?? rawCode,
      );
    }
    return parsed;
  }
}

export class AwsJsonProtocolClient {
  public constructor(
    private readonly region: string,
    private readonly http: AwsSignedHttpClient = new AwsSignedHttpClient(),
  ) {}

  public call(
    service: 'dynamodb' | 'secretsmanager',
    target: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const endpoint =
      service === 'dynamodb'
        ? `https://dynamodb.${this.region}.amazonaws.com/`
        : `https://secretsmanager.${this.region}.amazonaws.com/`;
    return this.http.json({
      service,
      region: this.region,
      url: endpoint,
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': target,
      },
      body: JSON.stringify(payload),
    });
  }
}
