import { describe, expect, it } from 'vitest';
import {
  CORRELATION_ID_PATTERN,
  generateRequestId,
  resolveCorrelationId,
} from './correlation.js';

const FALLBACK = 'fallback-id-0001';

describe('resolveCorrelationId', () => {
  it.each([
    '12345678',
    'a'.repeat(64),
    '3f2b8c1e-9d4a-4b7e-8a61-0c5d2e7f9a10',
    'order.flow_7-A',
  ])('reuses the valid value %j', (value) => {
    expect(resolveCorrelationId(value, FALLBACK)).toBe(value);
  });

  it.each([
    ['too short', '1234567'],
    ['too long', 'a'.repeat(65)],
    ['empty', ''],
    ['contains a space', 'abcd efgh'],
    ['contains a newline', 'abcdefgh\n{"level":60}'],
    ['contains a quote', 'abcdefgh"'],
    ['contains a comma, as joined duplicates do', 'abcdefgh, abcdefgh'],
    ['non-ASCII', 'abcdefghé'],
  ])('replaces a value that is %s', (_label, value) => {
    expect(resolveCorrelationId(value, FALLBACK)).toBe(FALLBACK);
  });

  it('replaces a missing or array value', () => {
    expect(resolveCorrelationId(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveCorrelationId(['abcdefgh', 'abcdefgh'], FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it('generates request IDs that satisfy the correlation format', () => {
    const id = generateRequestId();
    expect(CORRELATION_ID_PATTERN.test(id)).toBe(true);
    expect(generateRequestId()).not.toBe(id);
  });
});
