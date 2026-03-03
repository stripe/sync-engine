/**
 * Sync E2E Test
 * Tests sync command with real Stripe data and incremental sync
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
  sleep,
  type PostgresContainer,
} from '../testSetup'
import { ResourceTracker } from './helpers/cleanup.js'
import { runCliCommand } from './helpers/cli-process.js'

describe('Sync E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  const tracker = new ResourceTracker()
  const cwd = process.cwd()
  let stripe: ReturnType<typeof getStripeClient>

  const customerIds: string[] = []
  const productIds: string[] = []
  const priceIds: string[] = []

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')
    stripe = getStripeClient()

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    execSync('node dist/cli/index.js migrate', {
      cwd,
      env: { ...process.env, DATABASE_URL: container.databaseUrl },
      stdio: 'pipe',
    })

    const [customers, products] = await Promise.all([
      Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          stripe.customers.create({
            email: `test-backfill-${i + 1}@example.com`,
            name: `Test Customer ${i + 1}`,
            description: `Integration test customer ${i + 1}`,
          })
        )
      ),
      Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          stripe.products.create({
            name: `Test Product ${i + 1} - Backfill`,
            description: `Integration test product ${i + 1}`,
          })
        )
      ),
    ])

    for (const c of customers) {
      customerIds.push(c.id)
      tracker.trackCustomer(c.id)
    }
    for (const p of products) {
      productIds.push(p.id)
      tracker.trackProduct(p.id)
    }

    const prices = await Promise.all(
      productIds.map((pid, i) => {
        const params: {
          product: string
          unit_amount: number
          currency: string
          nickname: string
          recurring?: { interval: 'month' | 'year' | 'week' | 'day' }
        } = {
          product: pid,
          unit_amount: (i + 1) * 1000,
          currency: 'usd',
          nickname: `Test Price ${i + 1}`,
        }
        if (i === 2) params.recurring = { interval: 'month' }
        return stripe.prices.create(params)
      })
    )
    for (const price of prices) {
      priceIds.push(price.id)
      tracker.trackPrice(price.id)
    }
  }, 120000)

  afterAll(async () => {
    await tracker.cleanup(stripe)
    await pool?.end()
    await container?.stop()
  }, 30000)

  it('should sync all data from Stripe', async () => {
    runCliCommand('sync', ['all', '--rate-limit', '10', '--worker-count', '5'], {
      cwd,
      env: { DATABASE_URL: container.databaseUrl },
    })

    const customerCount = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.customers WHERE email LIKE 'test-backfill-%'"
    )
    expect(customerCount).toBeGreaterThanOrEqual(3)

    const productCount = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Backfill%'"
    )
    expect(productCount).toBeGreaterThanOrEqual(3)

    const priceCount = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.prices WHERE nickname LIKE 'Test Price%'"
    )
    expect(priceCount).toBeGreaterThanOrEqual(3)
  }, 120000)

  it('should save sync cursor after sync', async () => {
    // Get account ID from synced data
    const accountRow = await queryDbSingle<{ _account_id: string }>(
      pool,
      'SELECT DISTINCT _account_id FROM stripe.products LIMIT 1'
    )
    expect(accountRow).not.toBeNull()
    const accountId = accountRow!._account_id

    const cursorRow = await queryDbSingle<{ cursor: string }>(
      pool,
      `SELECT cursor FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o._account_id = '${accountId}' AND o.object = 'products' AND o.status = 'complete'
       ORDER BY o.completed_at DESC LIMIT 1`
    )
    expect(cursorRow).not.toBeNull()
    expect(parseInt(cursorRow!.cursor, 10)).toBeGreaterThan(0)
  })

  it('should have sync status as complete', async () => {
    const accountRow = await queryDbSingle<{ _account_id: string }>(
      pool,
      'SELECT DISTINCT _account_id FROM stripe.products LIMIT 1'
    )
    const accountId = accountRow!._account_id

    const statusRow = await queryDbSingle<{ status: string }>(
      pool,
      `SELECT o.status FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o._account_id = '${accountId}' AND o.object = 'products'
       ORDER BY r.started_at DESC LIMIT 1`
    )
    expect(statusRow?.status).toBe('complete')
  })

  it('should perform incremental sync on subsequent run', async () => {
    const newProduct = await stripe.products.create({
      name: 'Test Product 4 - Incremental',
      description: 'Integration test product 4 - created after first sync',
    })
    productIds.push(newProduct.id)
    tracker.trackProduct(newProduct.id)

    await sleep(2000)

    runCliCommand(
      'sync',
      ['product', '--interval', '0', '--rate-limit', '10', '--worker-count', '5'],
      {
        cwd,
        env: { DATABASE_URL: container.databaseUrl },
      }
    )

    const newProductInDb = await queryDbCount(
      pool,
      `SELECT COUNT(*) FROM stripe.products WHERE id = '${newProduct.id}'`
    )
    expect(newProductInDb).toBe(1)

    const totalProducts = await queryDbCount(
      pool,
      `SELECT COUNT(*) FROM stripe.products WHERE id IN (${productIds.map((id) => `'${id}'`).join(',')})`
    )
    expect(totalProducts).toBe(productIds.length)
  }, 60000)
})
