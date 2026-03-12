import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ConnectionOptions } from 'node:tls'
import type { Logger } from '../types'
import { SIGMA_INGESTION_CONFIGS } from '../sigma/sigmaIngestionConfigs'
import type { SigmaIngestionConfig } from '../sigma/sigmaIngestion'
import {
  OPENAPI_RESOURCE_TABLE_ALIASES,
  PostgresAdapter,
  RUNTIME_REQUIRED_TABLES,
  SpecParser,
  WritePathPlanner,
  resolveOpenApiSpec,
} from '../openapi'
import type { EmbeddedMigration } from './migrations-embedded'

const DEFAULT_STRIPE_API_VERSION = '2020-08-27'
const SIGMA_BASE_COLUMNS = ['_raw_data', '_last_synced_at', '_updated_at', '_account_id'] as const
// Postgres identifiers are capped at 63 bytes; long Sigma column names can collide after truncation.
const PG_IDENTIFIER_MAX_BYTES = 63
const SIGMA_COLUMN_HASH_PREFIX = '_h'
const SIGMA_COLUMN_HASH_BYTES = 8
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type MigrationConfig = {
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: Logger
  enableSigma?: boolean
  stripeApiVersion?: string
  openApiSpecPath?: string
  openApiCacheDir?: string
  schemaName?: string
  /** Schema for sync metadata tables (_sync_accounts, _sync_runs, etc.). Defaults to schemaName. */
  syncTablesSchemaName?: string
  /**
   * Table filtering mode for OpenAPI schema migration:
   * - 'runtime_required': Only migrate tables in RUNTIME_REQUIRED_TABLES (default)
   * - 'all_projected': Migrate all resolvable tables from the OpenAPI spec
   */
  tableMode?: 'runtime_required' | 'all_projected'
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function truncateIdentifier(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) return name
  return Buffer.from(name).subarray(0, maxBytes).toString('utf8')
}

function buildColumnHashSuffix(name: string): string {
  const hash = createHash('sha1').update(name).digest('hex').slice(0, SIGMA_COLUMN_HASH_BYTES)
  return `${SIGMA_COLUMN_HASH_PREFIX}${hash}`
}

function ensureUniqueIdentifier(name: string, used: Set<string>): string {
  const truncated = truncateIdentifier(name, PG_IDENTIFIER_MAX_BYTES)
  if (!used.has(truncated)) {
    return truncated
  }

  const baseSuffix = buildColumnHashSuffix(name)
  for (let counter = 0; counter < 10_000; counter += 1) {
    const suffix = counter === 0 ? baseSuffix : `${baseSuffix}_${counter}`
    const maxBaseBytes = PG_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix)
    if (maxBaseBytes <= 0) {
      throw new Error(`Unable to generate safe column name for ${name}: suffix too long`)
    }
    const base = truncateIdentifier(name, maxBaseBytes)
    const candidate = `${base}${suffix}`
    if (!used.has(candidate)) {
      return candidate
    }
  }

  throw new Error(`Unable to generate unique column name for ${name}`)
}

function buildSigmaGeneratedColumnNameMap(
  columnNames: string[],
  reserved: Set<string>
): Map<string, string> {
  const used = new Set<string>()
  for (const name of reserved) {
    used.add(truncateIdentifier(name, PG_IDENTIFIER_MAX_BYTES))
  }
  const map = new Map<string, string>()
  for (const name of columnNames) {
    const safeName = ensureUniqueIdentifier(name, used)
    map.set(name, safeName)
    used.add(safeName)
  }
  return map
}

function getSigmaColumnMappings(config: SigmaIngestionConfig) {
  const extraColumnNames = config.upsert.extraColumns?.map((c) => c.column) ?? []
  const extraColumnSet = new Set(extraColumnNames)
  const generatedColumns = (config.columns ?? []).filter((c) => !extraColumnSet.has(c.name))
  const reserved = new Set<string>([...SIGMA_BASE_COLUMNS, ...extraColumnNames])
  const generatedNameMap = buildSigmaGeneratedColumnNameMap(
    generatedColumns.map((c) => c.name),
    reserved
  )

  return {
    extraColumnNames,
    generatedColumns,
    generatedNameMap,
  }
}

