import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { Redis } from 'ioredis'
import { createApp } from './server.js'
import { FixedCostPricing } from './pricing.js'
import type { Config } from './config.js'
import type { PendingEvent } from './redis.js'
import { checkpointKey, pendingSetKey } from './redis.js'

// Use a unique prefix per test run to avoid collisions
const TEST_RUN_ID = `test_${Date.now()}_`

const config: Config = {
  REDIS_URL: 'redis://localhost:56379',
  CHECKPOINT_PREFIX: `${TEST_RUN_ID}sync:`,
  OPTIMISTIC_PREFIX: `${TEST_RUN_ID}optimistic:`,
  CREDIT_TYPE_ID: 'test-credit-type-001',
  PORT: 4199,
  WATERMARK_BUFFER_MS: 10_000,
  FIXED_EVENT_COST: 1,
}

let redis: Redis
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 })
  await redis.ping()
  const pricing = new FixedCostPricing(config.FIXED_EVENT_COST)
  app = createApp({ redis, config, pricing })
})

beforeEach(async () => {
  const patterns = [
    `${config.CHECKPOINT_PREFIX}*`,
    `${config.OPTIMISTIC_PREFIX}*`,
  ]
  for (const pattern of patterns) {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) {
        await redis.del(...keys)
      }
    } while (cursor !== '0')
  }
})

afterAll(async () => {
  const patterns = [
    `${config.CHECKPOINT_PREFIX}*`,
    `${config.OPTIMISTIC_PREFIX}*`,
  ]
  for (const pattern of patterns) {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) {
        await redis.del(...keys)
      }
    } while (cursor !== '0')
  }
  await redis.quit()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function seedCheckpoint(customerId: string, balance: number, syncedAtSec?: number) {
  const checkpoint = {
    balance,
    customer_id: customerId,
    credit_type_id: config.CREDIT_TYPE_ID,
    _synced_at: syncedAtSec ?? Math.floor(Date.now() / 1000),
  }
  const key = checkpointKey(config, customerId)
  await redis.set(key, JSON.stringify(checkpoint))
  return checkpoint
}

function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return app.request(path, init)
}

// ─── GET /v1/health ──────────────────────────────────────────────────────────

describe('GET /v1/health', () => {
  it('returns ok:true when Redis is connected', async () => {
    const res = await request('GET', '/v1/health')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.redis).toBe('connected')
  })

  it('reports last_checkpoint_age_ms when a checkpoint exists', async () => {
    const now = Math.floor(Date.now() / 1000)
    await seedCheckpoint('cust_health_test', 100, now)

    const res = await request('GET', '/v1/health')
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.last_checkpoint_age_ms).toBeTypeOf('number')
    expect(json.last_checkpoint_age_ms).toBeLessThan(5000)
  })

  it('returns 503 when Redis is unreachable', async () => {
    const badRedis = new Redis('redis://localhost:1', {
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      connectTimeout: 100,
    })
    const badApp = createApp({
      redis: badRedis,
      config,
      pricing: new FixedCostPricing(1),
    })

    const res = await badApp.request('/v1/health', { method: 'GET' })
    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.redis).toBe('disconnected')

    badRedis.disconnect()
  })
})

// ─── GET /v1/balance/:customer_id ────────────────────────────────────────────

