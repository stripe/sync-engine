/**
 * Sync Metadata Account Management E2E Test
 * Tests getCurrentAccount(), getAllSyncMetadataAccounts(), and sync-account-scoped deletion helpers
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import {
  startPostgresContainer,
  queryDbCount,
  queryDbSingle,
  checkEnvVars,
  type PostgresContainer,
} from '../testSetup'
import { runCliCommand } from './helpers/cli-process.js'
import { StripeSync } from '../../index.js'

describe('Account Management E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  let sync: StripeSync
  const cwd = process.cwd()
  let accountId: string

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    execSync('node dist/cli/index.js migrate', {
      cwd,
      env: { ...process.env, DATABASE_URL: container.databaseUrl },
      stdio: 'pipe',
    })

    sync = await StripeSync.create({
      databaseUrl: container.databaseUrl,
      stripeSecretKey: process.env.STRIPE_API_KEY!,
    })
  }, 60000)

  afterAll(async () => {
    await sync?.postgresClient?.pool?.end()
    await pool?.end()
    await container?.stop()
  }, 30000)

  describe('getCurrentAccount()', () => {
    it('should fetch and persist account to database', async () => {
      const account = await sync.getCurrentAccount()
      expect(account).not.toBeNull()
      expect(account!.id).toMatch(/^acct_/)
      accountId = account!.id

      const dbCount = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe._sync_accounts WHERE id = '${accountId}'`
      )
      expect(dbCount).toBe(1)
    })

    it('should have raw_data column populated', async () => {
      const row = await queryDbSingle<{ _raw_data: object }>(
        pool,
        `SELECT _raw_data FROM stripe._sync_accounts WHERE id = '${accountId}'`
      )
      expect(row).not.toBeNull()
      expect(row!._raw_data).not.toBeNull()
    })
  })

  describe('getAllSyncMetadataAccounts()', () => {
    it('should retrieve sync metadata accounts from database', async () => {
      const accounts = await sync.postgresClient.getAllSyncMetadataAccounts()
      expect(accounts.length).toBeGreaterThanOrEqual(1)
      expect(accounts[0].id).toMatch(/^acct_/)
    })

    it('should order sync metadata accounts by last synced', async () => {
      const accounts = await sync.postgresClient.getAllSyncMetadataAccounts()
      const firstAccount = accounts[0]
      expect(firstAccount.id).toBe(accountId)
    })
  })

  describe('sync-account-scoped deletion helpers', () => {
    beforeAll(async () => {
      runCliCommand('sync', ['product', '--rate-limit', '10', '--worker-count', '5'], {
        cwd,
        env: { DATABASE_URL: container.databaseUrl },
      })
    }, 120000)

    it('should count sync-account-scoped records before deletion', async () => {
      const productsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsBefore).toBeGreaterThan(0)

      const counts = await sync.postgresClient.getSyncAccountScopedRecordCounts(accountId)
      expect(counts.products).toBe(productsBefore)

      const productsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsAfter).toBe(productsBefore)
    })

    it('should delete all synced data for account', async () => {
      const productsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      const syncAccountsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe._sync_accounts WHERE id = '${accountId}'`
      )

      const result = await sync.postgresClient.deleteSyncAccountScopedDataWithCascade(
        accountId,
        true
      )
      expect(result.products).toBe(productsBefore)
      expect(result._sync_accounts).toBe(syncAccountsBefore)

      const productsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsAfter).toBe(0)

      const syncAccountsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe._sync_accounts WHERE id = '${accountId}'`
      )
      expect(syncAccountsAfter).toBe(0)
    })

    it('should handle non-existent account gracefully', async () => {
      const result = await sync.postgresClient.deleteSyncAccountScopedDataWithCascade(
        'acct_nonexistent',
        true
      )
      expect(result._sync_accounts).toBe(0)
    })
  })
})
