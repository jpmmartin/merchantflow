import { createHash, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_PREFIX,
  LOOKUP_ID_BYTES,
  SECRET_BYTES,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
} from './api-key-secret.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

const KEY_FORMAT = /^mfk_[0-9a-f]{16}_[0-9a-f]{64}$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Returns bytes counting up from `start`, so each call is recognizable. */
function sequentialSource(start: number) {
  const requested: number[] = [];
  const source = (size: number): Buffer => {
    requested.push(size);
    return Buffer.from(Array.from({ length: size }, (_, i) => start + i));
  };
  return { source, requested };
}

describe('generateApiKey', () => {
  it('produces the documented format', () => {
    const { key } = generateApiKey();

    expect(key).toMatch(KEY_FORMAT);
    expect(key.startsWith(`${API_KEY_PREFIX}_`)).toBe(true);
  });

  it('draws 8 bytes for the lookup id and 32 bytes (256 bits) for the secret', () => {
    const { source, requested } = sequentialSource(0);

    generateApiKey(source);

    expect(requested).toEqual([LOOKUP_ID_BYTES, SECRET_BYTES]);
    expect(LOOKUP_ID_BYTES).toBe(8);
    expect(SECRET_BYTES * 8).toBeGreaterThanOrEqual(256);
  });

  it('builds the key from the random bytes it receives', () => {
    const bytes = [Buffer.alloc(8, 0xab), Buffer.alloc(32, 0xcd)];
    const source = vi.fn((): Buffer => bytes.shift() ?? Buffer.alloc(0));

    const generated = generateApiKey(source);

    expect(generated.lookupId).toBe('ab'.repeat(8));
    expect(generated.key).toBe(`mfk_${'ab'.repeat(8)}_${'cd'.repeat(32)}`);
  });

  it('returns the lookup id embedded in the key', () => {
    const generated = generateApiKey();

    expect(parseApiKey(generated.key)?.lookupId).toBe(generated.lookupId);
  });

  it('returns the SHA-256 of the secret part, not of the whole key', () => {
    const generated = generateApiKey();
    const secret = parseApiKey(generated.key)?.secret ?? '';

    expect(generated.secretHash).toBe(sha256Hex(secret));
    expect(generated.secretHash).not.toBe(sha256Hex(generated.key));
  });

  it('does not repeat the secret in any field other than the key', () => {
    const generated = generateApiKey();
    const secret = parseApiKey(generated.key)?.secret ?? '';

    expect(generated.lookupId).not.toContain(secret);
    expect(generated.secretHash).not.toContain(secret);
  });

  it('never repeats a key, lookup id, or secret across 10 000 keys', () => {
    const keys = Array.from({ length: 10_000 }, () => generateApiKey());

    expect(new Set(keys.map((generated) => generated.key)).size).toBe(10_000);
    expect(new Set(keys.map((generated) => generated.lookupId)).size).toBe(
      10_000,
    );
    expect(new Set(keys.map((generated) => generated.secretHash)).size).toBe(
      10_000,
    );
    for (const generated of keys) {
      expect(generated.key).toMatch(KEY_FORMAT);
    }
  });
});

describe('hashApiKeySecret', () => {
  it('returns the SHA-256 digest in lowercase hexadecimal', () => {
    expect(hashApiKeySecret('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and sensitive to every character', () => {
    const secret = 'a'.repeat(64);

    expect(hashApiKeySecret(secret)).toBe(hashApiKeySecret(secret));
    expect(hashApiKeySecret(secret)).not.toBe(
      hashApiKeySecret(`${secret.slice(0, 63)}b`),
    );
  });

  it('always yields 64 hexadecimal characters', () => {
    expect(hashApiKeySecret('')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKeySecret('x'.repeat(10_000))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseApiKey', () => {
  const lookupId = '0123456789abcdef';
  const secret = 'f'.repeat(64);

  it('splits a well-formed key', () => {
    expect(parseApiKey(`mfk_${lookupId}_${secret}`)).toEqual({
      lookupId,
      secret,
    });
  });

  it.each([
    ['an empty string', ''],
    ['another prefix', `sk_${lookupId}_${secret}`],
    ['an uppercase prefix', `MFK_${lookupId}_${secret}`],
    ['an uppercase lookup id', `mfk_${lookupId.toUpperCase()}_${secret}`],
    ['an uppercase secret', `mfk_${lookupId}_${secret.toUpperCase()}`],
    ['a short lookup id', `mfk_${lookupId.slice(1)}_${secret}`],
    ['a long lookup id', `mfk_${lookupId}0_${secret}`],
    ['a short secret', `mfk_${lookupId}_${secret.slice(1)}`],
    ['a long secret', `mfk_${lookupId}_${secret}0`],
    ['a non-hexadecimal secret', `mfk_${lookupId}_${'g'.repeat(64)}`],
    ['no secret', `mfk_${lookupId}`],
    ['a missing separator', `mfk_${lookupId}${secret}`],
    ['leading whitespace', ` mfk_${lookupId}_${secret}`],
    ['trailing whitespace', `mfk_${lookupId}_${secret} `],
    ['a trailing newline', `mfk_${lookupId}_${secret}\n`],
    ['a Bearer scheme', `Bearer mfk_${lookupId}_${secret}`],
    ['a huge input', `mfk_${lookupId}_${'f'.repeat(1_000_000)}`],
  ])('rejects %s', (_label, presented) => {
    expect(parseApiKey(presented)).toBeUndefined();
  });
});

describe('verifyApiKeySecret', () => {
  it('accepts the secret that produced the stored hash', () => {
    const generated = generateApiKey();
    const secret = parseApiKey(generated.key)?.secret ?? '';

    expect(verifyApiKeySecret(secret, generated.secretHash)).toBe(true);
  });

  it('rejects another secret', () => {
    const generated = generateApiKey();
    const other = parseApiKey(generateApiKey().key)?.secret ?? '';

    expect(verifyApiKeySecret(other, generated.secretHash)).toBe(false);
  });

  it('rejects a secret that differs only in its last character', () => {
    const generated = generateApiKey();
    const secret = parseApiKey(generated.key)?.secret ?? '';
    const altered = `${secret.slice(0, -1)}${secret.endsWith('0') ? '1' : '0'}`;

    expect(verifyApiKeySecret(altered, generated.secretHash)).toBe(false);
  });

  it.each([
    ['an empty hash', ''],
    ['a short hash', 'ab'.repeat(31)],
    ['a long hash', 'ab'.repeat(33)],
    ['a hash that is not hexadecimal', 'zz'.repeat(32)],
  ])('rejects %s without throwing', (_label, storedHash) => {
    expect(verifyApiKeySecret('f'.repeat(64), storedHash)).toBe(false);
  });

  it('compares the digests with timingSafeEqual', () => {
    vi.mocked(timingSafeEqual).mockClear();
    const generated = generateApiKey();
    const secret = parseApiKey(generated.key)?.secret ?? '';

    verifyApiKeySecret(secret, generated.secretHash);

    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
