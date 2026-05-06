import pg from 'pg'
import type { PoolConfig } from 'pg'
import type { Destination } from '@stripe/sync-protocol'
import {
  ident,
  identList,
  qualifiedTable,
  sql,
  sslConfigFromConnectionString,
  stripSslParams,
  upsertWithStats,
  withPgConnectProxy,
  withQueryLogging,
} from '@stripe/sync-util-postgres'
import {
  enumCheckConstraintName,
  buildCreateTableDDL,
  getExistingEnumAllowLists,
} from './schemaProjection.js'
import defaultSpec from './spec.js'
import { log } from './logger.js'
import type { Config } from './spec.js'
import { pgPoolClient, pgliteClient } from './client.js'
import type { QueryClient, ManagedClient } from './client.js'

// MARK: - Spec

export { configSchema, type Config } from './spec.js'
export { pgPoolClient, pgliteClient } from './client.js'
export type { QueryClient, ManagedClient } from './client.js'

export async function buildPoolConfig(config: Config): Promise<PoolConfig> {
  if (config.aws) {
    const { buildRdsIamPasswordFn } = await import('./aws.js')
    const passwordFn = await buildRdsIamPasswordFn({
      host: config.aws.host,
      port: config.aws.port,
      user: config.aws.user,
      region: config.aws.region,
      roleArn: config.aws.role_arn,
      externalId: config.aws.external_id,
    })
    return withPgConnectProxy({
      host: config.aws.host,
      port: config.aws.port,
      database: config.aws.database,
      user: config.aws.user,
      password: passwordFn,
      ssl: true,
    })
  }

  const connectionString = config.url ?? config.connection_string
  if (connectionString) {
    return withPgConnectProxy({
      connectionString: stripSslParams(connectionString),
      ssl: sslConfigFromConnectionString(connectionString, { sslCaPem: config.ssl_ca_pem }),
    })
  }

  throw new Error('Either url/connection_string or aws config is required')
}

// MARK: - writeMany / upsertMany / deleteMany

export interface UpsertManyResult {
  created_count: number
  updated_count: number
  skipped_count: number
}

export interface DeleteManyResult {
  deleted_count: number
}

export interface WriteManyResult extends UpsertManyResult, DeleteManyResult {}

/**
 * Apply a mixed batch of live records and tombstones to a Postgres table.
 * Records with `deleted: true` are routed to {@link deleteMany} (hard delete);
 * everything else goes through {@link upsertMany}.
 *
 * Existing soft-deleted rows from prior deployments are intentionally not
 * cleaned up — no production user is on the soft-delete code path.
 */
export async function writeMany(
  client: QueryClient,
  schema: string,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/**
 * Upsert records into a Postgres table; `_updated_at` is source time and
 * `_synced_at` is the destination write time.
 */
export async function upsertMany(
  client: QueryClient,
  schema: string,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entries: Record<string, any>[],
  primaryKeyColumns: string[] = ['id'],
  newerThanField: string
): Promise<UpsertManyResult> {
  if (!entries.length)
    return {
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
    }

  const syncedAt = new Date().toISOString()
  const records = entries.map((e) => {
    const ts = e[newerThanField] as unknown
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new Error(
        `upsertMany: record missing source-stamped "${newerThanField}" (table=${schema}.${table}, id=${String(e.id)}). See DDR-009.`
      )
    }
    return { _raw_data: e, _synced_at: syncedAt, _updated_at: new Date(ts * 1000).toISOString() }
  })

  return await upsertWithStats(client, records, {
    schema,
    table,
    primaryKeyColumns,
    newerThanColumn: newerThanField,
  })
}

/**
 * Hard-delete rows by primary key. No `newer_than_field` guard: deletion is
 * terminal — once an object is deleted it cannot be undeleted.
 */
