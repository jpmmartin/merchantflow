import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getPaymentIntent, type PaymentIntent } from '../api/payments';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { PaymentStatusBadge } from '../components/PaymentStatusBadge';
import { formatAmountMinor } from '../money/amount';

type DetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly intent: PaymentIntent }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * One payment order, by the id in the URL, with every field the API returns.
 * An order of another merchant and an unknown id both show the API's
 * `NOT_FOUND`.
 */
export function PaymentDetailPage() {
  const { paymentIntentId = '' } = useParams();
  const [state, setState] = useState<DetailState>({ kind: 'loading' });

  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    getPaymentIntent(paymentIntentId).then(
      (intent) => {
        if (current) setState({ kind: 'loaded', intent });
      },
      (caught: unknown) => {
        if (current) setState({ kind: 'failed', error: caught });
      },
    );
    return () => {
      current = false;
    };
  }, [paymentIntentId]);

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
      {state.kind === 'loaded' ? <Details intent={state.intent} /> : null}
    </>
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
