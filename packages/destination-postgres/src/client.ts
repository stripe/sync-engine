import type pg from 'pg'
import type { Logger } from '@stripe/sync-logger'
import { log } from './logger.js'

export interface QueryClient {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>
}

export interface ManagedClient extends QueryClient {
  close(): Promise<void>
  stats?(): { total_count: number; idle_count: number; waiting_count: number }
}

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

export function isPGliteUrl(url: string): boolean {
  return url.startsWith('file://') || url.startsWith('memory://')
}

export async function pgliteClient(
  config: { data_dir?: string; url?: string } = {}
): Promise<ManagedClient> {
  const { PGlite } = await import('@electric-sql/pglite')

  const dataSource = config.url ?? config.data_dir
  const db = await PGlite.create(dataSource)

  function adaptResult(result: { rows: unknown[]; affectedRows?: number; fields?: { name: string; dataTypeID: number }[] }): pg.QueryResult {
    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.affectedRows ?? null,
      command: '',
      oid: 0,
      fields: result.fields?.map((f) => ({
        ...f,
        tableID: 0,
        columnID: 0,
        dataTypeSize: 0,
        dataTypeModifier: 0,
        format: 'text' as const,
      })) ?? [],
    } as pg.QueryResult
  }

  return {
    async query(text: string, values?: unknown[]) {
      if (values && values.length > 0) {
        return adaptResult(await db.query(text, values))
      }
      // PGlite's query() rejects multiple statements; use exec() as fallback
      try {
        return adaptResult(await db.query(text))
      } catch (err) {
        if (err instanceof Error && err.message.includes('multiple commands')) {
          await db.exec(text)
          return adaptResult({ rows: [], affectedRows: 0, fields: [] })
        }
        throw err
      }
    },
    async close() {
      await db.close()
    },
  }
}
