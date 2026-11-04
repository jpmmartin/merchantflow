import {
  subtractMoney,
  type Money,
  type MoneyArithmeticResult,
} from '../money/money.js';
import {
  normalBalanceSide,
  type LedgerAccountClassification,
} from './ledger-account.js';

/**
 * The balance of an account from the totals of its debit and credit lines,
 * signed by its normal side: debits minus credits for an asset or an expense,
 * credits minus debits for a liability or revenue. A positive balance is on
 * the normal side; a negative one is on the other side. Both totals must have
 * the account's currency.
 */
export function accountBalance(
  classification: LedgerAccountClassification,
  totals: { readonly debits: Money; readonly credits: Money },
): MoneyArithmeticResult {
  switch (normalBalanceSide(classification)) {
    case 'DEBIT':
      return subtractMoney(totals.debits, totals.credits);
    case 'CREDIT':
      return subtractMoney(totals.credits, totals.debits);
  }
}
