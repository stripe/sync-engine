import type pg from 'pg'
import type { Logger } from '@stripe/sync-logger'
import { log } from './logger.js'
import type { ManagedClient } from './client.js'

export function pgPoolClient(pool: pg.Pool, logger: Logger = log): ManagedClient {
  pool.on('error', (err) => {
    logger.error({ err }, 'Postgres destination pool error')
  })

  return {
    query(text: string, values?: unknown[]) {
      return pool.query(text, values)
    },
    async close() {
      await pool.end()
    },
    stats() {
      return {
        total_count: pool.totalCount,
        idle_count: pool.idleCount,
        waiting_count: pool.waitingCount,
      }
    },
  }
}
