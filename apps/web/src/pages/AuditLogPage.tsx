import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import {
  AUDIT_ACTIONS,
  isAuditAction,
  listAuditEvents,
  type AuditAction,
  type AuditEvent,
} from '../api/operations';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` query parameter, or none for any other value. */
function dateParamOf(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const value = params.get(name);
  return value !== null && LOCAL_DATE.test(value) ? value : undefined;
}

/**
 * The UTC instant of the start of a day of the browser's time zone, as the
 * API expects it. `dayOffset` 1 gives the start of the next day, which makes
 * the end date of the filter inclusive. `undefined` for an impossible date.
 */
function startOfLocalDay(date: string, dayOffset: 0 | 1): string | undefined {
  // A date-time text without an offset is read in the browser's time zone.
  const start = new Date(`${date}T00:00:00`);
  if (Number.isNaN(start.getTime())) return undefined;
  if (dayOffset === 1) start.setDate(start.getDate() + 1);
  return start.toISOString();
}

interface Filters {
  readonly action: AuditAction | undefined;
  /** First day shown, `YYYY-MM-DD` in the browser's time zone. */
  readonly fromDate: string | undefined;
  /** Last day shown, inclusive. */
  readonly toDate: string | undefined;
}

function filtersOf(params: URLSearchParams): Filters {
  const action = params.get('action');
  return {
    action: action !== null && isAuditAction(action) ? action : undefined,
    fromDate: dateParamOf(params, 'from'),
    toDate: dateParamOf(params, 'to'),
  };
}

/** Where the target of an event can be opened, for the viewer. */
function targetLink(
  principal: CurrentPrincipal,
  event: AuditEvent,
): string | undefined {
  if (
    event.target_type === 'PAYMENT_INTENT' &&
    principal.merchant_id !== null
  ) {
    return `/payments/${event.target_id}`;
  }
  if (event.target_type === 'MERCHANT') return `/merchants/${event.target_id}`;
  return undefined;
}

/**
 * The audit log, newest first, one API page at a time with "Load more". The
 * platform administrator sees every event, a merchant user only its own
 * merchant's; the API decides that from the session. The filters (action and
 * a range of days in the browser's time zone, sent as UTC instants) live in
 * the URL, so a filtered list survives a reload.
 */
export function AuditLogPage({
  principal,
}: {
  readonly principal: CurrentPrincipal;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = filtersOf(searchParams);
  const { action, fromDate, toDate } = filters;
  const [draft, setDraft] = useState<Filters>(filters);
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(undefined);
  // Identifies the latest load, so a page that arrives after the filters
  // changed is dropped instead of being mixed into the new list.
  const latestLoad = useRef(0);
  const isPlatform = principal.merchant_id === null;

  const load = useCallback(
    async (cursor: string | undefined) => {
      latestLoad.current += 1;
      const thisLoad = latestLoad.current;
      setLoading(true);
      setError(undefined);
      if (cursor === undefined) {
        setEvents([]);
        setNextCursor(null);
      }
      try {
        const page = await listAuditEvents({
          cursor,
          action,
          from:
            fromDate === undefined ? undefined : startOfLocalDay(fromDate, 0),
          to: toDate === undefined ? undefined : startOfLocalDay(toDate, 1),
        });
        if (thisLoad !== latestLoad.current) return;
        setEvents((current) =>
          cursor === undefined ? page.data : [...current, ...page.data],
        );
        setNextCursor(page.next_cursor);
      } catch (caught) {
        if (thisLoad !== latestLoad.current) return;
        setError(caught);
      } finally {
        if (thisLoad === latestLoad.current) setLoading(false);
      }
    },
    [action, fromDate, toDate],
  );

  useEffect(() => {
    void load(undefined);
  }, [load]);

  useEffect(() => {
    setDraft({ action, fromDate, toDate });
  }, [action, fromDate, toDate]);

  function apply(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (draft.action !== undefined) next['action'] = draft.action;
    if (draft.fromDate !== undefined) next['from'] = draft.fromDate;
    if (draft.toDate !== undefined) next['to'] = draft.toDate;
    setSearchParams(next);
  }

  const columns = isPlatform ? 7 : 6;

  return (
    <>
      <h1 className="h3 mb-3">Audit log</h1>
      <p className="text-body-secondary">
        {isPlatform
          ? 'Every recorded action of the platform, including those that concern no merchant.'
          : 'Every recorded action that concerns your merchant. Actions of the platform appear as "Platform administrator".'}{' '}
        Dates are days of your browser&apos;s time zone.
      </p>
      <form className="row gy-2 gx-3 align-items-end mb-3" onSubmit={apply}>
        <div className="col-auto">
          <label htmlFor="audit_action" className="form-label">
            Action
          </label>
          <select
            id="audit_action"
            className="form-select"
            value={draft.action ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              setDraft({
                ...draft,
                action: isAuditAction(value) ? value : undefined,
              });
            }}
          >
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className="col-auto">
          <label htmlFor="audit_from" className="form-label">
            From (day)
          </label>
          <input
            id="audit_from"
            type="date"
            className="form-control"
            value={draft.fromDate ?? ''}
            onChange={(event) =>
              setDraft({
                ...draft,
                fromDate:
                  event.target.value === '' ? undefined : event.target.value,
              })
            }
          />
        </div>
        <div className="col-auto">
          <label htmlFor="audit_to" className="form-label">
            To (day, inclusive)
          </label>
          <input
            id="audit_to"
            type="date"
            className="form-control"
            value={draft.toDate ?? ''}
            onChange={(event) =>
              setDraft({
                ...draft,
                toDate:
                  event.target.value === '' ? undefined : event.target.value,
              })
            }
          />
        </div>
        <div className="col-auto">
          <button type="submit" className="btn btn-primary me-2">
            Apply filters
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={() => setSearchParams({})}
          >
            Clear
          </button>
        </div>
      </form>
      <ErrorAlert error={error} />
      <div className="table-responsive">
        <table className="table table-striped align-middle bg-body small">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Who</th>
              <th>Summary</th>
              <th>Target</th>
              {isPlatform ? <th>Merchant</th> : null}
              <th>Correlation ID</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const link = targetLink(principal, event);
              return (
                <tr key={event.id}>
                  <td className="text-nowrap">
                    {formatTime(event.occurred_at)}
                  </td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  <td>{event.actor.label}</td>
                  <td>{event.summary}</td>
                  <td>
                    <span className="text-body-secondary">
                      {event.target_type}
                    </span>{' '}
                    {link === undefined ? (
                      <code>{event.target_id}</code>
                    ) : (
                      <Link to={link}>
                        <code>{event.target_id}</code>
                      </Link>
                    )}
                  </td>
                  {isPlatform ? (
                    <td>
                      {event.merchant_id === null ? (
                        <span className="text-body-secondary">None</span>
                      ) : (
                        <Link to={`/merchants/${event.merchant_id}`}>
                          <code>{event.merchant_id}</code>
                        </Link>
                      )}
                    </td>
                  ) : null}
                  <td>
                    <code>{event.correlation_id}</code>
                  </td>
                </tr>
              );
            })}
            {!loading && error === undefined && events.length === 0 ? (
              <tr>
                <td
                  colSpan={columns}
                  className="text-center text-body-secondary"
                >
                  No audit events match these filters.
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