describe('GET /v1/balance/:customer_id', () => {
  it('returns 503 when no checkpoint exists', async () => {
    const res = await request('GET', '/v1/balance/cust_nonexistent')
    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.error).toContain('No checkpoint')
  })

  it('returns checkpoint balance with no pending events', async () => {
    const now = Math.floor(Date.now() / 1000)
    await seedCheckpoint('cust_balance_1', 500, now)

    const res = await request('GET', '/v1/balance/cust_balance_1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.checkpoint_balance).toBe(500)
    expect(json.optimistic_balance).toBe(500)
    expect(json.pending_events).toBe(0)
    expect(json.confidence).toBe('high')
  })

  it('returns optimistic balance when pending events exist', async () => {
    const now = Math.floor(Date.now() / 1000)
    await seedCheckpoint('cust_balance_2', 100, now)

    const key = pendingSetKey(config, 'cust_balance_2')
    for (let i = 0; i < 3; i++) {
      const member = JSON.stringify({
        event_id: `evt_test_${i}`,
        event_type: 'api_call',
        estimated_cost: 1,
      })
      await redis.zadd(key, String(Date.now() + i), member)
    }

    const res = await request('GET', '/v1/balance/cust_balance_2')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.checkpoint_balance).toBe(100)
    expect(json.optimistic_balance).toBe(97)
    expect(json.pending_events).toBe(3)
  })

  it('prunes stale events on read (inline reconciliation)', async () => {
    const now = Math.floor(Date.now() / 1000)
    await seedCheckpoint('cust_inline_recon', 100, now)

    const key = pendingSetKey(config, 'cust_inline_recon')

    // Old event (before cutoff: _synced_at*1000 - WATERMARK_BUFFER_MS)
    const oldTs = (now * 1000) - config.WATERMARK_BUFFER_MS - 5000
    await redis.zadd(key, String(oldTs), JSON.stringify({
      event_id: 'evt_old',
      event_type: 'api_call',
      estimated_cost: 1,
    }))

    // Recent event (after cutoff)
    await redis.zadd(key, String(Date.now()), JSON.stringify({
      event_id: 'evt_new',
      event_type: 'api_call',
      estimated_cost: 1,
    }))

    const res = await request('GET', '/v1/balance/cust_inline_recon')
    const json = await res.json()
    expect(json.optimistic_balance).toBe(99) // only new event counted
    expect(json.pending_events).toBe(1)

    // Verify old event was actually removed from Redis
    const remaining = await redis.zrange(key, 0, -1)
    expect(remaining).toHaveLength(1)
    expect(JSON.parse(remaining[0]!).event_id).toBe('evt_new')
  })

  it('confidence is "high" when checkpoint is fresh (<30s)', async () => {
    const now = Math.floor(Date.now() / 1000)
    await seedCheckpoint('cust_conf_high', 100, now)

    const res = await request('GET', '/v1/balance/cust_conf_high')
    const json = await res.json()
    expect(json.confidence).toBe('high')
  })

  it('confidence is "medium" when checkpoint is 30s-120s old', async () => {
    const sixtySecondsAgo = Math.floor(Date.now() / 1000) - 60
    await seedCheckpoint('cust_conf_med', 100, sixtySecondsAgo)

    const res = await request('GET', '/v1/balance/cust_conf_med')
    const json = await res.json()
    expect(json.confidence).toBe('medium')
  })

  it('confidence is "low" when checkpoint is >120s old', async () => {
    const threeMinutesAgo = Math.floor(Date.now() / 1000) - 180
    await seedCheckpoint('cust_conf_low', 100, threeMinutesAgo)

    const res = await request('GET', '/v1/balance/cust_conf_low')
    const json = await res.json()
    expect(json.confidence).toBe('low')
  })
})

// ─── POST /v1/events ─────────────────────────────────────────────────────────

