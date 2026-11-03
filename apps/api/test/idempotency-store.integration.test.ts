import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOCK } from '../src/modules/clock/clock.js';
import {
  ClaimIdempotencyKeyService,
  type ClaimIdempotencyKeyOutcome,
} from '../src/modules/idempotency/application/claim-idempotency-key.service.js';
import {
  CompleteIdempotencyRecordService,
  type CompleteIdempotencyRecordResult,
} from '../src/modules/idempotency/application/complete-idempotency-record.service.js';
import {
  IDEMPOTENCY_RETENTION_MILLIS,
  type ClaimedIdempotencyRecord,
  type IdempotentResponse,
} from '../src/modules/idempotency/application/idempotency-record.js';
import { IdempotencyModule } from '../src/modules/idempotency/idempotency.module.js';
import {
  CLAIMED_AT,
  ManualClock,
  claimCommand,
  idempotencyServices,
  insertTestMerchant,
} from './support/idempotency.js';
import {
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const DAY = 24 * 60 * 60 * 1000;

const RESPONSE: IdempotentResponse = {
  statusCode: 201,
  // Keys deliberately out of alphabetical and length order.
  body: {
    status: 'CREATED',
    id: 'pi_1',
    amount_minor: '10000',
    nested: { zeta: 1, alpha: [true, null, 'x'], mid: 2.5 },
    a: '',
  },
};

describe('idempotency store', () => {
  let postgres: MigratedPostgres;
  let clock: ManualClock;
  let services: ReturnType<typeof idempotencyServices>;
  let merchantId: string;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    clock = new ManualClock();
    services = idempotencyServices(clock);
    merchantId = await insertTestMerchant(postgres.db);
  });

  afterAll(async () => {
    await postgres.stop();
  });

  function claim(command: Parameters<typeof services.claim.execute>[1]) {
    return postgres.db
      .transaction()
      .execute((trx) => services.claim.execute(trx, command));
  }

  function complete(
    record: Pick<ClaimedIdempotencyRecord, 'id' | 'merchantId'>,
    response: IdempotentResponse = RESPONSE,
  ) {
    return postgres.db
      .transaction()
      .execute((trx) =>
        services.complete.execute(trx, { record: { ...record }, response }),
      );
  }

  async function claimOwned(
    command = claimCommand(merchantId),
  ): Promise<ClaimedIdempotencyRecord> {
    const outcome = await claim(command);
    if (outcome.outcome !== 'CLAIMED') {
      throw new Error(`expected a claim, got ${outcome.outcome}`);
    }
    return outcome.record;
  }

  async function rowsOf(idempotencyKey: string) {
    const { rows } = await postgres.client.query(
      'select * from idempotency_records where idempotency_key = $1',
      [idempotencyKey],
    );
    return rows as Record<string, unknown>[];
  }

  describe('claim', () => {
    it('makes the first caller the owner and stores the record in progress', async () => {
      clock.current = CLAIMED_AT;
      const command = claimCommand(merchantId);

      const outcome = await claim(command);

      expect(outcome).toEqual({
        outcome: 'CLAIMED',
        record: {
          id: expect.any(String) as string,
          merchantId,
          operation: command.operation,
          idempotencyKey: command.idempotencyKey,
          requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
          operationId: command.operationId,
          createdAt: CLAIMED_AT,
          expiresAt: new Date(CLAIMED_AT.getTime() + 30 * DAY),
        },
      });
      const rows = await rowsOf(command.idempotencyKey);
      expect(rows).toEqual([
        {
          id: (outcome as { record: ClaimedIdempotencyRecord }).record.id,
          merchant_id: merchantId,
          operation: command.operation,
          idempotency_key: command.idempotencyKey,
          request_fingerprint: (outcome as { record: ClaimedIdempotencyRecord })
            .record.requestFingerprint,
          operation_id: command.operationId,
          status: 'IN_PROGRESS',
          response_status_code: null,
          response_body: null,
          created_at: CLAIMED_AT,
          completed_at: null,
          expires_at: new Date(CLAIMED_AT.getTime() + 30 * DAY),
        },
      ]);
    });

    it('answers IN_PROGRESS with the original operation ID for the same request before completion', async () => {
      const command = claimCommand(merchantId);
      await claimOwned(command);

      const outcome = await claim({ ...command, operationId: randomUUID() });

      expect(outcome).toEqual({
        outcome: 'IN_PROGRESS',
        operationId: command.operationId,
        createdAt: CLAIMED_AT,
      });
      expect(await rowsOf(command.idempotencyKey)).toHaveLength(1);
    });

    it('answers KEY_REUSED for a different request under the same key and operation', async () => {
      const command = claimCommand(merchantId);
      await claimOwned(command);

      const outcome = await claim({
        ...command,
        request: { ...(command.request as object), amount_minor: '10001' },
      });

      expect(outcome).toEqual({ outcome: 'KEY_REUSED' });
    });

    it('answers KEY_REUSED for a different request after completion, without the stored response', async () => {
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);
      await complete(record);

      const outcome = await claim({ ...command, request: { other: true } });

      expect(outcome).toEqual({ outcome: 'KEY_REUSED' });
    });

    it('treats the same request with its keys in another order as the same request', async () => {
      const command = claimCommand(merchantId, {
        request: {
          currency: 'USD',
          amount_minor: '10000',
          merchant_reference: 'r',
        },
      });
      await claimOwned(command);

      const outcome = await claim({
        ...command,
        request: {
          merchant_reference: 'r',
          amount_minor: '10000',
          currency: 'USD',
        },
      });

      expect(outcome.outcome).toBe('IN_PROGRESS');
    });

    it('gives independent owners to the same key under another merchant', async () => {
      const otherMerchantId = await insertTestMerchant(postgres.db);
      const command = claimCommand(merchantId);
      const first = await claimOwned(command);

      const second = await claim({ ...command, merchantId: otherMerchantId });

      expect(second.outcome).toBe('CLAIMED');
      const rows = await rowsOf(command.idempotencyKey);
      expect(rows.map((row) => row.merchant_id).sort()).toEqual(
        [merchantId, otherMerchantId].sort(),
      );
      // Completing one merchant's record leaves the other in progress.
      await complete(first);
      expect(
        (await claim({ ...command, merchantId: otherMerchantId })).outcome,
      ).toBe('IN_PROGRESS');
      expect((await claim(command)).outcome).toBe('REPLAY');
    });

    it('gives independent owners to the same key under another operation, even with the same request', async () => {
      const command = claimCommand(merchantId);
      await claimOwned(command);

      const second = await claim({
        ...command,
        operation: 'CONFIRM_PAYMENT_INTENT',
      });

      expect(second.outcome).toBe('CLAIMED');
      expect(await rowsOf(command.idempotencyKey)).toHaveLength(2);
    });

    it('treats keys that differ only in letter case as different keys', async () => {
      const command = claimCommand(merchantId, {
        idempotencyKey: 'Key-CASE-1',
      });
      await claimOwned(command);

      const outcome = await claim({ ...command, idempotencyKey: 'key-case-1' });

      expect(outcome.outcome).toBe('CLAIMED');
    });

    it('is released by a rollback of the claiming transaction', async () => {
      const command = claimCommand(merchantId);
      const rolledBack = new Error('the command failed after the claim');

      await expect(
        postgres.db.transaction().execute(async (trx) => {
          expect((await services.claim.execute(trx, command)).outcome).toBe(
            'CLAIMED',
          );
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);

      expect(await rowsOf(command.idempotencyKey)).toEqual([]);
      expect((await claim(command)).outcome).toBe('CLAIMED');
    });

    it('answers IN_PROGRESS to a second claim inside the owner transaction', async () => {
      const command = claimCommand(merchantId);

      const outcomes = await postgres.db
        .transaction()
        .execute(async (trx) => [
          await services.claim.execute(trx, command),
          await services.claim.execute(trx, command),
        ]);

      expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
        'CLAIMED',
        'IN_PROGRESS',
      ]);
    });

    it('throws, and stores nothing, for a merchant that does not exist', async () => {
      const command = claimCommand(randomUUID());

      await expect(claim(command)).rejects.toMatchObject({
        code: '23503',
        constraint: 'idempotency_records_merchant_id_fkey',
      });
      expect(await rowsOf(command.idempotencyKey)).toEqual([]);
    });

    it('throws for a request value outside the fingerprint types, before writing', async () => {
      const command = claimCommand(merchantId, {
        request: { amount_minor: 10000n } as unknown as Record<string, string>,
      });

      await expect(claim(command)).rejects.toThrow(TypeError);
      expect(await rowsOf(command.idempotencyKey)).toEqual([]);
    });
  });

  describe('replay', () => {
    it('returns the stored response unchanged, with its key order', async () => {
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);
      clock.current = new Date(CLAIMED_AT.getTime() + 1500);
      await complete(record);
      clock.current = new Date(CLAIMED_AT.getTime() + 60_000);

      const outcome = await claim(command);

      expect(outcome).toEqual({
        outcome: 'REPLAY',
        operationId: command.operationId,
        response: RESPONSE,
        completedAt: new Date(CLAIMED_AT.getTime() + 1500),
      });
      const replayed = (
        outcome as Extract<ClaimIdempotencyKeyOutcome, { outcome: 'REPLAY' }>
      ).response;
      expect(JSON.stringify(replayed.body)).toBe(JSON.stringify(RESPONSE.body));
      expect(replayed.statusCode).toBe(201);
    });

    it('returns the same response to every later retry', async () => {
      const command = claimCommand(merchantId);
      await complete(await claimOwned(command));

      const outcomes = await Promise.all([
        claim(command),
        claim(command),
        claim(command),
      ]);

      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          outcome: 'REPLAY',
          response: RESPONSE,
        });
      }
    });

    it('replays a stored failure response as stored', async () => {
      const command = claimCommand(merchantId);
      const failure: IdempotentResponse = {
        statusCode: 409,
        body: { error: { code: 'DUPLICATE_MERCHANT_REFERENCE' } },
      };
      await complete(await claimOwned(command), failure);

      expect(await claim(command)).toMatchObject({
        outcome: 'REPLAY',
        response: failure,
      });
    });
  });

  describe('complete', () => {
    it('stores the response, the completion time, and a restarted expiry', async () => {
      const command = claimCommand(merchantId);
      clock.current = CLAIMED_AT;
      const record = await claimOwned(command);
      const completedAt = new Date(CLAIMED_AT.getTime() + 2 * DAY);
      clock.current = completedAt;

      const result = await complete(record);

      expect(result).toEqual({
        ok: true,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + 30 * DAY),
      });
      const [row] = await rowsOf(command.idempotencyKey);
      expect(row).toMatchObject({
        status: 'COMPLETED',
        response_status_code: 201,
        response_body: RESPONSE.body,
        created_at: CLAIMED_AT,
        completed_at: completedAt,
        expires_at: new Date(completedAt.getTime() + 30 * DAY),
      });
      clock.current = CLAIMED_AT;
    });

    it('works in the same transaction as the claim, as a command with no external call does', async () => {
      const command = claimCommand(merchantId);

      const result = await postgres.db.transaction().execute(async (trx) => {
        const outcome = await services.claim.execute(trx, command);
        if (outcome.outcome !== 'CLAIMED') throw new Error(outcome.outcome);
        return services.complete.execute(trx, {
          record: outcome.record,
          response: RESPONSE,
        });
      });

      expect(result.ok).toBe(true);
      expect((await claim(command)).outcome).toBe('REPLAY');
    });

    it('works in a later transaction than the claim, as Reserve and Apply do', async () => {
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);
      expect((await claim(command)).outcome).toBe('IN_PROGRESS');

      expect((await complete(record)).ok).toBe(true);
      expect((await claim(command)).outcome).toBe('REPLAY');
    });

    it('is undone with its transaction, leaving the record in progress', async () => {
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);
      const rolledBack = new Error('apply failed');

      await expect(
        postgres.db.transaction().execute(async (trx) => {
          await services.complete.execute(trx, { record, response: RESPONSE });
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);

      expect((await claim(command)).outcome).toBe('IN_PROGRESS');
      expect((await complete(record)).ok).toBe(true);
    });

    it('returns ALREADY_COMPLETED for a second completion and keeps the first response', async () => {
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);
      await complete(record);
      const [before] = await rowsOf(command.idempotencyKey);
      clock.current = new Date(CLAIMED_AT.getTime() + DAY);

      const second = await complete(record, {
        statusCode: 500,
        body: { replaced: true },
      });

      expect(second).toEqual({ ok: false, code: 'ALREADY_COMPLETED' });
      expect(await rowsOf(command.idempotencyKey)).toEqual([before]);
      expect(await claim(command)).toMatchObject({
        outcome: 'REPLAY',
        response: RESPONSE,
      });
      clock.current = CLAIMED_AT;
    });

    it('lets exactly one of two concurrent completions win', async () => {
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);

      const results = await Promise.all([
        complete(record, { statusCode: 201, body: { winner: 'a' } }),
        complete(record, { statusCode: 201, body: { winner: 'b' } }),
      ]);

      const codes = results.map((result) => (result.ok ? 'ok' : result.code));
      expect(codes.sort()).toEqual(['ALREADY_COMPLETED', 'ok']);
    });

    it('returns RECORD_NOT_FOUND for an unknown record', async () => {
      expect(await complete({ id: randomUUID(), merchantId })).toEqual({
        ok: false,
        code: 'RECORD_NOT_FOUND',
      });
    });

    it('returns RECORD_NOT_FOUND, and changes nothing, for the record of another merchant', async () => {
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);
      const otherMerchantId = await insertTestMerchant(postgres.db);

      expect(
        await complete({ id: record.id, merchantId: otherMerchantId }),
      ).toEqual({ ok: false, code: 'RECORD_NOT_FOUND' });
      expect((await claim(command)).outcome).toBe('IN_PROGRESS');
    });

    it('returns RECORD_NOT_FOUND for a claim that was rolled back', async () => {
      const command = claimCommand(merchantId);
      let claimed: ClaimedIdempotencyRecord | undefined;
      await postgres.db
        .transaction()
        .execute(async (trx) => {
          const outcome = await services.claim.execute(trx, command);
          if (outcome.outcome === 'CLAIMED') claimed = outcome.record;
          throw new Error('roll back');
        })
        .catch(() => undefined);

      expect(claimed).toBeDefined();
      expect(await complete(claimed!)).toEqual({
        ok: false,
        code: 'RECORD_NOT_FOUND',
      });
    });

    it('can be handled exhaustively', () => {
      const describeResult = (result: CompleteIdempotencyRecordResult) => {
        if (result.ok) return 'completed';
        switch (result.code) {
          case 'RECORD_NOT_FOUND':
            return 'missing';
          case 'ALREADY_COMPLETED':
            return 'twice';
          default: {
            const unreachable: never = result.code;
            return unreachable;
          }
        }
      };
      expect(describeResult({ ok: false, code: 'ALREADY_COMPLETED' })).toBe(
        'twice',
      );
    });
  });

  describe('expiry', () => {
    it('uses a retention of 30 days', () => {
      expect(IDEMPOTENCY_RETENTION_MILLIS).toBe(30 * DAY);
    });

    it('still replays a completed record after it expired, and never claims its key again', async () => {
      clock.current = CLAIMED_AT;
      const command = claimCommand(merchantId);
      await complete(await claimOwned(command));
      clock.current = new Date(CLAIMED_AT.getTime() + 365 * DAY);

      expect(await claim(command)).toMatchObject({
        outcome: 'REPLAY',
        response: RESPONSE,
      });
      expect(await claim({ ...command, request: { other: 1 } })).toEqual({
        outcome: 'KEY_REUSED',
      });
      expect(await rowsOf(command.idempotencyKey)).toHaveLength(1);
      clock.current = CLAIMED_AT;
    });

    it('never reclaims a record in progress because it expired', async () => {
      clock.current = CLAIMED_AT;
      const command = claimCommand(merchantId);
      const record = await claimOwned(command);
      clock.current = new Date(CLAIMED_AT.getTime() + 365 * DAY);

      expect(await claim({ ...command, operationId: randomUUID() })).toEqual({
        outcome: 'IN_PROGRESS',
        operationId: command.operationId,
        createdAt: CLAIMED_AT,
      });
      const [row] = await rowsOf(command.idempotencyKey);
      expect(row).toMatchObject({ id: record.id, status: 'IN_PROGRESS' });
      // The original owner can still complete it.
      expect((await complete(record)).ok).toBe(true);
      clock.current = CLAIMED_AT;
    });
  });

  describe('outcomes', () => {
    it('can be handled exhaustively', () => {
      const describeOutcome = (outcome: ClaimIdempotencyKeyOutcome) => {
        switch (outcome.outcome) {
          case 'CLAIMED':
            return 'run';
          case 'REPLAY':
            return 'replay';
          case 'IN_PROGRESS':
            return 'wait';
          case 'KEY_REUSED':
            return 'conflict';
          default: {
            const unreachable: never = outcome;
            return unreachable;
          }
        }
      };
      expect(describeOutcome({ outcome: 'KEY_REUSED' })).toBe('conflict');
    });
  });

  describe('IdempotencyModule', () => {
    it('provides both services with the shared clock', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IdempotencyModule],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      const claimService = moduleRef.get(ClaimIdempotencyKeyService);
      const completeService = moduleRef.get(CompleteIdempotencyRecordService);
      clock.current = new Date(CLAIMED_AT.getTime() + 7 * DAY);
      const command = claimCommand(merchantId);

      const outcome = await postgres.db
        .transaction()
        .execute((trx) => claimService.execute(trx, command));
      if (outcome.outcome !== 'CLAIMED') throw new Error(outcome.outcome);
      const result = await postgres.db.transaction().execute((trx) =>
        completeService.execute(trx, {
          record: outcome.record,
          response: RESPONSE,
        }),
      );

      expect(outcome.record.createdAt).toEqual(clock.current);
      expect(result).toMatchObject({ ok: true, completedAt: clock.current });
      await moduleRef.close();
      clock.current = CLAIMED_AT;
    });
  });
});
