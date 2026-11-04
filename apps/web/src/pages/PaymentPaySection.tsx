import {
  CardElement,
  Elements,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import type { ProcessorAccount } from '../api/merchants';
import {
  completePaymentAction,
  confirmPaymentIntent,
  type PaymentConfirmation,
  type PaymentIntent,
} from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { runCustomerAction, stripeFor } from '../card-payments/stripe-loader';

/** What the page shows after a payment step: the API's answer and Stripe.js's note. */
export interface PaymentStepOutcome {
  readonly confirmation: PaymentConfirmation;
  readonly stripeMessage: string | undefined;
}

/**
 * A confirmation that was sent and may be sent again: the payment method the
 * browser created and the key that belongs to it. One key per payment method:
 * a resend after a lost answer reuses both, a new card gets a new key.
 */
interface PendingConfirmation {
  readonly paymentMethodId: string;
  readonly idempotencyKey: string;
  readonly processorAccountId: string;
}

/**
 * Failures after which the same confirmation may be sent again with the same
 * key: no answer was read, the same request is still in progress, or the
 * server failed. The stored answer, if any, is then returned instead of a
 * second charge.
 */
const RESENDABLE_CODES = new Set([
  'NETWORK_ERROR',
  'INVALID_RESPONSE',
  'OPERATION_IN_PROGRESS',
  'OPERATION_TIMEOUT',
  'SERVICE_BUSY',
  'INTERNAL_ERROR',
]);

function isResendable(error: unknown): boolean {
  return error instanceof ApiError && RESENDABLE_CODES.has(error.code);
}

/** Stripe test cards for the demo; any future date and any CVC work. */
const TEST_CARDS = [
  { number: '4242 4242 4242 4242', result: 'Succeeds' },
  { number: '4000 0000 0000 9995', result: 'Declined: insufficient funds' },
  { number: '4000 0000 0000 3220', result: '3D Secure, then succeeds' },
  { number: '4000 0084 0000 1629', result: '3D Secure, then declined' },
] as const;

function TestCards() {
  return (
    <div className="small mb-3">
      <div className="fw-semibold">Stripe test cards</div>
      <div className="text-body-secondary">
        Use any future expiry date, any CVC, and any postal code.
      </div>
      <table className="table table-sm mb-0 mt-1" style={{ maxWidth: 520 }}>
        <tbody>
          {TEST_CARDS.map((card) => (
            <tr key={card.number}>
              <td className="font-monospace">{card.number}</td>
              <td>{card.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface PaymentPaySectionProps {
  readonly intent: PaymentIntent;
  readonly merchantId: string;
  /** The merchant's accounts; `undefined` while they load. */
  readonly accounts: readonly ProcessorAccount[] | undefined;
  readonly onOutcome: (outcome: PaymentStepOutcome) => void;
  /** Reloads the intent and its attempts. */
  readonly onChanged: () => void;
}

/**
 * Pays a `CREATED` intent with a card. The card is typed only into Stripe's
 * own field (Stripe Elements), loaded with the publishable key of the
 * merchant's enabled default account; Stripe.js turns it into a payment
 * method, and only its `pm_` ID and the account ID reach the API.
 */
export function PaymentPaySection({
  intent,
  merchantId,
  accounts,
  onOutcome,
  onChanged,
}: PaymentPaySectionProps) {
  const account = accounts?.find((each) => each.enabled && each.is_default);
  const stripePromise = useMemo(
    () =>
      account === undefined ? undefined : stripeFor(account.publishable_key),
    [account],
  );

  return (
    <section className="card mb-4">
      <div className="card-body">
        <h2 className="h5">Pay with a card</h2>
        {accounts === undefined ? (
          <div className="spinner-border spinner-border-sm" role="status">
            <span className="visually-hidden">Loading…</span>
          </div>
        ) : account === undefined || stripePromise === undefined ? (
          <div className="alert alert-warning mb-0" role="alert">
            This merchant has no enabled default Stripe account, so no payment
            can be taken. Connect one or choose a default in{' '}
            <Link to={`/merchants/${merchantId}`}>Processor accounts</Link>.
          </div>
        ) : (
          <>
            <p className="small text-body-secondary">
              Through <strong>{account.display_name}</strong> (
              <code>{account.provider_account_id}</code>). The card is entered
              in Stripe&apos;s field and never reaches MerchantFlow.
            </p>
            <TestCards />
            {/* The Stripe instance cannot change once Elements is mounted, so
                a different account mounts a new Elements. */}
            <Elements key={account.id} stripe={stripePromise}>
              <CardForm
                intent={intent}
                account={account}
                onOutcome={onOutcome}
                onChanged={onChanged}
              />
            </Elements>
          </>
        )}
      </div>
    </section>
  );
}

interface CardFormProps {
  readonly intent: PaymentIntent;
  readonly account: ProcessorAccount;
  readonly onOutcome: (outcome: PaymentStepOutcome) => void;
  readonly onChanged: () => void;
}

function CardForm({ intent, account, onOutcome, onChanged }: CardFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [pending, setPending] = useState<PendingConfirmation | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [cardMessage, setCardMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  async function send(confirmation: PendingConfirmation) {
    setBusy(true);
    setError(undefined);
    let answer: PaymentConfirmation;
    try {
      answer = await confirmPaymentIntent(
        intent.id,
        {
          payment_method: confirmation.paymentMethodId,
          processor_account_id: confirmation.processorAccountId,
        },
        confirmation.idempotencyKey,
      );
    } catch (caught) {
      // A resendable failure keeps the payment method and its key, so the
      // resend cannot charge twice; any other refusal needs a new card entry.
      setPending(isResendable(caught) ? confirmation : undefined);
      setError(caught);
      setBusy(false);
      onChanged();
      return;
    }
    setPending(undefined);
    try {
      if (answer.next_action === null || stripe === null) {
        onOutcome({ confirmation: answer, stripeMessage: undefined });
        return;
      }
      // 3D Secure: Stripe.js runs the challenge, then the API reads the
      // result from Stripe and applies it.
      const action = await runCustomerAction(
        stripe,
        answer.next_action.client_secret,
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stripe === null || elements === null || busy) return;
    const card = elements.getElement(CardElement);
    if (card === null) return;
    setBusy(true);
    setCardMessage(undefined);
    setError(undefined);
    const created = await stripe.createPaymentMethod({ type: 'card', card });
    if (created.error !== undefined) {
      setCardMessage(
        created.error.message ?? 'Stripe did not accept the card details.',
      );
      setBusy(false);
      return;
    }
    // A new payment method gets a new key; the previous pending one is dropped.
    const confirmation: PendingConfirmation = {
      paymentMethodId: created.paymentMethod.id,
      idempotencyKey: crypto.randomUUID(),
      processorAccountId: account.id,
    };
    setPending(confirmation);
    await send(confirmation);
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <div className="form-control mb-2" style={{ maxWidth: 520 }}>
        <CardElement options={{ hidePostalCode: false }} />
      </div>
      {cardMessage === undefined ? null : (
        <div className="text-danger small mb-2">{cardMessage}</div>
      )}
      <ErrorAlert error={error} />
      {pending !== undefined && !busy && error !== undefined ? (
        <div className="alert alert-info small" role="status">
          The last payment request may not have been answered. Send it again: it
          reuses the same request key (<code>{pending.idempotencyKey}</code>
          ), so it cannot charge twice.
          <div className="mt-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              onClick={() => void send(pending)}
            >
              Send the same payment again
            </button>
          </div>
        </div>
      ) : null}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={stripe === null || busy}
      >
        {busy ? 'Processing…' : 'Pay'}
      </button>
    </form>
  );
}
