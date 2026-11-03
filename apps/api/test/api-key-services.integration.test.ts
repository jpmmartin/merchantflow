import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IssueApiKeyService } from '../src/modules/auth/application/issue-api-key.service.js';
import { RevokeApiKeyService } from '../src/modules/auth/application/revoke-api-key.service.js';
import {
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
} from '../src/modules/auth/application/api-key-secret.js';
import type { ApiKeyScope } from '../src/modules/auth/application/api-key-scope.js';
import { findApiKeyByLookupId } from '../src/modules/auth/infrastructure/api-key-queries.js';
import type { Clock } from '../src/modules/clock/clock.js';
import { insertMerchant } from '../src/modules/merchants/infrastructure/merchant-queries.js';
import { MERCHANT_STATUSES, type Merchant } from '@merchantflow/domain';
import {
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';
import { startApp, type LogLine } from './support/start-app.js';

const CREATED_AT = new Date('2026-11-03T10:00:00.123Z');
const ISSUED_AT = new Date('2026-11-03T12:00:00.456Z');
const REVOKED_AT = new Date('2026-11-03T13:00:00.789Z');
const LATER = new Date('2026-11-03T14:00:00.000Z');

const ACTOR = { actorType: 'API_KEY', actorId: randomUUID() } as const;

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  merchant_id: string | null;
  correlation_id: string;
  metadata: Record<string, unknown>;
}

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

