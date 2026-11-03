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
