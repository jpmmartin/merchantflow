import type { Role } from '../api/auth';

/** A screen the navigation bar can open. Only screens that exist are listed. */
export type Screen = 'home';

export interface NavigationEntry {
  readonly screen: Screen;
  readonly label: string;
}

const HOME: NavigationEntry = { screen: 'home', label: 'Home' };

/**
 * The navigation entries of a role. Platform and merchant roles get separate
 * lists, so screens of one kind never appear for the other.
 */
export function navigationFor(role: Role): readonly NavigationEntry[] {
  switch (role) {
    case 'PLATFORM_ADMIN':
      return [HOME];
    case 'MERCHANT_ADMIN':
    case 'MERCHANT_READ_ONLY':
      return [HOME];
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
