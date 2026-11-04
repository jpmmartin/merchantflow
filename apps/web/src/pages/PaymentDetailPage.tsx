import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import { listJournalEntries, type JournalEntry } from '../api/ledger';
import { listProcessorAccounts, type ProcessorAccount } from '../api/merchants';
import {
  getPaymentIntent,
  listAuthorizationActions,
  listPaymentAttempts,
  listRefunds,
  refreshRefund,
  type AuthorizationAction,
  type PaymentAttempt,
  type PaymentIntent,
  type Refund,
  type RefundList,
  type RefundRefresh,
} from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { JournalEntriesTable } from '../components/JournalEntriesTable';
import { canCreatePayments } from '../components/navigation';
import {
  PaymentAttemptStatusBadge,
  PaymentStatusBadge,
} from '../components/PaymentStatusBadge';
import { formatAmountMinor } from '../money/amount';
import { PaymentActionSection } from './PaymentActionSection';
import { PaymentCaptureSection } from './PaymentCaptureSection';
import {
  PaymentRefundSection,
  RefundAmounts,
  RefundsTable,
} from './PaymentRefundSection';
import {
  PaymentPaySection,
  type PaymentStepOutcome,
} from './PaymentPaySection';

/** What the last "Check with Stripe" found, in words the operator can act on. */
function RefundCheckOutcome({
  outcome,
}: {
  readonly outcome: RefundRefresh | undefined;
}) {
  if (outcome === undefined) return null;
  const { refund } = outcome;
  switch (outcome.change) {
    case null:
      return (
        <div className="alert alert-info">
          Stripe confirms the refund is {refund.status}. Nothing changed.
        </div>
      );
    case 'REFUND_SUCCEEDED':
      return (
        <div className="alert alert-success">
          Stripe reports the refund succeeded; the payment and the ledger are
          updated.
        </div>
      );
    case 'REFUND_PENDING':
      return (
        <div className="alert alert-info">
          Stripe reports the refund is still pending.
        </div>
      );
    case 'REFUND_FAILED':
      return (
        <div className="alert alert-warning">
          Stripe reports the refund failed; its amount can be refunded again.
        </div>
      );
    case 'REFUND_REVERSED':
      return (
        <div className="alert alert-warning">
          Stripe failed the refund after it had succeeded; a reversal entry was
          posted and the payment status was corrected.
        </div>
      );
  }
}

type DetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly intent: PaymentIntent }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * One payment order, by the id in the URL, with every field the API returns,
 * its attempt history, its refunds with the refunded and remaining amounts,
 * its journal entries, and for `MERCHANT_ADMIN` the pay section of a
 * `CREATED` order, the authentication step of a `REQUIRES_ACTION` one, or the
 * refund form of a `SUCCEEDED` or `PARTIALLY_REFUNDED` one, and for a
 * `MANUAL` order its captures and voids with, for `MERCHANT_ADMIN`, the Capture
 * and Void buttons of a `REQUIRES_CAPTURE` one. An order of
 * another merchant and an unknown id both show the API's `NOT_FOUND`.
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
  const [entries, setEntries] = useState<readonly JournalEntry[] | undefined>(
    undefined,
  );
  const [entriesError, setEntriesError] = useState<unknown>(undefined);
  const [refunds, setRefunds] = useState<RefundList | undefined>(undefined);
  const [refundsError, setRefundsError] = useState<unknown>(undefined);
  const [actions, setActions] = useState<
    readonly AuthorizationAction[] | undefined
  >(undefined);
  const [actionsError, setActionsError] = useState<unknown>(undefined);

  const reloadEntries = useCallback(async () => {
    if (merchantId === null) return;
    try {
      const page = await listJournalEntries(merchantId, { paymentIntentId });
      setEntries(page.data);
      setEntriesError(undefined);
    } catch (caught) {
      setEntriesError(caught);
    }
  }, [merchantId, paymentIntentId]);

  const reloadRefunds = useCallback(async () => {
    try {
      setRefunds(await listRefunds(paymentIntentId));
      setRefundsError(undefined);
    } catch (caught) {
      setRefundsError(caught);
    }
  }, [paymentIntentId]);

  const reloadActions = useCallback(async () => {
    try {
      setActions((await listAuthorizationActions(paymentIntentId)).data);
      setActionsError(undefined);
    } catch (caught) {
      setActionsError(caught);
    }
  }, [paymentIntentId]);

  const reload = useCallback(async () => {
    void reloadEntries();
    void reloadRefunds();
    void reloadActions();
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
  }, [paymentIntentId, reloadEntries, reloadRefunds, reloadActions]);

  useEffect(() => {
    setState({ kind: 'loading' });
    setAttempts(undefined);
    setEntries(undefined);
    setRefunds(undefined);
    setActions(undefined);
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

  const [checkingId, setCheckingId] = useState<string | undefined>(undefined);
  const [checkOutcome, setCheckOutcome] = useState<RefundRefresh | undefined>(
    undefined,
  );
  const [checkError, setCheckError] = useState<unknown>(undefined);

  /** Checks one refund with Stripe, then reloads every section of the page. */
  async function check(refund: Refund) {
    setCheckingId(refund.id);
    setCheckError(undefined);
    setCheckOutcome(undefined);
    try {
      setCheckOutcome(await refreshRefund(paymentIntentId, refund.id));
    } catch (caught) {
      setCheckError(caught);
    } finally {
      setCheckingId(undefined);
      await reload();
    }
  }

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
          {/* The outcome of the last payment step, while the order is still in
              the status that step left it in. */}
          {outcome === undefined ||
          outcome.confirmation.payment_intent.status !==
            state.intent.status ? null : (
            <OutcomeAlert outcome={outcome} />
          )}
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
          {state.intent.capture_mode === 'MANUAL' ? (
            <>
              <ErrorAlert error={actionsError} />
              {actions === undefined ? null : (
                <PaymentCaptureSection
                  intent={state.intent}
                  actions={actions}
                  accounts={accounts}
                  admin={admin}
                  onChanged={() => void reload()}
                />
              )}
            </>
          ) : null}
          <AttemptHistory
            attempts={attempts}
            accounts={accounts}
            error={attemptsError}
          />
          {admin &&
          refunds !== undefined &&
          (state.intent.status === 'SUCCEEDED' ||
            state.intent.status === 'PARTIALLY_REFUNDED' ||
            state.intent.status === 'REFUNDED') ? (
            <PaymentRefundSection
              intent={state.intent}
              list={refunds}
              onChanged={() => void reload()}
            />
          ) : null}
          <section className="mb-4">
            <h2 className="h5">Refunds</h2>
            <ErrorAlert error={refundsError} />
            {refunds === undefined ? null : (
              <>
                <RefundAmounts list={refunds} />
                <RefundCheckOutcome outcome={checkOutcome} />
                <ErrorAlert error={checkError} />
                <RefundsTable
                  list={refunds}
                  accounts={accounts}
                  checkingId={checkingId}
                  {...(admin
                    ? { onCheck: (refund) => void check(refund) }
                    : {})}
                />
              </>
            )}
          </section>
          <section className="mb-4">
            <h2 className="h5">Journal entries</h2>
            <ErrorAlert error={entriesError} />
            {entries === undefined ? null : entries.length === 0 ? (
              <p className="text-body-secondary">
                No journal entries. A payment is posted to the ledger when it is
                captured (when it succeeds, or for a manual-capture payment when
                it is captured), and a refund when it succeeds; authorizations,
                voids, declines, pending payments, and pending or failed refunds
                post nothing.
              </p>
            ) : (
              <JournalEntriesTable entries={entries} linkPayments={false} />
            )}
          </section>
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
    case 'AUTHORIZED':
      return (
        <div className="alert alert-success" role="status">
          <strong>Payment authorized.</strong> Stripe payment{' '}
          <code>{attempt.provider_transaction_id}</code> holds the funds;
          nothing is captured until you capture it below.
        </div>
      );
    case 'CANCELED':
      return null;
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
        <dt className="col-sm-3">Capture</dt>
        <dd className="col-sm-9">
          {intent.capture_mode === 'MANUAL'
            ? 'Manual: authorized first, then captured or voided'
            : 'Automatic'}
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
