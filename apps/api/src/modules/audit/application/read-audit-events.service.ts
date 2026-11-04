import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import {
  listAuditEvents,
  listAuditEventsForTarget,
} from '../infrastructure/audit-event-queries.js';
import type { AuditAction } from './audit-actions.js';
import type { AuditEvent } from './audit-event.js';

/** Which events a reader may see: all of them, or one merchant's. */
export type AuditReadScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'MERCHANT'; readonly merchantId: string };

export interface ListAuditEventsQuery {
  readonly scope: AuditReadScope;
  /** Page size. The caller validates the bounds. */
  readonly limit: number;
  /** Where the previous page ended, to continue after it. */
  readonly after?: KeysetPosition | undefined;
  readonly action?: AuditAction | undefined;
  /** Inclusive lower bound of the occurrence time. */
  readonly from?: Date | undefined;
  /** Exclusive upper bound of the occurrence time. */
  readonly to?: Date | undefined;
}

export interface AuditEventPage {
  readonly events: readonly AuditEvent[];
  /** Pass it as `after` to get the next page; `undefined` on the last page. */
  readonly next: KeysetPosition | undefined;
}

/**
 * Reads the audit trail for other modules, which never query `audit_events`
 * themselves. The caller decides the scope from its authenticated principal;
 * this service applies it as a filter on every row, so a merchant scope never
 * returns an event of another merchant or one with no merchant. Events are
 * returned as stored: showing them safely (metadata, actors) is the caller's
 * job, through `safeAuditMetadata`.
 */
@Injectable()
export class ReadAuditEventsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** One page, newest first by occurrence time and then id. */
  async list(query: ListAuditEventsQuery): Promise<AuditEventPage> {
    // One extra row tells whether another page exists without a count query.
    const rows = await listAuditEvents(this.database, {
      scope: query.scope,
      limit: query.limit + 1,
      after: query.after,
      action: query.action,
      from: query.from,
      to: query.to,
    });
    const events = rows.slice(0, query.limit);
    const last = events.at(-1);
    return {
      events,
      next:
        rows.length > query.limit && last !== undefined
          ? { createdAt: last.occurredAt, id: last.id }
          : undefined,
    };
  }

  /** Every event of the merchant about one target, oldest first. */
  async listForTarget(key: {
    readonly merchantId: string;
    readonly targetType: string;
    readonly targetId: string;
  }): Promise<readonly AuditEvent[]> {
    return listAuditEventsForTarget(this.database, key);
  }
}
