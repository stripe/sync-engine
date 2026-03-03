/**
 * Account Management E2E Test
 * Tests getCurrentAccount(), getAllSyncedAccounts(), and dangerouslyDeleteSyncedAccountData()
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
        `SELECT COUNT(*) FROM stripe.accounts WHERE id = '${accountId}'`
      )
      expect(dbCount).toBe(1)
    })

    it('should have raw_data column populated', async () => {
      const row = await queryDbSingle<{ _raw_data: object }>(
        pool,
        `SELECT _raw_data FROM stripe.accounts WHERE id = '${accountId}'`
      )
      expect(row).not.toBeNull()
      expect(row!._raw_data).not.toBeNull()
    })
  })

  describe('getAllSyncedAccounts()', () => {
    it('should retrieve synced accounts from database', async () => {
      const accounts = await sync.postgresClient.getAllSyncedAccounts()
      expect(accounts.length).toBeGreaterThanOrEqual(1)
      expect(accounts[0].id).toMatch(/^acct_/)
    })

    it('should order accounts by last synced', async () => {
      const accounts = await sync.postgresClient.getAllSyncedAccounts()
      const firstAccount = accounts[0]
      expect(firstAccount.id).toBe(accountId)
    })
  })

  describe('dangerouslyDeleteSyncedAccountData()', () => {
    beforeAll(async () => {
      runCliCommand('sync', ['product', '--rate-limit', '10', '--worker-count', '5'], {
        cwd,
        env: { DATABASE_URL: container.databaseUrl },
      })
    }, 120000)

    it('should preview deletion with dry-run (no actual deletion)', async () => {
      const productsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsBefore).toBeGreaterThan(0)

      const result = await sync.postgresClient.dangerouslyDeleteSyncedAccountData(accountId, {
        dryRun: true,
      })
      expect(result.deletedAccountId).toBe(accountId)
      expect(result.deletedRecordCounts).toBeDefined()
      expect(result.deletedRecordCounts.products).toBe(productsBefore)

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
      const accountsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.accounts WHERE id = '${accountId}'`
      )

      const result = await sync.postgresClient.dangerouslyDeleteSyncedAccountData(accountId, {
        dryRun: false,
      })
      expect(result.deletedAccountId).toBe(accountId)
      expect(result.deletedRecordCounts.products).toBe(productsBefore)
      expect(result.deletedRecordCounts.accounts).toBe(accountsBefore)

      const productsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsAfter).toBe(0)

      const accountsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.accounts WHERE id = '${accountId}'`
      )
      expect(accountsAfter).toBe(0)
    })

    it('should handle non-existent account gracefully', async () => {
      const result = await sync.postgresClient.dangerouslyDeleteSyncedAccountData(
        'acct_nonexistent',
        {
          dryRun: false,
        }
      )
      expect(result.deletedRecordCounts.accounts).toBe(0)
    })
  })
})
