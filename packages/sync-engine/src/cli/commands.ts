import chalk from 'chalk'
import express from 'express'
import http from 'node:http'
import dotenv from 'dotenv'
import { type PoolConfig } from 'pg'
import { loadConfig, type CliOptions, type ListenMode } from './config'
import {
  StripeSync,
  runMigrations,
  createStripeWebSocketClient,
  type StripeWebSocketClient,
  type StripeWebhookEvent,
} from '../index'
import { createTunnel, type NgrokTunnel } from './ngrok'
import { SYNC_OBJECTS, type StripeObject } from '../resourceRegistry'
import { install, uninstall } from '../supabase'

/**
 * Monitor command - live display of table row counts.
 */
export async function monitorCommand(options: CliOptions): Promise<void> {
  try {
    dotenv.config()

    let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

    if (!databaseUrl) {
      const inquirer = (await import('inquirer')).default
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'databaseUrl',
          message: 'Enter your Postgres DATABASE_URL:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') return 'DATABASE_URL is required'
            if (!input.startsWith('postgres://') && !input.startsWith('postgresql://'))
              return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
            return true
          },
        },
      ])
      databaseUrl = answers.databaseUrl
    }

    const poolConfig: PoolConfig = {
      max: 1,
      connectionString: databaseUrl,
      keepAlive: true,
    }

    const stripeSync = await StripeSync.create({
      databaseUrl,
      stripeSecretKey:
        options.stripeKey ||
        process.env.STRIPE_API_KEY ||
        process.env.STRIPE_SECRET_KEY ||
        'sk_placeholder',
      poolConfig,
    })

    console.log(chalk.blue('Monitoring table row counts (Ctrl-C to stop)...\n'))
    const activeRun = await stripeSync.postgresClient.getActiveSyncRun(stripeSync.accountId)
    if (!activeRun) {
      const lastCompleted = await stripeSync.postgresClient.getCompletedRun(
        stripeSync.accountId,
        Infinity
      )
      if (lastCompleted) {
        console.log(
          chalk.green(
            `No active sync run. Last completed at ${lastCompleted.runStartedAt.toISOString()}`
          )
        )
      } else {
        console.log(chalk.yellow('No active or completed sync runs found.'))
      }
      await stripeSync.close()
      return
    }
    const interval = stripeSync.startTableMonitor(2000, activeRun)

    const cleanup = () => {
      clearInterval(interval)
      stripeSync.close().finally(() => process.exit(0))
    }
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)

    await new Promise(() => {})
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    process.exit(1)
  }
}

export interface DeployOptions {
  supabaseAccessToken?: string
  supabaseProjectRef?: string
  stripeKey?: string
  packageVersion?: string
  workerInterval?: number
  syncInterval?: number
  supabaseManagementUrl?: string
  enableSigma?: boolean
  rateLimit?: number
}

export type { CliOptions }

/**
 * Migration command - runs database migrations only.
 */
export async function migrateCommand(options: CliOptions): Promise<void> {
  try {
    // For migrations, we only need the database URL
    dotenv.config()

    let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

    if (!databaseUrl) {
      const inquirer = (await import('inquirer')).default
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'databaseUrl',
          message: 'Enter your Postgres DATABASE_URL:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'DATABASE_URL is required'
            }
            if (!input.startsWith('postgres://') && !input.startsWith('postgresql://')) {
              return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
            }
            return true
          },
        },
      ])
      databaseUrl = answers.databaseUrl
    }

    // Check if sigma is enabled via CLI option or env var
    const enableSigma = options.enableSigma ?? process.env.ENABLE_SIGMA === 'true'

    console.log(chalk.blue("Running database migrations in 'stripe' schema..."))
    console.log(chalk.gray(`Database: ${databaseUrl.replace(/:[^:@]+@/, ':****@')}`))
    if (enableSigma) {
      console.log(chalk.blue('Sigma tables enabled'))
    }

    try {
      const schemaName = process.env.SYNC_SCHEMA_NAME ?? undefined
      const syncTablesSchemaName = process.env.SYNC_TABLES_SCHEMA_NAME ?? undefined
      await runMigrations({
        databaseUrl,
        enableSigma,
        stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
        schemaName,
        syncTablesSchemaName,
      })
      console.log(chalk.green('✓ Migrations completed successfully'))
    } catch (migrationError) {
      // Migration failed
      console.warn(chalk.yellow('Migrations failed.'))
      if (migrationError instanceof Error) {
        const errorMsg = migrationError.message || migrationError.toString()
        console.warn('Migration error:', errorMsg)
        if (migrationError.stack) {
          console.warn(chalk.gray(migrationError.stack))
        }
      } else {
        console.warn('Migration error:', String(migrationError))
      }
      throw migrationError
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    process.exit(1)
  }
}

