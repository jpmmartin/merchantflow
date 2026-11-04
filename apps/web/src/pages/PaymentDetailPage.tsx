import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import { listProcessorAccounts, type ProcessorAccount } from '../api/merchants';
import {
  getPaymentIntent,
  listPaymentAttempts,
  type PaymentAttempt,
  type PaymentIntent,
} from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { canCreatePayments } from '../components/navigation';
import {
  PaymentAttemptStatusBadge,
  PaymentStatusBadge,
} from '../components/PaymentStatusBadge';
import { formatAmountMinor } from '../money/amount';
import { PaymentActionSection } from './PaymentActionSection';
import {
  PaymentPaySection,
  type PaymentStepOutcome,
} from './PaymentPaySection';

type DetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly intent: PaymentIntent }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * One payment order, by the id in the URL, with every field the API returns,
 * its attempt history, and for `MERCHANT_ADMIN` the pay section of a
 * `CREATED` order or the authentication step of a `REQUIRES_ACTION` one. An
 * order of another merchant and an unknown id both show the API's
 * `NOT_FOUND`.
 */
export function PaymentDetailPage({
  principal,
}: {
  readonly principal: CurrentPrincipal;
}) {
  const { paymentIntentId = '' } = useParams();
  const merchantId = principal.merchant_id;
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [attempts, setAttempts] = useState<
    readonly PaymentAttempt[] | undefined
  >(undefined);
  const [attemptsError, setAttemptsError] = useState<unknown>(undefined);
  const [accounts, setAccounts] = useState<
    readonly ProcessorAccount[] | undefined
  >(undefined);
  const [accountsError, setAccountsError] = useState<unknown>(undefined);
  const [outcome, setOutcome] = useState<PaymentStepOutcome | undefined>(
    undefined,
  );

  const reload = useCallback(async () => {
    try {
      const [intent, list] = await Promise.all([
        getPaymentIntent(paymentIntentId),
        listPaymentAttempts(paymentIntentId),
      ]);
      setState({ kind: 'loaded', intent });
      setAttempts(list.data);
      setAttemptsError(undefined);
    } catch (caught) {
      setAttemptsError(caught);
      setState((previous) =>
        previous.kind === 'loaded'
          ? previous
          : { kind: 'failed', error: caught },
      );
    }
  }, [paymentIntentId]);

  useEffect(() => {
    setState({ kind: 'loading' });
    setAttempts(undefined);
    setOutcome(undefined);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (merchantId === null) return;
    listProcessorAccounts(merchantId).then(
      (list) => setAccounts(list),
      (caught: unknown) => setAccountsError(caught),
    );
  }, [merchantId]);

  const admin = canCreatePayments(principal.role);
  return (
    <>
      <p>
        <Link to="/payments">← Payments</Link>
      </p>
      {state.kind === 'loading' ? (
        <div className="spinner-border spinner-border-sm" role="status">
          <span className="visually-hidden">Loading…</span>
        </div>
      ) : null}
      {state.kind === 'failed' ? <ErrorAlert error={state.error} /> : null}
      {state.kind === 'loaded' ? (
        <>
          <Details intent={state.intent} />
          {outcome === undefined ? null : <OutcomeAlert outcome={outcome} />}
          {state.intent.status === 'UNKNOWN' ? (
            <div className="alert alert-warning" role="alert">
              <strong>Outcome unknown.</strong> An attempt of this payment may
              have charged the card, and its result could not be established. Do
              not pay again: no new attempt is accepted until the outcome is
              resolved, and automatic recovery does not exist yet.
            </div>
          ) : null}
          <ErrorAlert error={accountsError} />
          {admin && merchantId !== null && state.intent.status === 'CREATED' ? (
            <PaymentPaySection
              intent={state.intent}
              merchantId={merchantId}
              accounts={accounts}
              onOutcome={setOutcome}
              onChanged={() => void reload()}
            />
          ) : null}
          {admin && state.intent.status === 'REQUIRES_ACTION' ? (
            <PaymentActionSection
              intent={state.intent}
              attempt={attempts?.find(
                (attempt) => attempt.status === 'REQUIRES_ACTION',
              )}
              accounts={accounts}
              onOutcome={setOutcome}
              onChanged={() => void reload()}
            />
          ) : null}
          <AttemptHistory
            attempts={attempts}
            accounts={accounts}
            error={attemptsError}
          />
        </>
      ) : null}
    </>
  );
}