async function doesTableExist(client: Client, schema: string, tableName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_name = $2
    )`,
    [schema, tableName]
  )
  return result.rows[0]?.exists || false
}

async function renameMigrationsTableIfNeeded(
  client: Client,
  schema = 'stripe',
  logger?: Logger
): Promise<void> {
  const oldTableExists = await doesTableExist(client, schema, 'migrations')
  const newTableExists = await doesTableExist(client, schema, '_migrations')

  if (oldTableExists && !newTableExists) {
    logger?.info('Renaming migrations table to _migrations')
    await client.query(`ALTER TABLE "${schema}"."migrations" RENAME TO "_migrations"`)
    logger?.info('Successfully renamed migrations table')
  }
}

async function cleanupSchema(client: Client, schema: string, logger?: Logger): Promise<void> {
  logger?.warn(`Migrations table is empty - dropping and recreating schema "${schema}"`)
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.query(`CREATE SCHEMA "${schema}"`)
  logger?.info(`Schema "${schema}" has been reset`)
}

async function connectAndMigrate(
  client: Client,
  migrationsDirectory: string,
  schemaName: string,
  config: MigrationConfig,
  logOnError = true
): Promise<void> {
  if (!fs.existsSync(migrationsDirectory)) {
    throw new Error(`Migrations directory not found. ${migrationsDirectory} does not exist.`)
  }

  const optionalConfig = {
    schemaName,
    tableName: '_migrations',
  }

  try {
    await migrate({ client }, migrationsDirectory, optionalConfig)
  } catch (error) {
    if (logOnError && error instanceof Error) {
      config.logger?.error(error, 'Migration error:')
    }
    throw error
  }
}
async function fetchTableMetadata(client: Client, schema: string, table: string) {
  const colsResult = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
  `,
    [schema, table]
  )

  const pkResult = await client.query(
    `
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass
    AND i.indisprimary
  `,
    [`"${schema}"."${table}"`]
  )

  return {
    columns: colsResult.rows.map((r) => r.column_name),
    pk: pkResult.rows.map((r) => r.attname),
  }
}

function shouldRecreateTable(
  current: { columns: string[]; pk: string[] },
  expectedCols: string[],
  expectedPk: string[]
): boolean {
  const pkMatch =
    current.pk.length === expectedPk.length && expectedPk.every((p) => current.pk.includes(p))
  if (!pkMatch) return true

  const allExpected = [...new Set([...SIGMA_BASE_COLUMNS, ...expectedCols])]
  if (current.columns.length !== allExpected.length) return true
  return allExpected.every((c) => current.columns.includes(c))
}

async function ensureSigmaTableMetadata(
  client: Client,
  schema: string,
  config: SigmaIngestionConfig,
  stripeSchemaName = 'stripe'
): Promise<void> {
  const tableName = config.destinationTable

  const fkName = `fk_${tableName}_account`
  const stripeSchemaIdent = quoteIdentifier(stripeSchemaName)
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    DROP CONSTRAINT IF EXISTS "${fkName}";
  `)
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    ADD CONSTRAINT "${fkName}"
    FOREIGN KEY ("_account_id") REFERENCES ${stripeSchemaIdent}."_sync_accounts" (id);
  `)

  await client.query(`
    DROP TRIGGER IF EXISTS handle_updated_at ON "${schema}"."${tableName}";
  `)
  await client.query(`
    CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON "${schema}"."${tableName}"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `)
}

async function createSigmaTable(
  client: Client,
  schema: string,
  config: SigmaIngestionConfig,
  stripeSchemaName = 'stripe'
): Promise<void> {
  const tableName = config.destinationTable
  const { generatedColumns, generatedNameMap } = getSigmaColumnMappings(config)
  const pk = config.upsert.conflictTarget.map((c) => generatedNameMap.get(c) ?? c)

  const columnDefs = [
    '"_raw_data" jsonb NOT NULL',
    '"_last_synced_at" timestamptz',
    '"_updated_at" timestamptz DEFAULT now()',
    '"_account_id" text NOT NULL',
  ]

  for (const col of config.upsert.extraColumns ?? []) {
    columnDefs.push(`"${col.column}" ${col.pgType} NOT NULL`)
  }

  for (const col of generatedColumns) {
    // Temporal casts in generated columns are not immutable in Postgres.
    const isTemporal =
      col.pgType === 'timestamptz' || col.pgType === 'date' || col.pgType === 'timestamp'
    const pgType = isTemporal ? 'text' : col.pgType
    const safeName = generatedNameMap.get(col.name) ?? col.name
    columnDefs.push(
      `"${safeName}" ${pgType} GENERATED ALWAYS AS ((NULLIF(_raw_data->>'${col.name}', ''))::${pgType}) STORED`
    )
  }

  await client.query(`
    CREATE TABLE "${schema}"."${tableName}" (
      ${columnDefs.join(',\n      ')},
      PRIMARY KEY (${pk.map((c) => `"${c}"`).join(', ')})
    );
  `)
  await ensureSigmaTableMetadata(client, schema, config, stripeSchemaName)
}

