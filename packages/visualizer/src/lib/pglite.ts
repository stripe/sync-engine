/**
 * PGlite Database Hydration Hook
 *
 * Provides client-side Postgres database powered by PGlite (WASM).
 * Hydrates from static JSON/SQL artifacts in the public directory.
 *
 * Usage:
 *   const { db, status, error, query } = usePGlite();
 *
 *   if (status === 'loading') return <div>Loading database...</div>;
 *   if (status === 'error') return <div>Error: {error}</div>;
 *
 *   const result = await query('SELECT * FROM stripe.customers LIMIT 10');
 */

import { PGlite } from '@electric-sql/pglite'
import { useEffect, useState, useCallback, useRef } from 'react'

type PGliteInstance = InstanceType<typeof PGlite>
type QueryResult = Awaited<ReturnType<PGliteInstance['query']>>

// Manifest structure from explorer-seed.ts
interface ExplorerManifest {
  timestamp: string
  seed: number
  apiVersion: string
  totalTables: number
  coreTables: string[]
  longTailTables: string[]
  manifest: Record<string, number>
  failedTables: Array<{ table: string; reason: string }>
  verification: {
    allTablesSeeded: boolean
    tablesWithData: number
    emptyTables: string[]
  }
}

type DatabaseStatus = 'idle' | 'loading' | 'ready' | 'error'

type InitializedDatabase = {
  db: PGliteInstance
  manifest: ExplorerManifest
}

let sharedDatabasePromise: Promise<InitializedDatabase> | null = null

interface UsePGliteResult {
  db: PGliteInstance | null
  status: DatabaseStatus
  error: string | null
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  exec: (sql: string) => Promise<void>
  manifest: ExplorerManifest | null
}

export function usePGlite(): UsePGliteResult {
  const [db, setDb] = useState<PGliteInstance | null>(null)
  const [status, setStatus] = useState<DatabaseStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [manifest, setManifest] = useState<ExplorerManifest | null>(null)

  const currentPromiseRef = useRef<Promise<InitializedDatabase> | null>(null)

  useEffect(() => {
    let cancelled = false

    setStatus('loading')
    setError(null)

    currentPromiseRef.current ??= getOrCreateDatabase()

    currentPromiseRef.current
      .then(({ db: initializedDb, manifest: initializedManifest }) => {
        if (cancelled) return
        setManifest(initializedManifest)
        setDb(initializedDb)
        setStatus('ready')
      })
      .catch((err) => {
        console.error('[PGlite] Initialization error:', err)
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unknown error during initialization')
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const query = useCallback(
    async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      if (status !== 'ready' || !db) {
        throw new Error('Database not ready. Current status: ' + status)
      }

      try {
        const result = await db.query(sql, params)
        return result
      } catch (err) {
        console.error('[PGlite] Query error:', err)
        throw err
      }
    },
    [db, status]
  )

  const exec = useCallback(
    async (sql: string): Promise<void> => {
      if (status !== 'ready' || !db) {
        throw new Error('Database not ready. Current status: ' + status)
      }

      try {
        await db.exec(sql)
      } catch (err) {
        console.error('[PGlite] Exec error:', err)
        throw err
      }
    },
    [db, status]
  )

  return {
    db,
    status,
    error,
    query,
    exec,
    manifest,
  }
}

async function hydrateSqlBootstrap(db: PGliteInstance, sqlPath: string): Promise<void> {
  console.log(`[PGlite] Fetching SQL bootstrap from ${sqlPath}`)

  const response = await fetch(sqlPath)
  if (!response.ok) {
    throw new Error(`Failed to fetch SQL bootstrap: ${response.status} ${response.statusText}`)
  }

  const sqlContent = await response.text()
  console.log(`[PGlite] SQL bootstrap size: ${(sqlContent.length / 1024).toFixed(2)} KB`)

  try {
    console.log(`[PGlite] Attempting to execute SQL as single multi-statement block...`)
    await db.exec(sqlContent)
    console.log('[PGlite] SQL bootstrap executed successfully')
    return
  } catch (err) {
    console.warn(
      '[PGlite] Multi-statement execution failed, falling back to statement-by-statement execution'
    )
    console.warn('[PGlite] Error was:', err instanceof Error ? err.message : String(err))
  }

  const cleanedSql = sqlContent
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed && !trimmed.startsWith('--')
    })
    .join('\n')

  const statements = cleanedSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ';')

  console.log(`[PGlite] Executing ${statements.length} SQL statements individually...`)

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]
    try {
      await db.exec(statement)

      if ((i + 1) % 100 === 0) {
        console.log(`[PGlite] Progress: ${i + 1}/${statements.length} statements`)
      }
    } catch (err) {
      const preview = statement.length > 200 ? statement.substring(0, 200) + '...' : statement
      console.error(`[PGlite] Error executing statement ${i + 1}:`, preview)
      console.error('[PGlite] Full error:', err)
      throw new Error(
        `Failed to execute SQL statement ${i + 1}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  console.log('[PGlite] SQL bootstrap executed successfully (statement-by-statement mode)')
}

async function hydrateJsonBootstrap(
  db: PGliteInstance,
  jsonPath: string,
  _manifest: ExplorerManifest
): Promise<void> {
  console.log(`[PGlite] Fetching JSON bootstrap from ${jsonPath}`)

  const response = await fetch(jsonPath)
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON bootstrap: ${response.status} ${response.statusText}`)
  }

  const jsonData = await response.json()
  console.log(
    `[PGlite] JSON bootstrap size: ${(JSON.stringify(jsonData).length / 1024).toFixed(2)} KB`
  )

  const tables = Object.keys(jsonData)
  console.log(`[PGlite] Hydrating ${tables.length} tables...`)

  for (const tableName of tables) {
    const rows = jsonData[tableName]
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`[PGlite] Skipping empty table: ${tableName}`)
      continue
    }

    console.log(`[PGlite] Inserting ${rows.length} rows into stripe.${tableName}...`)

    for (const row of rows) {
      try {
        await db.query(`INSERT INTO stripe.${tableName} (_raw_data, _account_id) VALUES ($1, $2)`, [
          JSON.stringify(row._raw_data),
          row._account_id,
        ])
      } catch (err) {
        console.error(`[PGlite] Error inserting row into ${tableName}:`, err)
      }
    }
  }

  console.log('[PGlite] JSON bootstrap loaded successfully')
}

export async function createPGliteDatabase(): Promise<{
  db: PGliteInstance
  manifest: ExplorerManifest
}> {
  const manifestResponse = await fetch('/explorer-data/manifest.json')
  if (!manifestResponse.ok) {
    throw new Error(`Failed to fetch manifest: ${manifestResponse.status}`)
  }
  const manifest: ExplorerManifest = await manifestResponse.json()

  const db = await PGlite.create()

  const sqlCheckResponse = await fetch('/explorer-data/bootstrap.sql', { method: 'HEAD' })
  if (sqlCheckResponse.ok) {
    await hydrateSqlBootstrap(db, '/explorer-data/bootstrap.sql')
  } else {
    await hydrateJsonBootstrap(db, '/explorer-data/bootstrap.json', manifest)
  }

  return { db, manifest }
}

async function getOrCreateDatabase(): Promise<InitializedDatabase> {
  if (!sharedDatabasePromise) {
    sharedDatabasePromise = createPGliteDatabase().catch((error) => {
      sharedDatabasePromise = null
      throw error
    })
  }

  return sharedDatabasePromise
}