interface EventListenerResult {
  wsClient: StripeWebSocketClient | null
  tunnel: NgrokTunnel | null
  server: http.Server | null
  webhookId: string | null
}

/**
 * Sets up real-time event listening via WebSocket or ngrok webhook tunnel.
 * Returns the created resources so the caller can manage their lifecycle.
 */
export async function setupEventListener(
  stripeSync: StripeSync,
  config: { stripeApiKey: string; ngrokAuthToken?: string; databaseUrl: string },
  mode: ListenMode = 'websocket'
): Promise<EventListenerResult> {
  const modeLabel = mode === 'websocket' ? 'WebSocket' : 'Webhook (ngrok)'
  console.log(chalk.blue(`\nMode: ${modeLabel}`))

  const databaseUrlWithoutPassword = config.databaseUrl.replace(/:[^:@]+@/, ':****@')

  if (mode === 'websocket') {
    console.log(chalk.blue('\nConnecting to Stripe WebSocket...'))

    const wsClient = await createStripeWebSocketClient({
      stripeApiKey: config.stripeApiKey,
      onEvent: async (event: StripeWebhookEvent) => {
        try {
          const payload = JSON.parse(event.event_payload)
          console.log(chalk.cyan(`← ${payload.type}`) + chalk.gray(` (${payload.id})`))
          await stripeSync.webhook.processEvent(payload)
          return {
            status: 200,
            event_type: payload.type,
            event_id: payload.id,
            databaseUrl: databaseUrlWithoutPassword,
          }
        } catch (err) {
          console.error(chalk.red('Error processing event:'), err)
          return {
            status: 500,
            databaseUrl: databaseUrlWithoutPassword,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      },
      onReady: (secret) => {
        console.log(chalk.green('✓ Connected to Stripe WebSocket'))
        const maskedSecret =
          secret.length > 14 ? `${secret.slice(0, 10)}...${secret.slice(-4)}` : '****'
        console.log(chalk.gray(`  Webhook secret: ${maskedSecret}`))
      },
      onError: (error) => {
        console.error(chalk.red('WebSocket error:'), error.message)
      },
      onClose: (code, reason) => {
        console.log(chalk.yellow(`WebSocket closed: ${code} - ${reason}`))
      },
    })

    return { wsClient, tunnel: null, server: null, webhookId: null }
  }

  // Webhook mode (ngrok)
  const port = 3000
  const tunnel = await createTunnel(port, config.ngrokAuthToken!)

  const webhookPath = process.env.WEBHOOK_PATH || '/stripe-webhooks'
  console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))
  const webhook = await stripeSync.webhook.findOrCreateManagedWebhook(`${tunnel.url}${webhookPath}`)
  const webhookId = webhook.id
  const eventCount = webhook.enabled_events?.length || 0
  console.log(chalk.green(`✓ Webhook created: ${webhook.id}`))
  console.log(chalk.cyan(`  URL: ${webhook.url}`))
  console.log(chalk.cyan(`  Events: ${eventCount} supported events`))

  const app = express()
  const webhookRoute = webhookPath
  app.use(webhookRoute, express.raw({ type: 'application/json' }))

  app.post(webhookRoute, async (req, res) => {
    const sig = req.headers['stripe-signature']
    if (!sig || typeof sig !== 'string') {
      console.error('[Webhook] Missing stripe-signature header')
      return res.status(400).send({ error: 'Missing stripe-signature header' })
    }

    const rawBody = req.body
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      console.error('[Webhook] Body is not a Buffer!')
      return res.status(400).send({ error: 'Missing raw body for signature verification' })
    }

    try {
      await stripeSync.webhook.processWebhook(rawBody, sig)
      return res.status(200).send({ received: true })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error('[Webhook] Processing error:', errorMessage)
      return res.status(400).send({ error: errorMessage })
    }
  })

  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.get('/health', async (req, res) => res.status(200).json({ status: 'ok' }))

  console.log(chalk.blue(`\nStarting server on port ${port}...`))
  const server = await new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(port, '0.0.0.0', () => resolve(srv))
    srv.on('error', reject)
  })
  console.log(chalk.green(`✓ Server started on port ${port}`))

  return { wsClient: null, tunnel, server, webhookId }
}

