import type { Merchant } from '@merchantflow/domain';
import type { MerchantPage } from '../application/list-merchants.service.js';
import type { RevokedMerchantApiKey } from '../application/revoke-merchant-api-key.service.js';
import type { ApiKey } from '../../auth/application/api-key.js';
import { encodeMerchantCursor } from './merchant-cursor.js';
import type {
  IssuedApiKeyResponse,
  MerchantListResponse,
  MerchantResponse,
  RevokedApiKeyResponse,
} from './merchant.schemas.js';

export function toMerchantResponse(merchant: Merchant): MerchantResponse {
  return {
    id: merchant.id,
    legal_name: merchant.legalName,
    display_name: merchant.displayName,
    business_type: merchant.businessType,
    industry: merchant.industry,
    country_code: merchant.countryCode,
    default_currency: merchant.defaultCurrency,
    status: merchant.status,
    created_at: merchant.createdAt.toISOString(),
    updated_at: merchant.updatedAt.toISOString(),
  };
}

export function toMerchantListResponse(
  page: MerchantPage,
): MerchantListResponse {
  return {
    data: page.merchants.map(toMerchantResponse),
    next_cursor:
      page.next === undefined ? null : encodeMerchantCursor(page.next),
  };
}

/**
 * The response of an issuance: the key's description and the full key. The
 * stored hash and the lookup id are not copied, so only the key itself, which
 * the caller is entitled to see once, carries them.
 */
export function toIssuedApiKeyResponse(
  apiKey: ApiKey,
  key: string,
): IssuedApiKeyResponse {
  if (apiKey.scope.kind !== 'MERCHANT') {
    throw new Error(`api key ${apiKey.id} was issued without a merchant`);
  }
  return {
    id: apiKey.id,
    merchant_id: apiKey.scope.merchantId,
    role: apiKey.scope.role,
    created_at: apiKey.createdAt.toISOString(),
    key,
  };
}

export function toRevokedApiKeyResponse(
  apiKey: RevokedMerchantApiKey,
): RevokedApiKeyResponse {
  return {
    id: apiKey.id,
    merchant_id: apiKey.merchantId,
    role: apiKey.role,
    created_at: apiKey.createdAt.toISOString(),
    revoked_at: apiKey.revokedAt.toISOString(),
  };
}
