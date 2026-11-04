import {
  JOURNAL_LINE_SIDES,
  LEDGER_ACCOUNT_CLASSIFICATIONS,
} from '@merchantflow/domain';
import { z } from 'zod';
import {
  pageCursorQuerySchema,
  pageLimitQuerySchema,
} from '../../pagination/keyset-cursor.js';
import { JOURNAL_SOURCE_TYPES } from '../application/ledger.js';

export const journalEntryIdParamSchema = z.uuid();

/**
 * The query of the journal entry list. It is not strict: the merchant comes
 * only from the path, and any other parameter, such as `merchant_id`, is
 * ignored rather than refused.
 */
export const listJournalEntriesQuerySchema = z.object({
  limit: pageLimitQuerySchema,
  cursor: pageCursorQuerySchema,
  payment_intent_id: z
    .uuid()
    .optional()
    .describe(
      'Only the entries of this payment intent of the merchant. An intent of another merchant matches nothing.',
    ),
});

export type ListJournalEntriesQuery = z.infer<
  typeof listJournalEntriesQuerySchema
>;

const signedAmountMinor = z
  .string()
  .describe(
    'Amount in minor units as a base-10 integer string; a negative value starts with -.',
  );

export const ledgerAccountBalanceResponseSchema = z.object({
  account_id: z.uuid(),
  code: z.string().describe('Code of the account in the chart of accounts.'),
  name: z.string(),
  classification: z.enum(LEDGER_ACCOUNT_CLASSIFICATIONS),
  normal_side: z
    .enum(JOURNAL_LINE_SIDES)
    .describe(
      'The side that increases the account: DEBIT for ASSET and EXPENSE, CREDIT for LIABILITY and REVENUE.',
    ),
  currency: z.string(),
  debit_total_minor: z
    .string()
    .describe('Sum of the debit lines, in minor units, as an integer string.'),
  credit_total_minor: z
    .string()
    .describe('Sum of the credit lines, in minor units, as an integer string.'),
  balance_minor: signedAmountMinor.describe(
    'The normal-side total minus the other one, computed from the lines on each read. Positive on the normal side, negative on the other.',
  ),
  created_at: z.iso.datetime(),
});

export const ledgerBalancesResponseSchema = z.object({
  merchant_id: z.uuid(),
  data: z
    .array(ledgerAccountBalanceResponseSchema)
    .describe(
      'Every account of the merchant, by code and currency. Accounts are created at the first posting that needs them, so a merchant with no successful payment has none.',
    ),
});

export type LedgerBalancesResponse = z.infer<
  typeof ledgerBalancesResponseSchema
>;

export const journalLineResponseSchema = z.object({
  line_number: z.number().int().describe('Position of the line, from 1.'),
  ledger_account_id: z.uuid(),
  account_code: z.string(),
  account_name: z.string(),
  side: z.enum(JOURNAL_LINE_SIDES),
  amount_minor: z
    .string()
    .describe(
      'Amount in minor units as a base-10 integer string, always greater than zero.',
    ),
  currency: z.string(),
});

export const journalEntryResponseSchema = z.object({
  id: z.uuid(),
  merchant_id: z.uuid(),
  source_type: z
    .enum(JOURNAL_SOURCE_TYPES)
    .describe(
      'The business event the entry records. PAYMENT_SALE: the captured sale of a successful payment attempt. PAYMENT_REFUND: a successful refund of a captured payment.',
    ),
  source_id: z
    .uuid()
    .describe(
      'Identifier of the event, posted at most once: for PAYMENT_SALE, the successful payment attempt; for PAYMENT_REFUND, the refund.',
    ),
  payment_intent_id: z.uuid().nullable(),
  description: z.string(),
  posted_at: z.iso.datetime(),
  lines: z
    .array(journalLineResponseSchema)
    .describe(
      'At least two lines; the debits equal the credits in every currency.',
    ),
});

export type JournalEntryResponse = z.infer<typeof journalEntryResponseSchema>;

export const journalEntryListResponseSchema = z.object({
  merchant_id: z.uuid(),
  data: z.array(journalEntryResponseSchema).describe('Newest first.'),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass it as cursor for the next page; null on the last page.'),
});

export type JournalEntryListResponse = z.infer<
  typeof journalEntryListResponseSchema
>;
