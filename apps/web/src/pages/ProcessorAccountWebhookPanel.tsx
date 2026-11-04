import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  configureWebhookAutomatically,
  configureWebhookManually,
  getProcessorAccountWebhook,
  listProcessorEvents,
  removeProcessorAccountWebhook,
  type ProcessorAccount,
  type ProcessorAccountWebhook,
  type ProcessorEvent,
} from '../api/merchants';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';

interface ProcessorAccountWebhookPanelProps {
  readonly merchantId: string;
  readonly account: ProcessorAccount;
  /** Whether the signed-in role may change the configuration. */
  readonly manage: boolean;
}

/** A change the operator asked for that needs a confirmation first. */
type PendingChange =
  | { readonly kind: 'AUTOMATIC' }
  | { readonly kind: 'MANUAL'; readonly signingSecret: string }
  | { readonly kind: 'REMOVE' };

type CopyState = 'idle' | 'copied' | 'failed';

function outcomeBadge(outcome: ProcessorEvent['outcome']) {
  switch (outcome) {
    case 'PROCESSED':
      return <span className="badge text-bg-success">PROCESSED</span>;
    case 'IGNORED':
      return <span className="badge text-bg-secondary">IGNORED</span>;
    case 'FAILED':
      return <span className="badge text-bg-danger">FAILED</span>;
    case null:
      return <span className="badge text-bg-warning">RECEIVED</span>;
  }
}

function previousEndpointNote(
  previous: 'NONE' | 'DELETED' | 'NOT_DELETED',
): string | undefined {
  switch (previous) {
    case 'NONE':
      return undefined;
    case 'DELETED':
      return 'The previous webhook endpoint was deleted in Stripe.';
    case 'NOT_DELETED':
      return 'The previous webhook endpoint could not be deleted in Stripe; delete it in the Stripe Dashboard. Its deliveries are refused.';
  }
}

/**
 * The webhook of one processor account: the endpoint URL with a copy button,
 * whether a signing secret is stored, how it was configured, its hint and
 * time, the automatic configuration with replace and remove (both confirmed),
 * the manual signing secret field, a password field cleared as soon as it is
 * submitted, and the latest events received.
 */
