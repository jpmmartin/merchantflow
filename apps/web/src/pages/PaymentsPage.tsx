import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import {
  PAYMENT_INTENT_STATUSES,
  isPaymentIntentStatus,
  listPaymentIntents,
  type PaymentIntent,
  type PaymentIntentStatus,
} from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { canCreatePayments } from '../components/navigation';
import { PaymentStatusBadge } from '../components/PaymentStatusBadge';
import { formatAmountMinor } from '../money/amount';

/** The status filter of the URL (`?status=`), or none for an unknown value. */
function statusFilterOf(
  params: URLSearchParams,
): PaymentIntentStatus | undefined {
  const value = params.get('status');
  return value !== null && isPaymentIntentStatus(value) ? value : undefined;
}

/**
 * The merchant's payment orders, newest first, one API page at a time: "Load
 * more" asks for the page after `next_cursor`. The status filter lives in the
 * URL, so a filtered list survives a reload, and its options are the domain's
 * list of statuses. A row opens the order's page.
 */
export function PaymentsPage({
  principal,
}: {
  readonly principal: CurrentPrincipal;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = statusFilterOf(searchParams);
  const [intents, setIntents] = useState<readonly PaymentIntent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(undefined);
  // Identifies the latest load, so a page that arrives after the filter
  // changed is dropped instead of being mixed into the new list.
  const latestLoad = useRef(0);

  const load = useCallback(
    async (cursor: string | undefined) => {
      latestLoad.current += 1;
      const thisLoad = latestLoad.current;
      setLoading(true);
      setError(undefined);
      if (cursor === undefined) {
        setIntents([]);
        setNextCursor(null);
      }
      try {
        const page = await listPaymentIntents({ cursor, status });
        if (thisLoad !== latestLoad.current) return;
        setIntents((current) =>
          cursor === undefined ? page.data : [...current, ...page.data],
        );
        setNextCursor(page.next_cursor);
      } catch (caught) {
        if (thisLoad !== latestLoad.current) return;
        setError(caught);
      } finally {
        if (thisLoad === latestLoad.current) setLoading(false);
      }
    },
    [status],
  );

  useEffect(() => {
    void load(undefined);
  }, [load]);

  function changeStatus(value: string) {
    setSearchParams(value === '' ? {} : { status: value });
  }

  return (
    <>
      <div className="d-flex align-items-center mb-3">
        <h1 className="h3 me-auto mb-0">Payments</h1>
        {canCreatePayments(principal.role) ? (
          <Link to="/payments/new" className="btn btn-primary">
            Create payment order
          </Link>
        ) : null}
      </div>
      <div className="row g-2 align-items-center mb-3">
        <div className="col-auto">
          <label htmlFor="status_filter" className="col-form-label">
            Status
          </label>
        </div>
        <div className="col-auto">
          <select
            id="status_filter"
            className="form-select"
            value={status ?? ''}
            onChange={(event) => changeStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {PAYMENT_INTENT_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ErrorAlert error={error} />
      <div className="table-responsive">
        <table className="table table-striped table-hover align-middle bg-body">
          <thead>
            <tr>
              <th>Reference</th>
              <th className="text-end">Amount</th>
              <th>Currency</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {intents.map((intent) => (
              <tr
                key={intent.id}
                role="button"
                onClick={() => void navigate(`/payments/${intent.id}`)}
              >
                <td>
                  <Link
                    to={`/payments/${intent.id}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {intent.merchant_reference}
                  </Link>
                </td>
                <td className="text-end font-monospace">
                  {formatAmountMinor(intent.amount_minor, intent.currency)}
                </td>
                <td>{intent.currency}</td>
                <td>
                  <PaymentStatusBadge status={intent.status} />
                </td>
                <td>{formatTime(intent.created_at)}</td>
              </tr>
            ))}
            {!loading && error === undefined && intents.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-body-secondary">
                  {status === undefined
                    ? 'No payment orders yet.'
                    : `No payment orders with status ${status}.`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {loading ? (
        <div className="spinner-border spinner-border-sm" role="status">
          <span className="visually-hidden">Loading…</span>
        </div>
      ) : null}
      {!loading && nextCursor !== null ? (
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={() => void load(nextCursor)}
        >
          Load more
        </button>
      ) : null}
    </>
  );
}
