import type { Database } from '@merchantflow/database';
import type { ProcessorCredentials } from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  findProcessorAccountWithSecret,
  type ProcessorAccountWithSecret,
} from '../infrastructure/processor-account-queries.js';
import {
  SECRET_CIPHER,
  type SecretCipher,
} from '../infrastructure/secret-cipher.js';

/**
 * A processor account ready for one provider call: its identity and its keys,
 * the secret key decrypted. The caller keeps it only for that call and never
 * logs, stores, or returns the credentials.
 */
export interface PaymentProcessorAccount {
  readonly id: string;
  readonly merchantId: string;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly credentials: ProcessorCredentials;
}

export type PaymentProcessorAccountResult =
  | { readonly ok: true; readonly account: PaymentProcessorAccount }
  | {
      readonly ok: false;
      readonly code:
        /** The merchant has no account with this id; another merchant's account is the same. */
        | 'NOT_FOUND'
        /** The account is disabled, so a new payment cannot use it. */
        | 'DISABLED'
        /** The account is not the merchant's default, so a new payment cannot use it. */
        | 'NOT_DEFAULT'
        /** No master key is configured, so no secret can be decrypted. */
        | 'CREDENTIALS_KEY_NOT_CONFIGURED';
    };

/**
 * Gives the payments module the processor account of a payment, with its
 * secret key decrypted for the one provider call that needs it. The merchants
 * module owns `processor_accounts` and the cipher, so this service is the only
 * way another module reaches an account's keys. A secret that fails to decrypt
 * throws, with a message that carries nothing of it.
 *
 * Both methods read only the caller's merchant: the caller passes the merchant
 * of its authenticated principal, and another merchant's account is
 * `NOT_FOUND`, exactly as a missing one.
 */
@Injectable()
export class ProcessorAccountsForPaymentsService {
  constructor(
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher | null,
  ) {}

  /**
   * The account a new payment of the merchant may use: it must exist for the
   * merchant, be enabled, and be the merchant's default. Pass the caller's
   * transaction after it has share-locked the merchant row: the account
   * changes of a merchant lock that row for update, so the answer cannot change
   * until the transaction ends.
   */
  async forNewPayment(
    db: Database,
    key: { readonly merchantId: string; readonly processorAccountId: string },
  ): Promise<PaymentProcessorAccountResult> {
    const found = await findProcessorAccountWithSecret(db, {
      merchantId: key.merchantId,
      id: key.processorAccountId,
    });
    if (found === undefined) return { ok: false, code: 'NOT_FOUND' };
    if (!found.account.enabled) return { ok: false, code: 'DISABLED' };
    if (!found.account.isDefault) return { ok: false, code: 'NOT_DEFAULT' };
    return this.reveal(found);
  }

  /**
   * The account a payment was already made with, enabled or not and default
   * or not: completing or looking up that payment must use the same provider
   * account.
   */
  async forExistingPayment(
    db: Database,
    key: { readonly merchantId: string; readonly processorAccountId: string },
  ): Promise<PaymentProcessorAccountResult> {
    const found = await findProcessorAccountWithSecret(db, {
      merchantId: key.merchantId,
      id: key.processorAccountId,
    });
    if (found === undefined) return { ok: false, code: 'NOT_FOUND' };
    return this.reveal(found);
  }

  private reveal(
    found: ProcessorAccountWithSecret,
  ): PaymentProcessorAccountResult {
    const cipher = this.cipher;
    if (cipher === null) {
      return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
    }
    const { account, secret } = found;
    const secretKey = cipher.decrypt(secret, {
      merchantId: account.merchantId,
      processorAccountId: account.id,
      provider: account.provider,
    });
    return {
      ok: true,
      account: {
        id: account.id,
        merchantId: account.merchantId,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        credentials: { secretKey, publishableKey: account.publishableKey },
      },
    };
  }
}
