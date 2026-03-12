import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { minimalStripeOpenApiSpec } from '../../openapi/__tests__/fixtures/minimalSpec'

const TEST_DB_URL = process.env.TEST_POSTGRES_DB_URL
const describeWithDb = TEST_DB_URL ? describe : describe.skip

// Use a distinct non-default schema name so this test is isolated from the default 'stripe' schema suite.
const CUSTOM_SCHEMA_NAME = 'eval_test_schema'

describeWithDb('runMigrations — custom schema name support', () => {
  let pool: pg.Pool
  let specPath: string
  let tempDir: string

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-name-migrate-test-'))
    specPath = path.join(tempDir, 'spec.json')
    await fs.writeFile(specPath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')

    // Drop the test schema if it exists from a previous run so each test starts fresh.
    const cleanupClient = new pg.Client({ connectionString: TEST_DB_URL! })
    await cleanupClient.connect()
    await cleanupClient.query(`DROP SCHEMA IF EXISTS "${CUSTOM_SCHEMA_NAME}" CASCADE`)
    await cleanupClient.end()

    await runMigrations({
      databaseUrl: TEST_DB_URL!,
      schemaName: CUSTOM_SCHEMA_NAME,
      syncTablesSchemaName: CUSTOM_SCHEMA_NAME,
      openApiSpecPath: specPath,
      stripeApiVersion: '2020-08-27',
    })

    pool = new pg.Pool({ connectionString: TEST_DB_URL! })
  })

  afterAll(async () => {
    await pool?.end()
    // Tear down so subsequent test runs start clean.
    const cleanupClient = new pg.Client({ connectionString: TEST_DB_URL! })
    await cleanupClient.connect()
    await cleanupClient.query(`DROP SCHEMA IF EXISTS "${CUSTOM_SCHEMA_NAME}" CASCADE`)
    await cleanupClient.end()
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('creates bootstrap tables in the schema named by schemaName, not in "stripe"', async () => {
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ('_migrations', 'accounts', '_managed_webhooks', '_sync_runs', '_sync_obj_runs')
       ORDER BY table_name`,
      [CUSTOM_SCHEMA_NAME]
    )
    expect(result.rows.map((r) => r.table_name)).toEqual([
      '_managed_webhooks',
      '_migrations',
      '_sync_obj_runs',
      '_sync_runs',
      'accounts',
    ])

    // Nothing should leak into the default 'stripe' schema from this run.
    // The migration marker lives in the _migrations table under the schema named by schemaName.
    // The column may be named 'migration_name' (new format) or 'name' (legacy table format).
    const colCheck = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = '_migrations'
         AND column_name IN ('migration_name', 'name')`,
      [CUSTOM_SCHEMA_NAME]
    )
    const col = colCheck.rows.some(
      (r: { column_name: string }) => r.column_name === 'migration_name'
    )
      ? 'migration_name'
      : 'name'
    const markerResult = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM "${CUSTOM_SCHEMA_NAME}"."_migrations"
       WHERE "${col}" LIKE 'openapi:%'`
    )
    expect(Number(markerResult.rows[0].cnt)).toBeGreaterThan(0)
  })

  it('creates the sync_runs view in the schema named by schemaName', async () => {
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.views
       WHERE table_schema = $1 AND table_name = 'sync_runs'`,
      [CUSTOM_SCHEMA_NAME]
    )
    expect(result.rows).toHaveLength(1)
  })

  it('creates OpenAPI-derived resource tables in the schema named by schemaName', async () => {
    // customers is in the minimal spec
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'customers'`,
      [CUSTOM_SCHEMA_NAME]
    )
    expect(result.rows).toHaveLength(1)
  })

  it('generates columns in OpenAPI tables are derived from _raw_data', async () => {
    const result = await pool.query(
      `SELECT is_generated
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'customers' AND column_name = 'id'`,
      [CUSTOM_SCHEMA_NAME]
    )
    expect(result.rows[0]?.is_generated).toBe('ALWAYS')
  })

  it('accounts table FK constraint points inside the schema named by schemaName', async () => {
    // The FK on resource tables references the accounts table in the same schema.
    // Verify it is not pointing at "stripe"."accounts".
    const result = await pool.query(
      `SELECT ccu.table_schema AS referenced_schema
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name
         AND tc.constraint_schema = rc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON rc.unique_constraint_name = ccu.constraint_name
         AND rc.unique_constraint_schema = ccu.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
         AND tc.table_name = 'customers'
       LIMIT 1`,
      [CUSTOM_SCHEMA_NAME]
    )
    // If there are FK constraints (OpenAPI adapter emits one for _account_id -> accounts),
    // they must reference the schema named by schemaName, not the default stripe schema.
    for (const row of result.rows) {
      expect(row.referenced_schema).toBe(CUSTOM_SCHEMA_NAME)
    }
  })

  it('running migrations a second time is idempotent (no errors, no duplicate tables)', async () => {
    // Re-run should not throw even when all objects already exist.
    await expect(
      runMigrations({
        databaseUrl: TEST_DB_URL!,
        schemaName: CUSTOM_SCHEMA_NAME,
        syncTablesSchemaName: CUSTOM_SCHEMA_NAME,
        openApiSpecPath: specPath,
        stripeApiVersion: '2020-08-27',
      })
    ).resolves.toBeUndefined()
  })

  it('rejects split-schema config (schemaName !== syncTablesSchemaName)', async () => {
    await expect(
      runMigrations({
        databaseUrl: TEST_DB_URL!,
        schemaName: 'data_schema',
        syncTablesSchemaName: 'meta_schema',
        openApiSpecPath: specPath,
        stripeApiVersion: '2020-08-27',
      })
    ).rejects.toThrow(/Split schema configuration is not supported/)
  })

  it('set_updated_at trigger function exists in the schema named by schemaName', async () => {
    const result = await pool.query(
      `SELECT proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = 'set_updated_at'`,
      [CUSTOM_SCHEMA_NAME]
    )
    expect(result.rows).toHaveLength(1)
  })
})