/**
 * Tears down all resources: event listener (WebSocket/webhook/tunnel) and database pool.
 */
export async function cleanup(
  listener: EventListenerResult,
  stripeSync?: StripeSync,
  signal?: string
): Promise<void> {
  console.log(chalk.blue(`\n\nCleaning up... (signal: ${signal || 'manual'})`))

  if (listener.wsClient) {
    try {
      listener.wsClient.close()
      console.log(chalk.green('✓ WebSocket closed'))
    } catch {
      console.log(chalk.yellow('⚠ Could not close WebSocket'))
    }
  }

  const keepWebhooksOnShutdown = process.env.KEEP_WEBHOOKS_ON_SHUTDOWN === 'true'
  if (listener.webhookId && stripeSync && !keepWebhooksOnShutdown) {
    try {
      await stripeSync.webhook.deleteManagedWebhook(listener.webhookId)
      console.log(chalk.green('✓ Webhook cleanup complete'))
    } catch {
      console.log(chalk.yellow('⚠ Could not delete webhook'))
    }
  }

  if (listener.server) {
    try {
      await new Promise<void>((resolve, reject) => {
        listener.server!.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      console.log(chalk.green('✓ Server stopped'))
    } catch {
      console.log(chalk.yellow('⚠ Server already stopped'))
    }
  }

  if (listener.tunnel) {
    try {
      await listener.tunnel.close()
    } catch {
      console.log(chalk.yellow('⚠ Could not close tunnel'))
    }
  }

  if (stripeSync) {
    try {
      await stripeSync.close()
      console.log(chalk.green('✓ Database pool closed'))
    } catch {
      console.log(chalk.yellow('⚠ Could not close database pool'))
    }
  }
}

/**
 * Full resync command - uses reconciliation to skip if a successful run
 * completed within the given interval, otherwise re-syncs everything from Stripe.
 */
export async function fullSyncCommand(
  options: CliOptions,
  entityName: string = 'all'
): Promise<void> {
  let stripeSync: StripeSync
  let listener: EventListenerResult = {
    wsClient: null,
    tunnel: null,
    server: null,
    webhookId: null,
  }

  const shutdown = async (signal?: string) => {
    await cleanup(listener, stripeSync, signal)
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    const config = await loadConfig(options)
    const intervalSeconds = options.interval ?? 86400

    const maskedDbUrl = config.databaseUrl.replace(/:[^:@]+@/, ':****@')
    const entityLabel = entityName ? `Stripe ${entityName} data` : 'all Stripe data'
    console.log(chalk.blue(`\nPerforming full resync of ${entityLabel}...`))
    console.log(chalk.gray(`Database: ${maskedDbUrl}`))
    console.log(chalk.gray(`Reconciliation interval: ${intervalSeconds}s`))

    try {
      const schemaName = process.env.SYNC_SCHEMA_NAME ?? undefined
      const syncTablesSchemaName = process.env.SYNC_TABLES_SCHEMA_NAME ?? undefined
      await runMigrations({
        databaseUrl: config.databaseUrl,
        enableSigma: config.enableSigma,
        stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
        schemaName,
        syncTablesSchemaName,
      })
    } catch (migrationError) {
      console.error(chalk.red('Failed to run migrations:'))
      console.error(
        migrationError instanceof Error ? migrationError.message : String(migrationError)
      )
      throw migrationError
    }

    const poolConfig: PoolConfig = {
      max: 10,
      connectionString: config.databaseUrl,
      keepAlive: true,
    }

    stripeSync = await StripeSync.create({
      databaseUrl: config.databaseUrl,
      stripeSecretKey: config.stripeApiKey,
      enableSigma: config.enableSigma,
      stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      poolConfig,
    })

    const completedRun = await stripeSync.postgresClient.getCompletedRun(
      stripeSync.accountId,
      intervalSeconds
    )

    if (completedRun) {
      console.log(
        chalk.green(
          `✓ Skipping resync — a successful run completed at ${completedRun.runStartedAt.toISOString()} (within ${intervalSeconds}s window)`
        )
      )
      await stripeSync.close()
      return
    }

    if (options.listenMode && options.listenMode !== 'disabled') {
      listener = await setupEventListener(stripeSync, config, options.listenMode)
    }

    if (options.listenOnly) {
      console.log(chalk.yellow('Skipping initial sync (--listen-only)'))
      if (options.listenMode && options.listenMode !== 'disabled') {
        console.log(
          chalk.cyan('\n● Streaming live changes...') + chalk.gray(' [press Ctrl-C to abort]')
        )
        await new Promise(() => {})
      }
      await shutdown()
      return
    }

    const startTime = Date.now()
    const tables = entityName !== 'all' ? [entityName as StripeObject] : undefined
    const result = await stripeSync.fullSync(
      tables,
      true,
      options.workerCount,
      options.rateLimit,
      true,
      intervalSeconds
    )
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const objectCount = Object.keys(result.totals).length
    console.log(
      chalk.green(
        `✓ Full resync complete: ${result.totalSynced} rows synced across ${objectCount} objects in ${elapsed}s`
      )
    )
    if (result.skipped.length > 0) {
      console.log(
        chalk.yellow(
          `Skipped ${result.skipped.length} Sigma tables without access: ${result.skipped.join(', ')}`
        )
      )
    }
    if (result.errors.length > 0) {
      console.log(chalk.red(`Full resync finished with ${result.errors.length} errors:`))
      for (const err of result.errors) {
        console.log(chalk.red(`  - ${err.object}: ${err.message}`))
      }
    }

    if (options.listenMode && options.listenMode !== 'disabled') {
      console.log(
        chalk.cyan('\n● Streaming live changes...') + chalk.gray(' [press Ctrl-C to abort]')
      )
      await new Promise(() => {})
    } else {
      await shutdown()
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    await shutdown()
    process.exit(1)
  }
}

/**
 * Install command - installs Stripe sync Edge Functions to Supabase.
 * 1. Validates Supabase project access
 * 2. Deploys stripe-setup, stripe-webhook, and stripe-worker Edge Functions
 * 3. Sets required secrets (STRIPE_SECRET_KEY)
 * 4. Runs the setup function to create webhook and run migrations
 */
export async function installCommand(options: DeployOptions): Promise<void> {
  try {
    dotenv.config()

    let accessToken = options.supabaseAccessToken || process.env.SUPABASE_ACCESS_TOKEN || ''
    let projectRef = options.supabaseProjectRef || process.env.SUPABASE_PROJECT_REF || ''
    let stripeKey =
      options.stripeKey || process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || ''

    // Prompt for missing values
    if (!accessToken || !projectRef || !stripeKey) {
      const inquirer = (await import('inquirer')).default
      const questions = []

      if (!accessToken) {
        questions.push({
          type: 'password',
          name: 'accessToken',
          message: 'Enter your Supabase access token (from supabase.com/dashboard/account/tokens):',
          mask: '*',
          validate: (input: string) => input.trim() !== '' || 'Access token is required',
        })
      }

      if (!projectRef) {
        questions.push({
          type: 'input',
          name: 'projectRef',
          message: 'Enter your Supabase project ref (e.g., abcdefghijklmnop):',
          validate: (input: string) => input.trim() !== '' || 'Project ref is required',
        })
      }

      if (!stripeKey) {
        questions.push({
          type: 'password',
          name: 'stripeKey',
          message: 'Enter your Stripe secret key:',
          mask: '*',
          validate: (input: string) => {
            if (!input.trim()) return 'Stripe key is required'
            if (!input.startsWith('sk_') && !input.startsWith('rk_'))
              return 'Stripe key should start with "sk_" or "rk_"'
            return true
          },
        })
      }

      if (questions.length > 0) {
        console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
        const answers = await inquirer.prompt(questions)
        if (answers.accessToken) accessToken = answers.accessToken
        if (answers.projectRef) projectRef = answers.projectRef
        if (answers.stripeKey) stripeKey = answers.stripeKey
      }
    }

    console.log(chalk.blue('\n🚀 Installing Stripe Sync to Supabase Edge Functions...\n'))

    const tokenSource = options.supabaseAccessToken
      ? 'CLI'
      : process.env.SUPABASE_ACCESS_TOKEN
        ? 'env'
        : 'prompt'
    const projectSource = options.supabaseProjectRef
      ? 'CLI'
      : process.env.SUPABASE_PROJECT_REF
        ? 'env'
        : 'prompt'
    console.log(
      chalk.gray(
        `Access token source: ${tokenSource} (${accessToken.slice(0, 8)}...${accessToken.slice(-4)})`
      )
    )
    console.log(chalk.gray(`Project ref source: ${projectSource} (${projectRef})`))

    // Get management URL from options or environment variable
    const supabaseManagementUrl =
      options.supabaseManagementUrl || process.env.SUPABASE_MANAGEMENT_URL

    // Run installation via the install() function
    console.log(chalk.gray('Validating project access...'))
    await install({
      supabaseAccessToken: accessToken,
      supabaseProjectRef: projectRef,
      stripeKey,
      packageVersion: options.packageVersion,
      workerIntervalSeconds: options.workerInterval,
      syncIntervalSeconds: options.syncInterval,
      supabaseManagementUrl,
      enableSigma: options.enableSigma,
      rateLimit: options.rateLimit,
    })

    // Print summary
    console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
    console.log(chalk.cyan.bold('  Installation Complete!'))
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'))
    console.log(chalk.gray('\n  Your Stripe data will stay in sync to your Supabase database.'))
    console.log(
      chalk.gray('  View your data in the Supabase dashboard under the "stripe" schema.\n')
    )
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Installation failed: ${error.message}`))
    }
    process.exit(1)
  }
}

/**
 * Uninstall command - removes Stripe sync Edge Functions and resources from Supabase.
 * 1. Validates Supabase project access
 * 2. Deletes Stripe webhooks
 * 3. Deletes Edge Functions (stripe-setup, stripe-webhook, stripe-worker)
 * 4. Deletes secrets and pg_cron jobs
 * 5. Drops the stripe schema
 */
export async function uninstallCommand(options: DeployOptions): Promise<void> {
  try {
    dotenv.config()

    let accessToken = options.supabaseAccessToken || process.env.SUPABASE_ACCESS_TOKEN || ''
    let projectRef = options.supabaseProjectRef || process.env.SUPABASE_PROJECT_REF || ''

    // Prompt for missing values
    if (!accessToken || !projectRef) {
      const inquirer = (await import('inquirer')).default
      const questions = []

      if (!accessToken) {
        questions.push({
          type: 'password',
          name: 'accessToken',
          message: 'Enter your Supabase access token (from supabase.com/dashboard/account/tokens):',
          mask: '*',
          validate: (input: string) => input.trim() !== '' || 'Access token is required',
        })
      }

      if (!projectRef) {
        questions.push({
          type: 'input',
          name: 'projectRef',
          message: 'Enter your Supabase project ref (e.g., abcdefghijklmnop):',
          validate: (input: string) => input.trim() !== '' || 'Project ref is required',
        })
      }

      if (questions.length > 0) {
        console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
        const answers = await inquirer.prompt(questions)
        if (answers.accessToken) accessToken = answers.accessToken
        if (answers.projectRef) projectRef = answers.projectRef
      }
    }

    console.log(chalk.blue('\n🗑️  Uninstalling Stripe Sync from Supabase...\n'))
    console.log(chalk.yellow('⚠️  Warning: This will delete all Stripe data from your database!\n'))

    // Get management URL from options or environment variable
    const supabaseManagementUrl =
      options.supabaseManagementUrl || process.env.SUPABASE_MANAGEMENT_URL

    // Run uninstall via the uninstall() function
    console.log(chalk.gray('Removing all resources...'))
    await uninstall({
      supabaseAccessToken: accessToken,
      supabaseProjectRef: projectRef,
      supabaseManagementUrl,
    })

    // Print summary
    console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
    console.log(chalk.cyan.bold('  Uninstall Complete!'))
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'))
    console.log(
      chalk.gray('\n  All Stripe sync resources have been removed from your Supabase project.')
    )
    console.log(chalk.gray('  - Edge Functions deleted'))
    console.log(chalk.gray('  - Stripe webhooks removed'))
    console.log(chalk.gray('  - Database schema dropped\n'))
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Uninstall failed: ${error.message}`))
    }
    process.exit(1)
  }
}
