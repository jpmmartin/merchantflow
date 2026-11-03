/** Roles that belong to a merchant. */
export const MERCHANT_API_KEY_ROLES = [
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
] as const;

export type MerchantApiKeyRole = (typeof MERCHANT_API_KEY_ROLES)[number];

/** The only role a platform key can carry. */
export const PLATFORM_API_KEY_ROLE = 'PLATFORM_ADMIN';

export type PlatformApiKeyRole = typeof PLATFORM_API_KEY_ROLE;

export type ApiKeyRole = PlatformApiKeyRole | MerchantApiKeyRole;

/**
 * What a key may act on. A merchant key belongs to one merchant and has a
 * merchant role; a platform key belongs to no merchant. The
 * `api_keys_role_scope_check` constraint enforces the same pairing.
 */
export type ApiKeyScope =
  | { readonly kind: 'PLATFORM'; readonly role: PlatformApiKeyRole }
  | {
      readonly kind: 'MERCHANT';
      readonly merchantId: string;
      readonly role: MerchantApiKeyRole;
    };
