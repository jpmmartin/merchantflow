/**
 * Keeps the session token in `sessionStorage`.
 *
 * - `sessionStorage` lives only as long as the tab: closing it signs the
 *   browser out locally, and the token is not shared with other tabs or kept
 *   on disk across browser restarts the way `localStorage` keeps it.
 * - A page reload keeps the token, so the user is not signed out by F5, which
 *   a module variable alone would do.
 * - An `HttpOnly` cookie would hide the token from scripts, but the API
 *   authenticates with `Authorization: Bearer` and allows no credentials in
 *   CORS, so a cookie would need a second authentication path and CSRF
 *   protection. The demo accepts that a script injected into this origin
 *   could read the token; the API keeps no secret in the browser other than it.
 *
 * Storage can be unavailable (privacy modes, blocked site data), so every
 * access is guarded and the app then simply needs a new sign-in.
 */
const STORAGE_KEY = 'merchantflow.sessionToken';

export function readSessionToken(): string | undefined {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeSessionToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Without storage the token is lost on reload and the user signs in again.
  }
}

export function clearSessionToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was stored if storage is unavailable.
  }
}
