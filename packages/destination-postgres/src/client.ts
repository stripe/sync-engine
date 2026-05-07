import type pg from 'pg'

export interface QueryClient {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>
}

export interface ManagedClient extends QueryClient {
  close(): Promise<void>
  stats?(): { total_count: number; idle_count: number; waiting_count: number }
}

export { pgPoolClient } from './client-pg.js'
export { pgliteClient, isPGliteUrl } from './client-pglite.js'
