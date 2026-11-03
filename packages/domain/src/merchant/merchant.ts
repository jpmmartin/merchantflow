/** Operational statuses of a merchant. Onboarding review is modeled separately. */
export const MERCHANT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED'] as const;

export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

/** A merchant account. Timestamps are supplied by the caller, never read here. */
export interface Merchant {
  readonly id: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly businessType: string;
  readonly industry: string;
  /** ISO 3166-1 alpha-2 country code. */
  readonly countryCode: string;
  /** ISO 4217 currency code. */
  readonly defaultCurrency: string;
  readonly status: MerchantStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
