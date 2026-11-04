import {
  CURRENCY_EXPONENTS,
  MERCHANT_STATUSES,
  isSupportedCurrency,
} from '@merchantflow/domain';
import { PROVIDER_CODE_PATTERN } from '@merchantflow/processor-contracts';
import { z } from 'zod';
import { MERCHANT_API_KEY_ROLES } from '../../auth/application/api-key-scope.js';
import {
  EMAIL_MAX_LENGTH,
  normalizeEmail,
} from '../../auth/application/user-email.js';
import { decodeMerchantCursor } from './merchant-cursor.js';

/** Largest page a list request may ask for. */
export const MAX_PAGE_SIZE = 100;

/** Page size when the request gives none. */
export const DEFAULT_PAGE_SIZE = 20;

// The lengths and formats match the columns and check constraints of
// `merchants` (AD-44), so PostgreSQL never has to be the first to refuse a
// value. Text is trimmed and must keep a character.
const text = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const legalName = text(200);
const displayName = text(100);
const businessType = text(50);
const industry = text(100);
const countryCode = z.string().regex(/^[A-Z]{2}$/);

// The column checks only the format of the currency (AD-44). The currencies
// Money supports are the keys of its exponent table, and every other code is
// refused here, so the OpenAPI document lists exactly the supported codes.
const SUPPORTED_CURRENCIES =
  Object.keys(CURRENCY_EXPONENTS).filter(isSupportedCurrency);
const currencyCode = z.enum(SUPPORTED_CURRENCIES);

export const merchantIdParamSchema = z.uuid();
export const apiKeyIdParamSchema = z.uuid();
export const userIdParamSchema = z.uuid();

export const createMerchantSchema = z.strictObject({
  legal_name: legalName.describe('Legal name of the business.'),
  display_name: displayName.describe('Name shown to customers.'),
  business_type: businessType.describe('Legal form, for example LLC.'),
  industry: industry.describe('Industry the merchant operates in.'),
  country_code: countryCode.describe('ISO 3166-1 alpha-2 country code.'),
  default_currency: currencyCode.describe(
    `ISO 4217 currency code. Supported: ${SUPPORTED_CURRENCIES.join(', ')}. It cannot be changed afterwards.`,
  ),
});

export type CreateMerchantBody = z.infer<typeof createMerchantSchema>;

const FIXED_FIELD_NOTE =
  'Never accepted here; naming it is refused (403 for a merchant key, 400 for a platform key).';

/**
 * The fields of a profile update. `status` and `default_currency` are named
 * so that a request that tries to change them is answered by role first (a
 * merchant key gets 403) and not by an unknown-field error; no role can
 * change them through this endpoint.
 */
export const updateMerchantSchema = z
  .strictObject({
    legal_name: legalName
      .optional()
      .describe('Platform administrator only: legal identity.'),
    display_name: displayName
      .optional()
      .describe('Platform administrator or the merchant administrator.'),
    business_type: businessType
      .optional()
      .describe('Platform administrator only: legal identity.'),
    industry: industry
      .optional()
      .describe('Platform administrator or the merchant administrator.'),
    country_code: countryCode
      .optional()
      .describe('Platform administrator only: legal identity.'),
    status: z
      .string()
      .optional()
      .describe(`Use POST /merchants/{id}/status. ${FIXED_FIELD_NOTE}`),
    default_currency: z
      .string()
      .optional()
      .describe(`Fixed at creation. ${FIXED_FIELD_NOTE}`),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field is required.',
  });

export type UpdateMerchantBody = z.infer<typeof updateMerchantSchema>;

export const changeMerchantStatusSchema = z.strictObject({
  status: z
    .enum(MERCHANT_STATUSES)
    .describe(
      'Requested status. Allowed: DRAFT to ACTIVE, ACTIVE to SUSPENDED, SUSPENDED to ACTIVE.',
    ),
});

export type ChangeMerchantStatusBody = z.infer<
  typeof changeMerchantStatusSchema
>;

export const issueApiKeySchema = z.strictObject({
  role: z.enum(MERCHANT_API_KEY_ROLES).describe('Role of the new key.'),
});

export type IssueApiKeyBody = z.infer<typeof issueApiKeySchema>;

export const listMerchantsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe('Page size.'),
  cursor: z
    .string()
    .min(1)
    .max(200)
    .transform((value, context) => {
      const position = decodeMerchantCursor(value);
      if (position === undefined) {
        context.issues.push({
          code: 'custom',
          input: value,
          message: 'Invalid cursor.',
        });
        return z.NEVER;
      }
      return position;
    })
    .optional()
    .describe('The next_cursor of the previous page, unchanged.'),
});

export type ListMerchantsQuery = z.infer<typeof listMerchantsQuerySchema>;

const timestamp = z.iso.datetime();

export const merchantResponseSchema = z.object({
  id: z.uuid(),
  legal_name: z.string(),
  display_name: z.string(),
  business_type: z.string(),
  industry: z.string(),
  country_code: z.string(),
  default_currency: z.string(),
  status: z.enum(MERCHANT_STATUSES),
  created_at: timestamp,
  updated_at: timestamp,
});

export type MerchantResponse = z.infer<typeof merchantResponseSchema>;

export const merchantListResponseSchema = z.object({
  data: z.array(merchantResponseSchema),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass it as cursor for the next page; null on the last page.'),
});

export type MerchantListResponse = z.infer<typeof merchantListResponseSchema>;

export const issuedApiKeyResponseSchema = z.object({
  id: z.uuid().describe('Identifier of the key, used to revoke it.'),
  merchant_id: z.uuid(),
  role: z.enum(MERCHANT_API_KEY_ROLES),
  created_at: timestamp,
  key: z
    .string()
    .describe(
      'The API key. It is shown only in this response and cannot be retrieved again.',
    ),
});

