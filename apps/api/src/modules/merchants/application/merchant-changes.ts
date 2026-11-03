/** Profile fields of a merchant that a request can change. Absent means keep. */
export interface MerchantProfileChanges {
  readonly legalName?: string;
  readonly displayName?: string;
  readonly businessType?: string;
  readonly industry?: string;
  readonly countryCode?: string;
}

/** The fields of `MerchantProfileChanges`, for iterating over them. */
export const MERCHANT_PROFILE_FIELDS = [
  'legalName',
  'displayName',
  'businessType',
  'industry',
  'countryCode',
] as const satisfies readonly (keyof MerchantProfileChanges)[];

export type MerchantProfileField = (typeof MERCHANT_PROFILE_FIELDS)[number];

/**
 * Where a page of the merchant list ends. The next page starts after this
 * merchant in the order of creation time and then id.
 */
export interface MerchantListPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/** The column of each profile field, as audit metadata and the API name it. */
export const MERCHANT_PROFILE_FIELD_NAMES: Readonly<
  Record<MerchantProfileField, string>
> = {
  legalName: 'legal_name',
  displayName: 'display_name',
  businessType: 'business_type',
  industry: 'industry',
  countryCode: 'country_code',
};

/**
 * Fields a request may name but nobody can change through a profile update:
 * the status has its own command, and the currency is fixed when the merchant
 * is created.
 */
export const MERCHANT_FIXED_FIELDS = ['status', 'default_currency'] as const;

export type MerchantFixedField = (typeof MERCHANT_FIXED_FIELDS)[number];
