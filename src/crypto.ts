import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { IdGenerator } from './ports.js';

export const sha256Base64 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64');

export const sha256Base64Url = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('base64url');

export const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
};

export class SecureIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${randomBytes(16).toString('hex')}`;
  }

  secret(bytes: number): string {
    if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) {
      throw new Error('Secret byte length must be an integer between 16 and 128.');
    }
    return randomBytes(bytes).toString('base64url');
  }
}
