import { z } from 'zod';

/**
 * A position in a list ordered by `(created_at, id)`: the creation time and the
 * id of the last row of a page. The id breaks ties between rows created at the
 * same instant, so a position names exactly one place in the order.
 */
export interface KeysetPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/** Largest page a list request may ask for. */
export const MAX_PAGE_SIZE = 100;

/** Page size when the request gives none. */
export const DEFAULT_PAGE_SIZE = 20;

const cursorPayloadSchema = z.object({
  c: z.iso.datetime(),
  i: z.uuid(),
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Turns the end of a page into the opaque text a client sends back. It is
 * unsigned: it only says where in the order to continue, and what the client
 * can read after that position is limited by its credential, not by the cursor.
 */
export function encodeKeysetCursor(position: KeysetPosition): string {
  const payload = { c: position.createdAt.toISOString(), i: position.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Reads a cursor made by `encodeKeysetCursor`. It returns `undefined` for
 * anything else: text outside the base64url alphabet, text that is not JSON of
 * the expected shape, and a time that is not in the canonical form the encoder
 * writes. Input is untrusted, so each step only accepts and never repairs.
 */
export function decodeKeysetCursor(value: string): KeysetPosition | undefined {
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

/** The `limit` query parameter of a list: 1 to 100, 20 when absent. */
export const pageLimitQuerySchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .describe('Page size.');

/**
 * The `cursor` query parameter of a list, decoded into a position. A value the
 * encoder could not have written is one `custom` issue at `cursor`, and the
 * value itself is not echoed.
 */
export const pageCursorQuerySchema = z
  .string()
  .min(1)
  .max(200)
  .transform((value, context) => {
    const position = decodeKeysetCursor(value);
    if (position === undefined) {
      context.issues.push({
        code: 'custom',
        input: value,
        message: 'Invalid cursor.',
      });
      return z.NEVER;
    }
    return position;
  })
  .optional()
  .describe('The next_cursor of the previous page, unchanged.');
