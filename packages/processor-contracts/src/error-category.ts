/**
 * Why a processor call did not produce a business outcome. An adapter assigns
 * exactly one category, and a caller never reads a category as a card decline
 * unless it is `ISSUER_DECLINE`.
 *
 * - `CONFIGURATION`: the merchant's account or credentials are wrong.
 * - `NETWORK`: the provider could not be reached, or the connection broke.
 * - `GATEWAY`: the provider answered with an error of its own.
 * - `ISSUER_DECLINE`: the card issuer refused the payment.
 * - `INVALID_REQUEST`: the provider refused the request as malformed.
 * - `UNKNOWN`: the outcome cannot be classified.
 */
export const PROCESSOR_ERROR_CATEGORIES = [
  'CONFIGURATION',
  'NETWORK',
  'GATEWAY',
  'ISSUER_DECLINE',
  'INVALID_REQUEST',
  'UNKNOWN',
] as const;

export type ProcessorErrorCategory =
  (typeof PROCESSOR_ERROR_CATEGORIES)[number];
