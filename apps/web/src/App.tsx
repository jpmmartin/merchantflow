import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router';
import {
  fetchCurrentPrincipal,
  logOut,
  type CurrentPrincipal,
  type LoginResult,
} from './api/auth';
import { ApiError, onUnauthorized } from './api/client';
import { ErrorAlert } from './components/ErrorAlert';
import { Layout } from './components/Layout';
import { canCreatePayments, homePathFor } from './components/navigation';
import { AccountPage } from './pages/AccountPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { CreateMerchantPage } from './pages/CreateMerchantPage';
import { CreatePaymentPage } from './pages/CreatePaymentPage';
import { LedgerPage } from './pages/LedgerPage';
import { LoginPage } from './pages/LoginPage';
import { MerchantDetailPage } from './pages/MerchantDetailPage';
import { MerchantsPage } from './pages/MerchantsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PaymentDetailPage } from './pages/PaymentDetailPage';
import { PaymentsPage } from './pages/PaymentsPage';
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

/**
 * The screens of a principal. The platform administrator gets the merchant
 * list, the create form, any merchant's page and ledger, and the whole audit
 * log; a merchant user gets its own merchant's page and ledger, its payment
 * orders (the create form only for `MERCHANT_ADMIN`), and its merchant's audit
 * log, and every other path leads to its merchant's page.
 */
function SignedInRoutes({
  principal,
}: {
  readonly principal: CurrentPrincipal;
}) {
  const home = homePathFor(principal);
  if (principal.role === 'PLATFORM_ADMIN') {
    return (
      <Routes>
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/merchants" element={<MerchantsPage />} />
        <Route path="/merchants/new" element={<CreateMerchantPage />} />
        <Route
          path="/merchants/:merchantId"
          element={<MerchantDetailPage principal={principal} />}
        />
        <Route
          path="/merchants/:merchantId/ledger"
          element={<LedgerPage principal={principal} />}
        />
        <Route path="/audit" element={<AuditLogPage principal={principal} />} />
        <Route
          path="/account"
          element={<AccountPage principal={principal} />}
        />
        <Route path="*" element={<NotFoundPage homePath={home} />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route
        path="/merchants/:merchantId"
        element={<MerchantDetailPage principal={principal} />}
      />
      <Route
        path="/merchants/:merchantId/ledger"
        element={<LedgerPage principal={principal} />}
      />
      <Route
        path="/payments"
        element={<PaymentsPage principal={principal} />}
      />
      {canCreatePayments(principal.role) ? (
        <Route
          path="/payments/new"
          element={<CreatePaymentPage principal={principal} />}
        />
      ) : null}
      <Route
        path="/payments/:paymentIntentId"
        element={<PaymentDetailPage principal={principal} />}
      />
      <Route path="/audit" element={<AuditLogPage principal={principal} />} />
      <Route path="/account" element={<AccountPage principal={principal} />} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}

export function App() {
  const navigate = useNavigate();
  const [state, setState] = useState<AppState>(initialState);
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
    void loadPrincipal();
  }

  async function handleLogOut() {
    setLoggingOut(true);
    setLogOutError(undefined);
    try {
      await logOut();
      clearSessionToken();
      setState({ kind: 'signed-out', notice: 'You have signed out.' });
      void navigate('/', { replace: true });
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
          onLogOut={() => void handleLogOut()}
          loggingOut={loggingOut}
        >
          <ErrorAlert error={logOutError} />
          <SignedInRoutes principal={state.principal} />
        </Layout>
      );
  }
}
