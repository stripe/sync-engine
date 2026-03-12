#!/usr/bin/env tsx
/**
 * Export Schema Explorer Database to PGlite Bootstrap SQL
 *
 * This script:
 * 1. Reads connection details from .tmp/schema-explorer-run.json
 * 2. Connects to the harness Postgres database
 * 3. Introspects pg_catalog to discover the projected stripe schema
 * 4. Exports faithful CREATE TABLE DDL plus data, constraints, indexes, and triggers
 * 5. Writes the result to packages/visualizer/public/explorer-data/bootstrap.sql
 * 6. Generates a fresh manifest.json with metadata
 *
 * Usage:
 *   pnpm tsx scripts/explorer-export.ts
 */

import { Client } from 'pg'
import * as fs from 'fs'
import * as path from 'path'

const TMP_DIR = path.join(process.cwd(), '.tmp')
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json')
const OUTPUT_DIR = path.join(process.cwd(), 'packages/visualizer/public/explorer-data')
const BOOTSTRAP_FILE = path.join(OUTPUT_DIR, 'bootstrap.sql')
const MANIFEST_FILE = path.join(OUTPUT_DIR, 'manifest.json')
const STRIPE_SCHEMA = 'stripe'

// Core tables that receive special attention in manifest
const CORE_TABLES = [
  'accounts',
  'products',
  'prices',
  'customers',
  'payment_methods',
  'setup_intents',
  'subscriptions',
  'subscription_items',
  'invoices',
  'payment_intents',
  'charges',
  'refunds',
  'checkout_sessions',
  'credit_notes',
  'disputes',
  'tax_ids',
]

interface ContainerMetadata {
  databaseUrl: string
  containerId: string
  containerName: string
  port: number
  volumeName: string
  createdAt: string
}

interface ColumnInfo {
  name: string
  type: string
  isNullable: boolean
  defaultValue: string | null
  generationExpression: string | null
}

interface ConstraintInfo {
  name: string
  type: string
  definition: string
}

interface IndexInfo {
  name: string
  definition: string
}

interface TriggerInfo {
  name: string
  definition: string
  functionOid: number
}

interface TableInfo {
  tableName: string
  columns: ColumnInfo[]
  constraints: ConstraintInfo[]
  indexes: IndexInfo[]
  triggers: TriggerInfo[]
}

interface ManifestData {
  timestamp: string
  seed: number
  apiVersion: string
  totalTables: number
  coreTables: string[]
  longTailTables: string[]
  manifest: Record<string, number>
  failedTables: string[]
  verification: {
    allTablesSeeded: boolean
    tablesWithData: number
    emptyTables: string[]
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function qualifyTable(tableName: string): string {
  return `${quoteIdentifier(STRIPE_SCHEMA)}.${quoteIdentifier(tableName)}`
}

function qualifyIndex(indexName: string): string {
  return `${quoteIdentifier(STRIPE_SCHEMA)}.${quoteIdentifier(indexName)}`
}

function ensureTerminated(statement: string): string {
  const trimmed = statement.trim()
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

function isJsonType(type: string): boolean {
  return type === 'json' || type === 'jsonb'
}

function isNumericType(type: string): boolean {
  return /^(smallint|integer|bigint|numeric|real|double precision|oid)$/i.test(type)
}

function isNumericLiteral(value: string): boolean {
  return /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
}

function getArrayElementType(type: string): string {
  return type.endsWith('[]') ? type.slice(0, -2) : 'text'
}

/**
 * Get all table names in the stripe schema
 */
async function getAllTables(client: Client): Promise<string[]> {
  const result = await client.query(
    `
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
      AND c.relkind IN ('r', 'p')
      AND c.relname NOT LIKE '\\_%' ESCAPE '\\'
    ORDER BY c.relname
  `,
    [STRIPE_SCHEMA]
  )

  return result.rows.map((row) => row.table_name)
}

/**
 * Get faithful table details from pg_catalog
 */
async function getTableInfo(client: Client, tableName: string): Promise<TableInfo> {
  const [columnsResult, constraintsResult, indexesResult, triggersResult] = await Promise.all([
    client.query(
      `
      SELECT
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull AS is_not_null,
        CASE
          WHEN a.attgenerated = 's' THEN NULL
          ELSE pg_get_expr(ad.adbin, ad.adrelid)
        END AS column_default,
        CASE
          WHEN a.attgenerated = 's' THEN pg_get_expr(ad.adbin, ad.adrelid)
          ELSE NULL
        END AS generation_expression
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum
    `,
      [STRIPE_SCHEMA, tableName]
    ),
    client.query(
      `
      SELECT
        con.conname AS constraint_name,
        con.contype AS constraint_type,
        pg_get_constraintdef(con.oid, true) AS constraint_definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND con.contype IN ('p', 'u', 'f', 'c', 'x')
      ORDER BY
        CASE con.contype
          WHEN 'p' THEN 0
          WHEN 'u' THEN 1
          WHEN 'c' THEN 2
          WHEN 'f' THEN 3
          WHEN 'x' THEN 4
          ELSE 5
        END,
        con.conname
    `,
      [STRIPE_SCHEMA, tableName]
    ),
    client.query(
      `
      SELECT
        ci.relname AS index_name,
        pg_get_indexdef(i.indexrelid) AS index_definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class ci ON ci.oid = i.indexrelid
      LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
      WHERE n.nspname = $1
        AND c.relname = $2
        AND con.oid IS NULL
        AND i.indisvalid
      ORDER BY ci.relname
    `,
      [STRIPE_SCHEMA, tableName]
    ),
    client.query(
      `
      SELECT
        t.tgname AS trigger_name,
        pg_get_triggerdef(t.oid, true) AS trigger_definition,
        t.tgfoid::int AS function_oid
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND NOT t.tgisinternal
      ORDER BY t.tgname
    `,
      [STRIPE_SCHEMA, tableName]
    ),
  ])

  return {
    tableName,
    columns: columnsResult.rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      isNullable: !row.is_not_null,
      defaultValue: row.column_default,
      generationExpression: row.generation_expression,
    })),
    constraints: constraintsResult.rows.map((row) => ({
      name: row.constraint_name,
      type: row.constraint_type,
      definition: row.constraint_definition,
    })),
    indexes: indexesResult.rows.map((row) => ({
      name: row.index_name,
      definition: row.index_definition,
    })),
    triggers: triggersResult.rows.map((row) => ({
      name: row.trigger_name,
      definition: row.trigger_definition,
      functionOid: Number(row.function_oid),
    })),
  }
}

