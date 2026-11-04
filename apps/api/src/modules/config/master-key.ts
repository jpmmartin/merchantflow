/** Length of the AES-256 master key, in bytes. */
export const MASTER_KEY_BYTES = 32;

/**
 * Whether a value is exactly 32 bytes in canonical standard base64: decoding
 * and encoding again gives the same text, so padding, whitespace, URL-safe
 * characters, and trailing bits that Node would silently ignore are refused.
 */
export function isMasterKeyEncoding(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');
  return (
    decoded.length === MASTER_KEY_BYTES && decoded.toString('base64') === value
  );
}

/** Decodes a master key that `isMasterKeyEncoding` accepted. */
export function decodeMasterKey(value: string): Buffer {
  if (!isMasterKeyEncoding(value)) {
    throw new Error('the master key is not 32 bytes of canonical base64');
  }
  return Buffer.from(value, 'base64');
}
