import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgresClient } from '../../database/postgres'
import { setupTestDatabase, type TestDatabase } from '../testSetup'

describe('Observable Sync System Methods', () => {
  let postgresClient: PostgresClient
  let db: TestDatabase
  const testAccountId = 'acct_test_obs_123'
  const testApiKeyHash = `test_api_key_hash_${testAccountId}`

  beforeAll(async () => {
    db = await setupTestDatabase()

    postgresClient = new PostgresClient({
      schema: 'stripe',
      poolConfig: {
        connectionString: db.databaseUrl,
      },
    })

    await postgresClient.upsertSyncMetadataAccount(
      { id: testAccountId, raw_data: { id: testAccountId, object: 'account' } },
      testApiKeyHash
    )
  })

  afterAll(async () => {
    if (postgresClient) await postgresClient.pool.end()
    if (db) await db.close()
  })

  beforeEach(async () => {
    await db.clearSyncData(testAccountId)
    await db.clearTables(testAccountId, ['stripe.products'])
    await postgresClient.upsertSyncMetadataAccount(
      { id: testAccountId, raw_data: { id: testAccountId, object: 'account' } },
      testApiKeyHash
    )
  })

  describe('sync metadata account helpers', () => {
    it('should list and resolve sync metadata accounts by API key hash', async () => {
      const accounts = await postgresClient.getAllSyncMetadataAccounts()
      expect(accounts.some((account) => account.id === testAccountId)).toBe(true)

      const accountId = await postgresClient.getSyncMetadataAccountIdByApiKeyHash(testApiKeyHash)
      expect(accountId).toBe(testAccountId)

      const account = await postgresClient.getSyncMetadataAccountByApiKeyHash(testApiKeyHash)
      expect(account).toMatchObject({ id: testAccountId, object: 'account' })
    })

    it('should count and delete sync-account-scoped rows across projected and metadata tables', async () => {
      await db.pool.query(
        `INSERT INTO stripe.products (_raw_data, _account_id) VALUES ($1::jsonb, $2)`,
        [JSON.stringify({ id: 'prod_test_obs_123', object: 'product' }), testAccountId]
      )
      await db.pool.query(`INSERT INTO stripe._sync_runs ("_account_id") VALUES ($1)`, [
        testAccountId,
      ])

      const counts = await postgresClient.getSyncAccountScopedRecordCounts(testAccountId)
      expect(counts.products).toBe(1)
      expect(counts._sync_runs).toBe(1)

      const result = await postgresClient.deleteSyncAccountScopedDataWithCascade(
        testAccountId,
        true
      )
      expect(result.products).toBe(1)
      expect(result._sync_runs).toBe(1)
      expect(result._sync_accounts).toBe(1)

      const remainingSyncAccounts = await db.pool.query(
        `SELECT COUNT(*) AS count FROM stripe._sync_accounts WHERE id = $1`,
        [testAccountId]
      )
      expect(parseInt(remainingSyncAccounts.rows[0].count)).toBe(0)
    })
  })

  describe('getOrCreateSyncRun', () => {
    it('should create a new run when none exists', async () => {
      const result = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')

      expect(result).not.toBeNull()
      expect(result!.accountId).toBe(testAccountId)
      expect(result!.isNew).toBe(true)
      expect(result!.runStartedAt).toBeInstanceOf(Date)
    })

    it('should return existing run when one is active', async () => {
      const first = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      const second = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')

      expect(second).not.toBeNull()
      expect(second!.isNew).toBe(false)
      expect(second!.runStartedAt.getTime()).toBe(first!.runStartedAt.getTime())
    })

    it('should enforce single active run per account with EXCLUDE constraint', async () => {
      await postgresClient.getOrCreateSyncRun(testAccountId, 'test')

      await expect(
        db.pool.query(
          `INSERT INTO stripe._sync_runs ("_account_id", triggered_by) VALUES ($1, 'test')`,
          [testAccountId]
        )
      ).rejects.toThrow(/one_active_run_per_account/)
    })
  })

  describe('getActiveSyncRun', () => {
    it('should return null when no active run', async () => {
      const result = await postgresClient.getActiveSyncRun(testAccountId)
      expect(result).toBeNull()
    })

    it('should return active run when one exists', async () => {
      const created = await postgresClient.getOrCreateSyncRun(testAccountId)

      const result = await postgresClient.getActiveSyncRun(testAccountId)
      expect(result).not.toBeNull()
      expect(result!.runStartedAt.getTime()).toBe(created!.runStartedAt.getTime())
    })

    it('should not return closed runs', async () => {
      const created = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(created!.accountId, created!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(created!.accountId, created!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(created!.accountId, created!.runStartedAt, 'customer')

      const result = await postgresClient.getActiveSyncRun(testAccountId)
      expect(result).toBeNull()
    })
  })

  describe('closeSyncRun', () => {
    it('should close run and derive status from objects', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const result = await db.pool.query(
        `SELECT status, closed_at FROM stripe.sync_runs
         WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('complete')
      expect(result.rows[0].closed_at).not.toBeNull()
    })

    it('should derive error status when objects have errors', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.failObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        'Test error'
      )

      const result = await db.pool.query(
        `SELECT status, error_message FROM stripe.sync_runs
         WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('error')
      expect(result.rows[0].error_message).toBe('Test error')
    })
  })

  describe('createObjectRuns', () => {
    it('should create object run entries for each object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      const objects = ['customer', 'invoice', 'subscription']

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, objects)

      const result = await db.pool.query(
        `SELECT object, status FROM stripe._sync_obj_runs
         WHERE "_account_id" = $1 AND run_started_at = $2
         ORDER BY object`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows).toHaveLength(3)
      expect(result.rows[0].object).toBe('customer')
      expect(result.rows[0].status).toBe('pending')
      expect(result.rows[1].object).toBe('invoice')
      expect(result.rows[2].object).toBe('subscription')
    })

    it('should not fail on duplicate objects (ON CONFLICT DO NOTHING)', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])

      const result = await db.pool.query(
        `SELECT COUNT(*) as count FROM stripe._sync_obj_runs
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = 'customer'`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(parseInt(result.rows[0].count)).toBe(1)
    })
  })

  describe('tryStartObjectSync', () => {
    it('should claim a pending object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])

      const result = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )

      expect(result).toBe(true)

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.status).toBe('running')
    })

    it('should not claim an already running object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const result = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )

      expect(result).toBe(false)
    })

    it('should respect max_concurrent limit', async () => {
      await db.pool.query(
        `INSERT INTO stripe._sync_runs ("_account_id", max_concurrent, started_at)
         VALUES ($1, 2, date_trunc('milliseconds', now()))`,
        [testAccountId]
      )
      const run = await postgresClient.getActiveSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
        'subscription',
      ])

      const r1 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )
      const r2 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'invoice'
      )

      const r3 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'subscription'
      )

      expect(r1).toBe(true)
      expect(r2).toBe(true)
      expect(r3).toBe(false)
    })
  })

  describe('incrementObjectProgress', () => {
    it('should increment processed count', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.incrementObjectProgress(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        100
      )
      await postgresClient.incrementObjectProgress(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        50
      )

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.processedCount).toBe(150)
    })
  })

  describe('updateObjectCursor', () => {
    it('should update cursor value', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])

      await postgresClient.updateObjectCursor(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        'cus_abc123'
      )

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.cursor).toBe('cus_abc123')
    })
  })

  describe('completeObjectSync', () => {
    it('should mark object as complete', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.status).toBe('complete')
    })
  })

  describe('failObjectSync', () => {
    it('should mark object as error with message', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.failObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        'API error'
      )

      const result = await db.pool.query(
        `SELECT status, error_message FROM stripe._sync_obj_runs
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = 'customer'`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('error')
      expect(result.rows[0].error_message).toBe('API error')
    })
  })

  describe('countRunningObjects', () => {
    it('should count running objects', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
        'subscription',
      ])

      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(0)

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(1)

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(2)

      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(1)
    })
  })

  describe('getNextPendingObject', () => {
    it('should return next pending object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      const next = await postgresClient.getNextPendingObject(run!.accountId, run!.runStartedAt)
      expect(next).toBe('customer')
    })

    it('should return null when no pending objects', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const next = await postgresClient.getNextPendingObject(run!.accountId, run!.runStartedAt)
      expect(next).toBeNull()
    })

    it('should return null when at concurrency limit', async () => {
      await db.pool.query(
        `INSERT INTO stripe._sync_runs ("_account_id", max_concurrent, started_at)
         VALUES ($1, 1, date_trunc('milliseconds', now()))`,
        [testAccountId]
      )
      const run = await postgresClient.getActiveSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const next = await postgresClient.getNextPendingObject(run!.accountId, run!.runStartedAt)
      expect(next).toBeNull()
    })
  })

  describe('areAllObjectsComplete', () => {
    it('should return true when all objects complete', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        false
      )

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        false
      )

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        true
      )
    })

    it('should return true when all objects are complete or error', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      await postgresClient.failObjectSync(run!.accountId, run!.runStartedAt, 'invoice', 'error')

      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        true
      )
    })
  })

  describe('cancelStaleRuns', () => {
    it('should cancel runs with stale objects', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await db.pool.query(`ALTER TABLE stripe._sync_obj_runs DISABLE TRIGGER handle_updated_at`)
      await db.pool.query(
        `UPDATE stripe._sync_obj_runs
         SET updated_at = now() - interval '10 minutes'
         WHERE "_account_id" = $1`,
        [run!.accountId]
      )
      await db.pool.query(`ALTER TABLE stripe._sync_obj_runs ENABLE TRIGGER handle_updated_at`)

      await postgresClient.cancelStaleRuns(testAccountId)

      const result = await db.pool.query(
        `SELECT status, error_message FROM stripe.sync_runs
         WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('error')
      expect(result.rows[0].error_message).toContain('stale')
    })

    it('should not cancel runs with recent activity', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.cancelStaleRuns(testAccountId)

      const result = await db.pool.query(
        `SELECT status FROM stripe.sync_runs
         WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('running')
    })
  })

  describe('full sync workflow', () => {
    it('should complete a full sync cycle', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      expect(run!.isNew).toBe(true)

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      const started1 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )
      expect(started1).toBe(true)
      await postgresClient.incrementObjectProgress(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        100
      )
      await postgresClient.updateObjectCursor(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        'cus_last'
      )
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const started2 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'invoice'
      )
      expect(started2).toBe(true)
      await postgresClient.incrementObjectProgress(run!.accountId, run!.runStartedAt, 'invoice', 50)
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'invoice')

      const allDone = await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)
      expect(allDone).toBe(true)

      const finalRun = await db.pool.query(
        `SELECT status, total_processed FROM stripe.sync_runs
         WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )
      expect(finalRun.rows[0].status).toBe('complete')
      expect(Number(finalRun.rows[0].total_processed)).toBe(150)

      const newRun = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      expect(newRun!.isNew).toBe(true)
    })
  })

  describe('Sync Run Auto-Close', () => {
    it('should auto-close sync run when all objects are complete', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      let syncRunResult = await db.pool.query(
        `SELECT status FROM stripe.sync_runs WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )
      expect(syncRunResult.rows[0].status).toBe('running')

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'invoice')

      syncRunResult = await db.pool.query(
        `SELECT status FROM stripe.sync_runs WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )
      expect(syncRunResult.rows[0].status).toBe('complete')
    })

    it('should derive error status when all objects are done but some errored', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      await postgresClient.failObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'invoice',
        'Test error'
      )

      const syncRunResult = await db.pool.query(
        `SELECT status FROM stripe.sync_runs WHERE account_id = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )
      expect(syncRunResult.rows[0].status).toBe('error')
    })

    it('should not auto-close when only first object completes with upfront object runs', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customers',
        'invoices',
      ])

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customers')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customers')

      const syncRunResult = await db.pool.query(
        `SELECT closed_at FROM stripe._sync_runs WHERE "_account_id" = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )
      expect(syncRunResult.rows[0].closed_at).toBeNull()

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoices')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'invoices')

      const finalResult = await db.pool.query(
        `SELECT closed_at FROM stripe._sync_runs WHERE "_account_id" = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )
      expect(finalResult.rows[0].closed_at).not.toBeNull()
    })
  })

  describe('Object Type vs Resource Name Consistency', () => {
    it('should store resource names (plural) not object types (singular) in _sync_obj_runs', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      expect(run).toBeTruthy()

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'products',
        'customers',
        'prices',
      ])

      const result = await db.pool.query(
        `SELECT object FROM stripe._sync_obj_runs
         WHERE "_account_id" = $1 AND run_started_at = $2
         ORDER BY object`,
        [run!.accountId, run!.runStartedAt]
      )

      const storedObjects = result.rows.map((r) => r.object)

      expect(storedObjects).toEqual(['customers', 'prices', 'products'])

      expect(storedObjects).not.toContain('product')
      expect(storedObjects).not.toContain('customer')
      expect(storedObjects).not.toContain('price')
    })

    it('should reject object types if accidentally passed to createObjectRuns', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      expect(run).toBeTruthy()

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['product'])

      const resourceNameResult = await db.pool.query(
        `SELECT object FROM stripe._sync_obj_runs
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
        [run!.accountId, run!.runStartedAt, 'products']
      )

      expect(resourceNameResult.rows.length).toBe(0)

      const objectTypeResult = await db.pool.query(
        `SELECT object FROM stripe._sync_obj_runs
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
        [run!.accountId, run!.runStartedAt, 'product']
      )

      expect(objectTypeResult.rows.length).toBe(1)
      expect(objectTypeResult.rows[0].object).toBe('product')
    })

    it('should use consistent naming between createObjectRuns calls', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      expect(run).toBeTruthy()

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'products',
        'customers',
      ])

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['prices'])

      const result = await db.pool.query(
        `SELECT object FROM stripe._sync_obj_runs
         WHERE "_account_id" = $1 AND run_started_at = $2
         ORDER BY object`,
        [run!.accountId, run!.runStartedAt]
      )

      const allObjects = result.rows.map((r) => r.object)

      expect(allObjects).toEqual(['customers', 'prices', 'products'])

      allObjects.forEach((obj) => {
        expect(
          obj.endsWith('s') || obj === 'tax_ids' || obj === 'early_fraud_warnings'
        ).toBeTruthy()
      })
    })
  })
})