/**
 * Generate CREATE TABLE DDL from catalog-backed table info
 */
function generateCreateTableDDL(tableInfo: TableInfo): string {
  const columnDefs = tableInfo.columns.map((column) => {
    let definition = `  ${quoteIdentifier(column.name)} ${column.type}`

    if (column.generationExpression) {
      definition += ` GENERATED ALWAYS AS (${column.generationExpression}) STORED`
    } else if (column.defaultValue) {
      definition += ` DEFAULT ${column.defaultValue}`
    }

    if (!column.isNullable) {
      definition += ' NOT NULL'
    }

    return definition
  })

  return `CREATE TABLE IF NOT EXISTS ${qualifyTable(tableInfo.tableName)} (\n${columnDefs.join(',\n')}\n);`
}

/**
 * SQL literal helpers for table data export
 */
function formatScalarValue(value: unknown, columnType: string): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }

  if (Array.isArray(value)) {
    return formatArrayValue(value, `${columnType}[]`)
  }

  if (isJsonType(columnType)) {
    return `'${escapeSqlString(JSON.stringify(value))}'::${columnType}`
  }

  if (value instanceof Date) {
    return `'${value.toISOString()}'`
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }

  if (typeof value === 'object') {
    return `'${escapeSqlString(JSON.stringify(value))}'`
  }

  if (typeof value === 'string' && isNumericType(columnType) && isNumericLiteral(value)) {
    return value
  }

  return `'${escapeSqlString(String(value))}'`
}

function formatArrayValue(values: unknown[], columnType: string): string {
  if (values.length === 0) {
    return `ARRAY[]::${columnType}`
  }

  const elementType = getArrayElementType(columnType)
  const elements = values.map((value) => formatScalarValue(value, elementType))
  return `ARRAY[${elements.join(', ')}]::${columnType}`
}

function formatSqlValue(value: unknown, column: ColumnInfo): string {
  if (Array.isArray(value)) {
    return formatArrayValue(value, column.type)
  }

  return formatScalarValue(value, column.type)
}

async function generateInsertStatements(
  client: Client,
  tableName: string,
  tableInfo: TableInfo
): Promise<string> {
  const result = await client.query(`SELECT * FROM ${qualifyTable(tableName)}`)

  if (result.rows.length === 0) {
    return `-- No data in ${STRIPE_SCHEMA}.${tableName}\n`
  }

  const insertableColumns = tableInfo.columns.filter((column) => !column.generationExpression)

  if (insertableColumns.length === 0) {
    return result.rows
      .map(() => `INSERT INTO ${qualifyTable(tableName)} DEFAULT VALUES;`)
      .join('\n')
  }

  const columnList = insertableColumns.map((column) => quoteIdentifier(column.name)).join(', ')
  const inserts: string[] = []

  for (const row of result.rows) {
    const values = insertableColumns.map((column) => formatSqlValue(row[column.name], column))
    inserts.push(
      `INSERT INTO ${qualifyTable(tableName)} (${columnList}) VALUES (${values.join(', ')});`
    )
  }

  return inserts.join('\n')
}

