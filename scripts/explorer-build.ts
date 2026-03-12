#!/usr/bin/env tsx
/**
 * Schema Explorer Full Pipeline Orchestration Script
 *
 * This script chains together the complete schema explorer artifact generation pipeline:
 * 1. Start harness DB (isolated Postgres in Docker)
 * 2. Wait for DB to be ready
 * 3. Run migrations (all_projected mode)
 * 4. Seed data (deterministic fake Stripe data)
 * 5. Export artifact (bootstrap.sql + manifest.json)
 * 6. Stop harness DB (cleanup)
 *
 * Usage:
 *   pnpm explorer:build [--api-version=2020-08-27] [--seed=42]
 *
 * Flags:
 *   --api-version  Stripe API version for schema resolution (default: 2020-08-27)
 *   --seed         Random seed for deterministic data generation (default: 42)
 *
 * Examples:
 *   pnpm explorer:build
 *   pnpm explorer:build --api-version=2023-10-16
 *   pnpm explorer:build --api-version=2023-10-16 --seed=1337
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const TMP_DIR = path.join(process.cwd(), '.tmp')
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json')

interface PipelineConfig {
  apiVersion: string
  seed: number
}

/**
 * Parse command line arguments
 */
function parseArgs(): PipelineConfig {
  const args = process.argv.slice(2)
  const config: PipelineConfig = {
    apiVersion: '2020-08-27',
    seed: 42,
  }

  for (const arg of args) {
    if (arg.startsWith('--api-version=')) {
      config.apiVersion = arg.split('=')[1]
    } else if (arg.startsWith('--seed=')) {
      config.seed = parseInt(arg.split('=')[1], 10)
      if (isNaN(config.seed)) {
        throw new Error(`Invalid seed value: ${arg.split('=')[1]}`)
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm explorer:build [--api-version=2020-08-27] [--seed=42]')
      console.log('')
      console.log('Flags:')
      console.log('  --api-version  Stripe API version for schema resolution (default: 2020-08-27)')
      console.log('  --seed         Random seed for deterministic data generation (default: 42)')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return config
}

/**
 * Execute a command and handle errors with phase context
 */
function execPhase(command: string, phase: string, env?: NodeJS.ProcessEnv): void {
  try {
    execSync(command, {
      stdio: 'inherit',
      env: env ? { ...process.env, ...env } : process.env,
    })
  } catch (error) {
    console.error(`\n❌ Pipeline failed at phase: ${phase}`)
    console.error(`   Command: ${command}`)
    throw error
  }
}

/**
 * Check if harness is already running
 */
function isHarnessRunning(): boolean {
  return fs.existsSync(METADATA_FILE)
}

/**
 * Main pipeline orchestration
 */
async function main(): Promise<void> {
  console.log('🚀 Schema Explorer Build Pipeline\n')
  console.log('═══════════════════════════════════════════════════════════')

  // Parse configuration
  let config: PipelineConfig
  try {
    config = parseArgs()
  } catch (error) {
    console.error('❌ Configuration error:', (error as Error).message)
    process.exit(1)
  }

  console.log('\n📋 Configuration:')
  console.log(`   API Version: ${config.apiVersion}`)
  console.log(`   Seed: ${config.seed}`)
  console.log('\n═══════════════════════════════════════════════════════════\n')

  const startTime = Date.now()
  let shouldCleanup = false

  try {
    // Phase 1: Start harness DB
    console.log('📦 Phase 1: Starting harness database...\n')

    if (isHarnessRunning()) {
      console.log('⚠️  Harness already running. Stopping existing instance first...\n')
      try {
        execPhase('pnpm tsx scripts/explorer-harness.ts stop', 'Pre-cleanup')
      } catch {
        // Ignore cleanup errors, may have stale metadata file
        if (fs.existsSync(METADATA_FILE)) {
          fs.unlinkSync(METADATA_FILE)
        }
      }
      console.log('')
    }

    execPhase('pnpm tsx scripts/explorer-harness.ts start', 'Start Harness DB')
    shouldCleanup = true // Mark for cleanup if subsequent phases fail

    console.log('\n✅ Phase 1 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')

    // Phase 2: Run migrations
    console.log('📦 Phase 2: Running migrations (all_projected mode)...\n')

    // Set environment variable for API version
    try {
      execPhase(
        `pnpm tsx scripts/explorer-migrate.ts --api-version=${config.apiVersion}`,
        'Migrate schema',
        {
          STRIPE_API_VERSION: config.apiVersion,
        }
      )
    } catch (error) {
      throw new Error('Migration phase failed')
    }

    console.log('\n✅ Phase 2 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')

    // Phase 3: Seed data
    console.log('📦 Phase 3: Seeding deterministic data...\n')

    try {
      execPhase(
        `pnpm tsx scripts/explorer-seed.ts --api-version=${config.apiVersion} --seed=${config.seed}`,
        'Seed data',
        {
          STRIPE_API_VERSION: config.apiVersion,
          SEED: String(config.seed),
        }
      )
    } catch (error) {
      throw new Error('Seed phase failed')
    }

    console.log('\n✅ Phase 3 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')

    // Phase 4: Export artifact
    console.log('📦 Phase 4: Exporting artifact...\n')

    execPhase('pnpm tsx scripts/explorer-export.ts', 'Export Artifact')

    console.log('\n✅ Phase 4 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')

    // Phase 5: Stop harness DB
    console.log('📦 Phase 5: Cleaning up harness database...\n')

    execPhase('pnpm tsx scripts/explorer-harness.ts stop', 'Stop Harness DB')
    shouldCleanup = false // Cleanup successful

    console.log('\n✅ Phase 5 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')

    // Success summary
    const duration = Math.round((Date.now() - startTime) / 1000)
    console.log('🎉 Pipeline complete!\n')
    console.log(`   Duration: ${duration}s`)
    console.log(`   API Version: ${config.apiVersion}`)
    console.log(`   Seed: ${config.seed}`)
    console.log('')
    console.log('📦 Artifacts generated:')
    console.log('   - packages/visualizer/public/explorer-data/bootstrap.sql')
    console.log('   - packages/visualizer/public/explorer-data/manifest.json')
    console.log('')
    console.log('💡 Next steps:')
    console.log('   - Run locally: pnpm visualizer')
    console.log('   - Deploy to Vercel: see scripts/EXPLORER_RUNBOOK.md')
    console.log('')
  } catch (error) {
    // Attempt cleanup if harness is still running
    if (shouldCleanup && isHarnessRunning()) {
      console.error('\n🧹 Attempting to clean up harness database...\n')
      try {
        execSync('pnpm tsx scripts/explorer-harness.ts stop', { stdio: 'inherit' })
        console.error('\n✅ Cleanup successful\n')
      } catch (cleanupError) {
        console.error('\n⚠️  Cleanup failed. You may need to manually stop the container:\n')
        console.error('   pnpm tsx scripts/explorer-harness.ts stop\n')
      }
    }

    console.error('═══════════════════════════════════════════════════════════\n')
    console.error('❌ Pipeline failed\n')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error.message || error)
  process.exit(1)
})
