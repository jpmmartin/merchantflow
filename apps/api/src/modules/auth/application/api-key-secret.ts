import { randomBytes } from 'node:crypto';
import {
  LOOKUP_ID_BYTES,
  SECRET_BYTES,
  hashTokenSecret,
  opaqueTokenFormat,
  verifyTokenSecret,
  type RandomSource,
} from './opaque-token.js';

/**
 * Key format: `mfk_<lookup id>_<secret>`.
 *
 * - `mfk` is a fixed prefix that makes a key recognizable in a repository or a
 *   log scan.
 * - The lookup id is 8 random bytes in lowercase hexadecimal. It is public: it
 *   finds the stored row and carries no authority.
 * - The secret is 32 random bytes (256 bits of entropy) in lowercase
 *   hexadecimal, from the operating system's cryptographically secure source.
 *
 * Only the lookup id and the SHA-256 hash of the secret are stored. A fast
 * hash is enough because the secret is random with 256 bits of entropy: an
 * attacker holding the hash cannot guess the secret whatever the hash speed,
 * and a precomputed table over 2^256 values is impossible. Slow, salted
 * functions such as bcrypt or Argon2 exist for human-chosen passwords, whose
 * low entropy makes guessing feasible; here they would only add latency to
 * every authenticated request.
 */
export const API_KEY_PREFIX = 'mfk';
export { LOOKUP_ID_BYTES, SECRET_BYTES, type RandomSource };

const API_KEY_FORMAT = opaqueTokenFormat(API_KEY_PREFIX);

/** A newly generated key. `key` is the only place the secret appears. */
export interface GeneratedApiKey {
  /** The full key, shown to its owner once and never stored. */
  readonly key: string;
  readonly lookupId: string;
  /** SHA-256 of the secret part, the value that is stored. */
  readonly secretHash: string;
}

/** The two parts of a presented key. */
export interface ParsedApiKey {
  readonly lookupId: string;
  readonly secret: string;
}

/** Returns the SHA-256 of a secret as 64 lowercase hexadecimal characters. */
export function hashApiKeySecret(secret: string): string {
  return hashTokenSecret(secret);
}

/** Generates a key with a fresh lookup id and secret. */
export function generateApiKey(
  randomSource: RandomSource = randomBytes,
): GeneratedApiKey {
  const generated = API_KEY_FORMAT.generate(randomSource);
  return {
    key: generated.token,
    lookupId: generated.lookupId,
    secretHash: generated.secretHash,
  };
}

/**
 * Splits a presented key into its lookup id and secret. It returns `undefined`
 * for anything that is not exactly a well-formed key, and does not trim or
 * normalize its input.
 */
export function parseApiKey(presented: string): ParsedApiKey | undefined {
  return API_KEY_FORMAT.parse(presented);
}

/**
 * Tells whether a presented secret matches a stored hash, comparing the two
 * digests in constant time. Both digests have the same length unless the stored
 * value is not a SHA-256 digest, which never matches.
 */
export function verifyApiKeySecret(
  presentedSecret: string,
  storedHash: string,
): boolean {
  return verifyTokenSecret(presentedSecret, storedHash);
}
