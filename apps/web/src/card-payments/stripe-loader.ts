import type { Stripe } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';

const instances = new Map<string, Promise<Stripe | null>>();

/**
 * The Stripe.js instance of one publishable key, created once per key. The
 * `pure` entry point loads the Stripe.js script only when a payment screen
 * first asks for it, so pages without payments never load it. A failed load is
 * forgotten, so the next call tries again.
 */
export function stripeFor(publishableKey: string): Promise<Stripe | null> {
  const cached = instances.get(publishableKey);
  if (cached !== undefined) return cached;
  const loading = loadStripe(publishableKey);
  instances.set(publishableKey, loading);
  void loading.catch(() => {
    instances.delete(publishableKey);
  });
  return loading;
}

/** The outcome of running the customer's step in the browser. */
export interface CustomerActionResult {
  /** Stripe.js's own message when the step did not finish, if any. */
  readonly stripeMessage: string | undefined;
}

/**
 * Runs the customer's step of a payment, such as a 3D Secure challenge, with
 * Stripe.js `handleNextAction` and the client secret the API returned. The
 * client secret is used here and not kept. Whatever Stripe.js reports, the
 * caller then asks the API to read the result from Stripe, which decides.
 */
export async function runCustomerAction(
  stripe: Stripe,
  clientSecret: string,
): Promise<CustomerActionResult> {
  try {
    const result = await stripe.handleNextAction({ clientSecret });
    return { stripeMessage: result.error?.message };
  } catch (caught) {
    return {
      stripeMessage:
        caught instanceof Error
          ? caught.message
          : 'Stripe.js could not run the authentication step.',
    };
  }
}