async function migrateSigmaSchema(
  client: Client,
  config: MigrationConfig,
  sigmaSchemaName = 'sigma',
  stripeSchemaName = 'stripe'
): Promise<void> {
  config.logger?.info(`Reconciling Sigma schema "${sigmaSchemaName}"`)
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${sigmaSchemaName}"`)

  for (const [key, tableConfig] of Object.entries(SIGMA_INGESTION_CONFIGS)) {
    if (!tableConfig.columns) {
      config.logger?.info(`Skipping Sigma table ${key} - no column metadata`)
      continue
    }

    const tableName = tableConfig.destinationTable
    const tableExists = await doesTableExist(client, sigmaSchemaName, tableName)
    const { extraColumnNames, generatedColumns, generatedNameMap } =
      getSigmaColumnMappings(tableConfig)

    const expectedCols = [
      ...extraColumnNames,
      ...generatedColumns.map((c) => generatedNameMap.get(c.name) ?? c.name),
    ]
    const expectedPk = tableConfig.upsert.conflictTarget.map((c) => generatedNameMap.get(c) ?? c)

    if (tableExists) {
      const metadata = await fetchTableMetadata(client, sigmaSchemaName, tableName)
      if (shouldRecreateTable(metadata, expectedCols, expectedPk)) {
        config.logger?.warn(
          `Schema mismatch for ${sigmaSchemaName}.${tableName} - dropping and recreating`
        )
        await client.query(`DROP TABLE "${sigmaSchemaName}"."${tableName}" CASCADE`)
        await createSigmaTable(client, sigmaSchemaName, tableConfig, stripeSchemaName)
      } else {
        await ensureSigmaTableMetadata(client, sigmaSchemaName, tableConfig, stripeSchemaName)
      }
    } else {
      config.logger?.info(`Creating Sigma table ${sigmaSchemaName}.${tableName}`)
      await createSigmaTable(client, sigmaSchemaName, tableConfig, stripeSchemaName)
    }
  }
}

/** Run SQL, ignoring "already exists" errors (additive apply). Rethrows other errors. */
async function runSqlAdditive(client: Client, sql: string, logger?: Logger): Promise<void> {
  try {
    await client.query(sql)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    // 42P07=duplicate_table, 42710=duplicate_object (index/constraint), 42P16=invalid_table_definition
    if (code === '42P07' || code === '42710' || code === '42P16' || code === '42701') {
      logger?.info?.({ code }, 'Skipping already-existing object (additive apply)')
      return
    }
    throw err
  }
}

type MigrationMarkerColumn = 'migration_name' | 'name'

async function getMigrationMarkerColumn(
  client: Client,
  schema: string
): Promise<MigrationMarkerColumn> {
  const colCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = '_migrations' AND column_name IN ('migration_name', 'name')`,
    [schema]
  )
  const hasMigrationName = colCheck.rows.some((r) => r.column_name === 'migration_name')
  if (hasMigrationName) return 'migration_name'
  const hasName = colCheck.rows.some((r) => r.column_name === 'name')
  if (hasName) return 'name'
  throw new Error(
    `Unsupported _migrations schema in "${schema}" (expected migration_name or name column).`
  )
}

async function insertMigrationMarker(
  client: Client,
  schema: string,
  markerColumn: MigrationMarkerColumn,
  marker: string,
  hash: string
): Promise<void> {
  if (markerColumn === 'migration_name') {
    await client.query(
      `INSERT INTO "${schema}"."_migrations" ("migration_name") VALUES ($1) ON CONFLICT ("migration_name") DO NOTHING`,
      [marker]
    )
    return
  }

  const idResult = await client.query(
    `SELECT COALESCE(MAX(id), -1) + 1 as next_id FROM "${schema}"."_migrations"`
  )
  const nextId = Number(idResult.rows[0]?.next_id ?? 0)
  await client.query(
    `INSERT INTO "${schema}"."_migrations" (id, name, hash) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
    [nextId, marker, hash]
  )
}

