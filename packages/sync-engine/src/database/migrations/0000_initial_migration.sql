-- Internal sync metadata schema bootstrap for OpenAPI runtime.
-- Schema-qualified objects use the explicit {{sync_schema}} placeholder.
-- Uses idempotent DDL so it can be safely re-run.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
  -- Support both legacy "updated_at" and newer "_updated_at" columns.
  -- jsonb_populate_record silently ignores keys that are not present on NEW.
  NEW := jsonb_populate_record(
    NEW,
    jsonb_build_object(
      'updated_at', now(),
      '_updated_at', now()
    )
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_updated_at_metadata() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS {{sync_schema}}."accounts" (
  "_raw_data" jsonb NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "api_key_hashes" text[] NOT NULL DEFAULT '{}',
  "first_synced_at" timestamptz NOT NULL DEFAULT now(),
  "_last_synced_at" timestamptz NOT NULL DEFAULT now(),
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_accounts_api_key_hashes"
  ON {{sync_schema}}."accounts" USING GIN ("api_key_hashes");
DROP TRIGGER IF EXISTS handle_updated_at ON {{sync_schema}}."accounts";
CREATE TRIGGER handle_updated_at
BEFORE UPDATE ON {{sync_schema}}."accounts"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS {{sync_schema}}."_managed_webhooks" (
  "id" text PRIMARY KEY,
  "object" text,
  "url" text NOT NULL,
  "enabled_events" jsonb NOT NULL,
  "description" text,
  "enabled" boolean,
  "livemode" boolean,
  "metadata" jsonb,
  "secret" text NOT NULL,
  "status" text,
  "api_version" text,
  "created" bigint,
  "last_synced_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "account_id" text NOT NULL
);
ALTER TABLE {{sync_schema}}."_managed_webhooks"
  DROP CONSTRAINT IF EXISTS "managed_webhooks_url_account_unique";
ALTER TABLE {{sync_schema}}."_managed_webhooks"
  ADD CONSTRAINT "managed_webhooks_url_account_unique" UNIQUE ("url", "account_id");
ALTER TABLE {{sync_schema}}."_managed_webhooks"
  DROP CONSTRAINT IF EXISTS "fk_managed_webhooks_account";
ALTER TABLE {{sync_schema}}."_managed_webhooks"
  ADD CONSTRAINT "fk_managed_webhooks_account"
    FOREIGN KEY ("account_id") REFERENCES {{sync_schema}}."accounts" (id);
CREATE INDEX IF NOT EXISTS "idx_managed_webhooks_status"
  ON {{sync_schema}}."_managed_webhooks" ("status");
CREATE INDEX IF NOT EXISTS "idx_managed_webhooks_enabled"
  ON {{sync_schema}}."_managed_webhooks" ("enabled");
DROP TRIGGER IF EXISTS handle_updated_at ON {{sync_schema}}."_managed_webhooks";
CREATE TRIGGER handle_updated_at
BEFORE UPDATE ON {{sync_schema}}."_managed_webhooks"
FOR EACH ROW EXECUTE FUNCTION set_updated_at_metadata();

CREATE TABLE IF NOT EXISTS {{sync_schema}}."_sync_runs" (
  "_account_id" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  "max_concurrent" integer NOT NULL DEFAULT 3,
  "triggered_by" text,
  "error_message" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("_account_id", "started_at")
);
ALTER TABLE {{sync_schema}}."_sync_runs"
  ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE {{sync_schema}}."_sync_runs"
  DROP CONSTRAINT IF EXISTS "fk_sync_runs_account";
ALTER TABLE {{sync_schema}}."_sync_runs"
  ADD CONSTRAINT "fk_sync_runs_account"
    FOREIGN KEY ("_account_id") REFERENCES {{sync_schema}}."accounts" (id);
ALTER TABLE {{sync_schema}}."_sync_runs"
  DROP CONSTRAINT IF EXISTS one_active_run_per_account;
ALTER TABLE {{sync_schema}}."_sync_runs"
  DROP CONSTRAINT IF EXISTS one_active_run_per_account_triggered_by;
ALTER TABLE {{sync_schema}}."_sync_runs"
  ADD CONSTRAINT one_active_run_per_account_triggered_by
  EXCLUDE (
    "_account_id" WITH =,
    COALESCE(triggered_by, 'default') WITH =
  ) WHERE (closed_at IS NULL);
DROP TRIGGER IF EXISTS handle_updated_at ON {{sync_schema}}."_sync_runs";
CREATE TRIGGER handle_updated_at
BEFORE UPDATE ON {{sync_schema}}."_sync_runs"
FOR EACH ROW EXECUTE FUNCTION set_updated_at_metadata();
CREATE INDEX IF NOT EXISTS "idx_sync_runs_account_status"
  ON {{sync_schema}}."_sync_runs" ("_account_id", "closed_at");

CREATE TABLE IF NOT EXISTS {{sync_schema}}."_sync_obj_runs" (
  "_account_id" text NOT NULL,
  "run_started_at" timestamptz NOT NULL,
  "object" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'error')),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "processed_count" integer NOT NULL DEFAULT 0,
  "cursor" text,
  "page_cursor" text,
  "created_gte" integer NOT NULL DEFAULT 0,
  "created_lte" integer NOT NULL DEFAULT 0,
  "priority" integer NOT NULL DEFAULT 0,
  "error_message" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("_account_id", "run_started_at", "object", "created_gte", "created_lte")
);
ALTER TABLE {{sync_schema}}."_sync_obj_runs"
  ADD COLUMN IF NOT EXISTS "page_cursor" text;
