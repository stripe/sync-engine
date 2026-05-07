import type pg from 'pg'
import type { ManagedClient } from './client.js'

export function isPGliteUrl(url: string): boolean {
  return url.startsWith('file://') || url.startsWith('memory://')
}

export async function pgliteClient(
  config: { data_dir?: string; url?: string } = {}
): Promise<ManagedClient> {
  const { PGlite } = await import('@electric-sql/pglite')

  const dataSource = config.url ?? config.data_dir
  const db = await PGlite.create(dataSource)

  let closed = false
  const shutdown = () => {
    if (closed) return
    closed = true
    db.close().catch(() => {})
    cleanup()
  }
  const cleanup = () => {
    process.removeListener('SIGTERM', shutdown)
    process.removeListener('SIGINT', shutdown)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

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
      if (closed) return
      closed = true
      cleanup()
      await db.close()
    },
  }
}
