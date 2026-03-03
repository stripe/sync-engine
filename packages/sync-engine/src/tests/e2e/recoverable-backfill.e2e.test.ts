/**
 * Error Recovery E2E Test
 * Tests that sync can recover from crashes and preserve partial progress
 *
 * NOTE: This test requires write permissions to create test products.
 * It will be skipped if using restricted API keys (rk_*).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn } from 'child_process'
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

describe('Error Recovery E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  const tracker = new ResourceTracker()
  let stripe: ReturnType<typeof getStripeClient>
  const cwd = process.cwd()
  let hasWritePermissions = false

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')
    stripe = getStripeClient()

    try {
      const testProduct = await stripe.products.create({
        name: 'Permission Test Product',
        description: 'Testing write permissions',
      })
      await stripe.products.update(testProduct.id, { active: false })
      hasWritePermissions = true
    } catch (err: unknown) {
      const stripeError = err as { code?: string; type?: string }
      if (stripeError.code === 'permission_error' || stripeError.type === 'StripePermissionError') {
        console.log('Skipping Error Recovery tests: API key lacks write permissions')
        hasWritePermissions = false
        return
      }
      throw err
    }

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    execSync('node dist/cli/index.js migrate', {
      cwd,
      env: { ...process.env, DATABASE_URL: container.databaseUrl },
      stdio: 'pipe',
    })

    const batchSize = 10
    for (let i = 0; i < 100; i += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, 100 - i) }, (_, j) =>
        stripe.products.create({
          name: `Test Product ${i + j + 1} - Recovery`,
          description: `Integration test product ${i + j + 1} for error recovery`,
        })
      )
      const results = await Promise.all(batch)
      results.forEach((p) => tracker.trackProduct(p.id))
      await sleep(500)
    }
  }, 300000)

  afterAll(async () => {
    if (hasWritePermissions) {
      await tracker.cleanup(stripe)
    }
    await pool?.end()
    await container?.stop()
  }, 60000)

  it('should preserve partial progress and recover after crash', async () => {
    if (!hasWritePermissions) {
      console.log('Skipping: requires write permissions')
      return
    }

    const syncProcess = spawn(
      'node',
      ['dist/cli/index.js', 'sync', 'product', '--rate-limit', '10', '--worker-count', '5'],
      {
        cwd,
        env: { ...process.env, DATABASE_URL: container.databaseUrl },
        stdio: 'pipe',
      }
    )

    let status = ''
    let productsBeforeKill = 0
    let attempts = 0
    const maxAttempts = 200

    while (attempts < maxAttempts) {
      const statusRow = await queryDbSingle<{ status: string }>(
        pool,
        `SELECT o.status FROM stripe._sync_obj_runs o
         JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
         WHERE o.object = 'products'
         ORDER BY r.started_at DESC LIMIT 1`
      )
      status = statusRow?.status ?? ''

      productsBeforeKill = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')

      if (status === 'running' && productsBeforeKill > 0) {
        break
      }

      if (status === 'complete') {
        break
      }

      await sleep(100)
      attempts++
    }

    if (status === 'complete') {
      console.log('Sync completed before interruption - verifying completion instead')
      const finalProducts = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
      expect(finalProducts).toBeGreaterThanOrEqual(100)
      syncProcess.kill('SIGTERM')
      return
    }

    if (productsBeforeKill === 0) {
      console.log('Could not catch sync in progress with products - skipping crash test')
      syncProcess.kill('SIGTERM')
      return
    }

    expect(status).toBe('running')

    syncProcess.kill('SIGKILL')
    await sleep(500)

    const productsAfterKill = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
    expect(productsAfterKill).toBeGreaterThanOrEqual(productsBeforeKill)

    runCliCommand('sync', ['product', '--rate-limit', '10', '--worker-count', '5'], {
      cwd,
      env: { DATABASE_URL: container.databaseUrl },
    })

    const finalStatusRow = await queryDbSingle<{ status: string }>(
      pool,
      `SELECT o.status FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o.object = 'products'
       ORDER BY r.started_at DESC LIMIT 1`
    )
    expect(finalStatusRow?.status).toBe('complete')

    const finalProducts = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
    expect(finalProducts).toBeGreaterThanOrEqual(100)
  }, 120000)
})