/** The result of the last payment step, in words the operator can act on. */
function OutcomeAlert({ outcome }: { readonly outcome: PaymentStepOutcome }) {
  const { attempt, payment_intent: intent } = outcome.confirmation;
  const exhausted = intent.status === 'FAILED';
  const note =
    outcome.stripeMessage === undefined ? null : (
      <div className="small mt-1">Stripe.js: {outcome.stripeMessage}</div>
    );
  switch (attempt.status) {
    case 'SUCCEEDED':
      return (
        <div className="alert alert-success" role="status">
          <strong>Payment succeeded.</strong> Stripe payment{' '}
          <code>{attempt.provider_transaction_id}</code>.
        </div>
      );
    case 'DECLINED':
      return (
        <div className="alert alert-danger" role="alert">
          <strong>Card declined</strong>
          {attempt.decline_code === null ? null : (
            <>
              {' '}
              (<code>{attempt.decline_code}</code>)
            </>
          )}
          .{' '}
          {exhausted
            ? 'This was the third unsuccessful attempt, so the payment is now FAILED.'
            : 'Try another card.'}
          {note}
        </div>
      );
    case 'FAILED':
      return (
        <div className="alert alert-danger" role="alert">
          <strong>The attempt failed before the card was charged</strong> (
          <code>{attempt.error_category}</code>).{' '}
          {exhausted
            ? 'This was the third unsuccessful attempt, so the payment is now FAILED.'
            : 'Nothing was charged; try another card.'}
          {note}
        </div>
      );
    case 'REQUIRES_ACTION':
      return (
        <div className="alert alert-info" role="status">
          <strong>Authentication not completed.</strong> The payment is still
          waiting for the customer; continue the authentication below.
          {note}
        </div>
      );
    case 'UNKNOWN':
      return (
        <div className="alert alert-warning" role="alert">
          <strong>Outcome unknown.</strong> Do not pay again: the card may have
          been charged.
          {note}
        </div>
      );
    case 'EXECUTING':
      return null;
  }
}

function AttemptHistory({
  attempts,
  accounts,
  error,
}: {
  readonly attempts: readonly PaymentAttempt[] | undefined;
  readonly accounts: readonly ProcessorAccount[] | undefined;
  readonly error: unknown;
}) {
  const accountName = (id: string): string => {
    const account = accounts?.find((each) => each.id === id);
    return account === undefined
      ? id
      : `${account.display_name} (${account.provider_account_id})`;
  };
  return (
    <section className="mb-4">
      <h2 className="h5">Attempt history</h2>
      <ErrorAlert error={error} />
      {attempts === undefined ? null : attempts.length === 0 ? (
        <p className="text-body-secondary">No payment attempts yet.</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>Started</th>
                <th>Account</th>
                <th>Status</th>
                <th>Stripe payment</th>
                <th>Decline code</th>
                <th>Error category</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>{formatTime(attempt.created_at)}</td>
                  <td className="small">
                    {accountName(attempt.processor_account_id)}
                  </td>
                  <td>
                    <PaymentAttemptStatusBadge status={attempt.status} />
                  </td>
                  <td>
                    {attempt.provider_transaction_id === null ? (
                      '—'
                    ) : (
                      <code>{attempt.provider_transaction_id}</code>
                    )}
                  </td>
                  <td>
                    {attempt.decline_code === null ? (
                      '—'
                    ) : (
                      <code>{attempt.decline_code}</code>
                    )}
                  </td>
                  <td>{attempt.error_category ?? '—'}</td>
                  <td>{formatTime(attempt.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Details({ intent }: { readonly intent: PaymentIntent }) {
  return (
    <>
      <div className="d-flex align-items-center gap-3 mb-3">
        <h1 className="h3 mb-0">{intent.merchant_reference}</h1>
        <PaymentStatusBadge status={intent.status} />
      </div>
      <dl className="row">
        <dt className="col-sm-3">Amount</dt>
        <dd className="col-sm-9 font-monospace">
          {formatAmountMinor(intent.amount_minor, intent.currency)}{' '}
          {intent.currency}
        </dd>
        <dt className="col-sm-3">Amount in minor units</dt>
        <dd className="col-sm-9 font-monospace">{intent.amount_minor}</dd>
        <dt className="col-sm-3">Currency</dt>
        <dd className="col-sm-9">{intent.currency}</dd>
        <dt className="col-sm-3">Order reference</dt>
        <dd className="col-sm-9">
          <code>{intent.merchant_reference}</code>
        </dd>
        <dt className="col-sm-3">Status</dt>
        <dd className="col-sm-9">
          <PaymentStatusBadge status={intent.status} />
        </dd>
        <dt className="col-sm-3">Payment intent ID</dt>
        <dd className="col-sm-9">
          <code>{intent.id}</code>
        </dd>
        <dt className="col-sm-3">Merchant ID</dt>
        <dd className="col-sm-9">
          <code>{intent.merchant_id}</code>
        </dd>
        <dt className="col-sm-3">Created</dt>
        <dd className="col-sm-9">{formatTime(intent.created_at)}</dd>
        <dt className="col-sm-3">Updated</dt>
        <dd className="col-sm-9">{formatTime(intent.updated_at)}</dd>
      </dl>
    </>
  );
}
