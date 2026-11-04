import type { CredentialRejectionReason } from '@merchantflow/processor-contracts';

/** Longest key the adapter accepts; Stripe keys are far shorter. */
export const STRIPE_KEY_MAX_LENGTH = 255;

const KEY_BODY = /^[A-Za-z0-9_]+$/;

/**
 * Checks the format and mode of a key from its prefix alone, before any call
 * to Stripe: a test key has the `_test_` prefix, a live key has `_live_`. A
 * restricted key (`rk_`) is not accepted as the secret key, because it may lack
 * the read permissions the validation needs.
 */
export function checkStripeKey(
  key: string,
  kind: 'secret' | 'publishable',
): CredentialRejectionReason | undefined {
  const [testPrefix, livePrefixes] =
    kind === 'secret'
      ? ['sk_test_', ['sk_live_', 'rk_live_']]
      : ['pk_test_', ['pk_live_']];
  if (livePrefixes.some((prefix) => key.startsWith(prefix))) {
    return 'LIVE_MODE_KEY';
  }
  if (
    !key.startsWith(testPrefix) ||
    key.length <= testPrefix.length ||
    key.length > STRIPE_KEY_MAX_LENGTH ||
    !KEY_BODY.test(key)
  ) {
    return 'MALFORMED_KEY';
  }
  return undefined;
}
