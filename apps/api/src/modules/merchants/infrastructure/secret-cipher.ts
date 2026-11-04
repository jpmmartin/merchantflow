import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** 96-bit IV, the size NIST SP 800-38D recommends for GCM. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Version of the master key in use; a rotation adds a version. */
export const CURRENT_SECRET_KEY_VERSION = 1;

/** A secret as stored: the parts AES-256-GCM needs to decrypt it. */
export interface EncryptedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: number;
}

/**
 * The row a secret belongs to. It becomes the associated data of the
 * encryption, so a ciphertext copied to another account, merchant, or
 * provider fails authentication instead of decrypting.
 */
export interface SecretBinding {
  readonly merchantId: string;
  readonly processorAccountId: string;
  readonly provider: string;
}

function associatedData(binding: SecretBinding, keyVersion: number): Buffer {
  return Buffer.from(
    [
      'merchantflow/processor-account-secret',
      `v${keyVersion}`,
      binding.merchantId,
      binding.processorAccountId,
      binding.provider,
    ].join('|'),
    'utf8',
  );
}

/**
 * Encrypts and decrypts processor account secrets with AES-256-GCM under the
 * master key from configuration. Every encryption draws a new random IV. The
 * master key lives only in this object; it is never logged or stored.
 */
export class SecretCipher {
  readonly #masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error('the master key must be 32 bytes');
    }
    this.#masterKey = Buffer.from(masterKey);
  }

  encrypt(plaintext: string, binding: SecretBinding): EncryptedSecret {
    const keyVersion = CURRENT_SECRET_KEY_VERSION;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#masterKey, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(associatedData(binding, keyVersion));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
  }

  /**
   * Returns the plain text of a secret for the one call that needs it. A
   * wrong binding, a wrong key, or a changed ciphertext, IV, or tag throws,
   * with a message that carries none of them.
   */
  decrypt(secret: EncryptedSecret, binding: SecretBinding): string {
    if (secret.keyVersion !== CURRENT_SECRET_KEY_VERSION) {
      throw new Error(`no master key for version ${secret.keyVersion}`);
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.#masterKey, secret.iv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAuthTag(secret.authTag);
      decipher.setAAD(associatedData(binding, secret.keyVersion));
      return Buffer.concat([
        decipher.update(secret.ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // The OpenSSL error says only that authentication failed; it is replaced
      // so that no detail of the stored secret can reach a log.
      throw new Error('a processor account secret failed to decrypt');
    }
  }
}

/**
 * Injection token of the cipher: a `SecretCipher`, or `null` when no master
 * key is configured outside production.
 */
export const SECRET_CIPHER = Symbol('SECRET_CIPHER');
