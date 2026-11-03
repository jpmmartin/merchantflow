import { useCallback, useEffect, useState } from 'react';
import {
  fetchCurrentPrincipal,
  logOut,
  type CurrentPrincipal,
  type LoginResult,
} from './api/auth';
import { ApiError, onUnauthorized } from './api/client';
import { ErrorAlert } from './components/ErrorAlert';
import { Layout } from './components/Layout';
import type { Screen } from './components/navigation';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import {
  clearSessionToken,
  readSessionToken,
  storeSessionToken,
} from './session-token';

/**
 * What the app shows: the sign-in form, a load of the current principal, or
 * the signed-in layout. `failed` keeps a non-401 error of that load.
 */
type AppState =
  | { readonly kind: 'signed-out'; readonly notice: string | undefined }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'signed-in'; readonly principal: CurrentPrincipal };

const SESSION_ENDED = 'Your session has ended. Sign in again.';

function initialState(): AppState {
  return readSessionToken() === undefined
    ? { kind: 'signed-out', notice: undefined }
    : { kind: 'loading' };
}

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [screen, setScreen] = useState<Screen>('home');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logOutError, setLogOutError] = useState<unknown>(undefined);

  // Any 401 from an authenticated call returns to the sign-in screen.
  useEffect(
    () =>
      onUnauthorized(() =>
        setState({ kind: 'signed-out', notice: SESSION_ENDED }),
      ),
    [],
  );

  const loadPrincipal = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const principal = await fetchCurrentPrincipal();
      setState({ kind: 'signed-in', principal });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setState({ kind: 'failed', error });
      }
    }
  }, []);

  // A token kept from earlier in this tab is checked against the API once.
  useEffect(() => {
    if (readSessionToken() !== undefined) void loadPrincipal();
  }, [loadPrincipal]);

  function handleSignedIn(result: LoginResult) {
    storeSessionToken(result.token);
    setScreen('home');
    void loadPrincipal();
  }

  async function handleLogOut() {
    setLoggingOut(true);
    setLogOutError(undefined);
    try {
      await logOut();
      clearSessionToken();
      setState({ kind: 'signed-out', notice: 'You have signed out.' });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setLogOutError(error);
      }
    } finally {
      setLoggingOut(false);
    }
  }

  switch (state.kind) {
    case 'signed-out':
      return <LoginPage onSignedIn={handleSignedIn} notice={state.notice} />;
    case 'loading':
      return (
        <main className="container py-5">
          <div className="spinner-border" role="status">
            <span className="visually-hidden">Loading…</span>
          </div>
        </main>
      );
    case 'failed':
      return (
        <main className="container py-5" style={{ maxWidth: 640 }}>
          <ErrorAlert error={state.error} />
          <button
            type="button"
            className="btn btn-primary me-2"
            onClick={() => void loadPrincipal()}
          >
            Retry
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={() => {
              clearSessionToken();
              setState({ kind: 'signed-out', notice: undefined });
            }}
          >
            Back to sign-in
          </button>
        </main>
      );
    case 'signed-in':
      return (
        <Layout
          principal={state.principal}
          screen={screen}
          onNavigate={setScreen}
          onLogOut={() => void handleLogOut()}
          loggingOut={loggingOut}
        >
          <ErrorAlert error={logOutError} />
          {screen === 'home' ? <HomePage principal={state.principal} /> : null}
        </Layout>
      );
  }
}
