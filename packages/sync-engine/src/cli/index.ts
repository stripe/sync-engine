#!/usr/bin/env node

import { Command } from 'commander'
import pkg from '../../package.json' with { type: 'json' }
import {
  migrateCommand,
  monitorCommand,
  installCommand,
  uninstallCommand,
  fullSyncCommand,
} from './commands'

const program = new Command()

program
  .name('stripe-experiment-sync')
  .description('CLI tool for syncing Stripe data to PostgreSQL')
  .version(pkg.version)

// Migrate command
program
  .command('migrate')
  .description('Run database migrations only')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option('--sigma', 'Create Sigma tables during migration')
  .action(async (options) => {
    await migrateCommand({
      databaseUrl: options.databaseUrl,
      enableSigma: options.sigma,
    })
  })

// Sync command
program
  .command('sync [entityName]')
  .description(
    'Re-sync from Stripe, optionally for a specific entity (e.g., customer, invoice), skipping if a successful run completed within --interval'
  )
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option('--sigma', 'Enable Sigma tables')
  .option(
    '--interval <seconds>',
    'Skip resync if a successful run completed within this many seconds (default: 86400)',
    (val) => parseInt(val, 10),
    86400
  )
  .option(
    '--worker-count <count>',
    'Number of parallel sync workers (default: 50)',
    (val) => parseInt(val, 10),
    50
  )
  .option(
    '--rate-limit <limit>',
    'Max requests per second (default: 25)',
    (val) => parseInt(val, 10),
    25
  )
  .option(
    '--listen-mode <mode>',
    'Event listener mode: websocket, webhook, or disabled (default: disabled)',
    'disabled'
  )
  .option('--listen-only', 'Skip the initial sync and only set up the event listener')
  .action(async (entityName, options) => {
    await fullSyncCommand(
      {
        stripeKey: options.stripeKey,
        databaseUrl: options.databaseUrl,
        enableSigma: options.sigma,
        interval: options.interval,
        workerCount: options.workerCount,
        rateLimit: options.rateLimit,
        listenMode: options.listenMode,
        listenOnly: options.listenOnly,
      },
      entityName
    )
  })

// Monitor command
program
  .command('monitor')
  .description('Live display of table row counts in the stripe schema')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .action(async (options) => {
    await monitorCommand({
      databaseUrl: options.databaseUrl,
      stripeKey: options.stripeKey,
    })
  })

// Supabase commands
const supabase = program.command('supabase').description('Supabase Edge Functions commands')

supabase
  .command('install')
  .description('Install Stripe sync to Supabase Edge Functions')
  .option('--token <token>', 'Supabase access token (or SUPABASE_ACCESS_TOKEN env)')
  .option('--project <ref>', 'Supabase project ref (or SUPABASE_PROJECT_REF env)')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option(
    '--package-version <version>',
    'Package version to install (e.g., 1.0.8-beta.1, defaults to latest)'
  )
  .option(
    '--worker-interval <seconds>',
    'Worker interval in seconds (defaults to 60)',
    (val) => parseInt(val, 10),
    60
  )
  .option(
    '--management-url <url>',
    'Supabase management API URL with protocol (e.g., http://localhost:54323, defaults to https://api.supabase.com or SUPABASE_MANAGEMENT_URL env)'
  )
  .option('--sigma', 'Enable Sigma sync (deploy sigma worker and cron job)')
  .option(
    '--rate-limit <limit>',
    'Max Stripe API requests per second (default: 60)',
    (val) => parseInt(val, 10),
    60
  )
  .option(
    '--sync-interval <seconds>',
    'How often to run a full resync in seconds (default: 604800 = 1 week)',
    (val) => parseInt(val, 10),
    604800
  )
  .action(async (options) => {
    await installCommand({
      supabaseAccessToken: options.token,
      supabaseProjectRef: options.project,
      stripeKey: options.stripeKey,
      packageVersion: options.packageVersion,
      workerInterval: options.workerInterval,
      syncInterval: options.syncInterval,
      supabaseManagementUrl: options.managementUrl,
      enableSigma: options.sigma,
      rateLimit: options.rateLimit,
    })
  })

supabase
  .command('uninstall')
  .description('Uninstall Stripe sync from Supabase Edge Functions')
  .option('--token <token>', 'Supabase access token (or SUPABASE_ACCESS_TOKEN env)')
  .option('--project <ref>', 'Supabase project ref (or SUPABASE_PROJECT_REF env)')
  .option(
    '--management-url <url>',
    'Supabase management API URL with protocol (e.g., http://localhost:54323, defaults to https://api.supabase.com or SUPABASE_MANAGEMENT_URL env)'
  )
  .action(async (options) => {
    await uninstallCommand({
      supabaseAccessToken: options.token,
      supabaseProjectRef: options.project,
      supabaseManagementUrl: options.managementUrl,
    })
  })

program.parse()
