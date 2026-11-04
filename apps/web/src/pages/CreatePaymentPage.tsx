import { isSupportedCurrency } from '@merchantflow/domain';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import { getMerchant } from '../api/merchants';
import {
  createPaymentIntent,
  type CaptureMode,
  type NewPaymentIntent,
} from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { decimalAmountMessage, decimalToAmountMinor } from '../money/amount';

/** The order being sent and the `Idempotency-Key` that belongs to it. */
interface PendingOrder {
  readonly fingerprint: string;
  readonly key: string;
}

/** The values the API compares to decide whether a request is the same one. */
function fingerprintOf(order: NewPaymentIntent): string {
  return [
    order.amount_minor,
    order.currency,
    order.merchant_reference,
    order.capture_mode,
  ].join('\n');
}

type CurrencyState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly currency: string }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * The form that creates a payment order of the signed-in merchant user's
 * merchant. The amount is typed in major units and converted to minor units
 * as text before sending; the currency is the merchant's default currency and
 * cannot be changed. The capture mode is automatic by default; a manual order
 * is only authorized when it is paid, and is captured or voided afterwards on
 * its page.
 *
 * The `Idempotency-Key` is generated once per order: a resend of the same
 * values (after a network error, a 503, or any other failure) reuses it, so a
 * request that was created but whose answer was lost is answered with the same
 * order instead of a second one. Values that differ from the last sent ones,
 * or a successful creation, start a new key. Values are compared as sent, so
 * `100.5` and `100.50` are the same order.
 */
