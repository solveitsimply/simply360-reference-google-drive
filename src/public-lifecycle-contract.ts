import snapshot from './public-contracts/lifecycle-occurrence-v1.json' with { type: 'json' };

type Schema = {
  readonly type?: string;
  readonly const?: unknown;
  readonly pattern?: string;
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, Schema>>;
};

export type LifecycleEventType =
  | 'app.suspended'
  | 'app.grant.revoked'
  | 'app.uninstalled'
  | 'app.dataExport.requested'
  | 'app.dataDeletion.requested';

export interface LifecycleOccurrence {
  readonly eventSimplyId: string;
  readonly teamSimplyId: string;
  readonly teamIntegrationSimplyId: string;
  readonly eventType: LifecycleEventType;
  readonly protocolVersion: 1;
  readonly payloadSchemaId: 'simply360.event.app-lifecycle/v1';
  readonly payloadSchemaVersion: 1;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>> & {
    readonly eventType: LifecycleEventType;
    readonly idempotencyKey: string;
    readonly appVersion: string;
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const validate = (schema: Schema, value: unknown, path: string): void => {
  if ('const' in schema && value !== schema.const) {
    throw new Error(`${path} does not match the public constant`);
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      throw new Error(`${path} is shorter than the public minimum`);
    }
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
      throw new Error(`${path} is longer than the public maximum`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      throw new Error(`${path} does not match the public pattern`);
    }
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) {
      throw new Error(`${path} must be a date-time`);
    }
    return;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${path} must be a number`);
    }
    return;
  }
  if (schema.type === 'object') {
    if (!record(value)) throw new Error(`${path} must be a plain object`);
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new Error(`${path} is missing ${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) throw new Error(`${path} contains unknown property ${key}`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) validate(child, value[key], `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains an unsupported public schema node`);
};

const variants = snapshot.variants as unknown as readonly Schema[];
const byEventType = new Map(
  variants.map((variant) => {
    const eventType = variant.properties?.eventType?.const;
    if (typeof eventType !== 'string') {
      throw new Error('public lifecycle variant has no eventType');
    }
    return [eventType, variant] as const;
  }),
);

export const PUBLIC_LIFECYCLE_SOURCE_SHA256 = snapshot.source.sha256;
export const PUBLIC_LIFECYCLE_VARIANTS_SHA256 =
  snapshot.selectedVariantsSha256;

export const parseLifecycleOccurrence = (
  input: unknown,
): LifecycleOccurrence => {
  if (!record(input) || typeof input.eventType !== 'string') {
    throw new Error('lifecycle occurrence must be an object with eventType');
  }
  const variant = byEventType.get(input.eventType);
  if (!variant) throw new Error('lifecycle event type is not declared');
  validate(variant, input, 'lifecycle occurrence');
  return input as unknown as LifecycleOccurrence;
};
