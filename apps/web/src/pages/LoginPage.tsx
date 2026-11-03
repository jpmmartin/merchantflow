import { useState, type FormEvent } from 'react';
import { logIn, type LoginResult } from '../api/auth';
import { ErrorAlert } from '../components/ErrorAlert';

interface LoginPageProps {
  readonly onSignedIn: (result: LoginResult) => void;
  /** Shown above the form, for example after a session ended. */
  readonly notice: string | undefined;
}

/** The sign-in form. */
export function LoginPage({ onSignedIn, notice }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await logIn(email, password);
      setPassword('');
      onSignedIn(result);
    } catch (caught) {
      setError(caught);
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <main className="container py-5" style={{ maxWidth: 420 }}>
      <h1 className="h3 mb-4">Sign in to MerchantFlow</h1>
      {notice === undefined ? null : (
        <div className="alert alert-info">{notice}</div>
      )}
      <ErrorAlert error={error} />
      <form onSubmit={handleSubmit}>
        <div className="mb-3">
          <label htmlFor="email" className="form-label">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="form-control"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="mb-3">
          <label htmlFor="password" className="form-label">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="form-control"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary w-100"
          disabled={submitting}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
