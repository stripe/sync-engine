/**
 * Stripe Sigma Data Worker.
 *
 * Hourly cron starts a run; self-trigger continues until all objects finish.
 * Progress persists in _sync_runs and _sync_obj_runs across invocations.
 */

import postgres from 'postgres'
import { StripeSync } from '../../index.ts'

const BATCH_SIZE = 1
const MAX_RUN_AGE_MS = 6 * 60 * 60 * 1000
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7)

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) {
    return jsonResponse({ error: 'SUPABASE_DB_URL not set' }, 500)
  }
  const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
  const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
  const safeSyncSchema = syncTablesSchemaName.replace(/"/g, '""')

  let sql: ReturnType<typeof postgres> | undefined
  let stripeSync: StripeSync | undefined

  try {
    sql = postgres(dbUrl, { max: 1, prepare: false })
  } catch (error: unknown) {
    const err = error as Error
    return jsonResponse(
      {
        error: 'Failed to create postgres connection',
        details: err.message,
        stack: err.stack,
      },
      500
    )
  }

  try {
    // Validate the token against vault secret
    const vaultResult = await sql`
      SELECT decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name = 'stripe_sigma_worker_secret'
    `

    if (vaultResult.length === 0) {
      await sql.end()
      return new Response('Sigma worker secret not configured in vault', { status: 500 })
    }

    const storedSecret = vaultResult[0].decrypted_secret
    if (token !== storedSecret) {
      await sql.end()
      return new Response('Forbidden: Invalid sigma worker secret', { status: 403 })
    }

    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeSecretKey) {
      return jsonResponse({ error: 'STRIPE_SECRET_KEY not set' }, 500)
    }

    stripeSync = await StripeSync.create({
      poolConfig: { connectionString: dbUrl, max: 1 },
      stripeSecretKey,
      enableSigma: true,
      sigmaPageSizeOverride: 1000,
      schemaName,
      syncTablesSchemaName,
    })
  } catch (error: unknown) {
    const err = error as Error
    await sql.end()
    return jsonResponse(
      {
        error: 'Failed to create StripeSync',
        details: err.message,
        stack: err.stack,
      },
      500
    )
  }

  try {
    const accountId = await stripeSync.getAccountId()
    const sigmaObjects = stripeSync.getSupportedSigmaObjects()

    if (sigmaObjects.length === 0) {
      return jsonResponse({ message: 'No Sigma objects configured for sync' })
    }

    // Get or create sync run for sigma-worker (isolated from stripe-worker)
    const runResult = await stripeSync.postgresClient.getOrCreateSyncRun(accountId, 'sigma-worker')
    const runStartedAt =
      runResult?.runStartedAt ??
      (await stripeSync.postgresClient.getActiveSyncRun(accountId, 'sigma-worker'))?.runStartedAt

    if (!runStartedAt) {
      throw new Error('Failed to get or create sync run for sigma worker')
    }

    // Legacy cleanup: remove any prefixed sigma object runs that can block concurrency.
    // Previous versions stored objects as "sigma.<table>" which no longer matches processNext.
    await stripeSync.postgresClient.query(
      `UPDATE "${safeSyncSchema}"."_sync_obj_runs"
       SET status = 'error',
           error_message = 'Legacy sigma worker prefix run (sigma.*); superseded by unprefixed runs',
           completed_at = now()
       WHERE "_account_id" = $1
         AND run_started_at = $2
         AND object LIKE 'sigma.%'
         AND status IN ('pending', 'running')`,
      [accountId, runStartedAt]
    )

    // Stop self-triggering after MAX_RUN_AGE_MS.
    const runAgeMs = Date.now() - runStartedAt.getTime()
    if (runAgeMs > MAX_RUN_AGE_MS) {
      console.warn(
        `Sigma worker: run too old (${Math.round(runAgeMs / 1000 / 60)} min), closing without self-trigger`
      )
      await stripeSync.postgresClient.closeSyncRun(accountId, runStartedAt)
      return jsonResponse({
        message: 'Sigma run exceeded max age, closed without processing',
        runAgeMinutes: Math.round(runAgeMs / 1000 / 60),
        selfTriggered: false,
      })
    }

    // Create object runs for all sigma objects (idempotent).
    await stripeSync.postgresClient.createObjectRuns(accountId, runStartedAt, sigmaObjects)
    await stripeSync.postgresClient.ensureSyncRunMaxConcurrent(accountId, runStartedAt, BATCH_SIZE)

    // Prefer running objects; otherwise claim pending ones.
    const runningObjects = await stripeSync.postgresClient.listObjectsByStatus(
      accountId,
      runStartedAt,
      'running',
      sigmaObjects
    )

    const objectsToProcess = runningObjects.slice(0, BATCH_SIZE)
    let pendingObjects: string[] = []

    if (objectsToProcess.length === 0) {
      pendingObjects = await stripeSync.postgresClient.listObjectsByStatus(
        accountId,
        runStartedAt,
        'pending',
        sigmaObjects
      )

      for (const objectKey of pendingObjects) {
        if (objectsToProcess.length >= BATCH_SIZE) break
        const started = await stripeSync.postgresClient.tryStartObjectSync(
          accountId,
          runStartedAt,
          objectKey
        )
        if (started) {
          objectsToProcess.push(objectKey)
        }
      }
    }

    if (objectsToProcess.length === 0) {
      if (pendingObjects.length === 0) {
        console.info('Sigma worker: all objects complete or errored - run finished')
        return jsonResponse({ message: 'Sigma sync run complete', selfTriggered: false })
      }

      console.info('Sigma worker: at concurrency limit, will self-trigger', {
        pendingCount: pendingObjects.length,
      })
      let selfTriggered = false
      try {
        await sql.unsafe(`SELECT "${safeSyncSchema}".trigger_sigma_worker()`)
        selfTriggered = true
      } catch (error: unknown) {
        const err = error as Error
        console.warn('Failed to self-trigger sigma worker:', err.message)
      }

      return jsonResponse({
        message: 'At concurrency limit',
        pendingCount: pendingObjects.length,
        selfTriggered,
      })
    }

    // Process objects sequentially (one lifecycle per invocation).
    const results: Array<Record<string, unknown>> = []

    for (const object of objectsToProcess) {
      const objectKey = object
      try {
        console.info(`Sigma worker: processing ${object}`)

        // Process one sigma page and upsert results.
        const result = await stripeSync.processNext(
          object as keyof typeof stripeSync.resourceRegistry,
          {
            runStartedAt,
            triggeredBy: 'sigma-worker',
          }
        )

        results.push({
          object,
          processed: result.processed,
          hasMore: result.hasMore,
          status: 'success',
        })

        if (result.hasMore) {
          console.info(
            `Sigma worker: ${object} has more pages, processed ${result.processed} rows so far`
          )
        } else {
          console.info(`Sigma worker: ${object} complete, processed ${result.processed} rows`)
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error(`Sigma worker: error processing ${object}:`, error)

        // Mark object as failed and move on (no retries)
        await stripeSync.postgresClient.failObjectSync(
          accountId,
          runStartedAt,
          objectKey,
          err.message ?? 'Unknown error'
        )

        results.push({
          object,
          processed: 0,
          hasMore: false,
          status: 'error',
          error: err.message,
        })
      }
    }

    // Determine if self-trigger is needed
    const pendingAfter = await stripeSync.postgresClient.listObjectsByStatus(
      accountId,
      runStartedAt,
      'pending',
      sigmaObjects
    )
    const runningAfter = await stripeSync.postgresClient.listObjectsByStatus(
      accountId,
      runStartedAt,
      'running',
      sigmaObjects
    )

    // Calculate remaining run time for logging
    const remainingMs = MAX_RUN_AGE_MS - (Date.now() - runStartedAt.getTime())
    const remainingMinutes = Math.round(remainingMs / 1000 / 60)

    // Only self-trigger if there are pending or running objects AND run hasn't timed out
    const shouldSelfTrigger =
      (pendingAfter.length > 0 || runningAfter.length > 0) && remainingMs > 0

    let selfTriggered = false
    if (shouldSelfTrigger) {
      console.info('Sigma worker: more work remains, self-triggering', {
        pending: pendingAfter.length,
        running: runningAfter.length,
        remainingMinutes,
      })
      try {
        await sql.unsafe(`SELECT "${safeSyncSchema}".trigger_sigma_worker()`)
        selfTriggered = true
      } catch (error: unknown) {
        const err = error as Error
        console.warn('Failed to self-trigger sigma worker:', err.message)
      }
    } else if (pendingAfter.length > 0 || runningAfter.length > 0) {
      // Would self-trigger but run timed out
      console.warn('Sigma worker: work remains but run timed out, closing', {
        pending: pendingAfter.length,
        running: runningAfter.length,
      })
      await stripeSync.postgresClient.closeSyncRun(accountId, runStartedAt)
    } else {
      console.info('Sigma worker: no more work, run complete')
    }

    return jsonResponse({
      results,
      selfTriggered,
      remaining: { pending: pendingAfter.length, running: runningAfter.length },
    })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Sigma worker error:', error)
    return jsonResponse({ error: err.message, stack: err.stack }, 500)
  } finally {
    if (sql) await sql.end()
    if (stripeSync) await stripeSync.postgresClient.pool.end()
  }
})
