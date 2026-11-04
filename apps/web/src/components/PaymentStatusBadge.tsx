import type {
  PaymentAttemptStatus,
  PaymentIntentStatus,
} from '../api/payments';

const STATUS_CLASS: Readonly<Record<PaymentIntentStatus, string>> = {
  CREATED: 'text-bg-secondary',
  PROCESSING: 'text-bg-info',
  REQUIRES_ACTION: 'text-bg-primary',
  SUCCEEDED: 'text-bg-success',
  FAILED: 'text-bg-danger',
  UNKNOWN: 'text-bg-warning',
};

const ATTEMPT_STATUS_CLASS: Readonly<Record<PaymentAttemptStatus, string>> = {
  EXECUTING: 'text-bg-info',
  REQUIRES_ACTION: 'text-bg-primary',
  SUCCEEDED: 'text-bg-success',
  DECLINED: 'text-bg-danger',
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

/** A payment attempt status as a coloured badge. */
export function PaymentAttemptStatusBadge({
  status,
}: {
  readonly status: PaymentAttemptStatus;
}) {
  return (
    <span className={`badge ${ATTEMPT_STATUS_CLASS[status]}`}>{status}</span>
  );
}
