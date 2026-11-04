import { toAmountMinorString } from '@merchantflow/domain';
import { Injectable } from '@nestjs/common';
import { ReadAuditEventsService } from '../../audit/application/read-audit-events.service.js';
import { safeAuditMetadata } from '../../audit/application/safe-audit-metadata.js';
import { DescribeActorsService } from '../../auth/application/describe-actors.service.js';
import type { Principal } from '../../auth/application/principal.js';
import type { JournalEntry } from '../../ledger/application/ledger.js';
import { ListPaymentJournalEntriesService } from '../../ledger/application/list-payment-journal-entries.service.js';
import { GetPaymentHistoryService } from '../../payments/application/get-payment-history.service.js';
import { actorRefsOf, actorViewOf, type ActorView } from './actor-view.js';
import { summarizeAuditEvent } from './audit-summary.js';

/**
 * The kinds of timeline item, in the order they take among items of the same
 * instant: a record is created before the request that follows from it, and
 * the audit event of a change precedes the entry it posted.
 */
export const TIMELINE_ITEM_KINDS = [
  'PAYMENT_INTENT_CREATED',
  'PAYMENT_ATTEMPT_STARTED',
  'CAPTURE_REQUESTED',
  'VOID_REQUESTED',
  'REFUND_REQUESTED',
  'AUDIT_EVENT',
  'JOURNAL_ENTRY_POSTED',
] as const;

export type TimelineItemKind = (typeof TIMELINE_ITEM_KINDS)[number];

const KIND_RANK: ReadonlyMap<TimelineItemKind, number> = new Map(
  TIMELINE_ITEM_KINDS.map((kind, index) => [kind, index]),
);

/** One step of a payment, as a merchant user may see it. */
export interface TimelineItem {
  readonly kind: TimelineItemKind;
  /** The ID of the row the item comes from (intent, attempt, event, ...). */
  readonly sourceId: string;
  /** A stored time of that row, never the time of the request. */
  readonly occurredAt: Date;
  readonly summary: string;
  /** The current status of the record, or the status an event moved to. */
  readonly status: string | null;
  /** Minor units as an integer string, with `currency`, where one applies. */
  readonly amountMinor: string | null;
  readonly currency: string | null;
  /** Who acted; only audit events record an actor. */
  readonly actor: ActorView | null;
  /** The audit action of an `AUDIT_EVENT`, otherwise `null`. */
  readonly auditAction: string | null;
}

export interface PaymentTimeline {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly items: readonly TimelineItem[];
}

export type GetPaymentTimelineResult =
  | { readonly ok: true; readonly timeline: PaymentTimeline }
  | { readonly ok: false; readonly code: 'FORBIDDEN' }
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/**
 * Total order of the timeline: by time, then by kind (`TIMELINE_ITEM_KINDS`),
 * then by source ID, so items of the same instant always come out in the same
 * order.
 */
export function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  const byKind = (KIND_RANK.get(a.kind) ?? 0) - (KIND_RANK.get(b.kind) ?? 0);
  if (byKind !== 0) return byKind;
  if (a.sourceId < b.sourceId) return -1;
  return a.sourceId > b.sourceId ? 1 : 0;
}

/** The debit total of a balanced entry, which equals its credit total. */
function entryAmount(entry: JournalEntry): bigint {
  let total = 0n;
  for (const line of entry.lines) {
    if (line.side === 'DEBIT') total += line.amount.amountMinor;
  }
  return total;
}

function entrySummary(entry: JournalEntry): string {
  const lines = entry.lines
    .map((line) => `${line.accountCode} ${line.accountName} ${line.side}`)
    .join(', ');
  switch (entry.sourceType) {
    case 'PAYMENT_SALE':
      return `Sale posted to the ledger: ${lines}.`;
    case 'PAYMENT_REFUND':
      return `Refund posted to the ledger: ${lines}.`;
    case 'PAYMENT_REFUND_REVERSAL':
      return `Refund reversal posted to the ledger: ${lines}.`;
  }
}

/**
 * Builds the timeline of one payment: its creation, its attempts, its capture
 * or void, its refunds, its journal entries, and the audit events whose
 * target is the intent (each 3D Secure step, authorization, capture, void,
 * refund, webhook resolution, and reversal is one of them, with its actor).
 * Each module's rows come through that module's exported service. Access is
 * that of a payment read: merchant roles of the intent's merchant only,
 * another merchant's intent `NOT_FOUND`. Every time comes from a stored row.
 */
