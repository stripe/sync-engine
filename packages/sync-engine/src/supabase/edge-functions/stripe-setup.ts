import { StripeSync } from '../../stripeSync.ts'
import { runMigrationsFromContent } from '../../database/migrate.ts'
import { VERSION } from '../../version.ts'
import { embeddedMigrations } from '../../database/migrations-embedded.ts'
import { parseSchemaComment } from '../schemaComment.ts'
import postgres from 'postgres'

// Get management API base URL from environment variable (for testing against localhost/staging)
// Caller should provide full URL with protocol (e.g., http://localhost:54323 or https://api.supabase.com)
const MGMT_API_BASE_RAW = Deno.env.get('MANAGEMENT_API_URL') || 'https://api.supabase.com'
const MGMT_API_BASE = MGMT_API_BASE_RAW.match(/^https?:\/\//)
  ? MGMT_API_BASE_RAW
  : `https://${MGMT_API_BASE_RAW}`

// Helper to delete edge function via Management API
async function deleteEdgeFunction(
  projectRef: string,
  functionSlug: string,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/functions/${functionSlug}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok && response.status !== 404) {
    const text = await response.text()
    throw new Error(`Failed to delete function ${functionSlug}: ${response.status} ${text}`)
  }
}

// Helper to delete secrets via Management API
async function deleteSecret(
  projectRef: string,
  secretName: string,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/secrets`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([secretName]),
  })

  if (!response.ok && response.status !== 404) {
    const text = await response.text()
    console.warn(`Failed to delete secret ${secretName}: ${response.status} ${text}`)
  }
}

Deno.serve(async (req) => {
  // Extract project ref from SUPABASE_URL (format: https://{projectRef}.{base})
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return new Response(JSON.stringify({ error: 'SUPABASE_URL not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]

  // Validate access token for all requests
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const accessToken = authHeader.substring(7) // Remove 'Bearer '

  // Handle GET requests for status
  if (req.method === 'GET') {
    const dbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!dbUrl) {
      return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL not set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let sql

    try {
      sql = postgres(dbUrl, { max: 1, prepare: false })

      // Query installation status from schema comment
      const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
      const commentResult = await sql`
        SELECT obj_description(oid, 'pg_namespace') as comment
        FROM pg_namespace
        WHERE nspname = ${schemaName}
      `

      const comment = commentResult[0]?.comment || null

      // Query sync runs (only if schema exists)
      let syncStatus: Array<Record<string, unknown>> = []
      if (comment) {
        try {
          const syncSchema = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
          const safeSchema = syncSchema.replace(/"/g, '""')
          syncStatus = await sql.unsafe(`
            SELECT DISTINCT ON (account_id)
              account_id, started_at, closed_at, status, error_message,
              total_processed, total_objects, complete_count, error_count,
              running_count, pending_count, triggered_by, max_concurrent
            FROM "${safeSchema}"."sync_runs"
            ORDER BY account_id, started_at DESC
          `)
        } catch (err) {
          // Ignore errors if sync_runs view doesn't exist yet
          console.warn('sync_runs query failed (may not exist yet):', err)
        }
      }

      const parsedComment = parseSchemaComment(comment)

      return new Response(
        JSON.stringify({
          package_version: VERSION,
          installation_status: parsedComment.status,
          sync_status: syncStatus,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        }
      )
    } catch (error: unknown) {
      const err = error as Error
      console.error('Status query error:', error)
      return new Response(
        JSON.stringify({
          error: err.message,
          package_version: VERSION,
          installation_status: 'not_installed',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    } finally {
      if (sql) await sql.end()
    }
  }

  // Handle DELETE requests for uninstall
  if (req.method === 'DELETE') {
    let stripeSync = null
    try {
      // Get and validate database URL
      const dbUrl = Deno.env.get('SUPABASE_DB_URL')
      if (!dbUrl) {
        throw new Error('SUPABASE_DB_URL environment variable is not set')
      }

      // Stripe key is required for uninstall to delete webhooks
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
      if (!stripeKey) {
        throw new Error('STRIPE_SECRET_KEY environment variable is required for uninstall')
      }

      // Step 1: Delete Stripe webhooks and clean up database
      const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
      const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
      stripeSync = await StripeSync.create({
        poolConfig: { connectionString: dbUrl, max: 2 },
        stripeSecretKey: stripeKey,
        schemaName,
        syncTablesSchemaName,
      })

      // Delete all managed webhooks
      try {
        const webhooks = await stripeSync.webhook.listManagedWebhooks()
        for (const webhook of webhooks) {
          try {
            await stripeSync.webhook.deleteManagedWebhook(webhook.id)
            console.log(`Deleted webhook: ${webhook.id}`)
          } catch (err) {
            console.warn(`Could not delete webhook ${webhook.id}:`, err)
          }
        }
      } catch (err) {
        console.warn(`Could not get webooks:`, err)
      }

      // Unschedule pg_cron jobs
      try {
        await stripeSync.postgresClient.query(`
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker') THEN
              PERFORM cron.unschedule('stripe-sync-worker');
            END IF;
            IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sigma-worker') THEN
              PERFORM cron.unschedule('stripe-sigma-worker');
            END IF;
          END $$;
        `)
      } catch (err) {
        console.warn('Could not unschedule pg_cron job:', err)
      }

      // Delete vault secrets
      try {
        await stripeSync.postgresClient.query(`
          DELETE FROM vault.secrets
          WHERE name IN ('stripe_sync_worker_secret', 'stripe_sigma_worker_secret')
        `)
      } catch (err) {
        console.warn('Could not delete vault secret:', err)
      }

      // Drop Sigma self-trigger function if present
      try {
        const dropSchema = syncTablesSchemaName.replace(/"/g, '""')
        await stripeSync.postgresClient.query(
          `DROP FUNCTION IF EXISTS "${dropSchema}".trigger_sigma_worker()`
        )
      } catch (err) {
        console.warn('Could not drop sigma trigger function:', err)
      }

      // Terminate connections holding locks on schema
      try {
        await stripeSync.postgresClient.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_locks l
           JOIN pg_class c ON l.relation = c.oid
           JOIN pg_namespace n ON c.relnamespace = n.oid
           WHERE n.nspname = $1 AND l.pid != pg_backend_pid()`,
          [syncTablesSchemaName]
        )
      } catch (err) {
        console.warn('Could not terminate connections:', err)
      }

      // Drop schema(s) with retry
      const schemasToDrop = [...new Set([schemaName, syncTablesSchemaName])]
      let dropAttempts = 0
      const maxAttempts = 3
      while (dropAttempts < maxAttempts) {
        try {
          for (const s of schemasToDrop) {
            const safe = s.replace(/"/g, '""')
            await stripeSync.postgresClient.query(`DROP SCHEMA IF EXISTS "${safe}" CASCADE`)
          }
          break // Success, exit loop
        } catch (err: unknown) {
          const error = err as Error
          dropAttempts++
          if (dropAttempts >= maxAttempts) {
            throw new Error(
              `Failed to drop schema after ${maxAttempts} attempts. ` +
                `There may be active connections or locks on the stripe schema. ` +
                `Error: ${error.message}`
            )
          }
          // Wait 1 second before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      await stripeSync.postgresClient.pool.end()

      // Step 2: Delete Supabase secrets
      try {
        await deleteSecret(projectRef, 'STRIPE_SECRET_KEY', accessToken)
      } catch (err) {
        console.warn('Could not delete STRIPE_SECRET_KEY secret:', err)
      }

      try {
        await deleteSecret(projectRef, 'MANAGEMENT_API_URL', accessToken)
      } catch (err) {
        console.warn('Could not delete MANAGEMENT_API_URL secret:', err)
      }

      try {
        await deleteSecret(projectRef, 'ENABLE_SIGMA', accessToken)
      } catch (err) {
        console.warn('Could not delete ENABLE_SIGMA secret:', err)
      }

      // Step 3: Delete Edge Functions
      try {
        await deleteEdgeFunction(projectRef, 'stripe-setup', accessToken)
      } catch (err) {
        console.warn('Could not delete stripe-setup function:', err)
      }

      try {
        await deleteEdgeFunction(projectRef, 'stripe-webhook', accessToken)
      } catch (err) {
        console.warn('Could not delete stripe-webhook function:', err)
      }

      try {
        await deleteEdgeFunction(projectRef, 'stripe-worker', accessToken)
      } catch (err) {
        console.warn('Could not delete stripe-worker function:', err)
      }

      try {
        await deleteEdgeFunction(projectRef, 'sigma-data-worker', accessToken)
      } catch (err) {
        console.warn('Could not delete sigma-data-worker function:', err)
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Uninstall complete',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    } catch (error: unknown) {
      const err = error as Error
      console.error('Uninstall error:', error)
      // Cleanup on error
      if (stripeSync) {
        try {
          await stripeSync.postgresClient.pool.end()
        } catch (cleanupErr) {
          console.warn('Cleanup failed:', cleanupErr)
        }
      }
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  // Handle POST requests for install
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let stripeSync = null
  try {
    // Get and validate database URL
    const dbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!dbUrl) {
      throw new Error('SUPABASE_DB_URL environment variable is not set')
    }

    const enableSigma = (Deno.env.get('ENABLE_SIGMA') ?? 'false') === 'true'
    const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
    const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
    await runMigrationsFromContent(
      {
        databaseUrl: dbUrl,
        enableSigma,
        stripeApiVersion: Deno.env.get('STRIPE_API_VERSION') ?? '2020-08-27',
        schemaName,
        syncTablesSchemaName,
      },
      embeddedMigrations
    )

    stripeSync = await StripeSync.create({
      poolConfig: { connectionString: dbUrl, max: 2 }, // Need 2 for advisory lock + queries
      stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY'),
      schemaName,
      syncTablesSchemaName,
    })

    // Release any stale advisory locks from previous timeouts
    await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')

    // Construct webhook URL from SUPABASE_URL (available in all Edge Functions)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL environment variable is not set')
    }
    const webhookUrl = `'${supabaseUrl}/functions/v1/stripe-webhook`

    const webhook = await stripeSync.webhook.findOrCreateManagedWebhook(webhookUrl)

    await stripeSync.postgresClient.pool.end()

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Setup complete',
        webhookId: webhook.id,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error: unknown) {
    const err = error as Error
    console.error('Setup error:', error)
    // Cleanup on error
    if (stripeSync) {
      try {
        await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')
        await stripeSync.postgresClient.pool.end()
      } catch (cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr)
      }
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
