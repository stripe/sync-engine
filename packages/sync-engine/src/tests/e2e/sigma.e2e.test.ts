/**
 * Sigma E2E Test
 * Tests Sigma table sync functionality with --sigma flag
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import {
  startPostgresContainer,
  queryDbCount,
  queryDbSingle,
  getStripeClient,
  checkEnvVars,
  type PostgresContainer,
} from '../testSetup'
import { ResourceTracker } from './helpers/cleanup.js'
import { runCliCommand } from './helpers/cli-process.js'

describe('Sigma E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  const tracker = new ResourceTracker()
  const cwd = process.cwd()
  let stripe: ReturnType<typeof getStripeClient>
  let productId: string

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY_3')
    stripe = getStripeClient('STRIPE_API_KEY_3')

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    execSync('node dist/cli/index.js migrate --sigma', {
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: container.databaseUrl,
        STRIPE_API_KEY: process.env.STRIPE_API_KEY_3,
      },
      stdio: 'pipe',
    })

    const product = await stripe.products.create({
      name: 'Sigma Test Product',
      description: 'Integration test product for sigma test',
    })
    productId = product.id
    tracker.trackProduct(productId)
  }, 120000)

  afterAll(async () => {
    await tracker.cleanup(stripe)
    await pool?.end()
    await container?.stop()
  }, 30000)

  it('should sync products (non-sigma)', async () => {
    runCliCommand(
      'sync',
      ['product', '--interval', '0', '--rate-limit', '10', '--worker-count', '5'],
      {
        cwd,
        env: {
          DATABASE_URL: container.databaseUrl,
          STRIPE_API_KEY: process.env.STRIPE_API_KEY_3!,
        },
      }
    )

    const productCount = await queryDbCount(
      pool,
      `SELECT COUNT(*) FROM stripe.products WHERE id = '${productId}'`
    )
    expect(productCount).toBe(1)
  }, 60000)

  it('should sync subscription_item_change_events_v2_beta (sigma)', async () => {
    runCliCommand(
      'sync',
      [
        '--sigma',
        'subscription_item_change_events_v2_beta',
        '--interval',
        '0',
        '--rate-limit',
        '10',
        '--worker-count',
        '5',
      ],
      {
        cwd,
        env: {
          DATABASE_URL: container.databaseUrl,
          STRIPE_API_KEY: process.env.STRIPE_API_KEY_3!,
        },
      }
    )

    const count = await queryDbCount(
      pool,
      'SELECT COUNT(*) FROM sigma.subscription_item_change_events_v2_beta'
    )
    expect(count).toBeGreaterThan(0)
  }, 60000)

  it('should sync exchange_rates_from_usd (sigma)', async () => {
    runCliCommand(
      'sync',
      [
        '--sigma',
        'exchange_rates_from_usd',
        '--interval',
        '0',
        '--rate-limit',
        '10',
        '--worker-count',
        '5',
      ],
      {
        cwd,
        env: {
          DATABASE_URL: container.databaseUrl,
          STRIPE_API_KEY: process.env.STRIPE_API_KEY_3!,
        },
      }
    )

    const count = await queryDbCount(pool, 'SELECT COUNT(*) FROM sigma.exchange_rates_from_usd')
    expect(count).toBeGreaterThan(0)
  }, 60000)

  it('should track sync status correctly', async () => {
    const accountRow = await queryDbSingle<{ _account_id: string }>(
      pool,
      'SELECT DISTINCT _account_id FROM sigma.subscription_item_change_events_v2_beta LIMIT 1'
    )

    if (!accountRow) {
      const accountRow2 = await queryDbSingle<{ _account_id: string }>(
        pool,
        'SELECT DISTINCT _account_id FROM sigma.exchange_rates_from_usd LIMIT 1'
      )
      expect(accountRow2).not.toBeNull()
    }

    const accountId = accountRow?._account_id

    if (accountId) {
      const siceStatus = await queryDbSingle<{ status: string }>(
        pool,
        `SELECT o.status FROM stripe._sync_obj_runs o
         JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
         WHERE o._account_id = '${accountId}' AND o.object = 'subscription_item_change_events_v2_beta'
         ORDER BY r.started_at DESC LIMIT 1`
      )
      expect(siceStatus?.status).toBe('complete')

      const exchangeStatus = await queryDbSingle<{ status: string }>(
        pool,
        `SELECT o.status FROM stripe._sync_obj_runs o
         JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
         WHERE o._account_id = '${accountId}' AND o.object = 'exchange_rates_from_usd'
         ORDER BY r.started_at DESC LIMIT 1`
      )
      expect(exchangeStatus?.status).toBe('complete')
    }
  })
})
