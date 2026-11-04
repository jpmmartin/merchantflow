import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CurrentPrincipal } from '../api/auth';
import {
  connectProcessorAccount,
  disableProcessorAccount,
  listProcessorAccounts,
  setDefaultProcessorAccount,
  type ProcessorAccount,
} from '../api/merchants';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { canManageAccess } from '../components/navigation';

interface MerchantProcessorAccountsSectionProps {
  readonly merchantId: string;
  readonly principal: CurrentPrincipal;
}

/**
 * The processor accounts of a merchant: a form that connects a Stripe test
 * account with both keys, the list with the hint of each secret key, disabling
 * with a confirmation, and choosing the default. The secret key is held only
 * in the password field and is cleared as soon as the form is submitted.
 */
export function MerchantProcessorAccountsSection({
  merchantId,
  principal,
}: MerchantProcessorAccountsSectionProps) {
  const manage = canManageAccess(principal.role);
  const [accounts, setAccounts] = useState<
    readonly ProcessorAccount[] | undefined
  >(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [displayName, setDisplayName] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [publishableKey, setPublishableKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [toDisable, setToDisable] = useState<ProcessorAccount | undefined>(
    undefined,
  );

  const load = useCallback(async () => {
    try {
      setAccounts(await listProcessorAccounts(merchantId));
    } catch (caught) {
      setError(caught);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(secret: string) {
    setConnecting(true);
    setError(undefined);
    try {
      await connectProcessorAccount(merchantId, {
        provider: 'stripe',
        display_name: displayName,
        credentials: { secret_key: secret, publishable_key: publishableKey },
      });
      setDisplayName('');
      setPublishableKey('');
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setConnecting(false);
    }
  }

  function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = secretKey;
    // The secret key leaves the form state at once, whatever the answer.
    setSecretKey('');
    void connect(secret);
  }

  async function makeDefault(account: ProcessorAccount) {
    setBusyId(account.id);
    setError(undefined);
    try {
      await setDefaultProcessorAccount(merchantId, account.id);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyId(undefined);
    }
  }

  async function disable(account: ProcessorAccount) {
    setBusyId(account.id);
    setError(undefined);
    try {
      await disableProcessorAccount(merchantId, account.id);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyId(undefined);
      setToDisable(undefined);
    }
  }

  const hasDefault = (accounts ?? []).some((account) => account.is_default);

  return (
    <section className="mb-4">
      <h2 className="h4">Processor accounts</h2>
      <ErrorAlert error={error} />
      {manage ? (
        <form
          className="row g-2 align-items-end mb-3"
          onSubmit={handleConnect}
          autoComplete="off"
        >
          <div className="col-md-3">
            <label htmlFor="processor-display-name" className="form-label">
              Display name
            </label>
            <input
              id="processor-display-name"
              className="form-control"
              required
              maxLength={100}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <div className="col-md-3">
            <label htmlFor="processor-secret-key" className="form-label">
              Stripe secret key
            </label>
            <input
              id="processor-secret-key"
              type="password"
              className="form-control"
              required
              maxLength={255}
              autoComplete="new-password"
              placeholder="sk_test_…"
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
            />
          </div>
          <div className="col-md-3">
            <label htmlFor="processor-publishable-key" className="form-label">
              Stripe publishable key
            </label>
            <input
              id="processor-publishable-key"
              className="form-control"
              required
              maxLength={255}
              placeholder="pk_test_…"
              value={publishableKey}
              onChange={(event) => setPublishableKey(event.target.value)}
            />
          </div>
          <div className="col-md-3">
            <button
              type="submit"
              className="btn btn-primary w-100"
              disabled={connecting}
            >
              {connecting ? 'Connecting…' : 'Connect Stripe account'}
            </button>
          </div>
          <div className="form-text">
            Only Stripe test-mode keys are accepted. The secret key is stored
            encrypted and never shown again; the list shows its last four
            characters. Use the publishable key of the same Stripe account.
          </div>
        </form>
      ) : null}
      {accounts !== undefined && accounts.length > 0 && !hasDefault ? (
        <div className="alert alert-warning">
          This merchant has no default processor account. Payments need one.
        </div>
      ) : null}
      <div className="table-responsive">
        <table className="table table-striped align-middle bg-body">
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Stripe account</th>
              <th>Secret key</th>
              <th>State</th>
              <th>Connected</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(accounts ?? []).map((account) => (
              <tr key={account.id}>
                <td>
                  {account.display_name}
                  {account.is_default ? (
                    <span className="badge text-bg-primary ms-2">Default</span>
                  ) : null}
                </td>
                <td>
                  <code>{account.provider}</code>
                </td>
                <td>
                  <code>{account.provider_account_id}</code>
                </td>
                <td>
                  <code>…{account.secret_key_hint}</code>
                </td>
                <td>
                  {account.enabled ? (
                    <span className="badge text-bg-success">Enabled</span>
                  ) : (
                    <span className="badge text-bg-secondary">Disabled</span>
                  )}
                </td>
                <td>{formatTime(account.created_at)}</td>
                <td className="text-end text-nowrap">
                  {manage && account.enabled && !account.is_default ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-primary me-2"
                      disabled={busyId !== undefined}
                      onClick={() => void makeDefault(account)}
                    >
                      Make default
                    </button>
                  ) : null}
                  {manage && account.enabled ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger"
                      disabled={busyId !== undefined}
                      onClick={() => setToDisable(account)}
                    >
                      Disable
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {accounts !== undefined && accounts.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-body-secondary">
                  No processor accounts yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {toDisable === undefined ? null : (
        <ConfirmDialog
          title="Disable processor account"
          confirmLabel="Disable account"
          busy={busyId !== undefined}
          onConfirm={() => void disable(toDisable)}
          onCancel={() => setToDisable(undefined)}
        >
          <p className="mb-0">
            Disable <strong>{toDisable.display_name}</strong> (
            <code>{toDisable.provider_account_id}</code>)?
            {toDisable.is_default
              ? ' It is the default account, so the merchant will have no default until you choose another.'
              : ''}{' '}
            It cannot be enabled again; you can connect it again.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
