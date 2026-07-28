import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SIMPLY_ID = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/u;
const KID = /^[A-Za-z0-9._:@+/=-]{1,200}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export interface WebhookSigningKey {
  readonly kid: string;
  readonly secret: string | Uint8Array;
}

export interface VerifiedWebhook {
  readonly kid: string;
  readonly timestampUnixSeconds: number;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly attemptId: string;
  readonly bodySha256Hex: string;
}

const validKey = (key: WebhookSigningKey): boolean =>
  KID.test(key.kid) &&
  !key.kid.includes(';') &&
  Buffer.byteLength(key.secret) >= 32;

export const verifyWebhookV2 = (input: {
  readonly rawBody: string | Uint8Array;
  readonly signatureHeader: string;
  readonly keys: readonly WebhookSigningKey[];
  readonly now?: Date;
}): VerifiedWebhook => {
  if (
    input.keys.length < 1 ||
    input.keys.length > 2 ||
    new Set(input.keys.map((key) => key.kid)).size !== input.keys.length ||
    input.keys.some((key) => !validKey(key))
  ) {
    throw new Error('webhook key set is invalid');
  }
  const segments = input.signatureHeader.split(';');
  if (segments.shift() !== 'v2') throw new Error('webhook signature version is invalid');
  const values = new Map<string, string>();
  for (const segment of segments) {
    const separator = segment.indexOf('=');
    const key = segment.slice(0, separator);
    if (
      separator < 1 ||
      !['kid', 't', 'e', 'd', 'a', 'h'].includes(key) ||
      values.has(key)
    ) {
      throw new Error('webhook signature fields are invalid');
    }
    values.set(key, segment.slice(separator + 1));
  }
  if (values.size !== 6) throw new Error('webhook signature is incomplete');
  const kid = values.get('kid') as string;
  const timestamp = values.get('t') as string;
  const eventId = values.get('e') as string;
  const deliveryId = values.get('d') as string;
  const attemptId = values.get('a') as string;
  const digest = values.get('h') as string;
  if (
    !KID.test(kid) ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    !SIMPLY_ID.test(eventId) ||
    !SIMPLY_ID.test(deliveryId) ||
    !SIMPLY_ID.test(attemptId) ||
    !DIGEST.test(digest)
  ) {
    throw new Error('webhook signature contains an invalid value');
  }
  const key = input.keys.find((candidate) => candidate.kid === kid);
  if (!key) throw new Error('webhook signing key is not accepted');
  const bodySha256Hex = createHash('sha256').update(input.rawBody).digest('hex');
  const signingInput = [
    'S360-HMAC-V2',
    timestamp,
    eventId,
    deliveryId,
    attemptId,
    bodySha256Hex,
  ].join('\n');
  const expected = createHmac('sha256', key.secret).update(signingInput).digest();
  const provided = Buffer.from(digest, 'hex');
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    throw new Error('webhook signature does not match');
  }
  const now = input.now ?? new Date();
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > 300) {
    throw new Error('webhook signature timestamp is outside the replay window');
  }
  return {
    kid,
    timestampUnixSeconds: Number(timestamp),
    eventId,
    deliveryId,
    attemptId,
    bodySha256Hex,
  };
};
