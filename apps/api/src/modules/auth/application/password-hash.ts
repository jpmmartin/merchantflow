import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Shortest password a user may be given. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Longest password accepted anywhere, including at login, so the input of the
 * key derivation is bounded.
 */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * scrypt parameters of new hashes: N = 2^15, r = 8, p = 3. This is one of the
 * equivalent settings of the OWASP Password Storage Cheat Sheet (N = 2^17,
 * r = 8, p = 1 being the baseline); it needs 32 MiB per derivation
 * (128 * N * r bytes) instead of 128 MiB, so concurrent sign-ins on the
 * libuv thread pool use a quarter of the memory for comparable cost. Node's
 * defaults (N = 2^14, p = 1) are weaker. Each hash stores its own parameters,
 * so a later change keeps verifying older hashes.
 */
export const SCRYPT_PARAMETERS = {
  log2Cost: 15,
  blockSize: 8,
  parallelization: 3,
} as const;

/** Random salt per hash; Node's documentation recommends at least 16 bytes. */
const SALT_BYTES = 16;

/** Random bytes of a generated password: 24 base64url characters (144 bits). */
const GENERATED_PASSWORD_BYTES = 18;

/** Length of the derived key. */
const KEY_BYTES = 32;

/** Bounds of parameters read back from a stored hash. */
const MAX_LOG2_COST = 20;
const MAX_BLOCK_SIZE = 32;
const MAX_PARALLELIZATION = 16;

const PHC_PATTERN =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ScryptParameters {
  readonly log2Cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
}

interface StoredHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly key: Buffer;
}

/** Base64 without padding, as PHC strings use. */
function toUnpaddedBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/**
 * Derives a key with scrypt on the libuv thread pool, so the event loop is not
 * blocked. `maxmem` is twice the memory the parameters need, because Node
 * refuses a derivation when 128 * N * r reaches its bound.
 */
function deriveKey(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
  keyLength: number,
): Promise<Buffer> {
  const cost = 2 ** parameters.log2Cost;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      {
        cost,
        blockSize: parameters.blockSize,
        parallelization: parameters.parallelization,
        maxmem: 2 * 128 * cost * parameters.blockSize,
      },
      (error, derivedKey) => {
        if (error === null) resolve(derivedKey);
        else reject(error);
      },
    );
  });
}

/**
 * Reads a stored PHC string. The `users_password_hash_check` constraint makes
 * an unreadable value impossible to store, so one is a bug and throws.
 */
function parseStoredHash(stored: string): StoredHash {
  const match = PHC_PATTERN.exec(stored);
  const [, ln, r, p, salt, key] = match ?? [];
  if (
    ln === undefined ||
    r === undefined ||
    p === undefined ||
    salt === undefined ||
    key === undefined
  ) {
    throw new Error('stored password hash is not a scrypt PHC string');
  }
  const parameters = {
    log2Cost: Number.parseInt(ln, 10),
    blockSize: Number.parseInt(r, 10),
    parallelization: Number.parseInt(p, 10),
  };
  if (
    parameters.log2Cost < 1 ||
    parameters.log2Cost > MAX_LOG2_COST ||
    parameters.blockSize < 1 ||
    parameters.blockSize > MAX_BLOCK_SIZE ||
    parameters.parallelization < 1 ||
    parameters.parallelization > MAX_PARALLELIZATION
  ) {
    throw new Error('stored password hash has out-of-range parameters');
  }
  return {
    parameters,
    salt: Buffer.from(salt, 'base64'),
    key: Buffer.from(key, 'base64'),
  };
}

/**
 * Hashes a password with a fresh random salt and the current parameters, and
 * returns `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, SCRYPT_PARAMETERS, KEY_BYTES);
  const { log2Cost, blockSize, parallelization } = SCRYPT_PARAMETERS;
  return `$scrypt$ln=${log2Cost},r=${blockSize},p=${parallelization}$${toUnpaddedBase64(salt)}$${toUnpaddedBase64(key)}`;
}

/**
 * Tells whether a password matches a stored hash. It derives the key with the
 * stored salt and parameters and compares the two keys in constant time.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const { parameters, salt, key } = parseStoredHash(stored);
  const derived = await deriveKey(password, salt, parameters, key.length);
  return derived.length === key.length && timingSafeEqual(derived, key);
}

/**
 * Generates a password of 24 base64url characters from 18 random bytes (144
 * bits), for an account whose first password nobody chooses: the seeded
 * administrator and every user created through the API.
 */
export function generatePassword(): string {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}
