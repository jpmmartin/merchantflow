import type { DatabaseTransaction } from '@merchantflow/database';
import { Injectable } from '@nestjs/common';
import { findMerchantPaymentProfileForShare } from '../infrastructure/merchant-queries.js';
import type { MerchantPaymentProfile } from './merchant-payment-profile.js';

/**
 * Reads the status and currency of a merchant for a payment command of another
 * module, inside that command's transaction, and keeps the merchant's row
 * share-locked until the transaction ends. A status change of the merchant
 * therefore cannot commit between this read and the command's commit: it waits
 * for the command, or the command waits for it and reads the new status. So a
 * payment command never commits after a suspension of its merchant has
 * committed. It never opens, commits, or rolls back a transaction.
 *
 * The caller passes the merchant of its authenticated principal, never one
 * taken from the request.
 */
@Injectable()
export class LockMerchantForPaymentService {
  async execute(
    trx: DatabaseTransaction,
    merchantId: string,
  ): Promise<MerchantPaymentProfile | undefined> {
    return findMerchantPaymentProfileForShare(trx, merchantId);
  }
}