export type IssuedApiKeyResponse = z.infer<typeof issuedApiKeyResponseSchema>;

export const revokedApiKeyResponseSchema = z.object({
  id: z.uuid(),
  merchant_id: z.uuid(),
  role: z.enum(MERCHANT_API_KEY_ROLES),
  created_at: timestamp,
  revoked_at: timestamp.describe(
    'When the key was revoked; the earlier time when it already was.',
  ),
});

export type RevokedApiKeyResponse = z.infer<typeof revokedApiKeyResponseSchema>;

export const apiKeyResponseSchema = z.object({
  id: z.uuid().describe('Identifier of the key, used to revoke it.'),
  merchant_id: z.uuid(),
  role: z.enum(MERCHANT_API_KEY_ROLES),
  created_at: timestamp,
  revoked_at: timestamp
    .nullable()
    .describe('When the key was revoked; null while it is active.'),
});

export type ApiKeyResponse = z.infer<typeof apiKeyResponseSchema>;

export const apiKeyListResponseSchema = z.object({
  data: z
    .array(apiKeyResponseSchema)
    .describe(
      'Every key of the merchant, revoked ones included, oldest first.',
    ),
});

export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

/**
 * A new merchant user. The email is checked with the rule of the users table,
 * so PostgreSQL is never the first to refuse it; case does not matter, and it
 * is stored in lower case. There is no role and no password: every merchant
 * user is `MERCHANT_ADMIN`, and the server generates the initial password.
 */
export const createMerchantUserSchema = z.strictObject({
  email: z
    .string()
    .min(1)
    .max(EMAIL_MAX_LENGTH)
    .refine((value) => normalizeEmail(value) !== undefined, {
      message: 'Invalid email address.',
    })
    .describe(
      'Email the user signs in with. Unique across the platform; stored in lower case.',
    ),
  display_name: displayName.describe('Name shown for the user.'),
});

export type CreateMerchantUserBody = z.infer<typeof createMerchantUserSchema>;

export const merchantUserResponseSchema = z.object({
  id: z.uuid().describe('Identifier of the user, used to disable it.'),
  merchant_id: z.uuid(),
  email: z.string(),
  display_name: z.string(),
  role: z.enum(MERCHANT_API_KEY_ROLES),
  enabled: z
    .boolean()
    .describe('A disabled user cannot sign in and has no active session.'),
  created_at: timestamp,
  updated_at: timestamp,
});

export type MerchantUserResponse = z.infer<typeof merchantUserResponseSchema>;

export const createdMerchantUserResponseSchema =
  merchantUserResponseSchema.extend({
    initial_password: z
      .string()
      .describe(
        'Generated password of the user. It is shown only in this response and cannot be retrieved again.',
      ),
  });

export type CreatedMerchantUserResponse = z.infer<
  typeof createdMerchantUserResponseSchema
>;

export const merchantUserListResponseSchema = z.object({
  data: z
    .array(merchantUserResponseSchema)
    .describe(
      'Every user of the merchant, disabled ones included, oldest first.',
    ),
});

export type MerchantUserListResponse = z.infer<
  typeof merchantUserListResponseSchema
>;

export const processorAccountIdParamSchema = z.uuid();

/** Longest key accepted; provider keys are far shorter. */
const PROCESSOR_KEY_MAX_LENGTH = 255;

const processorKey = z.string().min(1).max(PROCESSOR_KEY_MAX_LENGTH);

/**
 * A processor account to connect. The provider code is checked by format
 * only; whether an adapter exists for it is the use case's answer. The keys
 * are checked only for length here: their format and mode are the adapter's
 * to judge. A validation issue names the field and the issue code, never the
 * value (AD-46), so a key never comes back in an error.
 */
export const connectProcessorAccountSchema = z.strictObject({
  provider: z
    .string()
    .regex(PROVIDER_CODE_PATTERN)
    .describe('Provider code. Supported: stripe.'),
  display_name: displayName.describe('Name shown for the account.'),
  credentials: z
    .strictObject({
      secret_key: processorKey.describe(
        'Secret key of the account; for Stripe, a test key (sk_test_). It is stored only encrypted and is never returned.',
      ),
      publishable_key: processorKey.describe(
        'Publishable key of the same account; for Stripe, a test key (pk_test_). Not a secret: the card form uses it.',
      ),
    })
    .describe('Credentials of the account. Live-mode keys are refused.'),
});

export type ConnectProcessorAccountBody = z.infer<
  typeof connectProcessorAccountSchema
>;

export const processorAccountResponseSchema = z.object({
  id: z.uuid().describe('Identifier of the processor account.'),
  merchant_id: z.uuid(),
  provider: z.string(),
  display_name: z.string(),
  provider_account_id: z
    .string()
    .describe('Identifier of the account at the provider, such as acct_...'),
  publishable_key: z.string(),
  secret_key_hint: z
    .string()
    .describe(
      'Last four characters of the secret key, which is never returned.',
    ),
  enabled: z.boolean(),
  is_default: z
    .boolean()
    .describe('The account payments use; at most one per merchant.'),
  created_at: timestamp,
  updated_at: timestamp,
});

export type ProcessorAccountResponse = z.infer<
  typeof processorAccountResponseSchema
>;

export const processorAccountListResponseSchema = z.object({
  data: z
    .array(processorAccountResponseSchema)
    .describe(
      'Every processor account of the merchant, disabled ones included, oldest first.',
    ),
});

export type ProcessorAccountListResponse = z.infer<
  typeof processorAccountListResponseSchema
>;
