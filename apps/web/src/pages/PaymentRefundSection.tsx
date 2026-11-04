import { isSupportedCurrency } from '@merchantflow/domain';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { ProcessorAccount } from '../api/merchants';
import {
  createRefund,
  type PaymentIntent,
  type Refund,
  type RefundCreation,
  type RefundList,
} from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { RefundStatusBadge } from '../components/PaymentStatusBadge';
import {
  decimalAmountMessage,
  decimalToAmountMinor,
  formatAmountMinor,
} from '../money/amount';

/**
 * A refund that was sent and may be sent again: the amount as sent and the
 * key that belongs to it.
 */
interface PendingRefund {
  readonly amountMinor: string;
  readonly idempotencyKey: string;
}

/**
 * Failures after which the same refund may be sent again with the same key:
 * no answer was read, the same request is still in progress, or the server
 * failed. The stored answer, if any, is then returned instead of a second
 * refund.
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

/** The refunded, pending, and remaining amounts of an intent. */
export function RefundAmounts({ list }: { readonly list: RefundList }) {
  const show = (amountMinor: string) =>
    `${formatAmountMinor(amountMinor, list.currency)} ${list.currency}`;
  return (
    <dl className="row mb-2">
      <dt className="col-sm-3">Captured</dt>
      <dd className="col-sm-9 font-monospace">
        {show(list.captured_amount_minor)}
      </dd>
      <dt className="col-sm-3">Refunded</dt>
      <dd className="col-sm-9 font-monospace">
        {show(list.refunded_amount_minor)}
      </dd>
      <dt className="col-sm-3">Pending refunds</dt>
      <dd className="col-sm-9 font-monospace">
        {show(list.pending_amount_minor)}
      </dd>
      <dt className="col-sm-3">Remaining refundable</dt>
      <dd className="col-sm-9 font-monospace">
        {show(list.refundable_amount_minor)}
      </dd>
    </dl>
  );
}

/**
 * The refunds of an intent, oldest first. With `onCheck`, each `PENDING` or
 * `UNKNOWN` refund has a "Check with Stripe" button.
 */
