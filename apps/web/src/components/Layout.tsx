import type { ReactNode } from 'react';
import type { CurrentPrincipal } from '../api/auth';
import { navigationFor, roleLabel, type Screen } from './navigation';

interface LayoutProps {
  readonly principal: CurrentPrincipal;
  readonly screen: Screen;
  readonly onNavigate: (screen: Screen) => void;
  readonly onLogOut: () => void;
  readonly loggingOut: boolean;
  readonly children: ReactNode;
}

/** The signed-in frame: a navigation bar whose entries depend on the role. */
export function Layout({
  principal,
  screen,
  onNavigate,
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
            {navigationFor(principal.role).map((entry) => (
              <li className="nav-item" key={entry.screen}>
                <button
                  type="button"
                  className={`nav-link btn btn-link${entry.screen === screen ? ' active' : ''}`}
                  aria-current={entry.screen === screen ? 'page' : undefined}
                  onClick={() => onNavigate(entry.screen)}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
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
      <main className="container py-4">{children}</main>
    </>
  );
}