function generateConstraintStatements(tableInfo: TableInfo): string[] {
  return tableInfo.constraints.flatMap((constraint) => {
    if (constraint.type === 'f' || constraint.type === 'x') {
      return [
        `-- Skipped constraint ${constraint.name} on ${tableInfo.tableName} during browser hydration: ${constraint.definition}`,
      ]
    }

    return [
      `ALTER TABLE ${qualifyTable(tableInfo.tableName)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraint.name)};`,
      `ALTER TABLE ${qualifyTable(tableInfo.tableName)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)} ${constraint.definition};`,
    ]
  })
}

function generateIndexStatements(tableInfo: TableInfo): string[] {
  return tableInfo.indexes.flatMap((index) => [
    `DROP INDEX IF EXISTS ${qualifyIndex(index.name)};`,
    ensureTerminated(index.definition),
  ])
}

function generateTriggerStatements(tableInfo: TableInfo): string[] {
  return tableInfo.triggers.flatMap((trigger) => [
    `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)} ON ${qualifyTable(tableInfo.tableName)};`,
    ensureTerminated(trigger.definition),
  ])
}

/**
 * Get row count for a table
 */
async function getRowCount(client: Client, tableName: string): Promise<number> {
  const result = await client.query(`SELECT COUNT(*) AS count FROM ${qualifyTable(tableName)}`)
  return parseInt(result.rows[0].count, 10)
}

/**
 * Main export function
 */
