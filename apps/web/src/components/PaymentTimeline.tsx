import type { TimelineItem, TimelineItemKind } from '../api/operations';
import { formatAmountMinor } from '../money/amount';
import { formatTime } from './format';

const KIND_LABELS: Record<TimelineItemKind, string> = {
  PAYMENT_INTENT_CREATED: 'Order created',
  PAYMENT_ATTEMPT_STARTED: 'Attempt',
  CAPTURE_REQUESTED: 'Capture',
  VOID_REQUESTED: 'Void',
  REFUND_REQUESTED: 'Refund',
  AUDIT_EVENT: 'Audit event',
  JOURNAL_ENTRY_POSTED: 'Journal entry',
};

/**
 * The steps of one payment, oldest first as the API orders them: records of
 * the order, its attempts, captures, voids, refunds, and journal entries, and
 * the audit events with who did each step.
 */
export function PaymentTimeline({
  items,
}: {
  readonly items: readonly TimelineItem[];
}) {
  if (items.length === 0) {
    return <p className="text-body-secondary">No steps recorded.</p>;
  }
  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle bg-body small">
        <thead>
          <tr>
            <th>Time</th>
            <th>Step</th>
            <th>What happened</th>
            <th className="text-end">Amount</th>
            <th>Who</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={`${item.kind}:${item.source_id}`}
              className={
                item.kind === 'AUDIT_EVENT' ? undefined : 'table-light'
              }
            >
              <td className="text-nowrap">{formatTime(item.occurred_at)}</td>
              <td>
                {KIND_LABELS[item.kind]}
                {item.audit_action === null ? null : (
                  <div>
                    <code>{item.audit_action}</code>
                  </div>
                )}
              </td>
              <td>{item.summary}</td>
              <td className="text-end font-monospace text-nowrap">
                {item.amount_minor === null || item.currency === null
                  ? '—'
                  : `${formatAmountMinor(item.amount_minor, item.currency)} ${item.currency}`}
              </td>
              <td>{item.actor === null ? '—' : item.actor.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
