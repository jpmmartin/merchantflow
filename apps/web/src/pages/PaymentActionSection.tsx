import { useState } from 'react';
import type { ProcessorAccount } from '../api/merchants';
import {
  completePaymentAction,
  type PaymentAttempt,
  type PaymentIntent,
} from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { runCustomerAction, stripeFor } from '../card-payments/stripe-loader';
import type { PaymentStepOutcome } from './PaymentPaySection';

interface PaymentActionSectionProps {
  readonly intent: PaymentIntent;
  /** The attempt waiting for the customer, if the attempts are loaded. */
  readonly attempt: PaymentAttempt | undefined;
  readonly accounts: readonly ProcessorAccount[] | undefined;
  readonly onOutcome: (outcome: PaymentStepOutcome) => void;
  readonly onChanged: () => void;
}

/**
 * Continues a payment that waits for the customer's authentication, for
 * example after the page was reloaded during a 3D Secure challenge. The API
 * reads the payment from Stripe: if it still needs the customer, it returns
 * the client secret again and Stripe.js runs the step with the publishable
 * key of the attempt's own account; the API then applies the result.
 */
export function PaymentActionSection({
  intent,
  attempt,
  accounts,
  onOutcome,
  onChanged,
}: PaymentActionSectionProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const account =
    attempt === undefined
      ? undefined
      : accounts?.find((each) => each.id === attempt.processor_account_id);

  async function continueAuthentication(publishableKey: string) {
    setBusy(true);
    setError(undefined);
    try {
      const first = await completePaymentAction(intent.id);
      if (first.next_action === null) {
        onOutcome({ confirmation: first, stripeMessage: undefined });
        return;
      }
      const stripe = await stripeFor(publishableKey);
      if (stripe === null) {
        onOutcome({
          confirmation: first,
          stripeMessage: 'Stripe.js is not available in this browser.',
        });
        return;
      }
      const action = await runCustomerAction(
        stripe,
        first.next_action.client_secret,
      );
      const completion = await completePaymentAction(intent.id);
      onOutcome({
        confirmation: completion,
        stripeMessage: action.stripeMessage,
      });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <section className="card mb-4 border-primary">
      <div className="card-body">
        <h2 className="h5">Customer authentication required</h2>
        <p className="small">
          The card asked for 3D Secure authentication and the payment is waiting
          for it. Continue to open the challenge again; the result is read from
          Stripe and applied.
        </p>
        <ErrorAlert error={error} />
        {account === undefined ? (
          <div className="spinner-border spinner-border-sm" role="status">
            <span className="visually-hidden">Loading…</span>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void continueAuthentication(account.publishable_key)}
          >
            {busy ? 'Waiting for authentication…' : 'Continue authentication'}
          </button>
        )}
      </div>
    </section>
  );
}