export async function deleteMany(
  client: QueryClient,
  schema: string,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  const stmt = `DELETE FROM ${tbl} t
USING (VALUES ${valueRows.join(', ')}) AS d(${identList(primaryKeyColumns)})
WHERE ${pkJoin}`

  const result = await client.query(stmt, params)
  return { deleted_count: result.rowCount ?? 0 }
}

// MARK: - Named exports

// Schema projection (JSON Schema -> Postgres DDL)
export {
  buildCreateTableDDL,
  buildCreateTableWithSchema,
  jsonSchemaToColumns,
  runSqlAdditive,
  applySchemaFromCatalog,
  type ApplySchemaFromCatalogConfig,
  type BuildTableOptions,
  type SystemColumn,
} from './schemaProjection.js'

// MARK: - Default export

/** Throw if any stream's catalog enum allow-list disagrees with an existing CHECK constraint. */
async function assertEnumConstraintsConsistent(
  client: QueryClient,
  schema: string,
  streams: ReadonlyArray<{ stream: { name: string; json_schema?: Record<string, unknown> } }>
): Promise<void> {
  // Collect all enum column names across all streams
  const enumColumns = new Set<string>()
  for (const { stream } of streams) {
    const props = stream.json_schema?.properties as Record<string, { enum?: string[] }> | undefined
    if (!props) continue
    for (const [col, prop] of Object.entries(props)) {
      if (Array.isArray(prop?.enum) && prop.enum.length > 0) enumColumns.add(col)
    }
  }
  if (enumColumns.size === 0) return

  const existing = await getExistingEnumAllowLists(
    client,
    schema,
    streams.map((s) => s.stream.name),
    [...enumColumns]
  )
  for (const { stream } of streams) {
    const tableConstraints = existing.get(stream.name)
    if (!tableConstraints) continue
    const props = stream.json_schema?.properties as Record<string, { enum?: string[] }> | undefined
    if (!props) continue
    for (const [col, existingVals] of tableConstraints) {
      const newVals = new Set(props[col]?.enum ?? [])
      if (newVals.size === 0) continue
      if (existingVals.size === newVals.size && [...existingVals].every((v) => newVals.has(v)))
        continue
      const c = enumCheckConstraintName(stream.name, col)
      const fmt = (s: Set<string>) => [...s].sort().join(', ')
      throw new Error(
        `Postgres destination: enum values changed for "${schema}"."${stream.name}"."${col}". ` +
          `Existing CHECK "${c}" allows [${fmt(existingVals)}]; new catalog wants [${fmt(newVals)}]. ` +
          `Drop manually before re-running setup: ALTER TABLE "${schema}"."${stream.name}" DROP CONSTRAINT "${c}";`
      )
    }
  }
}

/** Check if an error looks transient (connection refused, timeout, etc.). */
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.message) return err.message
  return (err as NodeJS.ErrnoException).code ?? err.constructor.name
}

function describePoolConfig(config: PoolConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    has_connection_string: Boolean(config.connectionString),
    ssl: config.ssl === true ? true : config.ssl ? 'custom' : false,
    max: config.max,
    min: config.min,
    connection_timeout_millis: config.connectionTimeoutMillis,
    idle_timeout_millis: config.idleTimeoutMillis,
    allow_exit_on_idle: config.allowExitOnIdle,
  }
}

async function createManagedClient(config: Config, operation: string): Promise<ManagedClient> {
  if (config.pglite) {
    const dataDir = config.pglite === true ? undefined : config.pglite.data_dir
    log.debug({ operation, data_dir: dataDir }, 'dest postgres: creating PGlite client')
    const startedAt = Date.now()
    const client = await pgliteClient({ data_dir: dataDir })
    log.debug(
      { operation, duration_ms: Date.now() - startedAt },
      'dest postgres: PGlite client ready'
    )
    return client
  }

  const configStartedAt = Date.now()
  log.debug({ operation }, 'dest postgres: building pool config')
  const poolConfig = await buildPoolConfig(config)
  log.debug(
    {
      operation,
      duration_ms: Date.now() - configStartedAt,
      pool_config: describePoolConfig(poolConfig),
    },
    'dest postgres: built pool config'
  )

  const pool = withQueryLogging(new pg.Pool(poolConfig), log)
  const client = pgPoolClient(pool, log)
  log.debug({ operation, ...client.stats?.() }, 'dest postgres: pool created')
  return client
}

