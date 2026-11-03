import type { Database, MerchantsTable } from '@merchantflow/database';
import type { Merchant, MerchantStatus } from '@merchantflow/domain';

function toRow(merchant: Merchant): MerchantsTable {
  return {
    id: merchant.id,
    legal_name: merchant.legalName,
    display_name: merchant.displayName,
    business_type: merchant.businessType,
    industry: merchant.industry,
    country_code: merchant.countryCode,
    default_currency: merchant.defaultCurrency,
    // Assigning between the row union and the domain union in both directions
    // makes the compiler reject a status that only one of them lists.
    status: merchant.status,
    created_at: merchant.createdAt,
    updated_at: merchant.updatedAt,
  };
}

function toMerchant(row: MerchantsTable): Merchant {
  const status: MerchantStatus = row.status;
  return {
    id: row.id,
    legalName: row.legal_name,
    displayName: row.display_name,
    businessType: row.business_type,
    industry: row.industry,
    countryCode: row.country_code,
    defaultCurrency: row.default_currency,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a merchant as given. PostgreSQL rejects a row that breaks a
 * constraint, which surfaces as a thrown database error.
 */
export async function insertMerchant(
  db: Database,
  merchant: Merchant,
): Promise<void> {
  await db.insertInto('merchants').values(toRow(merchant)).execute();
}

/** Returns the merchant with the given id, or `undefined` when none exists. */
export async function findMerchantById(
  db: Database,
  id: string,
): Promise<Merchant | undefined> {
  const row = await db
    .selectFrom('merchants')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : toMerchant(row);
}

/**
 * Moves a merchant from `expected` to `next` only if it is still in `expected`,
 * and returns how many rows changed: 1 when the update applied, 0 when the
 * merchant does not exist or its status is no longer `expected`. The caller
 * decides whether the transition is allowed before calling this.
 */
export async function updateMerchantStatus(
  db: Database,
  change: {
    readonly id: string;
    readonly expected: MerchantStatus;
    readonly next: MerchantStatus;
    readonly updatedAt: Date;
  },
): Promise<number> {
  const result = await db
    .updateTable('merchants')
    .set({ status: change.next, updated_at: change.updatedAt })
    .where('id', '=', change.id)
    .where('status', '=', change.expected)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
