import type { Database, MerchantsTable } from '@merchantflow/database';
import type { Merchant, MerchantStatus } from '@merchantflow/domain';
import type {
  MerchantListPosition,
  MerchantProfileChanges,
} from '../application/merchant-changes.js';

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

/**
 * Returns the merchant with the given id and locks its row until the
 * transaction ends, or `undefined` when none exists. Use it inside a
 * transaction that reads a merchant in order to change it, so that two changes
 * of the same merchant cannot both be computed from the same old values.
 */
export async function findMerchantByIdForUpdate(
  db: Database,
  id: string,
): Promise<Merchant | undefined> {
  const row = await db
    .selectFrom('merchants')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : toMerchant(row);
}

/**
 * Applies the given profile fields to a merchant and returns the updated
 * merchant, or `undefined` when none exists. Fields that are not given keep
 * their value. The status is not part of the profile, so this never changes it.
 */
export async function updateMerchantProfile(
  db: Database,
  change: {
    readonly id: string;
    readonly changes: MerchantProfileChanges;
    readonly updatedAt: Date;
  },
): Promise<Merchant | undefined> {
  const { changes } = change;
  const row = await db
    .updateTable('merchants')
    .set({
      ...(changes.legalName === undefined
        ? {}
        : { legal_name: changes.legalName }),
      ...(changes.displayName === undefined
        ? {}
        : { display_name: changes.displayName }),
      ...(changes.businessType === undefined
        ? {}
        : { business_type: changes.businessType }),
      ...(changes.industry === undefined ? {} : { industry: changes.industry }),
      ...(changes.countryCode === undefined
        ? {}
        : { country_code: changes.countryCode }),
      updated_at: change.updatedAt,
    })
    .where('id', '=', change.id)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toMerchant(row);
}

/**
 * Returns up to `limit` merchants ordered by `(created_at, id)`, starting after
 * `after` when it is given. Both columns are in the index
 * `merchants_created_at_id_idx`, and `id` makes the order total, so the walk
 * over pages neither repeats nor skips a merchant that existed when it began.
 * `merchantId` restricts the result to that one merchant.
 */
export async function listMerchants(
  db: Database,
  page: {
    readonly limit: number;
    readonly after?: MerchantListPosition | undefined;
    readonly merchantId?: string | undefined;
  },
): Promise<Merchant[]> {
  let query = db.selectFrom('merchants').selectAll();
  if (page.merchantId !== undefined) {
    query = query.where('id', '=', page.merchantId);
  }
  if (page.after !== undefined) {
    // A row comparison, so that a merchant with the same creation time as the
    // last one on the previous page is ordered by id instead of being skipped.
    const { createdAt, id } = page.after;
    query = query.where((eb) =>
      eb(eb.refTuple('created_at', 'id'), '>', eb.tuple(createdAt, id)),
    );
  }
  const rows = await query
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(page.limit)
    .execute();
  return rows.map(toMerchant);
}