function computeOpenApiFingerprint(spec: unknown): string {
  // Use a content-derived fingerprint so marker identity is stable across spec sources.
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)
}

function isLegacyOpenApiCommitMarker(
  marker: string,
  dataSchema: string,
  apiVersion: string
): boolean {
  const markerPrefix = `openapi:${dataSchema}:${apiVersion}:`
  if (!marker.startsWith(markerPrefix)) {
    return false
  }
  const suffix = marker.slice(markerPrefix.length)
  return /^[0-9a-f]{40}$/i.test(suffix)
}

async function listOpenApiMarkersForVersion(
  client: Client,
  schema: string,
  markerColumn: MigrationMarkerColumn,
  dataSchema: string,
  apiVersion: string
): Promise<string[]> {
  const markerPrefix = `openapi:${dataSchema}:${apiVersion}:`
  const result = await client.query<{ marker: string }>(
    `SELECT "${markerColumn}" AS marker
     FROM "${schema}"."_migrations"
     WHERE "${markerColumn}" LIKE $1`,
    [`${markerPrefix}%`]
  )

  return result.rows
    .map((row) => row.marker)
    .filter((marker): marker is string => typeof marker === 'string')
}

async function applyOpenApiSchema(
  client: Client,
  config: MigrationConfig,
  dataSchema: string,
  syncSchema: string
): Promise<void> {
  const apiVersion = config.stripeApiVersion ?? DEFAULT_STRIPE_API_VERSION
  const resolvedSpec = await resolveOpenApiSpec({
    apiVersion,
    openApiSpecPath: config.openApiSpecPath,
    cacheDir: config.openApiCacheDir,
  })
  const fingerprint = computeOpenApiFingerprint(resolvedSpec.spec)
  const marker = `openapi:${dataSchema}:${apiVersion}:${fingerprint}`

  config.logger?.info(
    {
      apiVersion,
      source: resolvedSpec.source,
      commitSha: resolvedSpec.commitSha,
      fingerprint,
    },
    'Resolved Stripe OpenAPI spec'
  )

  // Ensure _migrations exists (bootstrap creates it; may use pg-node-migrations format)
  const migrationsExists = await doesTableExist(client, syncSchema, '_migrations')
  if (!migrationsExists) {
    throw new Error(`_migrations table not found in schema "${syncSchema}". Run bootstrap first.`)
  }

  const markerColumn = await getMigrationMarkerColumn(client, syncSchema)
  const existingMarkers = await listOpenApiMarkersForVersion(
    client,
    syncSchema,
    markerColumn,
    dataSchema,
    apiVersion
  )
  if (existingMarkers.includes(marker)) {
    config.logger?.info({ marker }, 'OpenAPI schema already applied, skipping')
    return
  }

  // Backward compatibility:
  // older branches stored marker suffixes as 40-char commit SHAs. Treat those as equivalent
  // for GitHub/cache-resolved specs to prevent duplicate markers for the same API version.
  if (
    resolvedSpec.source !== 'explicit_path' &&
    existingMarkers.some((existingMarker) =>
      isLegacyOpenApiCommitMarker(existingMarker, dataSchema, apiVersion)
    )
  ) {
    config.logger?.info(
      {
        marker,
        existingMarkerCount: existingMarkers.length,
      },
      'OpenAPI schema already applied via legacy marker, skipping'
    )
    return
  }

  const parser = new SpecParser()
  const tableMode = config.tableMode ?? 'runtime_required'
  const parseOptions: { resourceAliases: Record<string, string>; allowedTables?: string[] } = {
    resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
  }

  // In 'runtime_required' mode, restrict to RUNTIME_REQUIRED_TABLES.
  // In 'all_projected' mode, omit allowedTables to parse all resolvable tables.
  if (tableMode === 'runtime_required') {
    parseOptions.allowedTables = [...RUNTIME_REQUIRED_TABLES]
  }

  const parsedSpec = parser.parse(resolvedSpec.spec, parseOptions)
  const adapter = new PostgresAdapter({
    schemaName: dataSchema,
    accountSchema: syncSchema,
    accountTableName: '_sync_accounts',
  })
  const statements = adapter.buildAllStatements(parsedSpec.tables)
  for (const statement of statements) {
    await runSqlAdditive(client, statement, config.logger)
  }

  await insertMigrationMarker(client, syncSchema, markerColumn, marker, fingerprint)

  const planner = new WritePathPlanner()
  const writePlans = planner.buildPlans(parsedSpec.tables)
  config.logger?.info(
    {
      tableCount: parsedSpec.tables.length,
      writePlanCount: writePlans.length,
      tableMode,
      marker,
    },
    'Applied OpenAPI-generated Stripe tables'
  )
}

