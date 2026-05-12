import { Hono } from 'hono'
import type { Config } from './config.js'
import type { Redis } from './redis.js'
import type { PricingStrategy } from './pricing.js'
import {
  getCheckpoint,
  pendingSetKey,
  sumPendingCosts,
} from './redis.js'
import type { PendingEvent } from './redis.js'

export interface ServerDeps {
  redis: Redis
  config: Config
  pricing: PricingStrategy
}

export function createApp(deps: ServerDeps): Hono {
  const { redis, config, pricing } = deps
  const app = new Hono()

  // Health check
  app.get('/v1/health', async (c) => {
    try {
      await redis.ping()
      let lastCheckpointAgeMs: number | null = null
      const pattern = `${config.CHECKPOINT_PREFIX}net_balance:*`
      let cursor = '0'
      let foundKey: string | null = null
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = nextCursor
        if (keys.length > 0) {
          foundKey = keys[0]!
          break
        }
      } while (cursor !== '0')

      if (foundKey) {
        const raw = await redis.get(foundKey)
        if (raw) {
          const data = JSON.parse(raw)
          const syncedAtMs = Number(data._synced_at) * 1000
          lastCheckpointAgeMs = Date.now() - syncedAtMs
        }
      }
      return c.json({
        ok: true,
        redis: 'connected',
        last_checkpoint_age_ms: lastCheckpointAgeMs,
      })
    } catch {
      return c.json({ ok: false, redis: 'disconnected', last_checkpoint_age_ms: null }, 503)
    }
  })

  // Get balance (inline reconciliation: prune stale events, compute fresh)
  app.get('/v1/balance/:customer_id', async (c) => {
    const customerId = c.req.param('customer_id')
    const checkpoint = await getCheckpoint(redis, config, customerId)

    if (!checkpoint) {
      return c.json(
        { error: 'No checkpoint available. Start the sync engine.' },
        503
      )
    }

    const syncedAtMs = checkpoint._synced_at * 1000
    const cutoff = syncedAtMs - config.WATERMARK_BUFFER_MS

    // Prune events older than cutoff (inline reconciliation)
    const key = pendingSetKey(config, customerId)
    await redis.zremrangebyscore(key, '-inf', cutoff)

    // Compute balance from remaining pending events
    const { total, count } = await sumPendingCosts(redis, config, customerId)
    const optimisticBalance = checkpoint.balance - total

    const ageMs = Date.now() - syncedAtMs
    let confidence: 'high' | 'medium' | 'low'
    if (ageMs < 30_000) {
      confidence = 'high'
    } else if (ageMs < 120_000) {
      confidence = 'medium'
    } else {
      confidence = 'low'
    }

    return c.json({
      checkpoint_balance: checkpoint.balance,
      optimistic_balance: optimisticBalance,
      pending_events: count,
      last_checkpoint_at: Math.floor(syncedAtMs / 1000),
      confidence,
    })
  })

  // Record event
  app.post('/v1/events', async (c) => {
    const body = await c.req.json()
    const { customer_id, event_type, properties, idempotency_key } = body

    if (!customer_id) {
      return c.json({ error: 'customer_id is required' }, 400)
    }
    if (!event_type) {
      return c.json({ error: 'event_type is required' }, 400)
    }

    const eventId =
      idempotency_key || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const estimatedCost = pricing.estimateCost(event_type, properties)
    const timestamp = Date.now()

    const key = pendingSetKey(config, customer_id)
    // Member is deterministic by event_id — excludes timestamp so retries with same
    // idempotency_key don't create duplicates regardless of when they arrive
    const member = JSON.stringify({
      event_id: eventId,
      event_type,
      estimated_cost: estimatedCost,
      properties,
    })

    const added = await redis.zadd(key, 'NX', timestamp, member)
    if (added === 0) {
      const checkpoint = await getCheckpoint(redis, config, customer_id)
      const { total, count } = await sumPendingCosts(redis, config, customer_id)
      return c.json({
        event_id: eventId,
        estimated_cost: estimatedCost,
        optimistic_balance: (checkpoint?.balance ?? 0) - total,
        pending_events: count,
        duplicate: true,
      })
    }

    const checkpoint = await getCheckpoint(redis, config, customer_id)
    const checkpointBalance = checkpoint?.balance ?? 0
    const { total, count } = await sumPendingCosts(redis, config, customer_id)
    const optimisticBalance = checkpointBalance - total

    return c.json({
      event_id: eventId,
      estimated_cost: estimatedCost,
      optimistic_balance: optimisticBalance,
      pending_events: count,
    })
  })

  return app
}
