import { hash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque bearer tokens of the form `<prefix>_<lookup id>_<secret>`, shared by
 * API keys (`mfk`) and user sessions (`mfs`).
 *
 * - The prefix makes a token recognizable in a repository or a log scan, and
 *   tells a session from a key.
 * - The lookup id is 8 random bytes in lowercase hexadecimal. It is public: it
 *   finds the stored row and carries no authority.
 * - The secret is 32 random bytes (256 bits of entropy) in lowercase
 *   hexadecimal, from the operating system's cryptographically secure source.
 *
 * Only the lookup id and the SHA-256 hash of the secret are stored. A fast hash
 * is enough because the secret is random with 256 bits of entropy (AD-45).
 */
export const LOOKUP_ID_BYTES = 8;
export const SECRET_BYTES = 32;

/** Source of random bytes. Tests replace it to get a known token. */
export type RandomSource = (size: number) => Buffer;

/** A newly generated token. `token` is the only place the secret appears. */
export interface GeneratedToken {
  readonly token: string;
  readonly lookupId: string;
  /** SHA-256 of the secret part, the value that is stored. */
  readonly secretHash: string;
}

/** The two parts of a presented token. */
export interface ParsedToken {
  readonly lookupId: string;
  readonly secret: string;
}

/** Generates and parses the tokens of one prefix. */
export interface OpaqueTokenFormat {
  readonly prefix: string;
  generate(randomSource?: RandomSource): GeneratedToken;
  /**
   * Splits a presented token into its lookup id and secret. It returns
   * `undefined` for anything that is not exactly a well-formed token of this
   * prefix, and does not trim or normalize its input.
   */
  parse(presented: string): ParsedToken | undefined;
}

/** Returns the SHA-256 of a secret as 64 lowercase hexadecimal characters. */
export function hashTokenSecret(secret: string): string {
  return hash('sha256', secret, 'hex');
}

/**
 * Tells whether a presented secret matches a stored hash, comparing the two
 * digests in constant time. Both digests have the same length unless the stored
 * value is not a SHA-256 digest, which never matches.
 */
export function verifyTokenSecret(
  presentedSecret: string,
  storedHash: string,
): boolean {
  const presentedDigest = Buffer.from(hashTokenSecret(presentedSecret), 'hex');
  const storedDigest = Buffer.from(storedHash, 'hex');
  return (
    presentedDigest.length === storedDigest.length &&
    timingSafeEqual(presentedDigest, storedDigest)
  );
}

/** The format of the tokens that start with `<prefix>_`. */
export function opaqueTokenFormat(prefix: string): OpaqueTokenFormat {
  const pattern = new RegExp(
    `^${prefix}_([0-9a-f]{${LOOKUP_ID_BYTES * 2}})_([0-9a-f]{${SECRET_BYTES * 2}})$`,
  );
  return {
    prefix,
    generate(randomSource: RandomSource = randomBytes): GeneratedToken {
      const lookupId = randomSource(LOOKUP_ID_BYTES).toString('hex');
      const secret = randomSource(SECRET_BYTES).toString('hex');
      return {
        token: `${prefix}_${lookupId}_${secret}`,
        lookupId,
        secretHash: hashTokenSecret(secret),
      };
    },
    parse(presented: string): ParsedToken | undefined {
      const match = pattern.exec(presented);
      if (match === null) return undefined;
      const [, lookupId, secret] = match;
      return lookupId === undefined || secret === undefined
        ? undefined
        : { lookupId, secret };
    },
  };
}