export async function runMigrations(config: MigrationConfig): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })
  const dataSchema = config.schemaName ?? 'stripe'
  const syncSchema = config.syncTablesSchemaName ?? dataSchema
  const migrationsDirectory = path.resolve(__dirname, './migrations')
  const defaultSchema = 'stripe'

  if (dataSchema !== defaultSchema || syncSchema !== defaultSchema) {
    throw new Error(
      `Custom schema migrations are no longer supported. Use "${defaultSchema}" for both schemaName and syncTablesSchemaName.`
    )
  }

  try {
    await client.connect()
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(defaultSchema)}`)
    await renameMigrationsTableIfNeeded(client, syncSchema, config.logger)

    const tableExists = await doesTableExist(client, syncSchema, '_migrations')
    if (tableExists) {
      const migrationCount = await client.query(
        `SELECT COUNT(*) as count FROM "${syncSchema}"."_migrations"`
      )
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, syncSchema, config.logger)
      } else if (fs.existsSync(migrationsDirectory)) {
        const initialFile = fs
          .readdirSync(migrationsDirectory)
          .filter((f) => f.endsWith('.sql'))
          .sort()
          .find((f) => parseMigrationId(f) === 0)
        if (initialFile) {
          const initialSql = fs.readFileSync(path.join(migrationsDirectory, initialFile), 'utf8')
          const expectedHash = computeMigrationHash(initialFile, initialSql)
          const result = await client.query(
            `SELECT hash FROM "${syncSchema}"."_migrations" WHERE id = 0`
          )
          if (result.rows.length > 0 && result.rows[0].hash !== expectedHash) {
            config.logger?.warn(
              'Initial migration (0) hash changed — resetting schema to reapply from scratch'
            )
            await cleanupSchema(client, syncSchema, config.logger)
          }
        }
      }
    }

    if (!fs.existsSync(migrationsDirectory)) {
      throw new Error(`Migrations directory not found. ${migrationsDirectory} does not exist.`)
    }
    config.logger?.info({ migrationsDirectory }, 'Running SQL migrations from directory')
    await connectAndMigrate(client, migrationsDirectory, syncSchema, config, true)

    await applyOpenApiSchema(client, config, dataSchema, syncSchema)

    if (config.enableSigma) {
      await migrateSigmaSchema(client, config, 'sigma', syncSchema)
    }
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}

// Helper to parse migration ID from filename (matches pg-node-migrations behavior)
function parseMigrationId(fileName: string): number {
  const match = /^(-?\d+)[-_]?/.exec(fileName)
  if (!match) {
    throw new Error(`Invalid migration file name: '${fileName}'`)
  }
  return parseInt(match[1], 10)
}

// Helper to compute hash matching pg-node-migrations format
function computeMigrationHash(fileName: string, sql: string): string {
  return crypto
    .createHash('sha1')
    .update(fileName + sql, 'utf8')
    .digest('hex')
}

type ParsedMigration = {
  id: number
  name: string
  fileName: string
  sql: string
  hash: string
}

function parseMigrations(migrations: EmbeddedMigration[]): ParsedMigration[] {
  return migrations
    .map((migration) => ({
      id: parseMigrationId(migration.name),
      name: migration.name.replace(/^\d+[-_]?/, '').replace(/\.sql$/, '') || migration.name,
      fileName: migration.name,
      sql: migration.sql,
      hash: computeMigrationHash(migration.name, migration.sql),
    }))
    .sort((a, b) => a.id - b.id)
}

async function ensureMigrationsTable(
  client: Client,
  schema: string,
  tableName: string
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (
      id integer PRIMARY KEY,
      name varchar(100) UNIQUE NOT NULL,
      hash varchar(40) NOT NULL,
      executed_at timestamp DEFAULT current_timestamp
    )
  `)
}

