import type { Destination } from '@stripe/sync-protocol'
import { ident, identList, qualifiedTable, sql } from '@stripe/sync-util-postgres/sql'
import { upsertWithStats } from '@stripe/sync-util-postgres/upsert'
import { buildCreateTableDDL, getExistingEnumAllowLists, enumCheckConstraintName } from './schemaProjection.js'
import defaultSpec from './spec.js'
import { log } from './logger.js'
import type { Config } from './spec.js'
import { pgliteClient, isPGliteUrl } from './client-pglite.js'
import type { QueryClient, ManagedClient } from './client.js'

export { configSchema, type Config } from './spec.js'
export { pgliteClient, isPGliteUrl } from './client-pglite.js'
export type { QueryClient, ManagedClient } from './client.js'
export { buildCreateTableDDL } from './schemaProjection.js'

export interface UpsertManyResult {
  created_count: number
  updated_count: number
  skipped_count: number
}

export interface DeleteManyResult {
  deleted_count: number
}

export interface WriteManyResult extends UpsertManyResult, DeleteManyResult {}

export async function writeMany(
  client: QueryClient,
  schema: string,
  table: string,
  entries: Record<string, any>[],
  primaryKeyColumns: string[] = ['id'],
  newerThanField: string
): Promise<WriteManyResult> {
  const tombstones = entries.filter((e) => e.recordDeleted === true).map((r) => r.data)
  const liveRecords = entries.filter((e) => e.recordDeleted !== true).map((r) => r.data)
  const u = await upsertMany(client, schema, table, liveRecords, primaryKeyColumns, newerThanField)
  const d = await deleteMany(client, schema, table, tombstones, primaryKeyColumns)
  return { ...u, deleted_count: d.deleted_count }
}

export async function upsertMany(
  client: QueryClient,
  schema: string,
  table: string,
  entries: Record<string, any>[],
  primaryKeyColumns: string[] = ['id'],
  newerThanField: string
): Promise<UpsertManyResult> {
  if (!entries.length) return { created_count: 0, updated_count: 0, skipped_count: 0 }
  const syncedAt = new Date().toISOString()
  const records = entries.map((e) => {
    const ts = e[newerThanField] as unknown
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new Error(
        `upsertMany: record missing source-stamped "${newerThanField}" (table=${schema}.${table}, id=${String(e.id)})`
      )
    }
    return { _raw_data: e, _synced_at: syncedAt, _updated_at: new Date(ts * 1000).toISOString() }
  })
  return await upsertWithStats(client, records, { schema, table, primaryKeyColumns, newerThanColumn: newerThanField })
}

export async function deleteMany(
  client: QueryClient,
  schema: string,
  table: string,
  entries: Record<string, any>[],
  primaryKeyColumns: string[] = ['id']
): Promise<DeleteManyResult> {
  if (!entries.length) return { deleted_count: 0 }
  const params: unknown[] = []
  const valueRows = entries.map((e) => {
    const cells = primaryKeyColumns.map((pk) => {
      params.push(String(e[pk]))
      return `$${params.length}::text`
    })
    return `(${cells.join(', ')})`
  })
  const tbl = qualifiedTable(schema, table)
  const pkJoin = primaryKeyColumns.map((c) => `t.${ident(c)} = d.${ident(c)}`).join(' AND ')
  const stmt = `DELETE FROM ${tbl} t\nUSING (VALUES ${valueRows.join(', ')}) AS d(${identList(primaryKeyColumns)})\nWHERE ${pkJoin}`
  const result = await client.query(stmt, params)
  return { deleted_count: result.rowCount ?? 0 }
}

async function assertEnumConstraintsConsistent(
  client: QueryClient,
  schema: string,
  streams: ReadonlyArray<{ stream: { name: string; json_schema?: Record<string, unknown> } }>
): Promise<void> {
  const enumColumns = new Set<string>()
  for (const { stream } of streams) {
    const props = stream.json_schema?.properties as Record<string, { enum?: string[] }> | undefined
    if (!props) continue
    for (const [col, prop] of Object.entries(props)) {
      if (Array.isArray(prop?.enum) && prop.enum.length > 0) enumColumns.add(col)
    }
  }
  if (enumColumns.size === 0) return
  const existing = await getExistingEnumAllowLists(client, schema, streams.map((s) => s.stream.name), [...enumColumns])
  for (const { stream } of streams) {
    const tableConstraints = existing.get(stream.name)
    if (!tableConstraints) continue
    const props = stream.json_schema?.properties as Record<string, { enum?: string[] }> | undefined
    if (!props) continue
    for (const [col, existingVals] of tableConstraints) {
      const newVals = new Set(props[col]?.enum ?? [])
      if (newVals.size === 0) continue
      if (existingVals.size === newVals.size && [...existingVals].every((v) => newVals.has(v))) continue
      const c = enumCheckConstraintName(stream.name, col)
      const fmt = (s: Set<string>) => [...s].sort().join(', ')
      throw new Error(
        `Enum values changed for "${schema}"."${stream.name}"."${col}". ` +
        `Existing CHECK "${c}" allows [${fmt(existingVals)}]; new catalog wants [${fmt(newVals)}]. ` +
        `Drop manually: ALTER TABLE "${schema}"."${stream.name}" DROP CONSTRAINT "${c}";`
      )
    }
  }
}

