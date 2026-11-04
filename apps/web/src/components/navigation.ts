import type { CurrentPrincipal, Role } from '../api/auth';

export interface NavigationEntry {
  /** Path the entry opens. */
  readonly to: string;
  readonly label: string;
  /** The entry is also active on the pages below its path. */
  readonly matchNested?: true;
}

/** The page a principal lands on after sign-in. */
export function homePathFor(principal: CurrentPrincipal): string {
  return principal.merchant_id === null
    ? '/merchants'
    : `/merchants/${principal.merchant_id}`;
}

/**
 * The navigation entries of a principal. Platform and merchant roles get
 * separate lists, so screens of one kind never appear for the other, and only
 * screens that exist are listed.
 */
export function navigationFor(
  principal: CurrentPrincipal,
): readonly NavigationEntry[] {
  const account: NavigationEntry = { to: '/account', label: 'Account' };
  switch (principal.role) {
    case 'PLATFORM_ADMIN':
      return [
        { to: '/merchants', label: 'Merchants', matchNested: true },
        account,
      ];
    case 'MERCHANT_ADMIN':
    case 'MERCHANT_READ_ONLY':
      // Payments are for merchant roles only: the payment endpoints refuse
      // the platform administrator.
      return [
        { to: homePathFor(principal), label: 'My merchant' },
        { to: '/payments', label: 'Payments', matchNested: true },
        { to: `${homePathFor(principal)}/ledger`, label: 'Ledger' },
        account,
      ];
  }
}

/** A readable name of a role. */
export function roleLabel(role: Role): string {
  switch (role) {
    case 'PLATFORM_ADMIN':
      return 'Platform administrator';
    case 'MERCHANT_ADMIN':
      return 'Merchant administrator';
    case 'MERCHANT_READ_ONLY':
      return 'Merchant read-only';
  }
}

/** Whether a role may create and disable users and issue and revoke keys. */
export function canManageAccess(role: Role): boolean {
  return role === 'PLATFORM_ADMIN' || role === 'MERCHANT_ADMIN';
}

/** Whether a role may create payment orders. */
export function canCreatePayments(role: Role): boolean {
  return role === 'MERCHANT_ADMIN';
}
