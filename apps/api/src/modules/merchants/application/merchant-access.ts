import type { Principal } from '../../auth/application/principal.js';

/**
 * Whether the caller may learn that a merchant exists. A platform key may
 * address every merchant; a merchant key only its own, taken from the key and
 * never from the request. When this is false the use case answers "not found"
 * before it looks at the role, so a caller cannot tell another merchant that
 * exists from one that does not.
 */
export function canAddressMerchant(
  principal: Principal,
  merchantId: string,
): boolean {
  switch (principal.kind) {
    case 'PLATFORM':
      return true;
    case 'MERCHANT':
      return principal.merchantId === merchantId;
  }
}

/**
 * Whether the caller may manage who and what can act for a merchant it can
 * address: create and disable its users, issue and revoke its API keys, and
 * connect, disable, and choose the default of its processor accounts. The
 * platform administrator may, and so may `MERCHANT_ADMIN` for its own
 * merchant; `MERCHANT_READ_ONLY` may not. Call it only after
 * `canAddressMerchant`, so another merchant is "not found" before any role
 * check.
 */
export function canManageMerchantAccess(principal: Principal): boolean {
  switch (principal.kind) {
    case 'PLATFORM':
      return true;
    case 'MERCHANT':
      return principal.role === 'MERCHANT_ADMIN';
  }
}