async function verifyConnectivity(client: ManagedClient, operation: string): Promise<void> {
  const startedAt = Date.now()
  log.debug({ operation, ...client.stats?.() }, 'dest postgres: connectivity check start')
  await client.query('SELECT 1')
  log.debug(
    { operation, duration_ms: Date.now() - startedAt, ...client.stats?.() },
    'dest postgres: connectivity check complete'
  )
}

async function closeClient(client: ManagedClient, operation: string): Promise<void> {
  const startedAt = Date.now()
  log.debug({ operation, ...client.stats?.() }, 'dest postgres: closing client')
  await client.close()
  log.debug({ operation, duration_ms: Date.now() - startedAt }, 'dest postgres: client closed')
}

const destination = {
  async *spec() {
    yield { type: 'spec' as const, spec: defaultSpec }
  },

  async *check({ config }) {
    const client = await createManagedClient(config, 'check')
    try {
      await verifyConnectivity(client, 'check')
      yield {
        type: 'connection_status' as const,
        connection_status: { status: 'succeeded' as const },
      }
    } catch (err) {
      yield {
        type: 'connection_status' as const,
        connection_status: {
          status: 'failed' as const,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      await closeClient(client, 'check')
    }
  },

  async *setup({ config, catalog }) {
    log.debug({ schema: config.schema }, 'dest setup: creating client')
    const client = await createManagedClient(config, 'setup')
    try {
      await verifyConnectivity(client, 'setup')
      log.info(`Creating schema "${config.schema}" (${catalog.streams.length} streams)`)
      log.debug('dest setup: creating schema')
      await client.query(sql`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`)
      log.debug('dest setup: dropping legacy set_updated_at() function')
      await client.query(sql`DROP FUNCTION IF EXISTS "${config.schema}".set_updated_at() CASCADE`)

      await assertEnumConstraintsConsistent(client, config.schema, catalog.streams)

      log.debug({ streamCount: catalog.streams.length }, 'dest setup: creating tables')
      for (const cs of catalog.streams) {
        await client.query(
          buildCreateTableDDL(config.schema, cs.stream.name, cs.stream.json_schema ?? {}, {
            system_columns: cs.system_columns,
            primary_key: cs.stream.primary_key,
          })
        )
      }
      log.debug('dest setup: complete')
    } finally {
      await closeClient(client, 'setup')
    }
  },

  async *teardown({ config }) {
    const PROTECTED_SCHEMAS = new Set(['public', 'information_schema', 'pg_catalog', 'pg_toast'])
    if (PROTECTED_SCHEMAS.has(config.schema)) {
      throw new Error(
        `Refusing to drop protected schema "${config.schema}" — teardown only drops user-created schemas`
      )
    }
    const client = await createManagedClient(config, 'teardown')
    try {
      await verifyConnectivity(client, 'teardown')
      await client.query(sql`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`)
    } finally {
      await closeClient(client, 'teardown')
    }
  },

  async *write({ config, catalog }, $stdin) {
    const client = await createManagedClient(config, 'write')
    const batchSize = config.batch_size
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamBuffers = new Map<string, Record<string, any>[]>()
    const streamKeyColumns = new Map(
      catalog.streams.map((cs) => [
        cs.stream.name,
        cs.stream.primary_key?.map((pk) => pk[0]) ?? ['id'],
      ])
    )
    const streamNewerThanField = new Map(
      catalog.streams.map((cs) => [cs.stream.name, cs.stream.newer_than_field])
    )

    const failedStreams = new Set<string>()

    const flushStream = async (streamName: string): Promise<string | undefined> => {
      if (failedStreams.has(streamName)) return undefined
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return undefined
      const pk = streamKeyColumns.get(streamName) ?? ['id']
      const newerThan = streamNewerThanField.get(streamName)!
      const startedAt = Date.now()
      log.debug(
        {
          stream: streamName,
          batch_size: buffer.length,
          schema: config.schema,
          primary_key: pk,
          newer_than_field: newerThan,
          ...client.stats?.(),
        },
        'dest write: flush start'
      )
      try {
        const stats = await writeMany(client, config.schema, streamName, buffer, pk, newerThan)
        log.debug(
          {
            stream: streamName,
            schema: config.schema,
            table: `${config.schema}.${streamName}`,
            batch_size: buffer.length,
            inserted: stats.created_count,
            updated: stats.updated_count,
            deleted: stats.deleted_count,
            skipped: stats.skipped_count,
            duration_ms: Date.now() - startedAt,
            ...client.stats?.(),
          },
          `dest write: upsert ${config.schema}.${streamName}`
        )
      } catch (err) {
        const detail =
          `stream=${streamName} table=${config.schema}.${streamName} ` +
          `pk=[${pk}] newerThan=${newerThan} records=${buffer.length}`
        const errMsg = errorMessage(err)
        log.error(
          {
            stream: streamName,
            batch_size: buffer.length,
            schema: config.schema,
            duration_ms: Date.now() - startedAt,
            error: errMsg,
            err,
            ...client.stats?.(),
          },
          'dest write: flush failed'
        )
        failedStreams.add(streamName)
        streamBuffers.set(streamName, [])
        return `${errMsg} (${detail})`
      }
      streamBuffers.set(streamName, [])
      return undefined
    }

    function streamError(stream: string, error: string) {
      return {
        type: 'stream_status' as const,
        stream_status: { stream, status: 'error' as const, error },
      }
    }

    try {
      await verifyConnectivity(client, 'write')
      for await (const msg of $stdin) {
        if (msg.type === 'record') {
          const { stream } = msg.record

          if (failedStreams.has(stream)) {
            log.debug({ stream }, 'dest write: skipping record for failed stream')
            continue
          }

          if (!streamBuffers.has(stream)) {
            streamBuffers.set(stream, [])
          }

          const buffer = streamBuffers.get(stream)!
          buffer.push(msg.record as Record<string, unknown>)

          if (buffer.length >= batchSize) {
            const err = await flushStream(stream)
            if (err) {
              log.error(
                { stream, error: err },
                'dest write: yielding stream_status error (batch flush)'
              )
              yield streamError(stream, err)
              continue
            }
          }
          yield msg
        } else if (msg.type === 'source_state') {
          if (msg.source_state.state_type !== 'global') {
            const stream = msg.source_state.stream
            if (failedStreams.has(stream)) {
              log.debug({ stream }, 'dest write: skipping source_state for failed stream')
              continue
            }
            const err = await flushStream(stream)
            if (err) {
              log.error(
                { stream, error: err },
                'dest write: yielding stream_status error (state flush)'
              )
              yield streamError(stream, err)
              continue
            }
          }
          yield msg
        } else {
          yield msg
        }
      }

      // Final flush for all remaining buffers
      for (const streamName of streamBuffers.keys()) {
        const err = await flushStream(streamName)
        if (err) {
          log.error(
            { stream: streamName, error: err },
            'dest write: yielding stream_status error (final flush)'
          )
          yield streamError(streamName, err)
        }
      }

      if (failedStreams.size > 0) {
        log.error(
          { failed_streams: [...failedStreams], schema: config.schema },
          `Postgres destination: completed with ${failedStreams.size} failed stream(s) in schema "${config.schema}"`
        )
      } else {
        log.debug(`Postgres destination: wrote to schema "${config.schema}"`)
      }
    } finally {
      await closeClient(client, 'write')
    }
  },
} satisfies Destination<Config>

export default destination
