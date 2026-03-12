import { vi, describe } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import Stripe from 'stripe'
import { StripeSync, runMigrations } from '../index'
import type { StripeSyncConfig } from '../types'

// ---------------------------------------------------------------------------
// Docker Postgres Container
// ---------------------------------------------------------------------------

const POSTGRES_IMAGE = 'postgres:15-alpine'
const POSTGRES_USER = 'postgres'
const POSTGRES_PASSWORD = 'postgres'
const POSTGRES_DB = 'test'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll `condition` until it returns true or `timeoutMs` elapses.
 * Exits early (no error) the moment the condition is satisfied.
 * Throws if the timeout expires without the condition being met.
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  opts?: { intervalMs?: number; message?: string }
): Promise<void> {
  const { intervalMs = 500, message } = opts ?? {}
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(Math.min(intervalMs, deadline - Date.now()))
  }
  throw new Error(message ?? `waitFor timed out after ${timeoutMs}ms`)
}

export interface PostgresContainer {
  databaseUrl: string
  port: number
  containerId: string
  stop(): Promise<void>
}

/**
 * Start an isolated Postgres container with a random host port.
 * Each test suite gets its own database — safe for parallel execution.
 */
export async function startPostgresContainer(): Promise<PostgresContainer> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const containerName = `test-pg-${suffix}`

  // Clean up any leftover container with the same name
  execSync(`docker rm -f ${containerName} 2>/dev/null || true`, { stdio: 'pipe' })

  // Start container; -p 0:5432 lets Docker pick a free host port
  const containerId = execSync(
    [
      'docker run -d',
      `--name ${containerName}`,
      `-e POSTGRES_USER=${POSTGRES_USER}`,
      `-e POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
      `-e POSTGRES_DB=${POSTGRES_DB}`,
      '-p 0:5432',
      POSTGRES_IMAGE,
    ].join(' '),
    { encoding: 'utf-8' }
  ).trim()

  // Discover the randomly assigned host port
  const portMapping = execSync(`docker port ${containerId} 5432`, {
    encoding: 'utf-8',
  }).trim()
  // Output looks like "0.0.0.0:55123" or ":::55123" — grab the port number
  const port = parseInt(portMapping.split(':').pop()!, 10)

  const databaseUrl = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${port}/${POSTGRES_DB}`

  // Wait until we can actually execute a query, not just pg_isready
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const testPool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
      await testPool.query('SELECT 1')
      await testPool.end()
      ready = true
      break
    } catch {
      await sleep(500)
    }
  }
  if (!ready) {
    execSync(`docker rm -f ${containerId} 2>/dev/null || true`, { stdio: 'pipe' })
    throw new Error(`Postgres container ${containerName} did not become ready`)
  }

  return {
    databaseUrl,
    port,
    containerId,
    async stop() {
      try {
        execSync(`docker rm -f ${containerId} 2>/dev/null || true`, { stdio: 'pipe' })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Conditional describe
// ---------------------------------------------------------------------------

export function describeWithDb(dbUrl: string | undefined) {
  return (dbUrl ? describe : describe.skip) as typeof describe
}

// ---------------------------------------------------------------------------
// Database Setup & Teardown
// ---------------------------------------------------------------------------

export interface TestDatabase {
  databaseUrl: string
  pool: pg.Pool
  container: PostgresContainer
  clearSyncData(accountId: string): Promise<void>
  clearTables(accountId: string, tables: string[]): Promise<void>
  /** Shut down the pool and stop the container — call in afterAll */
  close(): Promise<void>
}

/**
 * Start a fresh Postgres container, run migrations, return a pool + helpers.
 * Each call spins up its own isolated database.
 */
export async function setupTestDatabase(opts?: { enableSigma?: boolean }): Promise<TestDatabase> {
  const container = await startPostgresContainer()
  const { databaseUrl } = container

  await runMigrations({ databaseUrl, enableSigma: opts?.enableSigma })

  const pool = new pg.Pool({ connectionString: databaseUrl })

  return {
    databaseUrl,
    pool,
    container,

    async clearSyncData(accountId: string) {
      await pool.query('DELETE FROM stripe._sync_obj_runs WHERE _account_id = $1', [accountId])
      await pool.query('DELETE FROM stripe._sync_runs WHERE _account_id = $1', [accountId])
    },

    async clearTables(accountId: string, tables: string[]) {
      for (const table of tables) {
        await pool.query(`DELETE FROM ${table} WHERE _account_id = $1`, [accountId])
      }
    },

    async close() {
      await pool.end()
      await container.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// StripeSync Creation Helpers
// ---------------------------------------------------------------------------

/**
 * Create a real StripeSync instance pointed at a test database.
 * The Stripe key is fake — callers are expected to mock the Stripe client.
 */
export async function createTestStripeSync(opts: {
  databaseUrl: string
  accountId?: string
  stripeSecretKey?: string
  enableSigma?: boolean
}): Promise<StripeSync> {
  return StripeSync.create({
    stripeSecretKey: opts.stripeSecretKey ?? 'sk_test_fake',
    stripeAccountId: opts.accountId,
    databaseUrl: opts.databaseUrl,
    enableSigma: opts.enableSigma,
  })
}

/**
 * Create a StripeSync instance that is fully disconnected from a real DB.
 * Useful for unit tests that only exercise in-memory logic or mock Stripe calls.
 */
export async function createMockedStripeSync(
  configOverrides?: Partial<StripeSyncConfig>
): Promise<StripeSync> {
  const { StripeSync: SS } = await import('../stripeSync')
  vi.spyOn(SS.prototype, 'getCurrentAccount').mockResolvedValue({
    id: 'acct_test',
  } as Stripe.Account)

  return SS.create({
    stripeSecretKey: 'sk_test_fake',
    databaseUrl: 'postgresql://fake',
    ...configOverrides,
  })
}

/**
 * Upsert a sync metadata account root so foreign-key constraints are satisfied.
 */
export async function upsertTestAccount(sync: StripeSync, accountId: string): Promise<void> {
  await sync.postgresClient.upsertSyncMetadataAccount(
    { id: accountId, raw_data: { id: accountId } },
    'test_hash'
  )
}

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

type MockStripeObject = { id: string; created: number; [key: string]: unknown }

let customerIdCounter = 0
let planIdCounter = 0
let couponIdCounter = 0

export function resetMockCounters(): void {
  customerIdCounter = 0
  planIdCounter = 0
  couponIdCounter = 0
}

export function createMockCustomer(
  overrides: { id?: string; created?: number } = {}
): MockStripeObject {
  customerIdCounter++
  return {
    id: overrides.id ?? `cus_test_${customerIdCounter.toString().padStart(6, '0')}`,
    object: 'customer',
    created: overrides.created ?? Math.floor(Date.now() / 1000) - customerIdCounter,
  }
}

export function createMockPlan(
  overrides: { id?: string; created?: number } = {}
): MockStripeObject {
  planIdCounter++
  return {
    id: overrides.id ?? `plan_test_${planIdCounter.toString().padStart(6, '0')}`,
    object: 'plan',
    created: overrides.created ?? Math.floor(Date.now() / 1000) - planIdCounter,
  }
}

export function createMockCoupon(
  overrides: { id?: string; created?: number; deleted?: boolean } = {}
): MockStripeObject {
  couponIdCounter++
  return {
    id: overrides.id ?? `coupon_test_${couponIdCounter.toString().padStart(6, '0')}`,
    object: 'coupon',
    created: overrides.created ?? Math.floor(Date.now() / 1000) - couponIdCounter,
    ...(overrides.deleted != null ? { deleted: overrides.deleted } : {}),
  }
}

export function createMockCouponBatch(count: number, startTimestamp?: number): MockStripeObject[] {
  const baseTimestamp = startTimestamp ?? Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => createMockCoupon({ created: baseTimestamp - i }))
}

export function createMockCustomerBatch(
  count: number,
  startTimestamp?: number
): MockStripeObject[] {
  const baseTimestamp = startTimestamp ?? Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => createMockCustomer({ created: baseTimestamp - i }))
}

export function createMockPlanBatch(count: number, startTimestamp?: number): MockStripeObject[] {
  const baseTimestamp = startTimestamp ?? Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => createMockPlan({ created: baseTimestamp - i }))
}

// ---------------------------------------------------------------------------
// Paginated Response Helper (simulates Stripe list API)
// ---------------------------------------------------------------------------

export function createPaginatedResponse(
  allItems: MockStripeObject[],
  params: {
    limit?: number
    starting_after?: string
    created?: { gte?: number; lte?: number }
  } = {}
): { data: MockStripeObject[]; has_more: boolean; object: 'list' } {
  const limit = params.limit ?? 100

  let items = [...allItems].sort((a, b) => b.created - a.created)

  if (params.created?.gte) {
    items = items.filter((item) => item.created >= params.created!.gte!)
  }
  if (params.created?.lte) {
    items = items.filter((item) => item.created <= params.created!.lte!)
  }
  if (params.starting_after) {
    const cursorIndex = items.findIndex((item) => item.id === params.starting_after)
    if (cursorIndex !== -1) {
      items = items.slice(cursorIndex + 1)
    }
  }

  const pageItems = items.slice(0, limit)
  return { data: pageItems, has_more: items.length > limit, object: 'list' }
}

// ---------------------------------------------------------------------------
// Database Validator (query helpers for assertions)
// ---------------------------------------------------------------------------

export class DatabaseValidator {
  private pool: pg.Pool

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl })
  }

  async getRowCount(table: string, accountId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${table} WHERE _account_id = $1`,
      [accountId]
    )
    return parseInt(result.rows[0].count, 10)
  }

  async getColumnValues(table: string, column: string, accountId: string): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT ${column} FROM ${table} WHERE _account_id = $1 ORDER BY ${column}`,
      [accountId]
    )
    return result.rows.map((row) => row[column])
  }

  async clearAccountData(accountId: string, dataTables: string[] = []): Promise<void> {
    for (const table of dataTables) {
      await this.pool.query(`DELETE FROM ${table} WHERE _account_id = $1`, [accountId])
    }
    await this.pool.query('DELETE FROM stripe._sync_obj_runs WHERE _account_id = $1', [accountId])
    await this.pool.query('DELETE FROM stripe._sync_runs WHERE _account_id = $1', [accountId])
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

// ---------------------------------------------------------------------------
// Lightweight Query Helpers (for tests that use a raw pg.Pool)
// ---------------------------------------------------------------------------

export async function queryDb<T = Record<string, unknown>>(
  pool: pg.Pool,
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query(sql, params)
  return result.rows as T[]
}

export async function queryDbSingle<T = Record<string, unknown>>(
  pool: pg.Pool,
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await queryDb<T>(pool, sql, params)
  return rows[0] ?? null
}

export async function queryDbCount(
  pool: pg.Pool,
  sql: string,
  params?: unknown[]
): Promise<number> {
  const result = await pool.query(sql, params)
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

// ---------------------------------------------------------------------------
// E2E Helpers
// ---------------------------------------------------------------------------

export function getStripeClient(keyEnvVar = 'STRIPE_API_KEY'): Stripe {
  const apiKey = process.env[keyEnvVar]
  if (!apiKey) {
    throw new Error(`Environment variable ${keyEnvVar} is not set`)
  }
  return new Stripe(apiKey)
}

export function checkEnvVars(...vars: string[]): void {
  const missing = vars.filter((v) => !process.env[v])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Stripe Mock Injection
// ---------------------------------------------------------------------------

/**
 * Replace a Stripe resource namespace (e.g. `customers`) with mock functions.
 * Returns the mock so callers can set up `.mockImplementation(...)`.
 *
 * @example
 *   const mocks = mockStripeResource(sync, 'customers', ['list', 'retrieve'])
 *   mocks.list.mockImplementation(...)
 */
export function mockStripeResource<M extends string>(
  sync: StripeSync,
  resource: string,
  methods: M[]
): Record<M, ReturnType<typeof vi.fn>> {
  const mocks = {} as Record<M, ReturnType<typeof vi.fn>>
  const namespace: Record<string, unknown> = {}

  for (const method of methods) {
    const fn = vi.fn()
    mocks[method] = fn
    namespace[method] = fn
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(sync.stripe as any)[resource] = namespace
  return mocks
}

export type { MockStripeObject }
