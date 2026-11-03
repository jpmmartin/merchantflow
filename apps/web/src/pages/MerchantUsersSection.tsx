import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CurrentPrincipal } from '../api/auth';
import {
  createMerchantUser,
  disableMerchantUser,
  listMerchantUsers,
  type MerchantUser,
} from '../api/merchants';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { canManageAccess } from '../components/navigation';
import { SecretDialog } from '../components/SecretDialog';

interface MerchantUsersSectionProps {
  readonly merchantId: string;
  readonly principal: CurrentPrincipal;
}

/**
 * The users of a merchant: the list, a form that creates a user (always a
 * merchant administrator), the generated password shown once, and disabling
 * with a confirmation. A signed-in user cannot disable itself.
 */
export function MerchantUsersSection({
  merchantId,
  principal,
}: MerchantUsersSectionProps) {
  const manage = canManageAccess(principal.role);
  const selfId = principal.type === 'USER' ? principal.user_id : undefined;
  const [users, setUsers] = useState<readonly MerchantUser[] | undefined>(
    undefined,
  );
  const [error, setError] = useState<unknown>(undefined);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [creating, setCreating] = useState(false);
  // The generated password, kept only while its dialog is open.
  const [created, setCreated] = useState<
    { readonly email: string; readonly password: string } | undefined
  >(undefined);
  const [toDisable, setToDisable] = useState<MerchantUser | undefined>(
    undefined,
  );
  const [disabling, setDisabling] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await listMerchantUsers(merchantId));
    } catch (caught) {
      setError(caught);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    setError(undefined);
    try {
      const user = await createMerchantUser(merchantId, {
        email,
        display_name: displayName,
      });
      setCreated({ email: user.email, password: user.initial_password });
      setEmail('');
      setDisplayName('');
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setCreating(false);
    }
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void create();
  }

  async function disable(user: MerchantUser) {
    setDisabling(true);
    setError(undefined);
    try {
      await disableMerchantUser(merchantId, user.id);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setDisabling(false);
      setToDisable(undefined);
    }
  }

  return (
    <section className="mb-4">
      <h2 className="h4">Users</h2>
      <ErrorAlert error={error} />
      {manage ? (
        <form className="row g-2 align-items-end mb-3" onSubmit={handleCreate}>
          <div className="col-md-5">
            <label htmlFor="user-email" className="form-label">
              Email
            </label>
            <input
              id="user-email"
              type="email"
              className="form-control"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="col-md-4">
            <label htmlFor="user-display-name" className="form-label">
              Display name
            </label>
            <input
              id="user-display-name"
              className="form-control"
              required
              maxLength={100}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <div className="col-md-3">
            <button
              type="submit"
              className="btn btn-primary w-100"
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Create user'}
            </button>
          </div>
          <div className="form-text">
            New users are merchant administrators. The password is generated and
            shown once.
          </div>
        </form>
      ) : null}
      <div className="table-responsive">
        <table className="table table-striped align-middle bg-body">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>State</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((user) => (
              <tr key={user.id}>
                <td>
                  {user.display_name}
                  {user.id === selfId ? (
                    <span className="text-body-secondary"> (you)</span>
                  ) : null}
                </td>
                <td>{user.email}</td>
                <td>
                  <code>{user.role}</code>
                </td>
                <td>
                  {user.enabled ? (
                    <span className="badge text-bg-success">Enabled</span>
                  ) : (
                    <span className="badge text-bg-secondary">Disabled</span>
                  )}
                </td>
                <td>{formatTime(user.created_at)}</td>
                <td className="text-end">
                  {manage && user.enabled && user.id !== selfId ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger"
                      onClick={() => setToDisable(user)}
                    >
                      Disable
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {users !== undefined && users.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-body-secondary">
                  No users yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {created === undefined ? null : (
        <SecretDialog
          title={`User ${created.email} created`}
          label="initial password"
          secret={created.password}
          onClose={() => setCreated(undefined)}
        />
      )}
      {toDisable === undefined ? null : (
        <ConfirmDialog
          title="Disable user"
          confirmLabel="Disable user"
          busy={disabling}
          onConfirm={() => void disable(toDisable)}
          onCancel={() => setToDisable(undefined)}
        >
          <p className="mb-0">
            Disable <strong>{toDisable.email}</strong>? The user is signed out
            everywhere at once and can no longer sign in. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
