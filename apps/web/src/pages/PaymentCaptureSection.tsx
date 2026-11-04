import { useState } from 'react';
import { ApiError } from '../api/client';
import type { ProcessorAccount } from '../api/merchants';
import {
  actOnAuthorization,
  refreshAuthorizationAction,
  type AuthorizationAction,
  type AuthorizationActionKind,
  type AuthorizationActionRefresh,
  type AuthorizationActionResult,
  type PaymentIntent,
} from '../api/payments';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { AuthorizationActionStatusBadge } from '../components/PaymentStatusBadge';
import { formatAmountMinor } from '../money/amount';

/**
 * A capture or void that was sent and may be sent again: the action and the
 * key that belongs to it.
 */
interface PendingAction {
  readonly action: AuthorizationActionKind;
  readonly idempotencyKey: string;
}

/**
 * Failures after which the same capture or void may be sent again with the
 * same key: no answer was read, the same request is still in progress, or the
 * server failed. The stored answer, if any, is then returned instead of a
 * second capture or void.
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

const ACTION_WORD: Readonly<Record<AuthorizationActionKind, string>> = {
  CAPTURE: 'Capture',
  VOID: 'Void',
};

/** What the last capture or void answered, in words the operator can act on. */
function ActionOutcome({
  result,
}: {
  readonly result: AuthorizationActionResult | undefined;
}) {
  if (result === undefined) return null;
  const { authorization_action: action } = result;
  const word = ACTION_WORD[action.action];
  switch (action.status) {
    case 'SUCCEEDED':
      return (
        <div className="alert alert-success" role="status">
          {action.action === 'CAPTURE' ? (
            <>
              <strong>Captured.</strong> The held funds were captured; the
              payment is SUCCEEDED and its sale is posted to the ledger.
            </>
          ) : (
            <>
              <strong>Voided.</strong> The hold was released and nothing was
              captured; the payment is CANCELED.
            </>
          )}
        </div>
      );
    case 'FAILED':
      return (
        <div className="alert alert-danger" role="alert">
          <strong>{word} failed</strong>
          {action.failure_code === null ? null : (
            <>
              {' '}
              (<code>{action.failure_code}</code>)
            </>
          )}
          . Stripe refused it and the hold is unchanged.
        </div>
      );
    case 'UNKNOWN':
      return (
        <div className="alert alert-warning" role="alert">
          <strong>{word} outcome unknown.</strong> Do not capture or void again
          until it is resolved; use Check with Stripe below.
        </div>
      );
    case 'EXECUTING':
      return null;
  }
}

/** What the last "Check with Stripe" found. */
function CheckOutcome({
  outcome,
}: {
  readonly outcome: AuthorizationActionRefresh | undefined;
}) {
  if (outcome === undefined) return null;
  switch (outcome.change) {
    case null:
      return (
        <div className="alert alert-info">
          Stripe does not settle the{' '}
          {ACTION_WORD[outcome.authorization_action.action].toLowerCase()} yet;
          it is still {outcome.authorization_action.status}. Nothing changed.
        </div>
      );
    case 'CAPTURE_SUCCEEDED':
      return (
        <div className="alert alert-success">
          Stripe shows the payment captured; the payment and the ledger are
          updated.
        </div>
      );
    case 'VOID_SUCCEEDED':
      return (
        <div className="alert alert-success">
          Stripe shows the hold released; the payment is CANCELED.
        </div>
      );
    case 'CAPTURE_FAILED':
    case 'VOID_FAILED':
      return (
        <div className="alert alert-warning">
          Stripe shows the{' '}
          {outcome.change === 'CAPTURE_FAILED' ? 'capture' : 'void'} did not
          take effect
          {outcome.authorization_action.failure_code === null ? null : (
            <>
              {' '}
              (<code>{outcome.authorization_action.failure_code}</code>)
            </>
          )}
          .
        </div>
      );
  }
}

/**
 * The captures and voids of a manual-capture payment: for `MERCHANT_ADMIN` on a
 * `REQUIRES_CAPTURE` order, the Capture and Void buttons, each confirmed in a
 * dialog; the outcome of the last one; and the history, where an `UNKNOWN`
 * action can be checked with Stripe. Every action and check reloads the page.
 * One `Idempotency-Key` is used per action and is sent again by "Send the
 * same request again" after an answer that was lost or not conclusive.
 */
