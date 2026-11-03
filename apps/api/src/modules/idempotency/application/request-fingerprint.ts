import { createHash } from 'node:crypto';

/**
 * A value that can take part in a request fingerprint: the JSON types, with
 * finite numbers only. Amounts are not numbers here: the caller passes them as
 * their integer strings, as the API receives them.
 */
export type FingerprintValue =
  | string
  | number
  | boolean
  | null
  | readonly FingerprintValue[]
  | { readonly [key: string]: FingerprintValue };

/**
 * Returns the SHA-256, in lowercase hexadecimal, of the canonical encoding of
 * an operation and its validated request.
 *
 * The encoding is the JSON text of `[operation, request]` with no whitespace,
 * the keys of every object sorted by UTF-16 code units, strings escaped as
 * `JSON.stringify` escapes them, and numbers written in their shortest
 * round-trip form (so `-0` is written as `0`), hashed as UTF-8. It therefore
 * does not depend on the order in which object keys were added.
 *
 * Only the operation and the request take part. The idempotency key, the
 * correlation ID, and other transport metadata must not be inside `request`.
 *
 * Throws a `TypeError`, naming the path of the value, for anything outside
 * `FingerprintValue`: `undefined`, functions, symbols, `bigint`, non-finite
 * numbers, sparse arrays, objects that are not plain (such as `Date` or
 * `Map`), objects with symbol keys, and cycles. Such a value is a programming
 * error, because the type already excludes it.
 */
export function computeRequestFingerprint(
  operation: string,
  request: FingerprintValue,
): string {
  const encoded = encodeCanonical([operation, request], '$', new Set());
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

function encodeCanonical(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} is a non-finite number`);
      }
      return JSON.stringify(value);
    case 'object':
      if (value === null) {
        return 'null';
      }
      return encodeContainer(value, path, ancestors);
    default:
      throw new TypeError(`${path} has the unsupported type ${typeof value}`);
  }
}

function encodeContainer(
  value: object,
  path: string,
  ancestors: Set<object>,
): string {
  if (ancestors.has(value)) {
    throw new TypeError(`${path} refers to one of its ancestors`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] is a hole in a sparse array`);
        }
        items.push(
          encodeCanonical(value[index], `${path}[${index}]`, ancestors),
        );
      }
      return `[${items.join(',')}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} is not a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} has symbol keys`);
    }
    const record = value as Readonly<Record<string, unknown>>;
    const members = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${encodeCanonical(record[key], `${path}.${key}`, ancestors)}`,
      );
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
