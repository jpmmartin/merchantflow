import { hash, randomBytes, timingSafeEqual } from 'node:crypto';

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
export const LOOKUP_ID_BYTES = 8;
export const SECRET_BYTES = 32;

const API_KEY_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}_([0-9a-f]{${LOOKUP_ID_BYTES * 2}})_([0-9a-f]{${SECRET_BYTES * 2}})$`,
);

/** Source of random bytes. Tests replace it to get a known key. */
export type RandomSource = (size: number) => Buffer;

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
  return hash('sha256', secret, 'hex');
}

/** Generates a key with a fresh lookup id and secret. */
export function generateApiKey(
  randomSource: RandomSource = randomBytes,
): GeneratedApiKey {
  const lookupId = randomSource(LOOKUP_ID_BYTES).toString('hex');
  const secret = randomSource(SECRET_BYTES).toString('hex');
  return {
    key: `${API_KEY_PREFIX}_${lookupId}_${secret}`,
    lookupId,
    secretHash: hashApiKeySecret(secret),
  };
}

/**
 * Splits a presented key into its lookup id and secret. It returns `undefined`
 * for anything that is not exactly a well-formed key, and does not trim or
 * normalize its input.
 */
export function parseApiKey(presented: string): ParsedApiKey | undefined {
  const match = API_KEY_PATTERN.exec(presented);
  if (match === null) {
    return undefined;
  }
  const [, lookupId, secret] = match;
  return lookupId === undefined || secret === undefined
    ? undefined
    : { lookupId, secret };
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
  const presentedDigest = Buffer.from(hashApiKeySecret(presentedSecret), 'hex');
  const storedDigest = Buffer.from(storedHash, 'hex');
  return (
    presentedDigest.length === storedDigest.length &&
    timingSafeEqual(presentedDigest, storedDigest)
  );
}
