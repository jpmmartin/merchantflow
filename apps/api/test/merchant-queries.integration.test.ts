import { randomUUID } from 'node:crypto';
import { MERCHANT_STATUSES, type Merchant } from '@merchantflow/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../src/modules/audit/application/audit-event.js';
import { appendAuditEvent } from '../src/modules/audit/infrastructure/audit-event-queries.js';
import {
  findMerchantById,
  insertMerchant,
  updateMerchantStatus,
} from '../src/modules/merchants/infrastructure/merchant-queries.js';
import {
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const CREATED_AT = new Date('2026-11-02T10:00:00.123Z');
const LATER = new Date('2026-11-02T11:30:00.456Z');

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: randomUUID(),
    legalName: 'Acme Payments Ltd',
    displayName: 'Acme',
    businessType: 'LLC',
    industry: 'Retail',
    countryCode: 'US',
    defaultCurrency: 'USD',
    status: 'DRAFT',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: randomUUID(),
    occurredAt: LATER,
    actorType: 'API_KEY',
    actorId: randomUUID(),
    action: 'MERCHANT_STATUS_CHANGED',
    targetType: 'MERCHANT',
    targetId: randomUUID(),
    merchantId: null,
    correlationId: randomUUID(),
    metadata: { from: 'DRAFT', to: 'ACTIVE' },
    ...overrides,
  };
}

describe('merchant and audit query functions', () => {
  let postgres: MigratedPostgres;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
  });

  afterAll(async () => {
    await postgres.stop();
  });

  describe('insertMerchant and findMerchantById', () => {
    it('round-trips every field of the domain merchant', async () => {
      const inserted = merchant({ legalName: 'Ñandú Café S.L.' });
      await insertMerchant(postgres.db, inserted);

      expect(await findMerchantById(postgres.db, inserted.id)).toEqual(
        inserted,
      );
    });

    it.each(MERCHANT_STATUSES)('round-trips the status %s', async (status) => {
      const inserted = merchant({ status });
      await insertMerchant(postgres.db, inserted);

      expect((await findMerchantById(postgres.db, inserted.id))?.status).toBe(
        status,
      );
    });

    it('returns undefined for an unknown id', async () => {
      expect(await findMerchantById(postgres.db, randomUUID())).toBeUndefined();
    });

    it('fails when the merchant breaks a database constraint', async () => {
      await expect(
        insertMerchant(postgres.db, merchant({ countryCode: 'us' })),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'merchants_country_code_check',
      });
    });
  });

  describe('updateMerchantStatus', () => {
    it('changes one row when the expected status matches', async () => {
      const inserted = merchant();
      await insertMerchant(postgres.db, inserted);

      const changed = await updateMerchantStatus(postgres.db, {
        id: inserted.id,
        expected: 'DRAFT',
        next: 'ACTIVE',
        updatedAt: LATER,
      });

      expect(changed).toBe(1);
      expect(await findMerchantById(postgres.db, inserted.id)).toEqual({
        ...inserted,
        status: 'ACTIVE',
        updatedAt: LATER,
      });
    });

    it('changes no row when the expected status does not match', async () => {
      const inserted = merchant({ status: 'ACTIVE' });
      await insertMerchant(postgres.db, inserted);

      const changed = await updateMerchantStatus(postgres.db, {
        id: inserted.id,
        expected: 'DRAFT',
        next: 'SUSPENDED',
        updatedAt: LATER,
      });

      expect(changed).toBe(0);
      expect(await findMerchantById(postgres.db, inserted.id)).toEqual(
        inserted,
      );
    });

    it('changes no row for an unknown merchant', async () => {
      const changed = await updateMerchantStatus(postgres.db, {
        id: randomUUID(),
        expected: 'DRAFT',
        next: 'ACTIVE',
        updatedAt: LATER,
      });

      expect(changed).toBe(0);
    });

    it('lets exactly one of two concurrent updates from the same status win', async () => {
      const inserted = merchant({ status: 'ACTIVE' });
      await insertMerchant(postgres.db, inserted);

      const results = await Promise.all([
        updateMerchantStatus(postgres.db, {
          id: inserted.id,
          expected: 'ACTIVE',
          next: 'SUSPENDED',
          updatedAt: LATER,
        }),
        updateMerchantStatus(postgres.db, {
          id: inserted.id,
          expected: 'ACTIVE',
          next: 'SUSPENDED',
          updatedAt: LATER,
        }),
      ]);

      expect([...results].sort()).toEqual([0, 1]);
    });

    it('is rejected by PostgreSQL when updated_at would precede created_at', async () => {
      const inserted = merchant();
      await insertMerchant(postgres.db, inserted);

      await expect(
        updateMerchantStatus(postgres.db, {
          id: inserted.id,
          expected: 'DRAFT',
          next: 'ACTIVE',
          updatedAt: new Date('2026-11-02T09:00:00.000Z'),
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'merchants_updated_at_check',
      });
    });
  });

  describe('appendAuditEvent', () => {
    it('stores every field of the event', async () => {
      const concerned = merchant();
      await insertMerchant(postgres.db, concerned);
      const event = auditEvent({
        merchantId: concerned.id,
        metadata: { from: 'DRAFT', to: 'ACTIVE', nested: { list: [1, null] } },
      });

      await appendAuditEvent(postgres.db, event);

      const { rows } = await postgres.client.query(
        'select * from audit_events where id = $1',
        [event.id],
      );
      expect(rows).toEqual([
        {
          id: event.id,
          occurred_at: event.occurredAt,
          actor_type: event.actorType,
          actor_id: event.actorId,
          action: event.action,
          target_type: event.targetType,
          target_id: event.targetId,
          merchant_id: concerned.id,
          correlation_id: event.correlationId,
          metadata: event.metadata,
        },
      ]);
    });

    it('stores an event that concerns no merchant', async () => {
      const event = auditEvent({ actorType: 'SYSTEM', actorId: 'seed' });

      await appendAuditEvent(postgres.db, event);

      const { rows } = await postgres.client.query<{
        merchant_id: string | null;
      }>('select merchant_id from audit_events where id = $1', [event.id]);
      expect(rows).toEqual([{ merchant_id: null }]);
    });

    it('commits with a status change in the same transaction, or not at all', async () => {
      const inserted = merchant();
      await insertMerchant(postgres.db, inserted);
      const event = auditEvent({
        merchantId: inserted.id,
        targetId: inserted.id,
      });

      await expect(
        postgres.db.transaction().execute(async (trx) => {
          await updateMerchantStatus(trx, {
            id: inserted.id,
            expected: 'DRAFT',
            next: 'ACTIVE',
            updatedAt: LATER,
          });
          await appendAuditEvent(trx, event);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');

      expect((await findMerchantById(postgres.db, inserted.id))?.status).toBe(
        'DRAFT',
      );
      const { rows } = await postgres.client.query(
        'select count(*)::int as total from audit_events where id = $1',
        [event.id],
      );
      expect(rows).toEqual([{ total: 0 }]);
    });

    it('fails when the event breaks a database constraint', async () => {
      await expect(
        appendAuditEvent(postgres.db, auditEvent({ action: 'bad action' })),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'audit_events_action_check',
      });
    });
  });
});
