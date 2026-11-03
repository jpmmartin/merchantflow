import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import type { Clock } from '../../src/modules/clock/clock.js';
import {
  ClaimIdempotencyKeyService,
  type ClaimIdempotencyKeyCommand,
} from '../../src/modules/idempotency/application/claim-idempotency-key.service.js';
import { CompleteIdempotencyRecordService } from '../../src/modules/idempotency/application/complete-idempotency-record.service.js';
import { insertMerchant } from '../../src/modules/merchants/infrastructure/merchant-queries.js';

export const CLAIMED_AT = new Date('2026-11-03T10:00:00.000Z');

/** A clock that returns `current` until a test moves it. */
export class ManualClock implements Clock {
  constructor(public current: Date = CLAIMED_AT) {}

  now(): Date {
    return this.current;
  }
}

/** Both idempotency services over one manual clock. */
export function idempotencyServices(clock: Clock = new ManualClock()) {
  return {
    claim: new ClaimIdempotencyKeyService(clock),
    complete: new CompleteIdempotencyRecordService(clock),
  };
}

/** Inserts an active merchant and returns its id. */
export async function insertTestMerchant(db: Database): Promise<string> {
  const id = randomUUID();
  await insertMerchant(db, {
    id,
    legalName: 'Idempotency Test Merchant Ltd',
    displayName: 'Idempotency Test',
    businessType: 'LLC',
    industry: 'Retail',
    countryCode: 'US',
    defaultCurrency: 'USD',
    status: 'ACTIVE',
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  });
  return id;
}

/** A claim of a fresh key for the merchant, with a payment-like request. */
export function claimCommand(
  merchantId: string,
  overrides: Partial<ClaimIdempotencyKeyCommand> = {},
): ClaimIdempotencyKeyCommand {
  return {
    merchantId,
    operation: 'CREATE_PAYMENT_INTENT',
    idempotencyKey: `key-${randomUUID()}`,
    operationId: randomUUID(),
    request: {
      amount_minor: '10000',
      currency: 'USD',
      merchant_reference: 'order-1001',
    },
    ...overrides,
  };
}
