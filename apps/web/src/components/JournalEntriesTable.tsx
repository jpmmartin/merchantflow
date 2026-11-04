import { Link } from 'react-router';
import type { JournalEntry } from '../api/ledger';
import { formatAmountMinor } from '../money/amount';
import { formatTime } from './format';

/**
 * Journal entries with their debit and credit lines: one row per line, the
 * entry's time, description, and source on its first line. Amounts are the
 * API's integer strings, formatted as text. `linkPayments` links each entry
 * to its payment's page, which only merchant users have.
 */
export function JournalEntriesTable({
  entries,
  linkPayments,
}: {
  readonly entries: readonly JournalEntry[];
  readonly linkPayments: boolean;
}) {
  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle">
        <thead>
          <tr>
            <th>Posted</th>
            <th>Entry</th>
            <th>Account</th>
            <th className="text-end">Debit</th>
            <th className="text-end">Credit</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) =>
            entry.lines.map((line, index) => (
              <tr
                key={`${entry.id}-${line.line_number}`}
                className={index === 0 ? 'border-top border-secondary' : ''}
              >
                <td className="small">
                  {index === 0 ? formatTime(entry.posted_at) : null}
                </td>
                <td className="small">
                  {index === 0 ? (
                    <>
                      <div>{entry.description}</div>
                      <div className="text-body-secondary">
                        {entry.source_type} <code>{entry.source_id}</code>
                      </div>
                      {linkPayments && entry.payment_intent_id !== null ? (
                        <Link to={`/payments/${entry.payment_intent_id}`}>
                          Payment
                        </Link>
                      ) : null}
                    </>
                  ) : null}
                </td>
                <td>
                  <code>{line.account_code}</code> {line.account_name}
                </td>
                <td className="text-end font-monospace">
                  {line.side === 'DEBIT'
                    ? `${formatAmountMinor(line.amount_minor, line.currency)} ${line.currency}`
                    : ''}
                </td>
                <td className="text-end font-monospace">
                  {line.side === 'CREDIT'
                    ? `${formatAmountMinor(line.amount_minor, line.currency)} ${line.currency}`
                    : ''}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
