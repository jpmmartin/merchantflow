import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import type { Merchant } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { AuditMetadata } from '../../audit/application/audit-event.js';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import type { Principal } from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import {
  findMerchantByIdForUpdate,
  updateMerchantProfile,
} from '../infrastructure/merchant-queries.js';
import { auditActorOf, canAddressMerchant } from './merchant-access.js';
import {
  MERCHANT_PROFILE_FIELDS,
  MERCHANT_PROFILE_FIELD_NAMES,
  type MerchantFixedField,
  type MerchantProfileChanges,
  type MerchantProfileField,
} from './merchant-changes.js';

/** The only fields a `MERCHANT_ADMIN` may change, on its own merchant. */
const MERCHANT_ADMIN_FIELDS: ReadonlySet<MerchantProfileField> = new Set([
  'displayName',
  'industry',
]);

export interface UpdateMerchantProfileCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly changes: MerchantProfileChanges;
  /** Fixed fields the request named. Nobody can change them this way. */
  readonly fixedFieldsRequested: readonly MerchantFixedField[];
  readonly correlationId: string;
}

export type UpdateMerchantProfileResult =
  | { readonly ok: true; readonly merchant: Merchant }
  | {
      readonly ok: false;
      readonly code: 'MERCHANT_NOT_FOUND' | 'FORBIDDEN';
    }
  | {
      readonly ok: false;
      readonly code: 'FIXED_FIELD';
      readonly fields: readonly MerchantFixedField[];
    };

/**
 * Updates the profile of a merchant and writes one audit event with the old and
 * new values in the same transaction.
 *
 * The checks run in this order, and a failure stops the request before
 * anything is read or written: the merchant must be addressable by the caller
 * (otherwise "not found", whatever the role), then the role must allow every
 * field in the request (otherwise 403), then a fixed field is refused.
 * A `MERCHANT_ADMIN` may change `display_name` and `industry` of its own
 * merchant whatever the merchant's status: suspension blocks payment commands,
 * not the merchant's descriptive profile, and the audit event keeps the
 * previous values, so a platform administrator can see what changed. A request
 * that changes no value is not a mutation: it writes nothing.
 */
@Injectable()
export class UpdateMerchantProfileService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    command: UpdateMerchantProfileCommand,
  ): Promise<UpdateMerchantProfileResult> {
    const { principal, changes } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    const requested = MERCHANT_PROFILE_FIELDS.filter(
      (field) => changes[field] !== undefined,
    );
    if (!mayChange(principal, requested, command.fixedFieldsRequested)) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    if (command.fixedFieldsRequested.length > 0) {
      return {
        ok: false,
        code: 'FIXED_FIELD',
        fields: command.fixedFieldsRequested,
      };
    }

    const now = this.clock.now();
    return this.database
      .transaction()
      .execute(async (trx): Promise<UpdateMerchantProfileResult> => {
        // The row stays locked until commit, so the old values in the audit
        // event are the values this update replaces.
        const current = await findMerchantByIdForUpdate(
          trx,
          command.merchantId,
        );
        if (current === undefined) {
          return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        }
        const changed = requested.filter(
          (field) => current[field] !== changes[field],
        );
        if (changed.length === 0) {
          return { ok: true, merchant: current };
        }

        const updated = await updateMerchantProfile(trx, {
          id: current.id,
          changes,
          updatedAt: now,
        });
        if (updated === undefined) {
          // The row was locked above, so it cannot have disappeared.
          throw new Error(`merchant ${current.id} vanished while locked`);
        }
        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          ...auditActorOf(principal),
          action: 'MERCHANT_UPDATED',
          targetType: 'MERCHANT',
          targetId: current.id,
          merchantId: current.id,
          correlationId: command.correlationId,
          metadata: describeChange(current, updated, changed),
        });
        return { ok: true, merchant: updated };
      });
  }
}

/** Whether the role of the principal allows every field the request names. */
function mayChange(
  principal: Principal,
  fields: readonly MerchantProfileField[],
  fixedFields: readonly MerchantFixedField[],
): boolean {
  switch (principal.role) {
    case 'PLATFORM_ADMIN':
      return true;
    case 'MERCHANT_ADMIN':
      return (
        fixedFields.length === 0 &&
        fields.every((field) => MERCHANT_ADMIN_FIELDS.has(field))
      );
    case 'MERCHANT_READ_ONLY':
      return false;
  }
}

function describeChange(
  before: Merchant,
  after: Merchant,
  changed: readonly MerchantProfileField[],
): AuditMetadata {
  const previous: Record<string, string> = {};
  const current: Record<string, string> = {};
  for (const field of changed) {
    const name = MERCHANT_PROFILE_FIELD_NAMES[field];
    previous[name] = before[field];
    current[name] = after[field];
  }
  return {
    changed_fields: changed.map((field) => MERCHANT_PROFILE_FIELD_NAMES[field]),
    previous,
    current,
  };
}
