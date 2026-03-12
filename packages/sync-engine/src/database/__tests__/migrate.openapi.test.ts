import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { minimalStripeOpenApiSpec } from '../../openapi/__tests__/fixtures/minimalSpec'

const TEST_DB_URL = process.env.TEST_POSTGRES_DB_URL
const describeWithDb = TEST_DB_URL ? describe : describe.skip

describeWithDb('runMigrations openapi pipeline', () => {
  let pool: pg.Pool
  let specPath: string
  let tempDir: string

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openapi-migrate-test-'))
    specPath = path.join(tempDir, 'spec3.json')
    await fs.writeFile(specPath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')

    await runMigrations({
      databaseUrl: TEST_DB_URL!,
      openApiSpecPath: specPath,
      stripeApiVersion: '2020-08-27',
    })

    pool = new pg.Pool({ connectionString: TEST_DB_URL! })
  })

  afterAll(async () => {
    await pool?.end()
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('creates bootstrap internal tables and the sync_runs view', async () => {
    const tablesResult = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'stripe'
         AND table_name IN ('_migrations', '_sync_accounts', '_managed_webhooks', '_sync_runs', '_sync_obj_runs')
       ORDER BY table_name`
    )
    expect(tablesResult.rows.map((row) => row.table_name)).toEqual([
      '_managed_webhooks',
      '_migrations',
      '_sync_accounts',
      '_sync_obj_runs',
      '_sync_runs',
    ])

    const viewsResult = await pool.query(
      `SELECT table_name
       FROM information_schema.views
       WHERE table_schema = 'stripe' AND table_name = 'sync_runs'`
    )
    expect(viewsResult.rows).toHaveLength(1)
  })

  it('materializes runtime-critical generated columns and naming contracts', async () => {
    const subscriptionItemsColumns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'stripe' AND table_name = 'subscription_items'`
    )
    const subscriptionColumnSet = new Set(
      subscriptionItemsColumns.rows.map((row) => row.column_name as string)
    )
    expect(subscriptionColumnSet.has('deleted')).toBe(true)
    expect(subscriptionColumnSet.has('subscription')).toBe(true)

    const entitlementColumns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'stripe' AND table_name = 'active_entitlements'`
    )
    expect(entitlementColumns.rows.some((row) => row.column_name === 'customer')).toBe(true)

    const customerIdColumn = await pool.query(
      `SELECT is_generated
       FROM information_schema.columns
       WHERE table_schema = 'stripe' AND table_name = 'customers' AND column_name = 'id'`
    )
    expect(customerIdColumn.rows[0]?.is_generated).toBe('ALWAYS')

    const managedWebhookColumns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'stripe' AND table_name = '_managed_webhooks'`
    )
    const managedWebhookColumnSet = new Set(
      managedWebhookColumns.rows.map((row) => row.column_name as string)
    )
    expect(managedWebhookColumnSet.has('account_id')).toBe(true)
    expect(managedWebhookColumnSet.has('_account_id')).toBe(false)
  })

  it('enforces one active sync run per account+triggered_by', async () => {
    const accountId = 'acct_openapi_migrate_test'
    await pool.query(
      `INSERT INTO "stripe"."_sync_accounts" ("_raw_data", "api_key_hashes")
       VALUES ($1::jsonb, ARRAY['hash_openapi'])`,
      [JSON.stringify({ id: accountId, object: 'account' })]
    )

    await pool.query(
      `INSERT INTO "stripe"."_sync_runs" ("_account_id", "triggered_by", "started_at")
       VALUES ($1, 'worker', date_trunc('milliseconds', now()))`,
      [accountId]
    )
    await pool.query(
      `INSERT INTO "stripe"."_sync_runs" ("_account_id", "triggered_by", "started_at")
       VALUES ($1, 'sigma-worker', date_trunc('milliseconds', now()) + interval '1 second')`,
      [accountId]
    )

    await expect(
      pool.query(
        `INSERT INTO "stripe"."_sync_runs" ("_account_id", "triggered_by", "started_at")
         VALUES ($1, 'worker', date_trunc('milliseconds', now()) + interval '2 second')`,
        [accountId]
      )
    ).rejects.toThrow()
  })
})
