import type { MerchantStatus } from '@merchantflow/domain';

/**
 * What a payment command of another module needs to know about the merchant of
 * its principal: whether it may run payment commands (only `ACTIVE`) and the
 * currency its payments must use, which is fixed at creation.
 */
export interface MerchantPaymentProfile {
  readonly id: string;
  readonly status: MerchantStatus;
  readonly defaultCurrency: string;
}
