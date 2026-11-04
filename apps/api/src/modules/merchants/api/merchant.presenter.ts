import type { Merchant } from '@merchantflow/domain';
import type { MerchantPage } from '../application/list-merchants.service.js';
import type { RevokedMerchantApiKey } from '../application/revoke-merchant-api-key.service.js';
import type { ApiKey } from '../../auth/application/api-key.js';
import type { ApiKeySummary } from '../../auth/application/find-api-key.service.js';
import type { UserSummary } from '../../auth/application/user.js';
import type { ProcessorAccount } from '../application/processor-account.js';
import { encodeMerchantCursor } from './merchant-cursor.js';
import type {
  ApiKeyListResponse,
  ApiKeyResponse,
  CreatedMerchantUserResponse,
  IssuedApiKeyResponse,
  MerchantUserListResponse,
  MerchantUserResponse,
  MerchantListResponse,
  MerchantResponse,
  ProcessorAccountListResponse,
  ProcessorAccountResponse,
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

/** A merchant's key as a list shows it: no secret, hash, or lookup id. */
export function toApiKeyResponse(apiKey: ApiKeySummary): ApiKeyResponse {
  if (apiKey.scope.kind !== 'MERCHANT') {
    throw new Error(`api key ${apiKey.id} is listed without a merchant`);
  }
  return {
    id: apiKey.id,
    merchant_id: apiKey.scope.merchantId,
    role: apiKey.scope.role,
    created_at: apiKey.createdAt.toISOString(),
    revoked_at:
      apiKey.revokedAt === null ? null : apiKey.revokedAt.toISOString(),
  };
}

export function toApiKeyListResponse(
  apiKeys: readonly ApiKeySummary[],
): ApiKeyListResponse {
  return { data: apiKeys.map(toApiKeyResponse) };
}

/** A merchant user, built field by field: no password hash. */
export function toMerchantUserResponse(
  user: UserSummary,
): MerchantUserResponse {
  if (user.scope.kind !== 'MERCHANT') {
    throw new Error(`user ${user.id} is shown without a merchant`);
  }
  return {
    id: user.id,
    merchant_id: user.scope.merchantId,
    email: user.email,
    display_name: user.displayName,
    role: user.scope.role,
    enabled: user.enabled,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}

/** The response of a user creation: the user and its password, once. */
export function toCreatedMerchantUserResponse(
  user: UserSummary,
  initialPassword: string,
): CreatedMerchantUserResponse {
  return {
    ...toMerchantUserResponse(user),
    initial_password: initialPassword,
  };
}

export function toMerchantUserListResponse(
  users: readonly UserSummary[],
): MerchantUserListResponse {
  return { data: users.map(toMerchantUserResponse) };
}

/**
 * A processor account, built field by field: the secret key appears only as
 * its last four characters, and the encrypted secret is never read.
 */
export function toProcessorAccountResponse(
  account: ProcessorAccount,
): ProcessorAccountResponse {
  return {
    id: account.id,
    merchant_id: account.merchantId,
    provider: account.provider,
    display_name: account.displayName,
    provider_account_id: account.providerAccountId,
    publishable_key: account.publishableKey,
    secret_key_hint: account.secretKeyHint,
    enabled: account.enabled,
    is_default: account.isDefault,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

export function toProcessorAccountListResponse(
  accounts: readonly ProcessorAccount[],
): ProcessorAccountListResponse {
  return { data: accounts.map(toProcessorAccountResponse) };
}
