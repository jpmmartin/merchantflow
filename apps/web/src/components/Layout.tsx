import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import { navigationFor, roleLabel } from './navigation';
import { NotificationBell } from './NotificationBell';
import { NotificationToasts } from './NotificationToasts';

interface LayoutProps {
  readonly principal: CurrentPrincipal;
  readonly onLogOut: () => void;
  readonly loggingOut: boolean;
  readonly children: ReactNode;
}

/**
 * The signed-in frame: a navigation bar whose entries depend on the role,
 * with the notification bell and toasts for merchant users (inside
 * `NotificationsProvider`; nothing shows for others).
 */
export function Layout({
  principal,
  onLogOut,
  loggingOut,
  children,
}: LayoutProps) {
  const name = principal.type === 'USER' ? principal.display_name : 'API key';
  return (
    <>
      <nav className="navbar navbar-expand bg-dark" data-bs-theme="dark">
        <div className="container">
          <span className="navbar-brand">MerchantFlow</span>
          <ul className="navbar-nav me-auto">
            {navigationFor(principal).map((entry) => (
              <li className="nav-item" key={entry.to}>
                <NavLink
                  to={entry.to}
                  end={entry.matchNested !== true}
                  className={({ isActive }) =>
                    `nav-link${isActive ? ' active' : ''}`
                  }
                >
                  {entry.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <NotificationBell />
          <span className="navbar-text me-3">
            {name} · {roleLabel(principal.role)}
          </span>
          <button
            type="button"
            className="btn btn-outline-light btn-sm"
            onClick={onLogOut}
            disabled={loggingOut}
          >
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </nav>
      <NotificationToasts />
      <main className="container py-4">{children}</main>
    </>
  );
}