async function exportDatabase(client: Client): Promise<void> {
  console.log('🔍 Discovering tables in stripe schema...\n')

  const tables = await getAllTables(client)
  console.log(`   ✓ Found ${tables.length} tables\n`)

  const manifest: Record<string, number> = {}
  const emptyTables: string[] = []
  const tableExports: Array<{
    tableInfo: TableInfo
    rowCount: number
    inserts: string
  }> = []

  for (const tableName of tables) {
    console.log(`📦 Exporting ${tableName}...`)

    const tableInfo = await getTableInfo(client, tableName)
    const rowCount = await getRowCount(client, tableName)
    manifest[tableName] = rowCount

    if (rowCount === 0) {
      emptyTables.push(tableName)
    }

    console.log(`   ✓ ${rowCount} rows`)

    const inserts = rowCount > 0 ? await generateInsertStatements(client, tableName, tableInfo) : ''
    tableExports.push({ tableInfo, rowCount, inserts })
  }
  const sqlParts: string[] = []

  sqlParts.push('-- PGlite Bootstrap SQL')
  sqlParts.push('-- Generated by explorer-export.ts')
  sqlParts.push(`-- Timestamp: ${new Date().toISOString()}`)
  sqlParts.push(`-- Total Tables: ${tables.length}`)
  sqlParts.push('')
  sqlParts.push('-- Create schema')
  sqlParts.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(STRIPE_SCHEMA)};`)
  sqlParts.push('')

  sqlParts.push('-- Create table shells with catalog-derived column definitions')
  sqlParts.push('')
  for (const { tableInfo, rowCount } of tableExports) {
    sqlParts.push(`-- Table: ${tableInfo.tableName} (${rowCount} rows)`)
    sqlParts.push(generateCreateTableDDL(tableInfo))
    sqlParts.push('')
  }

  if (tableExports.some((tableExport) => tableExport.rowCount > 0)) {
    sqlParts.push(
      '-- Load data before constraints, indexes, and triggers so hydration remains resilient in PGlite'
    )
    sqlParts.push('')

    for (const { tableInfo, rowCount, inserts } of tableExports) {
      if (rowCount === 0) {
        continue
      }

      sqlParts.push(`-- Data: ${tableInfo.tableName}`)
      sqlParts.push(inserts)
      sqlParts.push('')
    }
  }

  if (tableExports.some((tableExport) => tableExport.tableInfo.constraints.length > 0)) {
    sqlParts.push('-- Re-apply browser-safe table constraints after data load')
    sqlParts.push(
      '-- Foreign keys and exclusion constraints are omitted for PGlite hydration compatibility.'
    )
    sqlParts.push('')

    for (const { tableInfo } of tableExports) {
      if (tableInfo.constraints.length === 0) {
        continue
      }

      sqlParts.push(`-- Constraints: ${tableInfo.tableName}`)
      sqlParts.push(...generateConstraintStatements(tableInfo))
      sqlParts.push('')
    }
  }

  if (tableExports.some((tableExport) => tableExport.tableInfo.indexes.length > 0)) {
    sqlParts.push('-- Re-create secondary indexes after data load')
    sqlParts.push('')

    for (const { tableInfo } of tableExports) {
      if (tableInfo.indexes.length === 0) {
        continue
      }

      sqlParts.push(`-- Indexes: ${tableInfo.tableName}`)
      sqlParts.push(...generateIndexStatements(tableInfo))
      sqlParts.push('')
    }
  }

  if (tableExports.some((tableExport) => tableExport.tableInfo.triggers.length > 0)) {
    sqlParts.push(
      '-- Trigger functions and triggers are intentionally omitted from the browser artifact.'
    )
    sqlParts.push('-- They are useful in Postgres, but not required for this read-only explorer.')
    sqlParts.push('')
  }

  // Write bootstrap.sql
  console.log('\n📝 Writing bootstrap.sql...')
  const sql = sqlParts.join('\n')

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  fs.writeFileSync(BOOTSTRAP_FILE, sql)
  const sqlSizeKB = Math.round((sql.length / 1024) * 10) / 10
  console.log(`   ✓ Written ${sqlSizeKB} KB to ${BOOTSTRAP_FILE}`)

  // Generate manifest.json
  console.log('\n📊 Generating manifest.json...')

  const coreTables = CORE_TABLES.filter((t) => tables.includes(t))
  const longTailTables = tables.filter((t) => !CORE_TABLES.includes(t))
  const tablesWithData = tables.filter((t) => manifest[t] > 0)

  // Try to read seed from .tmp/seed-manifest.json if it exists
  let seed = 42 // default
  let apiVersion = '2020-08-27' // default
  const seedManifestPath = path.join(TMP_DIR, 'seed-manifest.json')
  if (fs.existsSync(seedManifestPath)) {
    try {
      const seedManifest = JSON.parse(fs.readFileSync(seedManifestPath, 'utf-8'))
      seed = seedManifest.seed || seed
      apiVersion = seedManifest.apiVersion || apiVersion
    } catch {
      // Ignore errors, use defaults
    }
  }

  const manifestData: ManifestData = {
    timestamp: new Date().toISOString(),
    seed,
    apiVersion,
    totalTables: tables.length,
    coreTables,
    longTailTables,
    manifest,
    failedTables: [],
    verification: {
      allTablesSeeded: emptyTables.length === 0,
      tablesWithData: tablesWithData.length,
      emptyTables,
    },
  }

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifestData, null, 2))
  console.log(`   ✓ Written to ${MANIFEST_FILE}`)

  // Verification summary
  console.log('\n🔍 Export Summary:')
  console.log(`   ✓ Total tables: ${tables.length}`)
  console.log(`   ✓ Tables with data: ${tablesWithData.length}`)
  console.log(`   ✓ Core tables: ${coreTables.length}`)
  console.log(`   ✓ Long-tail tables: ${longTailTables.length}`)
  console.log(`   ✓ Total artifact size: ${sqlSizeKB} KB`)

  if (emptyTables.length > 0) {
    console.log(`\n   ⚠️  Empty tables (${emptyTables.length}):`)
    emptyTables.forEach((t) => console.log(`      - ${t}`))
  }

  // Check size budget (10MB uncompressed)
  const SIZE_BUDGET_KB = 10 * 1024
  if (sqlSizeKB > SIZE_BUDGET_KB) {
    console.log(
      `\n   ⚠️  WARNING: Artifact size (${sqlSizeKB} KB) exceeds budget (${SIZE_BUDGET_KB} KB)`
    )
  }
}

async function main(): Promise<void> {
  console.log('🚀 Schema Explorer Export Script\n')

  // Load metadata
  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ Error: No metadata file found')
    console.error(`   Expected: ${METADATA_FILE}`)
    console.error('\n💡 Start the harness first: pnpm tsx scripts/explorer-harness.ts start')
    process.exit(1)
  }

  const metadata: ContainerMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'))

  console.log('📋 Connection details:')
  console.log(`   Database URL: ${metadata.databaseUrl}`)
  console.log(`   Container: ${metadata.containerName}`)
  console.log('')

  // Connect to database
  const client = new Client({ connectionString: metadata.databaseUrl })

  try {
    await client.connect()
    console.log('✅ Connected to database\n')

    await exportDatabase(client)

    console.log('\n✅ Export complete!')
  } catch (error) {
    console.error('\n❌ Export failed:', error)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})