export function ProcessorAccountWebhookPanel({
  merchantId,
  account,
  manage,
}: ProcessorAccountWebhookPanelProps) {
  const [webhook, setWebhook] = useState<ProcessorAccountWebhook | undefined>(
    undefined,
  );
  const [events, setEvents] = useState<readonly ProcessorEvent[] | undefined>(
    undefined,
  );
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [signingSecret, setSigningSecret] = useState('');
  const [pending, setPending] = useState<PendingChange | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [copy, setCopy] = useState<CopyState>('idle');

  const load = useCallback(async () => {
    try {
      const [current, latest] = await Promise.all([
        getProcessorAccountWebhook(merchantId, account.id),
        listProcessorEvents(merchantId, account.id),
      ]);
      setWebhook(current);
      setEvents(latest);
    } catch (caught) {
      setError(caught);
    }
  }, [merchantId, account.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(change: PendingChange) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      switch (change.kind) {
        case 'AUTOMATIC': {
          const result = await configureWebhookAutomatically(
            merchantId,
            account.id,
          );
          setNotice(
            [
              'Webhook endpoint created in Stripe.',
              previousEndpointNote(result.previous_endpoint),
            ]
              .filter((part) => part !== undefined)
              .join(' '),
          );
          break;
        }
        case 'MANUAL': {
          const result = await configureWebhookManually(
            merchantId,
            account.id,
            change.signingSecret,
          );
          setNotice(
            [
              'Signing secret saved.',
              previousEndpointNote(result.previous_endpoint),
            ]
              .filter((part) => part !== undefined)
              .join(' '),
          );
          break;
        }
        case 'REMOVE':
          await removeProcessorAccountWebhook(merchantId, account.id);
          setNotice('Webhook configuration removed.');
          break;
      }
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  }

  /** A first configuration runs at once; a replacement is confirmed first. */
  function request(change: PendingChange) {
    if (change.kind !== 'REMOVE' && webhook?.configured !== true) {
      void apply(change);
    } else {
      setPending(change);
    }
  }

  function handleManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = signingSecret;
    // The signing secret leaves the form state at once, whatever the answer.
    setSigningSecret('');
    request({ kind: 'MANUAL', signingSecret: secret });
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  const fieldId = `webhook-secret-${account.id}`;
  return (
    <div className="card mb-3">
      <div className="card-header">
        Webhook of <strong>{account.display_name}</strong>{' '}
        <code>{account.provider_account_id}</code>
      </div>
      <div className="card-body">
        <ErrorAlert error={error} />
        {notice === undefined ? null : (
          <div className="alert alert-success">{notice}</div>
        )}
        {webhook === undefined ? null : (
          <>
            <label className="form-label" htmlFor={`webhook-url-${account.id}`}>
              Endpoint URL
            </label>
            {webhook.endpoint_url === null ? (
              <div className="alert alert-warning">
                The API has no public base URL (PUBLIC_API_BASE_URL), so it
                cannot show the endpoint URL or create the endpoint in Stripe.
                Start the ngrok service of the README.
              </div>
            ) : (
              <div className="input-group mb-3">
                <input
                  id={`webhook-url-${account.id}`}
                  className="form-control font-monospace"
                  readOnly
                  value={webhook.endpoint_url}
                  onFocus={(event) => event.target.select()}
                />
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={() => {
                    if (webhook.endpoint_url !== null) {
                      void copyUrl(webhook.endpoint_url);
                    }
                  }}
                >
                  {copy === 'copied'
                    ? 'Copied'
                    : copy === 'failed'
                      ? 'Copy failed'
                      : 'Copy'}
                </button>
              </div>
            )}
            <dl className="row mb-3">
              <dt className="col-sm-3">Status</dt>
              <dd className="col-sm-9">
                {webhook.configured ? (
                  <span className="badge text-bg-success">Configured</span>
                ) : (
                  <span className="badge text-bg-secondary">
                    Not configured
                  </span>
                )}
              </dd>
              <dt className="col-sm-3">Mode</dt>
              <dd className="col-sm-9">
                {webhook.mode === null ? (
                  '—'
                ) : webhook.mode === 'AUTOMATIC' ? (
                  <>
                    Automatic{' '}
                    {webhook.webhook_endpoint_id === null ? null : (
                      <code>{webhook.webhook_endpoint_id}</code>
                    )}
                  </>
                ) : (
                  'Manual (pasted signing secret)'
                )}
              </dd>
              <dt className="col-sm-3">Signing secret</dt>
              <dd className="col-sm-9">
                {webhook.signing_secret_hint === null ? (
                  '—'
                ) : (
                  <code>…{webhook.signing_secret_hint}</code>
                )}
              </dd>
              <dt className="col-sm-3">Configured</dt>
              <dd className="col-sm-9">{formatTime(webhook.configured_at)}</dd>
            </dl>
            {manage ? (
              <>
                <div className="mb-3">
                  <button
                    type="button"
                    className="btn btn-primary me-2"
                    disabled={
                      busy || !account.enabled || webhook.endpoint_url === null
                    }
                    onClick={() => request({ kind: 'AUTOMATIC' })}
                  >
                    {webhook.configured
                      ? 'Replace with a new Stripe endpoint'
                      : 'Configure webhook'}
                  </button>
                  {webhook.configured ? (
                    <button
                      type="button"
                      className="btn btn-outline-danger"
                      disabled={busy}
                      onClick={() => request({ kind: 'REMOVE' })}
                    >
                      Remove webhook
                    </button>
                  ) : null}
                  {account.enabled ? null : (
                    <div className="form-text">
                      A disabled account cannot be configured.
                    </div>
                  )}
                </div>
                <form
                  className="row g-2 align-items-end mb-3"
                  onSubmit={handleManual}
                  autoComplete="off"
                >
                  <div className="col-md-8">
                    <label htmlFor={fieldId} className="form-label">
                      Or paste the signing secret of an endpoint created in the
                      Stripe Dashboard
                    </label>
                    <input
                      id={fieldId}
                      type="password"
                      className="form-control"
                      required
                      maxLength={255}
                      autoComplete="new-password"
                      placeholder="whsec_…"
                      value={signingSecret}
                      onChange={(event) => setSigningSecret(event.target.value)}
                    />
                  </div>
                  <div className="col-md-4">
                    <button
                      type="submit"
                      className="btn btn-outline-primary w-100"
                      disabled={busy || !account.enabled}
                    >
                      Save signing secret
                    </button>
                  </div>
                  <div className="form-text">
                    The endpoint in Stripe must use the URL above and the events
                    payment_intent.succeeded, payment_intent.payment_failed,
                    refund.updated, and refund.failed. The secret is stored
                    encrypted and never shown again.
                  </div>
                </form>
              </>
            ) : null}
          </>
        )}
        <h3 className="h6">Latest events</h3>
        {events === undefined ? null : events.length === 0 ? (
          <p className="text-body-secondary mb-0">No events received yet.</p>
        ) : (
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Type</th>
                  <th>Object</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                  <th className="text-end">Runs</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatTime(event.received_at)}</td>
                    <td>
                      <code>{event.event_type}</code>
                    </td>
                    <td className="small">
                      {event.object_id === null ? (
                        '—'
                      ) : (
                        <code>{event.object_id}</code>
                      )}
                    </td>
                    <td>{outcomeBadge(event.outcome)}</td>
                    <td className="small">{event.detail ?? '—'}</td>
                    <td className="text-end">{event.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button
          type="button"
          className="btn btn-sm btn-link px-0 mt-2"
          onClick={() => void load()}
        >
          Reload
        </button>
      </div>
      {pending === undefined ? null : (
        <ConfirmDialog
          title={
            pending.kind === 'REMOVE'
              ? 'Remove webhook'
              : 'Replace webhook configuration'
          }
          confirmLabel={pending.kind === 'REMOVE' ? 'Remove' : 'Replace'}
          busy={busy}
          onConfirm={() => void apply(pending)}
          onCancel={() => setPending(undefined)}
        >
          <p className="mb-0">
            {pending.kind === 'REMOVE'
              ? 'Remove the webhook of this account? An endpoint MerchantFlow created is deleted in Stripe, and later deliveries are refused.'
              : 'Replace the current webhook configuration? An endpoint MerchantFlow created before is deleted in Stripe.'}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
