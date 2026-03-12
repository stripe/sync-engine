#!/usr/bin/env tsx
/**
 * Run migrations against the schema explorer database
 *
 * Usage:
 *   pnpm tsx scripts/explorer-migrate.ts [--api-version=2020-08-27]
 *   STRIPE_API_VERSION=2023-10-16 pnpm tsx scripts/explorer-migrate.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'node:util'
import { runMigrations } from '../packages/sync-engine/src/database/migrate.js'

const TMP_DIR = path.join(process.cwd(), '.tmp')
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json')
const DEFAULT_STRIPE_API_VERSION = '2020-08-27'

interface ContainerMetadata {
  databaseUrl: string
  containerId: string
  containerName: string
  port: number
  volumeName: string
  createdAt: string
}

interface MigrationScriptConfig {
  stripeApiVersion: string
}

function printUsage(): void {
  console.log('Usage: pnpm tsx scripts/explorer-migrate.ts --api-version=2020-08-27')
  console.log('')
  console.log('Flags:')
  console.log(
    `  --api-version  Stripe API version for schema resolution (default: ${DEFAULT_STRIPE_API_VERSION})`
  )
  console.log('')
  console.log('Environment:')
  console.log('  STRIPE_API_VERSION  Used when --api-version is not provided')
}

function resolveApiVersion(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_STRIPE_API_VERSION
  }

  const normalizedValue = value.trim()
  if (!normalizedValue) {
    throw new Error('Stripe API version cannot be empty')
  }

  return normalizedValue
}

function parseConfig(): MigrationScriptConfig {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: {
      'api-version': {
        type: 'string',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
    strict: true,
  })

  if (values.help) {
    printUsage()
    process.exit(0)
  }

  return {
    stripeApiVersion: resolveApiVersion(values['api-version'] ?? process.env.STRIPE_API_VERSION),
  }
}

async function main(): Promise<void> {
  console.log('🔧 Explorer Migration Script\n')

  let config: MigrationScriptConfig
  try {
    config = parseConfig()
  } catch (error) {
    console.error('❌ Configuration error:', (error as Error).message)
    process.exit(1)
  }

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
  console.log(`   API Version: ${config.stripeApiVersion}`)
  console.log('')

  console.log('🚀 Running migrations...\n')

  try {
    await runMigrations({
      databaseUrl: metadata.databaseUrl,
      logger: {
        info: (msg: any) =>
          console.log('  ℹ️ ', typeof msg === 'string' ? msg : JSON.stringify(msg)),
        warn: (msg: any) =>
          console.log('  ⚠️ ', typeof msg === 'string' ? msg : JSON.stringify(msg)),
        error: (msg: any) =>
          console.log('  ❌', typeof msg === 'string' ? msg : JSON.stringify(msg)),
      },
      stripeApiVersion: config.stripeApiVersion,
      tableMode: 'all_projected', // Use all_projected mode to include all projected tables
    })

    console.log('\n✅ Migrations complete!')
  } catch (error) {
    console.error('\n❌ Migration failed:', error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})
