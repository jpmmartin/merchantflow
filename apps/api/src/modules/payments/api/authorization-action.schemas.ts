import { PROCESSOR_ERROR_CATEGORIES } from '@merchantflow/processor-contracts';
import { z } from 'zod';
import {
  AUTHORIZATION_ACTION_KINDS,
  AUTHORIZATION_ACTION_STATUSES,
} from '../application/authorization-action.js';
import { paymentAttemptResponseSchema } from './payment-confirmation.schemas.js';
import { paymentIntentResponseSchema } from './payment-intent.schemas.js';

/** The `:actionId` of an action check, validated before any tenant is consulted. */
export const authorizationActionIdParamSchema = z.uuid();

export const authorizationActionResponseSchema = z.object({
  id: z.uuid(),
  payment_intent_id: z.uuid(),
  merchant_id: z.uuid(),
  payment_attempt_id: z
    .uuid()
    .describe('The authorized attempt whose hold the action acts on.'),
  processor_account_id: z
    .uuid()
    .describe('The processor account that authorized the payment.'),
  action: z
    .enum(AUTHORIZATION_ACTION_KINDS)
    .describe('CAPTURE takes the held funds; VOID releases the hold.'),
  amount_minor: z
    .string()
    .describe(
      "The amount captured or released, the intent's whole amount, in minor units as a base-10 integer string.",
    ),
  currency: z.string(),
  status: z
    .enum(AUTHORIZATION_ACTION_STATUSES)
    .describe(
      'SUCCEEDED: the hold was captured or released. FAILED: the processor refused the action and the hold is unchanged. UNKNOWN: the outcome is not known; no new capture or void of the intent is accepted until it is resolved. EXECUTING: the processor call has not finished.',
    ),
  failure_code: z
    .string()
    .nullable()
    .describe(
      "The processor's error code of a FAILED action, not_executed when a later check found the hold unchanged, or payment_already_final when the processor's payment can no longer be captured or released.",
    ),
  error_category: z
    .enum(PROCESSOR_ERROR_CATEGORIES)
    .nullable()
    .describe('Why a FAILED or UNKNOWN action did not succeed.'),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type AuthorizationActionResponse = z.infer<
  typeof authorizationActionResponseSchema
>;

export const authorizationActionResultResponseSchema = z.object({
  authorization_action: authorizationActionResponseSchema,
  payment_intent: paymentIntentResponseSchema,
  attempt: paymentAttemptResponseSchema,
});

export type AuthorizationActionResultResponse = z.infer<
  typeof authorizationActionResultResponseSchema
>;

export const authorizationActionListResponseSchema = z.object({
  payment_intent_id: z.uuid(),
  merchant_id: z.uuid(),
  data: z.array(authorizationActionResponseSchema).describe('Oldest first.'),
});

export type AuthorizationActionListResponse = z.infer<
  typeof authorizationActionListResponseSchema
>;

export const authorizationActionRefreshResponseSchema =
  authorizationActionResultResponseSchema.extend({
    change: z
      .enum([
        'CAPTURE_SUCCEEDED',
        'CAPTURE_FAILED',
        'VOID_SUCCEEDED',
        'VOID_FAILED',
      ])
      .nullable()
      .describe(
        "What the check changed, or null when the action's outcome was already known or the processor's state does not settle it yet.",
      ),
  });

export type AuthorizationActionRefreshResponse = z.infer<
  typeof authorizationActionRefreshResponseSchema
>;
