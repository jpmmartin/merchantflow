import { z } from 'zod';
import { MERCHANT_API_KEY_ROLES } from '../application/api-key-scope.js';
import { PASSWORD_MAX_LENGTH } from '../application/password-hash.js';

/**
 * Sign-in request. The bounds only limit the input size: any email and any
 * non-empty password that fit are checked against the stored users, so a
 * malformed or unknown email gets the same 401 as a wrong password.
 */
export const loginSchema = z.strictObject({
  email: z
    .string()
    .min(1)
    .max(320)
    .describe('Email address of the user. Case does not matter.'),
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH)
    .describe('Password of the user.'),
});

export type LoginBody = z.infer<typeof loginSchema>;

const roleSchema = z
  .enum(['PLATFORM_ADMIN', ...MERCHANT_API_KEY_ROLES])
  .describe('Role of the caller.');

const merchantIdSchema = z
  .uuid()
  .nullable()
  .describe('Merchant of a merchant role; null for a platform role.');

const userPrincipalSchema = z.object({
  type: z.literal('USER'),
  user_id: z.uuid(),
  display_name: z.string(),
  email: z.string(),
  role: roleSchema,
  merchant_id: merchantIdSchema,
});

const apiKeyPrincipalSchema = z.object({
  type: z.literal('API_KEY'),
  api_key_id: z.uuid(),
  role: roleSchema,
  merchant_id: merchantIdSchema,
});

export const loginResponseSchema = z.object({
  token: z
    .string()
    .describe(
      'Session token, sent as Authorization: Bearer <token>. Shown only in this response; it cannot be retrieved again.',
    ),
  expires_at: z.iso
    .datetime()
    .describe('When the session stops authenticating (8 hours after sign-in).'),
  principal: userPrincipalSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const currentPrincipalResponseSchema = z.discriminatedUnion('type', [
  userPrincipalSchema,
  apiKeyPrincipalSchema,
]);

export type CurrentPrincipalResponse = z.infer<
  typeof currentPrincipalResponseSchema
>;
