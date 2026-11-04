import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import {
  getLedgerBalances,
  listJournalEntries,
  type JournalEntry,
  type LedgerAccountBalance,
} from '../api/ledger';
import { ErrorAlert } from '../components/ErrorAlert';
import { JournalEntriesTable } from '../components/JournalEntriesTable';
import { formatAmountMinor, formatSignedAmountMinor } from '../money/amount';

/**
 * A merchant's ledger: its accounts with their balances, and its journal
 * entries newest first, one API page at a time. The platform administrator
 * opens it from any merchant's page; a merchant user only for its own
 * merchant, and gets the API's `NOT_FOUND` for any other.
 */
export function LedgerPage({
  principal,
}: {
  readonly principal: CurrentPrincipal;
}) {
  const { merchantId = '' } = useParams();
  const [balances, setBalances] = useState<
    readonly LedgerAccountBalance[] | undefined
  >(undefined);
  const [balancesError, setBalancesError] = useState<unknown>(undefined);
  const [entries, setEntries] = useState<readonly JournalEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [entriesError, setEntriesError] = useState<unknown>(undefined);
  // Identifies the latest load, so a page of an earlier merchant is dropped.
  const latestLoad = useRef(0);

  const loadEntries = useCallback(
    async (cursor: string | undefined) => {
      latestLoad.current += 1;
      const thisLoad = latestLoad.current;
      setLoadingEntries(true);
      setEntriesError(undefined);
      if (cursor === undefined) {
        setEntries([]);
        setNextCursor(null);
      }
      try {
        const page = await listJournalEntries(merchantId, { cursor });
        if (thisLoad !== latestLoad.current) return;
        setEntries((current) =>
          cursor === undefined ? page.data : [...current, ...page.data],
        );
        setNextCursor(page.next_cursor);
      } catch (caught) {
        if (thisLoad === latestLoad.current) setEntriesError(caught);
      } finally {
        if (thisLoad === latestLoad.current) setLoadingEntries(false);
      }
    },
    [merchantId],
  );

  useEffect(() => {
    setBalances(undefined);
    setBalancesError(undefined);
    getLedgerBalances(merchantId).then(
      (result) => setBalances(result.data),
      (caught: unknown) => setBalancesError(caught),
    );
    void loadEntries(undefined);
  }, [merchantId, loadEntries]);

  return (
    <>
      <p>
        <Link to={`/merchants/${merchantId}`}>← Merchant</Link>
      </p>
      <h1 className="h3 mb-3">Ledger</h1>
      <p className="text-body-secondary small">
        The merchant&apos;s own payments ledger: captured card sales are owed to
        the merchant by its processor account (Processor receivable) and
        recorded as Sales, gross of processor fees, which are not recorded yet.
        A successful refund is recorded in Refunds, which reduces Sales, and
        lowers the Processor receivable. Balances are computed from the journal
        lines on every read.
      </p>
      <section className="mb-4">
        <h2 className="h5">Accounts and balances</h2>
        <ErrorAlert error={balancesError} />
        {balances === undefined && balancesError === undefined ? (
          <div className="spinner-border spinner-border-sm" role="status">
            <span className="visually-hidden">Loading…</span>
          </div>
        ) : null}
        {balances === undefined ? null : balances.length === 0 ? (
          <p className="text-body-secondary">
            No ledger accounts yet. They are created by the first successful
            payment.
          </p>
        ) : (
          <div className="table-responsive">
            <table className="table table-sm align-middle">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Classification</th>
                  <th>Normal side</th>
                  <th>Currency</th>
                  <th className="text-end">Debits</th>
                  <th className="text-end">Credits</th>
                  <th className="text-end">Balance</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((row) => (
                  <tr key={row.account_id}>
                    <td>
                      <code>{row.code}</code>
                    </td>
                    <td>{row.name}</td>
                    <td>{row.classification}</td>
                    <td>{row.normal_side}</td>
                    <td>{row.currency}</td>
                    <td className="text-end font-monospace">
                      {formatAmountMinor(row.debit_total_minor, row.currency)}
                    </td>
                    <td className="text-end font-monospace">
                      {formatAmountMinor(row.credit_total_minor, row.currency)}
                    </td>
                    <td className="text-end font-monospace fw-semibold">
                      {formatSignedAmountMinor(row.balance_minor, row.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="mb-4">
        <h2 className="h5">Journal entries</h2>
        <ErrorAlert error={entriesError} />
        {entries.length === 0 &&
        !loadingEntries &&
        entriesError === undefined ? (
          <p className="text-body-secondary">No journal entries yet.</p>
        ) : null}
        {entries.length === 0 ? null : (
          <JournalEntriesTable
            entries={entries}
            linkPayments={principal.role !== 'PLATFORM_ADMIN'}
          />
        )}
        {loadingEntries ? (
          <div className="spinner-border spinner-border-sm" role="status">
            <span className="visually-hidden">Loading…</span>
          </div>
        ) : null}
        {nextCursor !== null && !loadingEntries ? (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={() => void loadEntries(nextCursor)}
          >
            Load more
          </button>
        ) : null}
      </section>
    </>
  );
}