@Injectable()
export class GetPaymentTimelineService {
  constructor(
    private readonly getPaymentHistory: GetPaymentHistoryService,
    private readonly listJournalEntries: ListPaymentJournalEntriesService,
    private readonly readAuditEvents: ReadAuditEventsService,
    private readonly describeActors: DescribeActorsService,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly paymentIntentId: string;
  }): Promise<GetPaymentTimelineResult> {
    const found = await this.getPaymentHistory.execute(command);
    if (!found.ok) return found;
    const { intent, attempts, holdActions, refunds } = found.history;
    const key = { merchantId: intent.merchantId, paymentIntentId: intent.id };
    const [entries, events] = await Promise.all([
      this.listJournalEntries.execute(key),
      this.readAuditEvents.listForTarget({
        merchantId: intent.merchantId,
        targetType: 'PAYMENT_INTENT',
        targetId: intent.id,
      }),
    ]);
    const directory = await this.describeActors.execute(actorRefsOf(events));

    const intentAmount = toAmountMinorString(intent.amount);
    const items: TimelineItem[] = [
      {
        kind: 'PAYMENT_INTENT_CREATED',
        sourceId: intent.id,
        occurredAt: intent.createdAt,
        summary: `Payment order ${intent.merchantReference} created (${intent.captureMode} capture); now ${intent.status}.`,
        status: intent.status,
        amountMinor: intentAmount,
        currency: intent.amount.currency,
        actor: null,
        auditAction: null,
      },
      ...attempts.map((attempt): TimelineItem => ({
        kind: 'PAYMENT_ATTEMPT_STARTED',
        sourceId: attempt.id,
        occurredAt: attempt.createdAt,
        summary: `Payment attempt sent to the processor; now ${attempt.status}${attempt.declineCode === null ? '' : ` (${attempt.declineCode})`}.`,
        status: attempt.status,
        amountMinor: intentAmount,
        currency: intent.amount.currency,
        actor: null,
        auditAction: null,
      })),
      ...holdActions.map((action): TimelineItem => ({
        kind:
          action.action === 'CAPTURE' ? 'CAPTURE_REQUESTED' : 'VOID_REQUESTED',
        sourceId: action.id,
        occurredAt: action.createdAt,
        summary: `${action.action === 'CAPTURE' ? 'Capture' : 'Void'} sent to the processor; now ${action.status}${action.failureCode === null ? '' : ` (${action.failureCode})`}.`,
        status: action.status,
        amountMinor: toAmountMinorString(action.amount),
        currency: action.amount.currency,
        actor: null,
        auditAction: null,
      })),
      ...refunds.map((refund): TimelineItem => ({
        kind: 'REFUND_REQUESTED',
        sourceId: refund.id,
        occurredAt: refund.createdAt,
        summary: `Refund sent to the processor; now ${refund.status}${refund.failureCode === null ? '' : ` (${refund.failureCode})`}.`,
        status: refund.status,
        amountMinor: toAmountMinorString(refund.amount),
        currency: refund.amount.currency,
        actor: null,
        auditAction: null,
      })),
      ...entries.map((entry): TimelineItem => ({
        kind: 'JOURNAL_ENTRY_POSTED',
        sourceId: entry.id,
        occurredAt: entry.postedAt,
        summary: entrySummary(entry),
        status: entry.sourceType,
        amountMinor: entryAmount(entry).toString(),
        currency: entry.lines[0]?.amount.currency ?? intent.amount.currency,
        actor: null,
        auditAction: null,
      })),
      ...events.map((event): TimelineItem => {
        const metadata = safeAuditMetadata(event.metadata);
        const amount = metadata['amount_minor'];
        const currency = metadata['currency'];
        const status = metadata['status'];
        return {
          kind: 'AUDIT_EVENT',
          sourceId: event.id,
          occurredAt: event.occurredAt,
          summary: summarizeAuditEvent(event.action, metadata),
          status: typeof status === 'string' ? status : null,
          amountMinor: typeof amount === 'string' ? amount : null,
          currency:
            typeof amount === 'string' && typeof currency === 'string'
              ? currency
              : null,
          actor: actorViewOf(event, directory, command.principal),
          auditAction: event.action,
        };
      }),
    ];
    items.sort(compareTimelineItems);
    return {
      ok: true,
      timeline: {
        paymentIntentId: intent.id,
        merchantId: intent.merchantId,
        items,
      },
    };
  }
}