export function RefundsTable({
  list,
  accounts,
  onCheck,
  checkingId,
}: {
  readonly list: RefundList;
  readonly accounts: readonly ProcessorAccount[] | undefined;
  readonly onCheck?: (refund: Refund) => void;
  /** The refund being checked, while a check runs. */
  readonly checkingId?: string | undefined;
}) {
  const accountName = (id: string): string => {
    const account = accounts?.find((each) => each.id === id);
    return account === undefined
      ? id
      : `${account.display_name} (${account.provider_account_id})`;
  };
  if (list.data.length === 0) {
    return <p className="text-body-secondary">No refunds yet.</p>;
  }
  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle">
        <thead>
          <tr>
            <th>Requested</th>
            <th className="text-end">Amount</th>
            <th>Status</th>
            <th>Stripe refund</th>
            <th>Account</th>
            <th>Failure</th>
            <th>Updated</th>
            {onCheck === undefined ? null : <th />}
          </tr>
        </thead>
        <tbody>
          {list.data.map((refund) => (
            <tr key={refund.id}>
              <td>{formatTime(refund.created_at)}</td>
              <td className="text-end font-monospace">
                {formatAmountMinor(refund.amount_minor, refund.currency)}{' '}
                {refund.currency}
              </td>
              <td>
                <RefundStatusBadge status={refund.status} />
              </td>
              <td>
                {refund.provider_refund_id === null ? (
                  '—'
                ) : (
                  <code>{refund.provider_refund_id}</code>
                )}
              </td>
              <td className="small">
                {accountName(refund.processor_account_id)}
              </td>
              <td className="small">
                {refund.error_category === null ? (
                  '—'
                ) : (
                  <>
                    {refund.error_category}
                    {refund.failure_code === null ? null : (
                      <>
                        {' '}
                        <code>{refund.failure_code}</code>
                      </>
                    )}
                  </>
                )}
              </td>
              <td>{formatTime(refund.updated_at)}</td>
              {onCheck === undefined ? null : (
                <td className="text-end text-nowrap">
                  {refund.status === 'PENDING' ||
                  refund.status === 'UNKNOWN' ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-primary"
                      disabled={checkingId !== undefined}
                      onClick={() => onCheck(refund)}
                    >
                      {checkingId === refund.id
                        ? 'Checking…'
                        : 'Check with Stripe'}
                    </button>
                  ) : null}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The result of the last refund request, in words the operator can act on. */
function RefundOutcomeAlert({ outcome }: { readonly outcome: RefundCreation }) {
  const { refund } = outcome;
  const amount = `${formatAmountMinor(refund.amount_minor, refund.currency)} ${refund.currency}`;
  switch (refund.status) {
    case 'SUCCEEDED':
      return (
        <div className="alert alert-success" role="status">
          <strong>Refund of {amount} succeeded.</strong> Stripe refund{' '}
          <code>{refund.provider_refund_id}</code>; the payment is now{' '}
          <code>{outcome.payment_intent.status}</code>.
        </div>
      );
    case 'PENDING':
      return (
        <div className="alert alert-info" role="status">
          <strong>Refund of {amount} is pending at Stripe.</strong> The amount
          stays reserved; the payment status and the ledger change when the
          refund succeeds. Stripe reports it through the account&apos;s webhook,
          or use <strong>Check with Stripe</strong> in the refunds table.
        </div>
      );
    case 'FAILED':
      return (
        <div className="alert alert-danger" role="alert">
          <strong>Refund of {amount} failed</strong> (
          <code>{refund.error_category}</code>
          {refund.failure_code === null ? null : (
            <>
              , <code>{refund.failure_code}</code>
            </>
          )}
          ). No money was returned, and the amount can be refunded again.
        </div>
      );
    case 'UNKNOWN':
      return (
        <div className="alert alert-warning" role="alert">
          <strong>Refund outcome unknown.</strong> Do not refund again: money
          may have been returned, and no new refund of this payment is accepted
          until the outcome is resolved, by the account&apos;s webhook or by{' '}
          <strong>Check with Stripe</strong> once Stripe has identified it.
        </div>
      );
    case 'EXECUTING':
      return null;
  }
}

/**
 * The refund form of a `SUCCEEDED` or `PARTIALLY_REFUNDED` payment, for
 * `MERCHANT_ADMIN`; for a `REFUNDED` one it shows the last outcome and that
 * nothing is left to refund. The amount is typed in major units, defaults to the
 * remaining refundable amount (a full refund), and is converted to minor units
 * as text before sending.
 *
 * The `Idempotency-Key` is generated once per refund: a resend of the same
 * amount after a network error, `OPERATION_IN_PROGRESS`, a 503, or a server
 * failure reuses it, so a refund whose answer was lost is answered with the
 * same refund instead of a second one. Any other answer, or a different
 * amount, starts a new key.
 */
export function PaymentRefundSection({
  intent,
  list,
  onChanged,
}: {
  readonly intent: PaymentIntent;
  readonly list: RefundList;
  readonly onChanged: () => void;
}) {
  const remaining = list.refundable_amount_minor;
  const currency = isSupportedCurrency(list.currency)
    ? list.currency
    : undefined;
  const [amount, setAmount] = useState(() =>
    formatAmountMinor(remaining, list.currency),
  );
  const [amountError, setAmountError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PendingRefund | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [outcome, setOutcome] = useState<RefundCreation | undefined>(undefined);

  // A new remaining amount, after a refund, becomes the new default.
  useEffect(() => {
    setAmount(formatAmountMinor(remaining, list.currency));
  }, [remaining, list.currency]);

  async function send(refund: PendingRefund) {
    setPending(refund);
    setSubmitting(true);
    setError(undefined);
    setOutcome(undefined);
    try {
      const created = await createRefund(
        intent.id,
        refund.amountMinor,
        refund.idempotencyKey,
      );
      setPending(undefined);
      setOutcome(created);
      onChanged();
    } catch (caught) {
      setError(caught);
      // A conclusive refusal frees the key; a lost answer keeps it.
      if (!isResendable(caught)) setPending(undefined);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (currency === undefined) return;
    const parsed = decimalToAmountMinor(amount, currency);
    if (!parsed.ok) {
      setAmountError(decimalAmountMessage(parsed.code, currency));
      return;
    }
    setAmountError(undefined);
    const reuse =
      pending !== undefined && pending.amountMinor === parsed.amountMinor;
    void send(
      reuse
        ? pending
        : {
            amountMinor: parsed.amountMinor,
            idempotencyKey: crypto.randomUUID(),
          },
    );
  }

  const converted =
    currency === undefined ? undefined : decimalToAmountMinor(amount, currency);
  const nothingLeft = remaining === '0';
  return (
    <section className="card mb-4">
      <div className="card-body">
        <h2 className="h5 card-title">Refund</h2>
        {outcome === undefined ? null : (
          <RefundOutcomeAlert outcome={outcome} />
        )}
        <ErrorAlert error={error} />
        {currency === undefined ? (
          <div className="alert alert-warning" role="alert">
            The currency <code>{list.currency}</code> is not supported by this
            version, so no refund can be made.
          </div>
        ) : nothingLeft ? (
          <p className="text-body-secondary mb-0">
            Nothing left to refund: the captured amount is refunded or reserved
            by pending refunds.
          </p>
        ) : (
          <form onSubmit={handleSubmit} noValidate style={{ maxWidth: 520 }}>
            <div className="mb-2">
              <label htmlFor="refund-amount" className="form-label">
                Amount ({currency})
              </label>
              <div className="input-group">
                <input
                  id="refund-amount"
                  className={`form-control font-monospace${amountError === undefined ? '' : ' is-invalid'}`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  disabled={submitting}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setAmountError(undefined);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  disabled={submitting}
                  onClick={() => {
                    setAmount(formatAmountMinor(remaining, list.currency));
                    setAmountError(undefined);
                  }}
                >
                  Full remaining
                </button>
              </div>
              {amountError === undefined ? null : (
                <div className="invalid-feedback d-block">{amountError}</div>
              )}
              <div className="form-text">
                Up to {formatAmountMinor(remaining, list.currency)} {currency}.
                {converted?.ok === true ? (
                  <>
                    {' '}
                    Sent as <code>amount_minor</code>{' '}
                    <code>{converted.amountMinor}</code>
                    {converted.amountMinor === remaining
                      ? ' (full refund of the remaining amount).'
                      : ' (partial refund).'}
                  </>
                ) : null}
              </div>
            </div>
            {pending === undefined ? null : (
              <div className="form-text mb-2">
                Request key <code>{pending.idempotencyKey}</code> will be reused
                for the same amount.
              </div>
            )}
            <button
              type="submit"
              className="btn btn-danger"
              disabled={submitting}
            >
              {submitting
                ? 'Refunding…'
                : pending !== undefined && error !== undefined
                  ? 'Send the same refund again'
                  : 'Refund'}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
