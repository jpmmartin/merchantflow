-- Lets the ledger record successful refunds: the CONTRA_REVENUE classification
-- (debit-normal, for the Refunds account 4100) and the PAYMENT_REFUND source
-- type, whose source is the refund and which, like a sale, always names its
-- payment intent. Each check is replaced in one statement; every existing row
-- satisfies the new lists, which mirror LEDGER_ACCOUNT_CLASSIFICATIONS in
-- packages/domain and JOURNAL_SOURCE_TYPES in the ledger module.

ALTER TABLE ledger_accounts
  DROP CONSTRAINT ledger_accounts_classification_check,
  ADD CONSTRAINT ledger_accounts_classification_check CHECK (
    classification IN ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'CONTRA_REVENUE')
  );

ALTER TABLE journal_entries
  DROP CONSTRAINT journal_entries_source_type_check,
  ADD CONSTRAINT journal_entries_source_type_check CHECK (
    source_type IN ('PAYMENT_SALE', 'PAYMENT_REFUND')
  ),
  DROP CONSTRAINT journal_entries_payment_source_check,
  ADD CONSTRAINT journal_entries_payment_source_check CHECK (
    source_type NOT IN ('PAYMENT_SALE', 'PAYMENT_REFUND') OR payment_intent_id IS NOT NULL
  );
