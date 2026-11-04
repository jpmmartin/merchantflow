import { Injectable } from '@nestjs/common';
import type { AuditAction } from '../../audit/application/audit-actions.js';
import {
  ReadAuditEventsService,
  type AuditReadScope,
} from '../../audit/application/read-audit-events.service.js';
import {
  safeAuditMetadata,
  type SafeAuditMetadata,
} from '../../audit/application/safe-audit-metadata.js';
import { DescribeActorsService } from '../../auth/application/describe-actors.service.js';
import type { Principal } from '../../auth/application/principal.js';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import { actorRefsOf, actorViewOf, type ActorView } from './actor-view.js';
import { summarizeAuditEvent } from './audit-summary.js';

export interface ListAuditLogCommand {
  readonly principal: Principal;
  /** Page size. The caller validates the bounds. */
  readonly limit: number;
  readonly after?: KeysetPosition | undefined;
  readonly action?: AuditAction | undefined;
  /** Inclusive lower bound of the occurrence time. */
  readonly from?: Date | undefined;
  /** Exclusive upper bound of the occurrence time; after `from`. */
  readonly to?: Date | undefined;
}

/** An audit event as a reader may see it. */
export interface AuditLogEntry {
  readonly id: string;
  readonly occurredAt: Date;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly merchantId: string | null;
  readonly correlationId: string;
  readonly actor: ActorView;
  readonly summary: string;
  readonly metadata: SafeAuditMetadata;
}

export interface AuditLogPage {
  readonly entries: readonly AuditLogEntry[];
  readonly next: KeysetPosition | undefined;
}

/**
 * Lists the audit trail for the operations panel, newest first. The scope
 * comes only from the principal: `PLATFORM_ADMIN` sees every event, including
 * those with no merchant; `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` see only
 * the events whose merchant is their own, never one with no merchant. Each
 * event carries only its reviewed metadata, a summary built from it, and a
 * readable actor (`actorViewOf`). A list writes nothing.
 */
@Injectable()
export class ListAuditLogService {
  constructor(
    private readonly readAuditEvents: ReadAuditEventsService,
    private readonly describeActors: DescribeActorsService,
  ) {}

  async execute(command: ListAuditLogCommand): Promise<AuditLogPage> {
    const { principal } = command;
    const scope: AuditReadScope =
      principal.kind === 'PLATFORM'
        ? { kind: 'ALL' }
        : { kind: 'MERCHANT', merchantId: principal.merchantId };
    const page = await this.readAuditEvents.list({
      scope,
      limit: command.limit,
      after: command.after,
      action: command.action,
      from: command.from,
      to: command.to,
    });
    const directory = await this.describeActors.execute(
      actorRefsOf(page.events),
    );
    return {
      entries: page.events.map((event) => {
        const metadata = safeAuditMetadata(event.metadata);
        return {
          id: event.id,
          occurredAt: event.occurredAt,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          merchantId: event.merchantId,
          correlationId: event.correlationId,
          actor: actorViewOf(event, directory, principal),
          summary: summarizeAuditEvent(event.action, metadata),
          metadata,
        };
      }),
      next: page.next,
    };
  }
}
