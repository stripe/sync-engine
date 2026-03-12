-- Rename the sync-managed account root table to avoid collisions with the OpenAPi

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'stripe'
      AND table_name = 'accounts'
      AND column_name = 'api_key_hashes'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'stripe'
      AND table_name = '_sync_accounts'
  ) THEN
    ALTER TABLE "stripe"."accounts" RENAME TO "_sync_accounts";
  END IF;
END;
$$;

ALTER INDEX IF EXISTS "stripe"."idx_accounts_api_key_hashes"
  RENAME TO "idx_sync_accounts_api_key_hashes";

ALTER TABLE "stripe"."_managed_webhooks"
  DROP CONSTRAINT IF EXISTS "fk_managed_webhooks_account";
ALTER TABLE "stripe"."_managed_webhooks"
  ADD CONSTRAINT "fk_managed_webhooks_account"
    FOREIGN KEY ("account_id") REFERENCES "stripe"."_sync_accounts" (id);

ALTER TABLE "stripe"."_sync_runs"
  DROP CONSTRAINT IF EXISTS "fk_sync_runs_account";
ALTER TABLE "stripe"."_sync_runs"
  ADD CONSTRAINT "fk_sync_runs_account"
    FOREIGN KEY ("_account_id") REFERENCES "stripe"."_sync_accounts" (id);
