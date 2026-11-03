import type { MerchantStatus } from '../api/merchants';

const STATUS_CLASS: Readonly<Record<MerchantStatus, string>> = {
  DRAFT: 'text-bg-secondary',
  ACTIVE: 'text-bg-success',
  SUSPENDED: 'text-bg-warning',
};

/** A merchant status as a coloured badge. */
export function StatusBadge({ status }: { readonly status: MerchantStatus }) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{status}</span>;
}