async function createClient(config: Config): Promise<ManagedClient> {
  const url = config.url ?? config.connection_string
  if (config.pglite || (url && isPGliteUrl(url))) {
    const pgliteUrl = url && isPGliteUrl(url) ? url : undefined
    const dataDir = config.pglite && config.pglite !== true ? config.pglite.data_dir : undefined
    return pgliteClient({ url: pgliteUrl, data_dir: dataDir })
  }
  throw new Error('PGlite-only destination: url must be memory:// or file://')
}

const destination = {
  async *spec() {
    yield { type: 'spec' as const, spec: defaultSpec }
  },

  async *check({ config }) {
    const client = await createClient(config)
    try {
      await client.query('SELECT 1')
      yield { type: 'connection_status' as const, connection_status: { status: 'succeeded' as const } }
    } catch (err) {
      yield { type: 'connection_status' as const, connection_status: { status: 'failed' as const, message: err instanceof Error ? err.message : String(err) } }
    } finally {
      await client.close()
    }
  },

  async *setup({ config, catalog }) {
    const client = await createClient(config)
    try {
      await client.query(sql`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`)
      await client.query(sql`DROP FUNCTION IF EXISTS "${config.schema}".set_updated_at() CASCADE`)
      await assertEnumConstraintsConsistent(client, config.schema, catalog.streams)
      for (const cs of catalog.streams) {
        await client.query(
          buildCreateTableDDL(config.schema, cs.stream.name, cs.stream.json_schema ?? {}, {
            system_columns: cs.system_columns,
            primary_key: cs.stream.primary_key,
          })
        )
      }
    } finally {
      await client.close()
    }
  },

  async *teardown({ config }) {
    const client = await createClient(config)
    try {
      await client.query(sql`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`)
    } finally {
      await client.close()
    }
  },

  async *write({ config, catalog }, $stdin) {
    const client = await createClient(config)
    const batchSize = config.batch_size
    const streamBuffers = new Map<string, Record<string, any>[]>()
    const streamKeyColumns = new Map(catalog.streams.map((cs) => [cs.stream.name, cs.stream.primary_key?.map((pk) => pk[0]) ?? ['id']]))
    const streamNewerThanField = new Map(catalog.streams.map((cs) => [cs.stream.name, cs.stream.newer_than_field]))
    const failedStreams = new Set<string>()

    const flushStream = async (streamName: string): Promise<string | undefined> => {
      if (failedStreams.has(streamName)) return undefined
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return undefined
      const pk = streamKeyColumns.get(streamName) ?? ['id']
      const newerThan = streamNewerThanField.get(streamName)!
      try {
        await writeMany(client, config.schema, streamName, buffer, pk, newerThan)
      } catch (err) {
        failedStreams.add(streamName)
        streamBuffers.set(streamName, [])
        return err instanceof Error ? err.message : String(err)
      }
      streamBuffers.set(streamName, [])
      return undefined
    }

    function streamError(stream: string, error: string) {
      return { type: 'stream_status' as const, stream_status: { stream, status: 'error' as const, error } }
    }

    try {
      await client.query('SELECT 1')
      for await (const msg of $stdin) {
        if (msg.type === 'record') {
          const { stream } = msg.record
          if (failedStreams.has(stream)) continue
          if (!streamBuffers.has(stream)) streamBuffers.set(stream, [])
          const buffer = streamBuffers.get(stream)!
          buffer.push(msg.record as Record<string, unknown>)
          if (buffer.length >= batchSize) {
            const err = await flushStream(stream)
            if (err) { yield streamError(stream, err); continue }
          }
          yield msg
        } else if (msg.type === 'source_state') {
          if (msg.source_state.state_type !== 'global') {
            const stream = msg.source_state.stream
            if (failedStreams.has(stream)) continue
            const err = await flushStream(stream)
            if (err) { yield streamError(stream, err); continue }
          }
          yield msg
        } else {
          yield msg
        }
      }
      for (const streamName of streamBuffers.keys()) {
        const err = await flushStream(streamName)
        if (err) yield streamError(streamName, err)
      }
    } finally {
      await client.close()
    }
  },
} satisfies Destination<Config>

export default destination