describe('API key issuance and revocation', () => {
  let postgres: MigratedPostgres;
  let app: INestApplication;
  let lines: () => LogLine[];
  let issue: IssueApiKeyService;
  let revoke: RevokeApiKeyService;
  let now = ISSUED_AT;
  const clock: Clock = { now: () => now };
  let acme: Merchant;

  async function auditEventsFor(targetId: string): Promise<AuditRow[]> {
    const result = await postgres.client.query<AuditRow>(
      'select * from audit_events where target_id = $1 order by occurred_at',
      [targetId],
    );
    return result.rows;
  }

  async function countRows(table: 'api_keys' | 'audit_events') {
    const result = await postgres.client.query<{ total: string }>(
      `select count(*) as total from ${table}`,
    );
    return Number(result.rows[0]?.total);
  }

  async function issuePlatformKey() {
    const result = await issue.execute({
      actor: ACTOR,
      scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
      correlationId: randomUUID(),
    });
    if (!result.ok) {
      throw new Error('Expected the platform key to be issued');
    }
    return result;
  }

  /** Every row of a table as JSON text, one row per line. */
  async function tableText(table: 'api_keys' | 'audit_events') {
    const result = await postgres.client.query<{ dump: string }>(
      `select coalesce(string_agg(row_to_json(t)::text, E'\\n'), '') as dump
         from ${table} t`,
    );
    return result.rows[0]?.dump ?? '';
  }

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    const started = await startApp(postgres.connectionString, { clock });
    app = started.app;
    lines = started.lines;
    issue = app.get(IssueApiKeyService);
    revoke = app.get(RevokeApiKeyService);
    acme = merchant();
    await insertMerchant(postgres.db, acme);
  });

  afterAll(async () => {
    await app.close();
    await postgres.stop();
  });

  describe('issuance', () => {
    it('issues a platform key and returns the full key once', async () => {
      now = ISSUED_AT;

      const result = await issuePlatformKey();

      const parsed = parseApiKey(result.key);
      expect(parsed).toBeDefined();
      expect(result.apiKey.lookupId).toBe(parsed?.lookupId);
      expect(result.apiKey.scope).toEqual({
        kind: 'PLATFORM',
        role: 'PLATFORM_ADMIN',
      });
      expect(result.apiKey.createdAt).toEqual(ISSUED_AT);
      expect(result.apiKey.revokedAt).toBeNull();
    });

    it('stores the lookup id and the hash, and nothing that contains the secret', async () => {
      const result = await issuePlatformKey();
      const parsed = parseApiKey(result.key);
      const secret = parsed?.secret ?? '';

      const row = await postgres.client.query<Record<string, unknown>>(
        'select * from api_keys where id = $1',
        [result.apiKey.id],
      );

      expect(row.rows).toHaveLength(1);
      const stored = row.rows[0] ?? {};
      expect(stored.lookup_id).toBe(parsed?.lookupId);
      expect(stored.secret_hash).toBe(hashApiKeySecret(secret));
      expect(stored.merchant_id).toBeNull();
      expect(stored.role).toBe('PLATFORM_ADMIN');
      expect(stored.revoked_at).toBeNull();
      expect((stored.created_at as Date).toISOString()).toBe(
        ISSUED_AT.toISOString(),
      );
      const rowText = JSON.stringify(stored);
      expect(rowText).not.toContain(secret);
      expect(rowText).not.toContain(result.key);
    });

    it('stores a hash that verifies the issued secret and no other', async () => {
      const result = await issuePlatformKey();
      const other = await issuePlatformKey();
      const stored = await findApiKeyByLookupId(
        postgres.db,
        result.apiKey.lookupId,
      );

      const secret = parseApiKey(result.key)?.secret ?? '';
      const otherSecret = parseApiKey(other.key)?.secret ?? '';
      expect(stored?.id).toBe(result.apiKey.id);
      expect(verifyApiKeySecret(secret, stored?.secretHash ?? '')).toBe(true);
      expect(verifyApiKeySecret(otherSecret, stored?.secretHash ?? '')).toBe(
        false,
      );
    });

    it.each(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'] as const)(
      'issues a merchant key with the %s role',
      async (role) => {
        const scope: ApiKeyScope = {
          kind: 'MERCHANT',
          merchantId: acme.id,
          role,
        };

        const result = await issue.execute({
          actor: ACTOR,
          scope,
          correlationId: randomUUID(),
        });

        expect(result.ok).toBe(true);
        const stored = await postgres.client.query<{
          merchant_id: string;
          role: string;
        }>('select merchant_id, role from api_keys where id = $1', [
          result.ok ? result.apiKey.id : '',
        ]);
        expect(stored.rows[0]).toEqual({ merchant_id: acme.id, role });
      },
    );

    it.each(MERCHANT_STATUSES)(
      'issues a key for a merchant in status %s',
      async (status) => {
        const target = merchant({ status });
        await insertMerchant(postgres.db, target);

        const result = await issue.execute({
          actor: ACTOR,
          scope: {
            kind: 'MERCHANT',
            merchantId: target.id,
            role: 'MERCHANT_ADMIN',
          },
          correlationId: randomUUID(),
        });

        expect(result.ok).toBe(true);
      },
    );

    it('writes exactly one audit event, without the secret', async () => {
      const correlationId = randomUUID();

      const result = await issue.execute({
        actor: ACTOR,
        scope: {
          kind: 'MERCHANT',
          merchantId: acme.id,
          role: 'MERCHANT_READ_ONLY',
        },
        correlationId,
      });
      if (!result.ok) {
        throw new Error('Expected the key to be issued');
      }

      const events = await auditEventsFor(result.apiKey.id);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        actor_type: 'API_KEY',
        actor_id: ACTOR.actorId,
        action: 'API_KEY_ISSUED',
        target_type: 'API_KEY',
        target_id: result.apiKey.id,
        merchant_id: acme.id,
        correlation_id: correlationId,
        metadata: {
          lookup_id: result.apiKey.lookupId,
          role: 'MERCHANT_READ_ONLY',
          scope: 'MERCHANT',
        },
      });
      expect(event?.occurred_at.toISOString()).toBe(ISSUED_AT.toISOString());
      const secret = parseApiKey(result.key)?.secret ?? '';
      const eventText = JSON.stringify(event);
      expect(eventText).not.toContain(secret);
      expect(eventText).not.toContain(result.key);
      expect(eventText).not.toContain(result.apiKey.secretHash);
    });

    it('audits a platform key without a merchant and accepts a system actor', async () => {
      const result = await issue.execute({
        actor: { actorType: 'SYSTEM', actorId: 'seed' },
        scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
        correlationId: randomUUID(),
      });
      if (!result.ok) {
        throw new Error('Expected the key to be issued');
      }

      const events = await auditEventsFor(result.apiKey.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_type: 'SYSTEM',
        actor_id: 'seed',
        merchant_id: null,
        metadata: {
          lookup_id: result.apiKey.lookupId,
          role: 'PLATFORM_ADMIN',
          scope: 'PLATFORM',
        },
      });
    });

    it('reports an unknown merchant and leaves no key and no audit event', async () => {
      const keysBefore = await countRows('api_keys');
      const eventsBefore = await countRows('audit_events');

      const result = await issue.execute({
        actor: ACTOR,
        scope: {
          kind: 'MERCHANT',
          merchantId: randomUUID(),
          role: 'MERCHANT_ADMIN',
        },
        correlationId: randomUUID(),
      });

      expect(result).toEqual({ ok: false, code: 'MERCHANT_NOT_FOUND' });
      expect(await countRows('api_keys')).toBe(keysBefore);
      expect(await countRows('audit_events')).toBe(eventsBefore);
    });

    it('rolls the key back when the audit insert fails', async () => {
      const keysBefore = await countRows('api_keys');
      const eventsBefore = await countRows('audit_events');

      // The correlation ID violates audit_events_correlation_id_check, so the
      // audit insert fails after the key was inserted in the same transaction.
      await expect(
        issue.execute({
          actor: ACTOR,
          scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
          correlationId: 'bad',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'audit_events_correlation_id_check',
      });

      expect(await countRows('api_keys')).toBe(keysBefore);
      expect(await countRows('audit_events')).toBe(eventsBefore);
    });

    it('issues unique keys and lookup ids under concurrent issuance', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => issuePlatformKey()),
      );

      expect(new Set(results.map((result) => result.key)).size).toBe(100);
      expect(
        new Set(results.map((result) => result.apiKey.lookupId)).size,
      ).toBe(100);
    });
  });

  describe('revocation', () => {
    async function issuedMerchantKey(
      target: Merchant = acme,
    ): Promise<{ id: string; key: string; lookupId: string }> {
      now = ISSUED_AT;
      const result = await issue.execute({
        actor: ACTOR,
        scope: {
          kind: 'MERCHANT',
          merchantId: target.id,
          role: 'MERCHANT_ADMIN',
        },
        correlationId: randomUUID(),
      });
      if (!result.ok) {
        throw new Error('Expected the key to be issued');
      }
      return {
        id: result.apiKey.id,
        key: result.key,
        lookupId: result.apiKey.lookupId,
      };
    }

    async function revokedAtOf(id: string): Promise<Date | null> {
      const result = await postgres.client.query<{ revoked_at: Date | null }>(
        'select revoked_at from api_keys where id = $1',
        [id],
      );
      return result.rows[0]?.revoked_at ?? null;
    }

    async function revocationEvents(id: string): Promise<AuditRow[]> {
      return (await auditEventsFor(id)).filter(
        (event) => event.action === 'API_KEY_REVOKED',
      );
    }

    it('sets the revocation timestamp from the clock', async () => {
      const key = await issuedMerchantKey();
      now = REVOKED_AT;

      const result = await revoke.execute({
        actor: ACTOR,
        apiKeyId: key.id,
        correlationId: randomUUID(),
      });

      expect(result).toEqual({
        ok: true,
        outcome: 'REVOKED',
        revokedAt: REVOKED_AT,
      });
      expect((await revokedAtOf(key.id))?.toISOString()).toBe(
        REVOKED_AT.toISOString(),
      );
    });

    it('writes exactly one audit event for the revocation, without the secret', async () => {
      const key = await issuedMerchantKey();
      const correlationId = randomUUID();
      now = REVOKED_AT;

      await revoke.execute({ actor: ACTOR, apiKeyId: key.id, correlationId });

      const events = await revocationEvents(key.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_type: 'API_KEY',
        actor_id: ACTOR.actorId,
        action: 'API_KEY_REVOKED',
        target_type: 'API_KEY',
        target_id: key.id,
        merchant_id: acme.id,
        correlation_id: correlationId,
        metadata: {
          lookup_id: key.lookupId,
          role: 'MERCHANT_ADMIN',
          scope: 'MERCHANT',
        },
      });
      expect(events[0]?.occurred_at.toISOString()).toBe(
        REVOKED_AT.toISOString(),
      );
      const secret = parseApiKey(key.key)?.secret ?? '';
      expect(JSON.stringify(events[0])).not.toContain(secret);
      expect(JSON.stringify(events[0])).not.toContain(key.key);
    });

    it('audits the revocation of a platform key without a merchant', async () => {
      const platform = await issuePlatformKey();
      now = REVOKED_AT;

      await revoke.execute({
        actor: ACTOR,
        apiKeyId: platform.apiKey.id,
        correlationId: randomUUID(),
      });

      const events = await revocationEvents(platform.apiKey.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.merchant_id).toBeNull();
    });

    it('reports a repeated revocation and changes nothing', async () => {
      const key = await issuedMerchantKey();
      now = REVOKED_AT;
      await revoke.execute({
        actor: ACTOR,
        apiKeyId: key.id,
        correlationId: randomUUID(),
      });
      const eventsBefore = await countRows('audit_events');
      now = LATER;

      const repeated = await revoke.execute({
        actor: ACTOR,
        apiKeyId: key.id,
        correlationId: randomUUID(),
      });

      expect(repeated).toEqual({
        ok: true,
        outcome: 'ALREADY_REVOKED',
        revokedAt: REVOKED_AT,
      });
      expect((await revokedAtOf(key.id))?.toISOString()).toBe(
        REVOKED_AT.toISOString(),
      );
      expect(await countRows('audit_events')).toBe(eventsBefore);
      expect(await revocationEvents(key.id)).toHaveLength(1);
    });

    it('reports an unknown key and writes nothing', async () => {
      const eventsBefore = await countRows('audit_events');

      const result = await revoke.execute({
        actor: ACTOR,
        apiKeyId: randomUUID(),
        correlationId: randomUUID(),
      });

      expect(result).toEqual({ ok: false, code: 'API_KEY_NOT_FOUND' });
      expect(await countRows('audit_events')).toBe(eventsBefore);
    });

    it('leaves the key active when the audit insert fails', async () => {
      const key = await issuedMerchantKey();
      const eventsBefore = await countRows('audit_events');
      now = REVOKED_AT;

      await expect(
        revoke.execute({
          actor: ACTOR,
          apiKeyId: key.id,
          correlationId: 'bad',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'audit_events_correlation_id_check',
      });

      expect(await revokedAtOf(key.id)).toBeNull();
      expect(await countRows('audit_events')).toBe(eventsBefore);
    });

    it('can be repeated after a failed attempt', async () => {
      const key = await issuedMerchantKey();
      now = REVOKED_AT;
      await expect(
        revoke.execute({
          actor: ACTOR,
          apiKeyId: key.id,
          correlationId: 'bad',
        }),
      ).rejects.toBeDefined();

      const result = await revoke.execute({
        actor: ACTOR,
        apiKeyId: key.id,
        correlationId: randomUUID(),
      });

      expect(result).toMatchObject({ ok: true, outcome: 'REVOKED' });
    });

    it('revokes the key of a suspended merchant', async () => {
      const suspended = merchant({ status: 'SUSPENDED' });
      await insertMerchant(postgres.db, suspended);
      const key = await issuedMerchantKey(suspended);
      now = REVOKED_AT;

      const result = await revoke.execute({
        actor: ACTOR,
        apiKeyId: key.id,
        correlationId: randomUUID(),
      });

      expect(result).toMatchObject({ ok: true, outcome: 'REVOKED' });
    });

    it('lets exactly one of many concurrent revocations win and audit', async () => {
      const key = await issuedMerchantKey();
      now = REVOKED_AT;

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          revoke.execute({
            actor: ACTOR,
            apiKeyId: key.id,
            correlationId: randomUUID(),
          }),
        ),
      );

      const outcomes = results.map((result) =>
        result.ok ? result.outcome : result.code,
      );
      expect(outcomes.filter((outcome) => outcome === 'REVOKED')).toHaveLength(
        1,
      );
      expect(
        outcomes.filter((outcome) => outcome === 'ALREADY_REVOKED'),
      ).toHaveLength(9);
      expect(await revocationEvents(key.id)).toHaveLength(1);
    });

    it('does not change how a revoked key is stored: the hash and scope survive', async () => {
      const key = await issuedMerchantKey();
      now = REVOKED_AT;
      await revoke.execute({
        actor: ACTOR,
        apiKeyId: key.id,
        correlationId: randomUUID(),
      });

      const stored = await findApiKeyByLookupId(postgres.db, key.lookupId);

      expect(stored?.revokedAt).toEqual(REVOKED_AT);
      expect(stored?.scope).toEqual({
        kind: 'MERCHANT',
        merchantId: acme.id,
        role: 'MERCHANT_ADMIN',
      });
      expect(
        verifyApiKeySecret(
          parseApiKey(key.key)?.secret ?? '',
          stored?.secretHash ?? '',
        ),
      ).toBe(true);
    });
  });

  describe('secrecy', () => {
    it('keeps every issued secret out of the audit rows, the key rows, and the logs', async () => {
      const issued = await Promise.all(
        Array.from({ length: 5 }, () => issuePlatformKey()),
      );
      await revoke.execute({
        actor: ACTOR,
        apiKeyId: issued[0]?.apiKey.id ?? '',
        correlationId: randomUUID(),
      });
      const failedIssue = await issue
        .execute({
          actor: ACTOR,
          scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
          correlationId: 'bad',
        })
        .catch(() => undefined);
      expect(failedIssue).toBeUndefined();

      const keyRows = await tableText('api_keys');
      const auditRows = await tableText('audit_events');
      const logs = lines()
        .map((line) => JSON.stringify(line))
        .join('\n');

      expect(logs).toContain('api key issued');
      expect(logs).toContain('api key revocation processed');
      for (const result of issued) {
        const secret = parseApiKey(result.key)?.secret ?? '';
        expect(secret).toHaveLength(64);
        // The key rows hold the hash by design, so only they may contain it.
        expect(keyRows).toContain(result.apiKey.secretHash);
        for (const haystack of [keyRows, auditRows, logs]) {
          expect(haystack).not.toContain(secret);
          expect(haystack).not.toContain(result.key);
        }
        for (const haystack of [auditRows, logs]) {
          expect(haystack).not.toContain(result.apiKey.secretHash);
        }
      }
    });
  });
});
