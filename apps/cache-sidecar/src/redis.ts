import { Redis } from 'ioredis'
import type { Config } from './config.js'

export interface CheckpointData {
  balance: number
  customer_id: string
  credit_type_id: string
  _synced_at: number
}

export interface PendingEvent {
  event_id: string
  event_type: string
  estimated_cost: number
  timestamp: number
  properties?: Record<string, unknown>
}

export type { Redis }

export function createRedisClient(config: Config): Redis {
  const client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 })
  client.on('error', (err) => {
    console.error(JSON.stringify({ msg: 'redis error', error: err.message }))
  })
  return client
}

export function checkpointKey(config: Config, customerId: string): string {
  return `${config.CHECKPOINT_PREFIX}net_balance:${customerId}:${config.CREDIT_TYPE_ID}`
}

export function pendingSetKey(config: Config, customerId: string): string {
  return `${config.OPTIMISTIC_PREFIX}pending:${customerId}`
}

export async function getCheckpoint(
  redis: Redis,
  config: Config,
  customerId: string
): Promise<CheckpointData | null> {
  const raw = await redis.get(checkpointKey(config, customerId))
  if (!raw) return null
  return JSON.parse(raw) as CheckpointData
}

export async function getPendingEvents(
  redis: Redis,
  config: Config,
  customerId: string
): Promise<PendingEvent[]> {
  const members = await redis.zrange(pendingSetKey(config, customerId), 0, -1)
  return members.map((m) => JSON.parse(m) as PendingEvent)
}

export async function sumPendingCosts(
  redis: Redis,
  config: Config,
  customerId: string
): Promise<{ total: number; count: number }> {
  const events = await getPendingEvents(redis, config, customerId)
  // Sub-cent precision; round to avoid IEEE-754 drift
  const total = Math.round(events.reduce((sum, e) => sum + e.estimated_cost, 0) * 100) / 100
  return { total, count: events.length }
}