export function PaymentCaptureSection({
  intent,
  actions,
  accounts,
  admin,
  onChanged,
}: {
  readonly intent: PaymentIntent;
  readonly actions: readonly AuthorizationAction[];
  readonly accounts: readonly ProcessorAccount[] | undefined;
  readonly admin: boolean;
  readonly onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState<
    AuthorizationActionKind | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | undefined>(undefined);
  const [result, setResult] = useState<AuthorizationActionResult | undefined>(
    undefined,
  );
  const [error, setError] = useState<unknown>(undefined);
  const [checkingId, setCheckingId] = useState<string | undefined>(undefined);
  const [checkOutcome, setCheckOutcome] = useState<
    AuthorizationActionRefresh | undefined
  >(undefined);
  const [checkError, setCheckError] = useState<unknown>(undefined);

  async function send(sending: PendingAction) {
    setPending(sending);
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setCheckOutcome(undefined);
    try {
      const answer = await actOnAuthorization(
        intent.id,
        sending.action,
        sending.idempotencyKey,
      );
      setResult(answer);
      setPending(undefined);
    } catch (caught) {
      setError(caught);
      // The key stays only while the same request may be sent again.
      if (!isResendable(caught)) setPending(undefined);
    } finally {
      setBusy(false);
      setConfirming(undefined);
      onChanged();
    }
  }

  async function check(action: AuthorizationAction) {
    setCheckingId(action.id);
    setCheckError(undefined);
    setCheckOutcome(undefined);
    try {
      setCheckOutcome(await refreshAuthorizationAction(intent.id, action.id));
    } catch (caught) {
      setCheckError(caught);
    } finally {
      setCheckingId(undefined);
      onChanged();
    }
  }

  const accountName = (id: string): string => {
    const account = accounts?.find((each) => each.id === id);
    return account === undefined
      ? id
      : `${account.display_name} (${account.provider_account_id})`;
  };
  const amount = `${formatAmountMinor(intent.amount_minor, intent.currency)} ${intent.currency}`;
  const unknown = actions.some((action) => action.status === 'UNKNOWN');
  const executing = actions.some((action) => action.status === 'EXECUTING');
  const actionable =
    admin && intent.status === 'REQUIRES_CAPTURE' && !unknown && !executing;

  return (
    <section className="mb-4">
      <h2 className="h5">Capture</h2>
      {intent.status === 'REQUIRES_CAPTURE' ? (
        <div className="alert alert-primary" role="status">
          <strong>Authorized, not captured.</strong> {amount} is held on the
          customer&apos;s card. Capture it to collect the money, or void it to
          release the hold. Stripe releases an uncaptured card authorization
          after seven days.
        </div>
      ) : null}
      {unknown ? (
        <div className="alert alert-warning" role="alert">
          <strong>Outcome unknown.</strong> A capture or void of this payment
          may have changed the hold. No new capture or void is accepted until it
          is resolved by Stripe&apos;s webhook or by Check with Stripe.
        </div>
      ) : null}
      <ActionOutcome result={result} />
      <ErrorAlert error={error} />
      {actionable ? (
        <div className="d-flex gap-2 mb-3">
          <button
            type="button"
            className="btn btn-success"
            disabled={busy}
            onClick={() => setConfirming('CAPTURE')}
          >
            Capture {amount}
          </button>
          <button
            type="button"
            className="btn btn-outline-danger"
            disabled={busy}
            onClick={() => setConfirming('VOID')}
          >
            Void
          </button>
          {pending === undefined || busy ? null : (
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={() => void send(pending)}
            >
              Send the same {ACTION_WORD[pending.action].toLowerCase()} again
            </button>
          )}
        </div>
      ) : null}
      {confirming === undefined ? null : (
        <ConfirmDialog
          title={confirming === 'CAPTURE' ? 'Capture payment' : 'Void payment'}
          confirmLabel={confirming === 'CAPTURE' ? 'Capture' : 'Void'}
          busy={busy}
          onConfirm={() =>
            void send(
              pending?.action === confirming
                ? pending
                : { action: confirming, idempotencyKey: crypto.randomUUID() },
            )
          }
          onCancel={() => setConfirming(undefined)}
        >
          {confirming === 'CAPTURE' ? (
            <p>
              Capture {amount} from the customer&apos;s card? The payment
              becomes SUCCEEDED and can then only be refunded.
            </p>
          ) : (
            <p>
              Release the hold of {amount} on the customer&apos;s card? Nothing
              is captured, the payment becomes CANCELED, and it cannot be
              captured afterwards.
            </p>
          )}
        </ConfirmDialog>
      )}
      <CheckOutcome outcome={checkOutcome} />
      <ErrorAlert error={checkError} />
      {actions.length === 0 ? (
        <p className="text-body-secondary">No captures or voids yet.</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Action</th>
                <th className="text-end">Amount</th>
                <th>Status</th>
                <th>Account</th>
                <th>Failure</th>
                <th>Updated</th>
                {admin ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {actions.map((action) => (
                <tr key={action.id}>
                  <td>{formatTime(action.created_at)}</td>
                  <td>{action.action}</td>
                  <td className="text-end font-monospace">
                    {formatAmountMinor(action.amount_minor, action.currency)}{' '}
                    {action.currency}
                  </td>
                  <td>
                    <AuthorizationActionStatusBadge status={action.status} />
                  </td>
                  <td className="small">
                    {accountName(action.processor_account_id)}
                  </td>
                  <td className="small">
                    {action.error_category === null ? (
                      '—'
                    ) : (
                      <>
                        {action.error_category}
                        {action.failure_code === null ? null : (
                          <>
                            {' '}
                            <code>{action.failure_code}</code>
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td>{formatTime(action.updated_at)}</td>
                  {admin ? (
                    <td>
                      {action.status === 'UNKNOWN' ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary"
                          disabled={checkingId !== undefined}
                          onClick={() => void check(action)}
                        >
                          {checkingId === action.id
                            ? 'Checking…'
                            : 'Check with Stripe'}
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
