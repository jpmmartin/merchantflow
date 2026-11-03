import { z } from 'zod';
import type { MerchantListPosition } from '../application/merchant-changes.js';

const cursorPayloadSchema = z.object({
  c: z.iso.datetime(),
  i: z.uuid(),
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Turns the end of a page into the opaque text a client sends back. It is
 * unsigned: it only says where in the order to continue, and what the client
 * can read after that position is limited by its key, not by the cursor.
 */
export function encodeMerchantCursor(position: MerchantListPosition): string {
  const payload = { c: position.createdAt.toISOString(), i: position.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Reads a cursor made by `encodeMerchantCursor`. It returns `undefined` for
 * anything else: text outside the base64url alphabet, text that is not JSON of
 * the expected shape, and a time that is not in the canonical form the encoder
 * writes. Input is untrusted, so each step only accepts and never repairs.
 */
export function decodeMerchantCursor(
  value: string,
): MerchantListPosition | undefined {
  if (!BASE64URL.test(value)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const payload = cursorPayloadSchema.safeParse(json);
  if (!payload.success) return undefined;
  const createdAt = new Date(payload.data.c);
  // Rejects a time the encoder could not have written, such as one with more
  // than millisecond precision, so every cursor means exactly one position.
  if (createdAt.toISOString() !== payload.data.c) return undefined;
  return { createdAt, id: payload.data.i };
}