async function getAppliedMigrations(
  client: Client,
  schema: string,
  tableName: string
): Promise<{ id: number; name: string; hash: string }[]> {
  const tableExists = await doesTableExist(client, schema, tableName)
  if (!tableExists) {
    return []
  }
  const result = await client.query(
    `SELECT id, name, hash FROM "${schema}"."${tableName}" ORDER BY id`
  )
  return result.rows
}

async function runMigration(
  client: Client,
  schema: string,
  tableName: string,
  migration: ParsedMigration,
  logger?: Logger
): Promise<void> {
  logger?.info(`Running migration: ${migration.id} ${migration.name}`)

  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query(
      `INSERT INTO "${schema}"."${tableName}" (id, name, hash) VALUES ($1, $2, $3)`,
      [migration.id, migration.name, migration.hash]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

/**
 * Run migrations from embedded content (for edge runtimes without filesystem migrations access).
 * This is compatible with pg-node-migrations table format.
 */
export async function runMigrationsFromContent(
  config: MigrationConfig,
  migrations: EmbeddedMigration[]
): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })
  const dataSchema = config.schemaName ?? 'stripe'
  const syncSchema = config.syncTablesSchemaName ?? dataSchema
  const defaultSchema = 'stripe'
  const tableName = '_migrations'

  if (dataSchema !== defaultSchema || syncSchema !== defaultSchema) {
    throw new Error(
      `Custom schema migrations are no longer supported. Use "${defaultSchema}" for both schemaName and syncTablesSchemaName.`
    )
  }

  try {
    config.logger?.info('Starting migrations (from embedded content)')
    await client.connect()
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(defaultSchema)}`)
    await renameMigrationsTableIfNeeded(client, syncSchema, config.logger)

    const tableExists = await doesTableExist(client, syncSchema, tableName)
    if (tableExists) {
      const migrationCount = await client.query(
        `SELECT COUNT(*) as count FROM "${syncSchema}"."${tableName}"`
      )
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, syncSchema, config.logger)
      }
    }

    await ensureMigrationsTable(client, syncSchema, tableName)

    let appliedMigrations = await getAppliedMigrations(client, syncSchema, tableName)
    const parsedMigrations = parseMigrations(migrations)

    const appliedInitial = appliedMigrations.find((m) => m.id === 0)
    const intendedInitial = parsedMigrations.find((m) => m.id === 0)
    if (appliedInitial && intendedInitial && appliedInitial.hash !== intendedInitial.hash) {
      config.logger?.warn(
        'Initial migration (0) hash changed — resetting schema to reapply from scratch'
      )
      await cleanupSchema(client, syncSchema, config.logger)
      await ensureMigrationsTable(client, syncSchema, tableName)
      appliedMigrations = []
    } else {
      for (const applied of appliedMigrations) {
        const intended = parsedMigrations.find((migration) => migration.id === applied.id)
        if (intended && intended.hash !== applied.hash) {
          throw new Error(
            `Migration hash mismatch for ${applied.name}: ` +
              `expected ${intended.hash}, got ${applied.hash}. ` +
              `Migrations cannot be modified after being applied.`
          )
        }
      }
    }

    const appliedIds = new Set(appliedMigrations.map((migration) => migration.id))
    const pendingMigrations = parsedMigrations.filter((migration) => !appliedIds.has(migration.id))
    if (pendingMigrations.length === 0) {
      config.logger?.info('No migrations to run')
    } else {
      config.logger?.info(`Running ${pendingMigrations.length} migration(s)`)
      for (const migration of pendingMigrations) {
        await runMigration(client, syncSchema, tableName, migration, config.logger)
      }
      config.logger?.info(`Successfully applied ${pendingMigrations.length} migration(s)`)
    }

    await applyOpenApiSchema(client, config, dataSchema, syncSchema)

    if (config.enableSigma) {
      await migrateSigmaSchema(client, config, 'sigma', syncSchema)
    }
  } catch (err) {
    config.logger?.error(err, 'Error running migrations from content')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}
