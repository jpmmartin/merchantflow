import type { PaymentIntentStatus } from '../api/payments';

const STATUS_CLASS: Readonly<Record<PaymentIntentStatus, string>> = {
  CREATED: 'text-bg-secondary',
  PROCESSING: 'text-bg-info',
  SUCCEEDED: 'text-bg-success',
  FAILED: 'text-bg-danger',
  UNKNOWN: 'text-bg-warning',
};

/** A payment intent status as a coloured badge. */
export function PaymentStatusBadge({
  status,
}: {
  readonly status: PaymentIntentStatus;
}) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{status}</span>;
}
