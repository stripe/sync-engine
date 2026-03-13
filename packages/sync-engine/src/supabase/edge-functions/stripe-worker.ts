/**
 * Stripe Sync Worker
 *
 * Triggered by pg_cron at a configurable interval (default: 60 seconds).
 *
 * Flow:
 *
 * Concurrency:
 */

import { StripeSync } from '../../stripeSync.ts'
import { StripeSyncWorker } from '../../stripeSyncWorker.ts'
import postgres from 'postgres'

// Reuse these between requests
const dbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!dbUrl) {
  throw new Error('SUPABASE_DB_URL secret not configured')
}
const SYNC_INTERVAL = Number(Deno.env.get('SYNC_INTERVAL')) || 60 * 60 * 24 * 7 // Once a week default
const rateLimit = Number(Deno.env.get('RATE_LIMIT')) || 60
const workerCount = Number(Deno.env.get('WORKER_COUNT')) || 10
const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName

const sql = postgres(dbUrl, { max: 1, prepare: false })
const stripeSync = await StripeSync.create({
  poolConfig: { connectionString: dbUrl, max: 1 },
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
  enableSigma: false,
  partnerId: 'pp_supabase',
  schemaName,
  syncTablesSchemaName,
})
const objects = stripeSync.getSupportedSyncObjects()
const tableNames = objects.map(
  (obj: keyof typeof stripeSync.resourceRegistry) => stripeSync.resourceRegistry[obj].tableName
)

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7) // Remove 'Bearer '

  // Validate that the token matches the unique worker secret stored in vault
  const vaultResult = await sql`
    SELECT decrypted_secret
    FROM vault.decrypted_secrets
    WHERE name = 'stripe_sync_worker_secret'
  `

  if (vaultResult.length === 0) {
    return new Response('Worker secret not configured in vault', { status: 500 })
  }
  const storedSecret = vaultResult[0].decrypted_secret
  if (token !== storedSecret) {
    return new Response('Forbidden: Invalid worker secret', { status: 403 })
  }
  const runKey = await stripeSync.reconciliationSync(
    objects,
    tableNames,
    true,
    'edge-worker',
    SYNC_INTERVAL
  )
  if (runKey === null) {
    const activeSkipResult = await sql`SELECT decrypted_secret::timestamptz::text AS skip_until
      FROM vault.decrypted_secrets
      WHERE name = 'stripe_sync_skip_until'
        AND decrypted_secret::timestamptz >= NOW()
      LIMIT 1`

    let skipUntil = activeSkipResult[0]?.skip_until
    if (!skipUntil) {
      skipUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      await sql`DELETE FROM vault.secrets WHERE name = 'stripe_sync_skip_until'`
      await sql`SELECT vault.create_secret(
        ${skipUntil},
        'stripe_sync_skip_until'
      )`
    }
    const completedRun = await stripeSync.postgresClient.getCompletedRun(
      stripeSync.accountId,
      SYNC_INTERVAL
    )
    const message = `Skipping resync — a successful run completed at ${completedRun?.runStartedAt.toISOString()} (within ${SYNC_INTERVAL}s window). Cron paused until ${skipUntil}.`
    console.log(message)
    return new Response(JSON.stringify({ skipped: true, message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  await stripeSync.postgresClient.resetStuckRunningObjects(runKey.accountId, runKey.runStartedAt, 1)

  const workers = Array.from(
    { length: workerCount },
    () =>
      new StripeSyncWorker(
        stripeSync.stripe,
        stripeSync.config,
        stripeSync.sigma,
        stripeSync.postgresClient,
        stripeSync.accountId,
        stripeSync.resourceRegistry,
        stripeSync.sigmaRegistry,
        runKey,
        stripeSync.upsertAny.bind(stripeSync),
        Infinity,
        rateLimit
      )
  )
  const MAX_EXECUTION_MS = 20_000 // stop before edge function limit
  workers.forEach((worker) => worker.start())
  await Promise.race([
    Promise.all(workers.map((w) => w.waitUntilDone())),
    new Promise((resolve) => setTimeout(resolve, MAX_EXECUTION_MS)),
  ])
  workers.forEach((w) => w.shutdown())
  const totals = await stripeSync.postgresClient.getObjectSyncedCounts(
    stripeSync.accountId,
    runKey.runStartedAt
  )
  const totalSynced = (Object.values(totals) as number[]).reduce(
    (sum: number, n: number) => sum + n,
    0
  )
  console.log(`Finished: ${totalSynced} objects synced`, totals)

  return new Response(JSON.stringify({ totals }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