export function CreatePaymentPage({
  principal,
}: {
  readonly principal: CurrentPrincipal;
}) {
  const navigate = useNavigate();
  const merchantId = principal.merchant_id;
  const [currencyState, setCurrencyState] = useState<CurrencyState>({
    kind: 'loading',
  });
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [captureMode, setCaptureMode] = useState<CaptureMode>('AUTOMATIC');
  const [amountError, setAmountError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PendingOrder | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    if (merchantId === null) return;
    let current = true;
    getMerchant(merchantId).then(
      (merchant) => {
        if (current) {
          setCurrencyState({
            kind: 'loaded',
            currency: merchant.default_currency,
          });
        }
      },
      (caught: unknown) => {
        if (current) setCurrencyState({ kind: 'failed', error: caught });
      },
    );
    return () => {
      current = false;
    };
  }, [merchantId]);

  const currency =
    currencyState.kind === 'loaded' ? currencyState.currency : undefined;
  const supportedCurrency =
    currency !== undefined && isSupportedCurrency(currency)
      ? currency
      : undefined;
  const converted =
    supportedCurrency === undefined
      ? undefined
      : decimalToAmountMinor(amount, supportedCurrency);
  // The key shown is the one a submission of the current values would reuse.
  const currentFingerprint =
    supportedCurrency !== undefined && converted !== undefined && converted.ok
      ? fingerprintOf({
          amount_minor: converted.amountMinor,
          currency: supportedCurrency,
          merchant_reference: reference,
          capture_mode: captureMode,
        })
      : undefined;

  async function submit() {
    if (supportedCurrency === undefined) return;
    const parsed = decimalToAmountMinor(amount, supportedCurrency);
    if (!parsed.ok) {
      setAmountError(decimalAmountMessage(parsed.code, supportedCurrency));
      return;
    }
    const order: NewPaymentIntent = {
      amount_minor: parsed.amountMinor,
      currency: supportedCurrency,
      merchant_reference: reference,
      capture_mode: captureMode,
    };
    const fingerprint = fingerprintOf(order);
    const sending =
      pending !== undefined && pending.fingerprint === fingerprint
        ? pending
        : { fingerprint, key: crypto.randomUUID() };
    setPending(sending);
    setSubmitting(true);
    setError(undefined);
    try {
      const created = await createPaymentIntent(order, sending.key);
      setPending(undefined);
      void navigate(`/payments/${created.id}`);
    } catch (caught) {
      // The key stays with these values, so sending them again is a retry.
      setError(caught);
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  if (merchantId === null) {
    return <p>Only a merchant user can create payment orders.</p>;
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 className="h3 mb-3">Create payment order</h1>
      {currencyState.kind === 'failed' ? (
        <ErrorAlert error={currencyState.error} />
      ) : null}
      {currency !== undefined && supportedCurrency === undefined ? (
        <div className="alert alert-warning" role="alert">
          The merchant&apos;s currency <code>{currency}</code> is not supported
          by this version, so no order can be created.
        </div>
      ) : null}
      <ErrorAlert error={error} />
      <form onSubmit={handleSubmit} noValidate>
        <div className="mb-3">
          <label htmlFor="amount" className="form-label">
            Amount
          </label>
          <input
            id="amount"
            className={`form-control font-monospace${amountError === undefined ? '' : ' is-invalid'}`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="100.50"
            value={amount}
            aria-describedby="amount_help"
            onChange={(event) => {
              setAmount(event.target.value);
              setAmountError(undefined);
            }}
          />
          {amountError === undefined ? null : (
            <div className="invalid-feedback">{amountError}</div>
          )}
          <div id="amount_help" className="form-text">
            In major units with a decimal point, for example 100.50.
            {converted !== undefined && converted.ok ? (
              <>
                {' '}
                Sent as <code>amount_minor</code>{' '}
                <code>{converted.amountMinor}</code>.
              </>
            ) : null}
          </div>
        </div>
        <div className="mb-3">
          <label htmlFor="currency" className="form-label">
            Currency
          </label>
          <input
            id="currency"
            className="form-control"
            readOnly
            value={currency ?? ''}
            placeholder={currencyState.kind === 'loading' ? 'Loading…' : ''}
            aria-describedby="currency_help"
          />
          <div id="currency_help" className="form-text">
            The merchant&apos;s default currency.
          </div>
        </div>
        <div className="mb-3">
          <label htmlFor="merchant_reference" className="form-label">
            Order reference
          </label>
          <input
            id="merchant_reference"
            className="form-control"
            maxLength={128}
            autoComplete="off"
            value={reference}
            aria-describedby="merchant_reference_help"
            onChange={(event) => setReference(event.target.value)}
          />
          <div id="merchant_reference_help" className="form-text">
            Your own order identifier: 1 to 128 visible characters, without
            spaces. Each reference can be used for one order only.
          </div>
        </div>
        <fieldset className="mb-3">
          <legend className="form-label fs-6 mb-1">Capture</legend>
          <div className="form-check">
            <input
              id="capture_mode_automatic"
              className="form-check-input"
              type="radio"
              name="capture_mode"
              value="AUTOMATIC"
              checked={captureMode === 'AUTOMATIC'}
              onChange={() => setCaptureMode('AUTOMATIC')}
            />
            <label
              htmlFor="capture_mode_automatic"
              className="form-check-label"
            >
              Automatic: the payment is captured as soon as it succeeds
            </label>
          </div>
          <div className="form-check">
            <input
              id="capture_mode_manual"
              className="form-check-input"
              type="radio"
              name="capture_mode"
              value="MANUAL"
              checked={captureMode === 'MANUAL'}
              onChange={() => setCaptureMode('MANUAL')}
            />
            <label htmlFor="capture_mode_manual" className="form-check-label">
              Manual: the payment is only authorized and the funds are held;
              capture or void it later on its page
            </label>
          </div>
          <div className="form-text">
            Stripe releases an uncaptured card authorization after seven days.
          </div>
        </fieldset>
        {pending === undefined ||
        submitting ||
        pending.fingerprint !== currentFingerprint ? null : (
          <p className="small text-body-secondary">
            Sending the same values again reuses the request key{' '}
            <code>{pending.key}</code>.
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={submitting || supportedCurrency === undefined}
        >
          {submitting ? 'Creating…' : 'Create payment order'}
        </button>
        <Link to="/payments" className="btn btn-link">
          Cancel
        </Link>
      </form>
    </div>
  );
}
