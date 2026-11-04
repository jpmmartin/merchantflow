import type { Role } from './auth';
import { apiRequest } from './client';

export type MerchantStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED';

export type MerchantRole = Exclude<Role, 'PLATFORM_ADMIN'>;

/** Currencies the API accepts as a merchant's default currency. */
export const SUPPORTED_CURRENCIES = ['USD'] as const;

export interface Merchant {
  readonly id: string;
  readonly legal_name: string;
  readonly display_name: string;
  readonly business_type: string;
  readonly industry: string;
  readonly country_code: string;
  readonly default_currency: string;
  readonly status: MerchantStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MerchantPage {
  readonly data: readonly Merchant[];
  readonly next_cursor: string | null;
}

export interface NewMerchant {
  readonly legal_name: string;
  readonly display_name: string;
  readonly business_type: string;
  readonly industry: string;
  readonly country_code: string;
  readonly default_currency: string;
}

export interface MerchantUser {
  readonly id: string;
  readonly merchant_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: MerchantRole;
  readonly enabled: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A created user with its generated password, which is shown only once. */
export interface CreatedMerchantUser extends MerchantUser {
  readonly initial_password: string;
}

export interface ApiKey {
  readonly id: string;
  readonly merchant_id: string;
  readonly role: MerchantRole;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

/** An issued key with its secret, which is shown only once. */
export interface IssuedApiKey {
  readonly id: string;
  readonly merchant_id: string;
  readonly role: MerchantRole;
  readonly created_at: string;
  readonly key: string;
}

/** The status a merchant can move to from its current one, if any. */
export function nextStatusAction(
  status: MerchantStatus,
): { readonly target: MerchantStatus; readonly label: string } | undefined {
  switch (status) {
    case 'DRAFT':
      return { target: 'ACTIVE', label: 'Activate' };
    case 'ACTIVE':
      return { target: 'SUSPENDED', label: 'Suspend' };
    case 'SUSPENDED':
      return { target: 'ACTIVE', label: 'Reactivate' };
  }
}

function merchantPath(merchantId: string): string {
  return `/merchants/${encodeURIComponent(merchantId)}`;
}

export async function listMerchants(
  cursor: string | undefined,
): Promise<MerchantPage> {
  const query =
    cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return (await apiRequest('GET', `/merchants${query}`)) as MerchantPage;
}

export async function createMerchant(merchant: NewMerchant): Promise<Merchant> {
  return (await apiRequest('POST', '/merchants', {
    body: merchant,
  })) as Merchant;
}

export async function getMerchant(merchantId: string): Promise<Merchant> {
  return (await apiRequest('GET', merchantPath(merchantId))) as Merchant;
}

export async function changeMerchantStatus(
  merchantId: string,
  status: MerchantStatus,
): Promise<Merchant> {
  return (await apiRequest('POST', `${merchantPath(merchantId)}/status`, {
    body: { status },
  })) as Merchant;
}

export async function listMerchantUsers(
  merchantId: string,
): Promise<readonly MerchantUser[]> {
  const page = (await apiRequest(
    'GET',
    `${merchantPath(merchantId)}/users`,
  )) as {
    readonly data: readonly MerchantUser[];
  };
  return page.data;
}

export async function createMerchantUser(
  merchantId: string,
  user: { readonly email: string; readonly display_name: string },
): Promise<CreatedMerchantUser> {
  return (await apiRequest('POST', `${merchantPath(merchantId)}/users`, {
    body: user,
  })) as CreatedMerchantUser;
}

export async function disableMerchantUser(
  merchantId: string,
  userId: string,
): Promise<MerchantUser> {
  return (await apiRequest(
    'POST',
    `${merchantPath(merchantId)}/users/${encodeURIComponent(userId)}/disable`,
  )) as MerchantUser;
}

export async function listApiKeys(
  merchantId: string,
): Promise<readonly ApiKey[]> {
  const page = (await apiRequest(
    'GET',
    `${merchantPath(merchantId)}/api-keys`,
  )) as { readonly data: readonly ApiKey[] };
  return page.data;
}

export async function issueApiKey(
  merchantId: string,
  role: MerchantRole,
): Promise<IssuedApiKey> {
  return (await apiRequest('POST', `${merchantPath(merchantId)}/api-keys`, {
    body: { role },
  })) as IssuedApiKey;
}

export async function revokeApiKey(
  merchantId: string,
  apiKeyId: string,
): Promise<void> {
  await apiRequest(
    'POST',
    `${merchantPath(merchantId)}/api-keys/${encodeURIComponent(apiKeyId)}/revoke`,
  );
}

/**
 * A processor account as the API lists it: the secret key appears only as its
 * last four characters.
 */
export interface ProcessorAccount {
  readonly id: string;
  readonly merchant_id: string;
  readonly provider: string;
  readonly display_name: string;
  readonly provider_account_id: string;
  readonly publishable_key: string;
  readonly secret_key_hint: string;
  readonly enabled: boolean;
  readonly is_default: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface NewProcessorAccount {
  readonly provider: string;
  readonly display_name: string;
  readonly credentials: {
    readonly secret_key: string;
    readonly publishable_key: string;
  };
}

export async function listProcessorAccounts(
  merchantId: string,
): Promise<readonly ProcessorAccount[]> {
  const page = (await apiRequest(
    'GET',
    `${merchantPath(merchantId)}/processor-accounts`,
  )) as { readonly data: readonly ProcessorAccount[] };
  return page.data;
}

export async function connectProcessorAccount(
  merchantId: string,
  account: NewProcessorAccount,
): Promise<ProcessorAccount> {
  return (await apiRequest(
    'POST',
    `${merchantPath(merchantId)}/processor-accounts`,
    { body: account },
  )) as ProcessorAccount;
}

export async function disableProcessorAccount(
  merchantId: string,
  processorAccountId: string,
): Promise<ProcessorAccount> {
  return (await apiRequest(
    'POST',
    `${merchantPath(merchantId)}/processor-accounts/${encodeURIComponent(processorAccountId)}/disable`,
  )) as ProcessorAccount;
}

export async function setDefaultProcessorAccount(
  merchantId: string,
  processorAccountId: string,
): Promise<ProcessorAccount> {
  return (await apiRequest(
    'POST',
    `${merchantPath(merchantId)}/processor-accounts/${encodeURIComponent(processorAccountId)}/default`,
  )) as ProcessorAccount;
}

/**
 * The webhook configuration of a processor account as the API returns it: the
 * signing secret appears only as its last four characters.
 */
export interface ProcessorAccountWebhook {
  readonly processor_account_id: string;
  readonly merchant_id: string;
  readonly provider: string;
  /** Where the provider must deliver events; null without a public base URL. */
  readonly endpoint_url: string | null;
  readonly configured: boolean;
  readonly mode: 'AUTOMATIC' | 'MANUAL' | null;
  readonly signing_secret_hint: string | null;
  readonly webhook_endpoint_id: string | null;
  readonly configured_at: string | null;
}

/** The answer of a configuration: also what happened to a replaced endpoint. */
export interface ConfiguredProcessorAccountWebhook extends ProcessorAccountWebhook {
  readonly previous_endpoint: 'NONE' | 'DELETED' | 'NOT_DELETED';
}

/** A received webhook event, as the panel lists it. */
export interface ProcessorEvent {
  readonly id: string;
  readonly provider_event_id: string;
  readonly event_type: string;
  readonly object_type: string | null;
  readonly object_id: string | null;
  readonly received_at: string;
  readonly attempts: number;
  readonly outcome: 'PROCESSED' | 'IGNORED' | 'FAILED' | null;
  readonly detail: string | null;
  readonly processed_at: string | null;
}

function webhookPath(merchantId: string, processorAccountId: string): string {
  return `${merchantPath(merchantId)}/processor-accounts/${encodeURIComponent(processorAccountId)}/webhook`;
}

export async function getProcessorAccountWebhook(
  merchantId: string,
  processorAccountId: string,
): Promise<ProcessorAccountWebhook> {
  return (await apiRequest(
    'GET',
    webhookPath(merchantId, processorAccountId),
  )) as ProcessorAccountWebhook;
}

/** Asks the API to create the endpoint in the Stripe account. */
export async function configureWebhookAutomatically(
  merchantId: string,
  processorAccountId: string,
): Promise<ConfiguredProcessorAccountWebhook> {
  return (await apiRequest(
    'POST',
    webhookPath(merchantId, processorAccountId),
    {
      body: { mode: 'AUTOMATIC' },
    },
  )) as ConfiguredProcessorAccountWebhook;
}

/** Stores the signing secret of an endpoint created in the Stripe Dashboard. */
export async function configureWebhookManually(
  merchantId: string,
  processorAccountId: string,
  signingSecret: string,
): Promise<ConfiguredProcessorAccountWebhook> {
  return (await apiRequest(
    'POST',
    webhookPath(merchantId, processorAccountId),
    {
      body: { mode: 'MANUAL', signing_secret: signingSecret },
    },
  )) as ConfiguredProcessorAccountWebhook;
}

export async function removeProcessorAccountWebhook(
  merchantId: string,
  processorAccountId: string,
): Promise<ProcessorAccountWebhook> {
  return (await apiRequest(
    'POST',
    `${webhookPath(merchantId, processorAccountId)}/remove`,
  )) as ProcessorAccountWebhook;
}

export async function listProcessorEvents(
  merchantId: string,
  processorAccountId: string,
): Promise<readonly ProcessorEvent[]> {
  const page = (await apiRequest(
    'GET',
    `${webhookPath(merchantId, processorAccountId)}/events`,
  )) as { readonly data: readonly ProcessorEvent[] };
  return page.data;
}
