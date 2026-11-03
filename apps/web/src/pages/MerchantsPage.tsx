import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  changeMerchantStatus,
  listMerchants,
  nextStatusAction,
  type Merchant,
} from '../api/merchants';
import { countryName } from '../components/countries';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { StatusBadge } from '../components/StatusBadge';

/**
 * The platform administrator's list of merchants, one API page at a time:
 * "Load more" asks for the page after `next_cursor`. Each row has the status
 * change its current status allows.
 */
export function MerchantsPage() {
  const [merchants, setMerchants] = useState<readonly Merchant[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  const load = useCallback(async (cursor: string | undefined) => {
    setLoading(true);
    setError(undefined);
    try {
      const page = await listMerchants(cursor);
      setMerchants((current) =>
        cursor === undefined ? page.data : [...current, ...page.data],
      );
      setNextCursor(page.next_cursor);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(undefined);
  }, [load]);

  async function changeStatus(merchant: Merchant) {
    const action = nextStatusAction(merchant.status);
    if (action === undefined) return;
    setChanging(merchant.id);
    setError(undefined);
    try {
      const updated = await changeMerchantStatus(merchant.id, action.target);
      setMerchants((current) =>
        current.map((row) => (row.id === updated.id ? updated : row)),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setChanging(undefined);
    }
  }

  return (
    <>
      <div className="d-flex align-items-center mb-3">
        <h1 className="h3 me-auto mb-0">Merchants</h1>
        <Link to="/merchants/new" className="btn btn-primary">
          Create merchant
        </Link>
      </div>
      <ErrorAlert error={error} />
      <div className="table-responsive">
        <table className="table table-striped align-middle bg-body">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Legal name</th>
              <th>Country</th>
              <th>Currency</th>
              <th>Status</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {merchants.map((merchant) => {
              const action = nextStatusAction(merchant.status);
              return (
                <tr key={merchant.id}>
                  <td>
                    <Link to={`/merchants/${merchant.id}`}>
                      {merchant.display_name}
                    </Link>
                  </td>
                  <td>{merchant.legal_name}</td>
                  <td>{countryName(merchant.country_code)}</td>
                  <td>{merchant.default_currency}</td>
                  <td>
                    <StatusBadge status={merchant.status} />
                  </td>
                  <td>{formatTime(merchant.created_at)}</td>
                  <td className="text-end">
                    {action === undefined ? null : (
                      <button
                        type="button"
                        className={`btn btn-sm ${action.target === 'SUSPENDED' ? 'btn-outline-warning' : 'btn-outline-success'}`}
                        disabled={changing !== undefined}
                        onClick={() => void changeStatus(merchant)}
                      >
                        {changing === merchant.id ? 'Saving…' : action.label}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && merchants.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-body-secondary">
                  No merchants yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {loading ? (
        <div className="spinner-border spinner-border-sm" role="status">
          <span className="visually-hidden">Loading…</span>
        </div>
      ) : null}
      {!loading && nextCursor !== null ? (
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={() => void load(nextCursor)}
        >
          Load more
        </button>
      ) : null}
    </>
  );
}