describe('POST /v1/events', () => {
  it('rejects missing customer_id', async () => {
    const res = await request('POST', '/v1/events', { event_type: 'api_call' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('customer_id')
  })

  it('rejects missing event_type', async () => {
    const res = await request('POST', '/v1/events', { customer_id: 'cust_1' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('event_type')
  })

  it('generates event_id and returns estimated cost', async () => {
    await seedCheckpoint('cust_evt_1', 50)

    const res = await request('POST', '/v1/events', {
      customer_id: 'cust_evt_1',
      event_type: 'api_call',
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.event_id).toMatch(/^evt_/)
    expect(json.estimated_cost).toBe(1)
    expect(json.optimistic_balance).toBe(49)
    expect(json.pending_events).toBe(1)
  })

  it('uses idempotency_key as event_id when provided', async () => {
    await seedCheckpoint('cust_evt_2', 50)

    const res = await request('POST', '/v1/events', {
      customer_id: 'cust_evt_2',
      event_type: 'api_call',
      idempotency_key: 'my-custom-key-123',
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.event_id).toBe('my-custom-key-123')
  })

  it('decrements balance with each event', async () => {
    await seedCheckpoint('cust_evt_3', 10)

    await request('POST', '/v1/events', {
      customer_id: 'cust_evt_3',
      event_type: 'api_call',
    })
    await request('POST', '/v1/events', {
      customer_id: 'cust_evt_3',
      event_type: 'api_call',
    })

    const res = await request('GET', '/v1/balance/cust_evt_3')
    const json = await res.json()
    expect(json.optimistic_balance).toBe(8)
    expect(json.pending_events).toBe(2)
  })

  it('works even without a checkpoint (balance defaults to 0)', async () => {
    const res = await request('POST', '/v1/events', {
      customer_id: 'cust_no_checkpoint',
      event_type: 'api_call',
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.optimistic_balance).toBe(-1)
  })

  it('deduplicates events by idempotency_key', async () => {
    await seedCheckpoint('cust_dedup', 100)

    const res1 = await request('POST', '/v1/events', {
      customer_id: 'cust_dedup',
      event_type: 'api_call',
      idempotency_key: 'same_key',
    })
    const json1 = await res1.json()
    expect(json1.optimistic_balance).toBe(99)

    const res2 = await request('POST', '/v1/events', {
      customer_id: 'cust_dedup',
      event_type: 'api_call',
      idempotency_key: 'same_key',
    })
    const json2 = await res2.json()
    expect(json2.duplicate).toBe(true)
    expect(json2.optimistic_balance).toBe(99)
    expect(json2.pending_events).toBe(1)
  })

  it('passes properties through to the pending event', async () => {
    await seedCheckpoint('cust_props', 50)

    await request('POST', '/v1/events', {
      customer_id: 'cust_props',
      event_type: 'api_call',
      properties: { model: 'gpt-4', tokens: 500 },
    })

    const key = pendingSetKey(config, 'cust_props')
    const members = await redis.zrange(key, 0, -1)
    expect(members).toHaveLength(1)
    const stored = JSON.parse(members[0]!)
    expect(stored.properties).toEqual({ model: 'gpt-4', tokens: 500 })
  })
})

// ─── FixedCostPricing ────────────────────────────────────────────────────────

describe('FixedCostPricing', () => {
  it('returns configured cost for any event type', () => {
    const pricing = new FixedCostPricing(5)
    expect(pricing.estimateCost('api_call')).toBe(5)
    expect(pricing.estimateCost('webhook')).toBe(5)
    expect(pricing.estimateCost('anything', { foo: 'bar' })).toBe(5)
  })

  it('supports fractional cost', () => {
    const pricing = new FixedCostPricing(0.25)
    expect(pricing.estimateCost('api_call')).toBe(0.25)
  })
})

// ─── Full Flow ───────────────────────────────────────────────────────────────

describe('full flow: checkpoint -> events -> balance -> new checkpoint -> prune', () => {
  it('end-to-end optimistic balance lifecycle', async () => {
    const customerId = 'cust_e2e_flow'
    const now = Math.floor(Date.now() / 1000)

    // Step 1: No checkpoint — balance returns 503
    const r1 = await request('GET', `/v1/balance/${customerId}`)
    expect(r1.status).toBe(503)

    // Step 2: Checkpoint arrives
    await seedCheckpoint(customerId, 1000, now)

    // Step 3: Balance shows full checkpoint amount
    const r2 = await request('GET', `/v1/balance/${customerId}`)
    const b2 = await r2.json()
    expect(b2.checkpoint_balance).toBe(1000)
    expect(b2.optimistic_balance).toBe(1000)

    // Step 4: User sends 3 events
    for (let i = 0; i < 3; i++) {
      await request('POST', '/v1/events', {
        customer_id: customerId,
        event_type: 'api_call',
      })
    }

    // Step 5: Balance reflects pending deductions
    const r3 = await request('GET', `/v1/balance/${customerId}`)
    const b3 = await r3.json()
    expect(b3.optimistic_balance).toBe(997)
    expect(b3.pending_events).toBe(3)

    // Step 6: New checkpoint arrives (Metronome processed the events)
    const laterSyncedAt = now + 30
    await seedCheckpoint(customerId, 997, laterSyncedAt)

    // Step 7: GET /v1/balance triggers inline reconciliation — prunes old events
    const r4 = await request('GET', `/v1/balance/${customerId}`)
    const b4 = await r4.json()
    expect(b4.checkpoint_balance).toBe(997)
    expect(b4.optimistic_balance).toBe(997)
    expect(b4.pending_events).toBe(0)
  })
})