ALTER TABLE {{sync_schema}}."_sync_obj_runs"
  ADD COLUMN IF NOT EXISTS "created_gte" integer NOT NULL DEFAULT 0;
ALTER TABLE {{sync_schema}}."_sync_obj_runs"
  ADD COLUMN IF NOT EXISTS "created_lte" integer NOT NULL DEFAULT 0;
ALTER TABLE {{sync_schema}}."_sync_obj_runs"
  ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 0;
ALTER TABLE {{sync_schema}}."_sync_obj_runs"
  ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE {{sync_schema}}."_sync_obj_runs"
  DROP CONSTRAINT IF EXISTS "fk_sync_obj_runs_parent";
ALTER TABLE {{sync_schema}}."_sync_obj_runs"
  ADD CONSTRAINT "fk_sync_obj_runs_parent"
    FOREIGN KEY ("_account_id", "run_started_at")
    REFERENCES {{sync_schema}}."_sync_runs" ("_account_id", "started_at");
DROP TRIGGER IF EXISTS handle_updated_at ON {{sync_schema}}."_sync_obj_runs";
CREATE TRIGGER handle_updated_at
BEFORE UPDATE ON {{sync_schema}}."_sync_obj_runs"
FOR EACH ROW EXECUTE FUNCTION set_updated_at_metadata();
CREATE INDEX IF NOT EXISTS "idx_sync_obj_runs_status"
  ON {{sync_schema}}."_sync_obj_runs" ("_account_id", "run_started_at", "status");
CREATE INDEX IF NOT EXISTS "idx_sync_obj_runs_priority"
  ON {{sync_schema}}."_sync_obj_runs" ("_account_id", "run_started_at", "status", "priority");

CREATE TABLE IF NOT EXISTS {{sync_schema}}."_rate_limits" (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION {{sync_schema}}.check_rate_limit(
  rate_key TEXT,
  max_requests INTEGER,
  window_seconds INTEGER
)
RETURNS VOID AS $$
DECLARE
  now TIMESTAMPTZ := clock_timestamp();
  window_length INTERVAL := make_interval(secs => window_seconds);
  current_count INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(rate_key));

  INSERT INTO {{sync_schema}}."_rate_limits" (key, count, window_start)
  VALUES (rate_key, 1, now)
  ON CONFLICT (key) DO UPDATE
  SET count = CASE
                WHEN "_rate_limits".window_start + window_length <= now
                  THEN 1
                  ELSE "_rate_limits".count + 1
              END,
      window_start = CASE
                       WHEN "_rate_limits".window_start + window_length <= now
                         THEN now
                         ELSE "_rate_limits".window_start
                     END;

  SELECT count INTO current_count FROM {{sync_schema}}."_rate_limits" WHERE key = rate_key;

  IF current_count > max_requests THEN
    RAISE EXCEPTION 'Rate limit exceeded for %', rate_key;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW {{sync_schema}}."sync_runs" AS
SELECT
  r._account_id as account_id,
  r.started_at,
  r.closed_at,
  r.triggered_by,
  r.max_concurrent,
  COALESCE(SUM(o.processed_count), 0) as total_processed,
  COUNT(o.*) as total_objects,
  COUNT(*) FILTER (WHERE o.status = 'complete') as complete_count,
  COUNT(*) FILTER (WHERE o.status = 'error') as error_count,
  COUNT(*) FILTER (WHERE o.status = 'running') as running_count,
  COUNT(*) FILTER (WHERE o.status = 'pending') as pending_count,
  STRING_AGG(o.error_message, '; ') FILTER (WHERE o.error_message IS NOT NULL) as error_message,
  CASE
    WHEN r.closed_at IS NULL AND COUNT(*) FILTER (WHERE o.status = 'running') > 0 THEN 'running'
    WHEN r.closed_at IS NULL AND (COUNT(o.*) = 0 OR COUNT(o.*) = COUNT(*) FILTER (WHERE o.status = 'pending')) THEN 'pending'
    WHEN r.closed_at IS NULL THEN 'running'
    WHEN COUNT(*) FILTER (WHERE o.status = 'error') > 0 THEN 'error'
    ELSE 'complete'
  END as status
FROM {{sync_schema}}."_sync_runs" r
LEFT JOIN {{sync_schema}}."_sync_obj_runs" o
  ON o._account_id = r._account_id
  AND o.run_started_at = r.started_at
GROUP BY r._account_id, r.started_at, r.closed_at, r.triggered_by, r.max_concurrent;

DROP FUNCTION IF EXISTS {{sync_schema}}."sync_obj_progress"(TEXT, TIMESTAMPTZ);
CREATE OR REPLACE VIEW {{sync_schema}}."sync_obj_progress" AS
SELECT
  r."_account_id" AS account_id,
  r.run_started_at,
  r.object,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE r.status = 'complete') / NULLIF(COUNT(*), 0),
    1
  ) AS pct_complete,
  COALESCE(SUM(r.processed_count), 0) AS processed
FROM {{sync_schema}}."_sync_obj_runs" r
WHERE r.run_started_at = (
  SELECT MAX(s.started_at)
  FROM {{sync_schema}}."_sync_runs" s
  WHERE s."_account_id" = r."_account_id"
)
GROUP BY r."_account_id", r.run_started_at, r.object;
