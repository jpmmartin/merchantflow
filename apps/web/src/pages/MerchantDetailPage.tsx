import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { CurrentPrincipal } from '../api/auth';
import {
  changeMerchantStatus,
  getMerchant,
  nextStatusAction,
  type Merchant,
} from '../api/merchants';
import { countryName } from '../components/countries';
import { ErrorAlert } from '../components/ErrorAlert';
import { formatTime } from '../components/format';
import { StatusBadge } from '../components/StatusBadge';
import { MerchantApiKeysSection } from './MerchantApiKeysSection';
import { MerchantProcessorAccountsSection } from './MerchantProcessorAccountsSection';
import { MerchantUsersSection } from './MerchantUsersSection';

interface MerchantDetailPageProps {
  readonly principal: CurrentPrincipal;
}

/**
 * One merchant: its profile, its users, and its API keys. Only the platform
 * administrator sees the status change; a merchant user sees its own merchant
 * and gets the API's 404 for any other.
 */
export function MerchantDetailPage({ principal }: MerchantDetailPageProps) {
  const { merchantId = '' } = useParams();
  const [merchant, setMerchant] = useState<Merchant | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(undefined);
  const [statusError, setStatusError] = useState<unknown>(undefined);
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    setMerchant(undefined);
    setLoadError(undefined);
    try {
      setMerchant(await getMerchant(merchantId));
    } catch (caught) {
      setLoadError(caught);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeStatus(current: Merchant) {
    const action = nextStatusAction(current.status);
    if (action === undefined) return;
    setChanging(true);
    setStatusError(undefined);
    try {
      setMerchant(await changeMerchantStatus(current.id, action.target));
    } catch (caught) {
      setStatusError(caught);
    } finally {
      setChanging(false);
    }
  }

  if (loadError !== undefined) return <ErrorAlert error={loadError} />;
  if (merchant === undefined) {
    return (
      <div className="spinner-border" role="status">
        <span className="visually-hidden">Loading…</span>
      </div>
    );
  }

  const action =
    principal.role === 'PLATFORM_ADMIN'
      ? nextStatusAction(merchant.status)
      : undefined;

  return (
    <>
      <div className="d-flex align-items-center mb-3 gap-2">
        <h1 className="h3 mb-0 me-2">{merchant.display_name}</h1>
        <StatusBadge status={merchant.status} />
        <span className="me-auto" />
        {action === undefined ? null : (
          <button
            type="button"
            className={`btn ${action.target === 'SUSPENDED' ? 'btn-outline-warning' : 'btn-outline-success'}`}
            disabled={changing}
            onClick={() => void changeStatus(merchant)}
          >
            {changing ? 'Saving…' : action.label}
          </button>
        )}
      </div>
      <ErrorAlert error={statusError} />
      <div className="card mb-4">
        <div className="card-body">
          <dl className="row mb-0">
            <dt className="col-sm-3">Merchant ID</dt>
            <dd className="col-sm-9">
              <code>{merchant.id}</code>
            </dd>
            <dt className="col-sm-3">Legal name</dt>
            <dd className="col-sm-9">{merchant.legal_name}</dd>
            <dt className="col-sm-3">Business type</dt>
            <dd className="col-sm-9">{merchant.business_type}</dd>
            <dt className="col-sm-3">Industry</dt>
            <dd className="col-sm-9">{merchant.industry}</dd>
            <dt className="col-sm-3">Country</dt>
            <dd className="col-sm-9">{countryName(merchant.country_code)}</dd>
            <dt className="col-sm-3">Default currency</dt>
            <dd className="col-sm-9">{merchant.default_currency}</dd>
            <dt className="col-sm-3">Created</dt>
            <dd className="col-sm-9">{formatTime(merchant.created_at)}</dd>
          </dl>
        </div>
      </div>
      <MerchantUsersSection merchantId={merchant.id} principal={principal} />
      <MerchantApiKeysSection merchantId={merchant.id} principal={principal} />
      <MerchantProcessorAccountsSection
        merchantId={merchant.id}
        principal={principal}
      />
    </>
  );
}
