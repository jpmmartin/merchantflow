import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CurrentPrincipal } from '../api/auth';
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKey,
  type MerchantRole,
} from '../api/merchants';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { canManageAccess } from '../components/navigation';
import { SecretDialog } from '../components/SecretDialog';

interface MerchantApiKeysSectionProps {
  readonly merchantId: string;
  readonly principal: CurrentPrincipal;
}

/** The roles a merchant key can have; a platform role is never offered. */
const KEY_ROLES: readonly MerchantRole[] = [
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
];

/**
 * The API keys of a merchant: the list with creation and revocation times,
 * issuing a key with a merchant role, the key shown once, and revoking with a
 * confirmation.
 */
export function MerchantApiKeysSection({
  merchantId,
  principal,
}: MerchantApiKeysSectionProps) {
  const manage = canManageAccess(principal.role);
  const [keys, setKeys] = useState<readonly ApiKey[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [role, setRole] = useState<MerchantRole>('MERCHANT_ADMIN');
  const [issuing, setIssuing] = useState(false);
  // The issued key, kept only while its dialog is open.
  const [issuedKey, setIssuedKey] = useState<string | undefined>(undefined);
  const [toRevoke, setToRevoke] = useState<ApiKey | undefined>(undefined);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await listApiKeys(merchantId));
    } catch (caught) {
      setError(caught);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issue() {
    setIssuing(true);
    setError(undefined);
    try {
      const issued = await issueApiKey(merchantId, role);
      setIssuedKey(issued.key);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setIssuing(false);
    }
  }

  function handleIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void issue();
  }

  async function revoke(apiKey: ApiKey) {
    setRevoking(true);
    setError(undefined);
    try {
      await revokeApiKey(merchantId, apiKey.id);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setRevoking(false);
      setToRevoke(undefined);
    }
  }

  return (
    <section className="mb-4">
      <h2 className="h4">API keys</h2>
      <ErrorAlert error={error} />
      {manage ? (
        <form className="row g-2 align-items-end mb-3" onSubmit={handleIssue}>
          <div className="col-md-5">
            <label htmlFor="key-role" className="form-label">
              Role of the new key
            </label>
            <select
              id="key-role"
              className="form-select"
              value={role}
              onChange={(event) => setRole(event.target.value as MerchantRole)}
            >
              {KEY_ROLES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-3">
            <button
              type="submit"
              className="btn btn-primary w-100"
              disabled={issuing}
            >
              {issuing ? 'Issuing…' : 'Issue key'}
            </button>
          </div>
        </form>
      ) : null}
      <div className="table-responsive">
        <table className="table table-striped align-middle bg-body">
          <thead>
            <tr>
              <th>Key ID</th>
              <th>Role</th>
              <th>Created</th>
              <th>Revoked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(keys ?? []).map((apiKey) => (
              <tr key={apiKey.id}>
                <td>
                  <code>{apiKey.id}</code>
                </td>
                <td>
                  <code>{apiKey.role}</code>
                </td>
                <td>{formatTime(apiKey.created_at)}</td>
                <td>{formatTime(apiKey.revoked_at)}</td>
                <td className="text-end">
                  {manage && apiKey.revoked_at === null ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger"
                      onClick={() => setToRevoke(apiKey)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {keys !== undefined && keys.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-body-secondary">
                  No API keys yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {issuedKey === undefined ? null : (
        <SecretDialog
          title="API key issued"
          label="API key"
          secret={issuedKey}
          onClose={() => setIssuedKey(undefined)}
        />
      )}
      {toRevoke === undefined ? null : (
        <ConfirmDialog
          title="Revoke API key"
          confirmLabel="Revoke key"
          busy={revoking}
          onConfirm={() => void revoke(toRevoke)}
          onCancel={() => setToRevoke(undefined)}
        >
          <p className="mb-0">
            Revoke the <code>{toRevoke.role}</code> key{' '}
            <code>{toRevoke.id}</code>? Requests made with it fail from now on.
            This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
