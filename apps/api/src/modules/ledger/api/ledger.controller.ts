import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../../auth/api/current-principal.decorator.js';
import { Roles } from '../../auth/api/route-access.js';
import type { Principal } from '../../auth/application/principal.js';
import { ApiErrorResponses } from '../../errors/api/api-error-responses.decorator.js';
import { ApiException } from '../../errors/api/api-exception.js';
import {
  NOT_FOUND_DOC,
  UNAUTHENTICATED_DOC,
  VALIDATION_FAILED_DOC,
} from '../../merchants/api/merchant-error-docs.js';
import { merchantIdParamSchema } from '../../merchants/api/merchant.schemas.js';
import { GetJournalEntryService } from '../application/get-journal-entry.service.js';
import { ListJournalEntriesService } from '../application/list-journal-entries.service.js';
import { ListLedgerBalancesService } from '../application/list-ledger-balances.service.js';
import {
  toJournalEntryListResponse,
  toJournalEntryResponse,
  toLedgerBalancesResponse,
} from './ledger.presenter.js';
import {
  journalEntryIdParamSchema,
  journalEntryListResponseSchema,
  journalEntryResponseSchema,
  ledgerBalancesResponseSchema,
  listJournalEntriesQuerySchema,
  type JournalEntryListResponse,
  type JournalEntryResponse,
  type LedgerBalancesResponse,
  type ListJournalEntriesQuery,
} from './ledger.schemas.js';

/**
 * Every role passes the guard, so that another merchant is 404 from the use
 * case and not 403 from the guard (AD-52): the platform administrator reads
 * any merchant's ledger, a merchant role only its own.
 */
const ANY_ROLE = [
  'PLATFORM_ADMIN',
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
] as const;

const INTERNAL_ERROR_DOC = {
  status: 500,
  description:
    'INTERNAL_ERROR: unexpected failure, including a stored amount or currency that this version cannot represent.',
} as const;

/** Both "not found" outcomes are one answer, so existence is never revealed. */
function notFound(): ApiException {
  return new ApiException('NOT_FOUND');
}

@ApiTags('Ledger')
@ApiBearerAuth('bearer')
@Controller('merchants/:id/ledger')
export class LedgerController {
  constructor(
    private readonly listBalances: ListLedgerBalancesService,
    private readonly listEntries: ListJournalEntriesService,
    private readonly getEntry: GetJournalEntryService,
  ) {}

  @Get('balances')
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: "List a merchant's ledger accounts and balances",
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY for their own, whatever its status. Lists every ledger account of the merchant (one per code and currency) with the totals of its debit and credit lines and its balance, computed from the lines on each read and never stored. Another merchant is 404. A read writes no audit event.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The accounts and their balances; amounts are integer strings.',
    standardSchema: ledgerBalancesResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    NOT_FOUND_DOC,
    INTERNAL_ERROR_DOC,
  )
  async balances(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
  ): Promise<LedgerBalancesResponse> {
    const result = await this.listBalances.execute({ principal, merchantId });
    if (!result.ok) throw notFound();
    return toLedgerBalancesResponse(result.merchantId, result.balances);
  }

  @Get('journal-entries')
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: "List a merchant's journal entries",
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY for their own. Lists the posted entries with their lines, newest first by posting time and then id, continued with next_cursor. payment_intent_id keeps only the entries of that intent. Parameters other than limit, cursor, and payment_intent_id are ignored. Another merchant is 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'One page of entries; amounts are integer strings.',
    standardSchema: journalEntryListResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED: the merchant id or payment_intent_id is not a UUID, limit is not an integer from 1 to 100, or cursor is not a next_cursor of this API.',
    },
    UNAUTHENTICATED_DOC,
    NOT_FOUND_DOC,
    INTERNAL_ERROR_DOC,
  )
  async entries(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Query({ schema: listJournalEntriesQuerySchema })
    query: ListJournalEntriesQuery,
  ): Promise<JournalEntryListResponse> {
    const result = await this.listEntries.execute({
      principal,
      merchantId,
      limit: query.limit,
      after: query.cursor,
      paymentIntentId: query.payment_intent_id,
    });
    if (!result.ok) throw notFound();
    return toJournalEntryListResponse(result.page);
  }

  @Get('journal-entries/:journalEntryId')
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'Read a journal entry',
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY for their own. One posted entry with its debit and credit lines. An entry of another merchant and an unknown id are 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'The entry; amounts are integer strings.',
    standardSchema: journalEntryResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    NOT_FOUND_DOC,
    INTERNAL_ERROR_DOC,
  )
  async entry(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Param('journalEntryId', { schema: journalEntryIdParamSchema })
    journalEntryId: string,
  ): Promise<JournalEntryResponse> {
    const result = await this.getEntry.execute({
      principal,
      merchantId,
      journalEntryId,
    });
    if (!result.ok) throw notFound();
    return toJournalEntryResponse(result.entry);
  }
}
