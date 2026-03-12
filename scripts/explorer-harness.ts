#!/usr/bin/env tsx
/**
 * Docker Postgres Harness for Schema Explorer
 *
 * Creates an isolated Postgres container with:
 * - Random suffix name to avoid collisions
 * - Random host port (not 5432 or 55432)
 * - Unique volume for data persistence
 * - Explicit credentials
 * - Safety checks to prevent running against shared instances
 *
 * Usage:
 *   pnpm tsx scripts/explorer-harness.ts start   # Create and start container
 *   pnpm tsx scripts/explorer-harness.ts stop    # Stop and cleanup container
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const POSTGRES_IMAGE = 'postgres:15-alpine'
const POSTGRES_USER = 'explorer'
const POSTGRES_PASSWORD = 'explorer_pass_' + Math.random().toString(36).slice(2, 8)
const POSTGRES_DB = 'schema_explorer'

const TMP_DIR = path.join(process.cwd(), '.tmp')
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json')

// Forbidden values that indicate shared/user instances
// Port 55432 is specifically mentioned as a shared instance port in requirements
// Container name 'stripe-db' is specifically mentioned as a shared instance name
const FORBIDDEN_PORTS = [5432, 55432]
const FORBIDDEN_CONTAINER_NAMES = ['stripe-db']

interface ContainerMetadata {
  databaseUrl: string
  containerId: string
  containerName: string
  port: number
  volumeName: string
  createdAt: string
}

function generateSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

function getRandomPort(): number {
  // Generate random port between 50000-60000, avoiding forbidden ports
  let port: number
  do {
    port = Math.floor(Math.random() * 10000) + 50000
  } while (FORBIDDEN_PORTS.includes(port))
  return port
}

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  }
}

function safetyCheck(containerName: string, port: number, databaseUrl: string): void {
  // Check container name doesn't match forbidden names
  const lowerName = containerName.toLowerCase()
  for (const forbidden of FORBIDDEN_CONTAINER_NAMES) {
    if (lowerName.includes(forbidden)) {
      throw new Error(
        `SAFETY CHECK FAILED: Container name '${containerName}' matches forbidden pattern '${forbidden}'. ` +
          `This harness refuses to create containers with common shared database names.`
      )
    }
  }

  // Check port isn't forbidden
  if (FORBIDDEN_PORTS.includes(port)) {
    throw new Error(
      `SAFETY CHECK FAILED: Port ${port} is in the forbidden list ${JSON.stringify(FORBIDDEN_PORTS)}. ` +
        `This harness refuses to use standard Postgres ports to avoid conflicts with existing instances.`
    )
  }

  // Check database URL is localhost
  if (!databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1')) {
    throw new Error(
      `SAFETY CHECK FAILED: Database URL '${databaseUrl}' does not point to localhost. ` +
        `This harness only works with local Docker containers.`
    )
  }

  // Parse and double-check port from URL
  const urlPort = parseInt(databaseUrl.split(':').pop()?.split('/')[0] || '0', 10)
  if (FORBIDDEN_PORTS.includes(urlPort)) {
    throw new Error(
      `SAFETY CHECK FAILED: Database URL contains forbidden port ${urlPort}. ` +
        `Refusing to proceed to avoid conflicts with shared instances.`
    )
  }

  console.log('✅ Safety checks passed')
}

async function startContainer(): Promise<void> {
  console.log('🚀 Starting Schema Explorer Postgres harness...\n')

  // Generate unique identifiers
  const suffix = generateSuffix()
  const containerName = `schema-explorer-${suffix}`
  const volumeName = `schema-explorer-vol-${suffix}`
  const hostPort = getRandomPort()

  // Build database URL
  const databaseUrl = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${hostPort}/${POSTGRES_DB}`

  // Run safety checks
  console.log('🔒 Running safety checks...')
  safetyCheck(containerName, hostPort, databaseUrl)

  // Clean up any existing container with same name (shouldn't happen due to random suffix)
  try {
    execSync(`docker rm -f ${containerName} 2>/dev/null`, { stdio: 'pipe' })
  } catch {
    // Container doesn't exist, that's fine
  }

  console.log(`\n📦 Creating Docker container '${containerName}'...`)
  console.log(`   Image: ${POSTGRES_IMAGE}`)
  console.log(`   Volume: ${volumeName}`)
  console.log(`   Host Port: ${hostPort}`)
  console.log(`   Database: ${POSTGRES_DB}`)

  // Create volume
  execSync(`docker volume create ${volumeName}`, { stdio: 'inherit' })

  // Start container
  const containerId = execSync(
    [
      'docker run -d',
      `--name ${containerName}`,
      `-e POSTGRES_USER=${POSTGRES_USER}`,
      `-e POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
      `-e POSTGRES_DB=${POSTGRES_DB}`,
      `-p ${hostPort}:5432`,
      `-v ${volumeName}:/var/lib/postgresql/data`,
      POSTGRES_IMAGE,
    ].join(' '),
    { encoding: 'utf-8' }
  ).trim()

  console.log(`\n⏳ Waiting for Postgres to be ready...`)

  // Wait for Postgres to be ready (max 30 seconds)
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      // Try to connect using psql in the container
      execSync(
        `docker exec ${containerId} psql -U ${POSTGRES_USER} -d ${POSTGRES_DB} -c "SELECT 1" > /dev/null 2>&1`,
        { stdio: 'pipe' }
      )
      ready = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  if (!ready) {
    console.error('❌ Postgres failed to start in time. Cleaning up...')
    execSync(`docker rm -f ${containerId}`, { stdio: 'inherit' })
    execSync(`docker volume rm ${volumeName}`, { stdio: 'inherit' })
    process.exit(1)
  }

  // Save metadata
  ensureTmpDir()
  const metadata: ContainerMetadata = {
    databaseUrl,
    containerId,
    containerName,
    port: hostPort,
    volumeName,
    createdAt: new Date().toISOString(),
  }

  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2))

  console.log('\n✅ Schema Explorer Postgres is ready!\n')
  console.log('📋 Connection details:')
  console.log(`   Database URL: ${databaseUrl}`)
  console.log(`   Container ID: ${containerId.slice(0, 12)}`)
  console.log(`   Container Name: ${containerName}`)
  console.log(`   Port: ${hostPort}`)
  console.log(`\n📄 Metadata saved to: ${METADATA_FILE}`)
  console.log(`\n🛑 To stop: pnpm tsx scripts/explorer-harness.ts stop`)
}

async function stopContainer(): Promise<void> {
  console.log('🛑 Stopping Schema Explorer Postgres harness...\n')

  // Load metadata
  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ No metadata file found. Nothing to clean up.')
    console.error(`   Expected: ${METADATA_FILE}`)
    process.exit(1)
  }

  const metadata: ContainerMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'))

  console.log('📋 Found container metadata:')
  console.log(`   Container ID: ${metadata.containerId.slice(0, 12)}`)
  console.log(`   Container Name: ${metadata.containerName}`)
  console.log(`   Volume: ${metadata.volumeName}`)

  // Stop and remove container
  try {
    console.log(`\n🗑️  Removing container...`)
    execSync(`docker rm -f ${metadata.containerId}`, { stdio: 'inherit' })
  } catch (error) {
    console.warn('⚠️  Container may have already been removed')
  }

  // Remove volume
  try {
    console.log(`🗑️  Removing volume...`)
    execSync(`docker volume rm ${metadata.volumeName}`, { stdio: 'inherit' })
  } catch (error) {
    console.warn('⚠️  Volume may have already been removed')
  }

  // Remove metadata file
  fs.unlinkSync(METADATA_FILE)

  console.log('\n✅ Cleanup complete!')
}

async function statusCheck(): Promise<void> {
  console.log('ℹ️  Schema Explorer Postgres Status\n')

  if (!fs.existsSync(METADATA_FILE)) {
    console.log('❌ No running instance found')
    console.log(`   Metadata file not found: ${METADATA_FILE}`)
    console.log(`\n💡 Start with: pnpm tsx scripts/explorer-harness.ts start`)
    process.exit(0)
  }

  const metadata: ContainerMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'))

  console.log('📋 Saved metadata:')
  console.log(`   Container ID: ${metadata.containerId.slice(0, 12)}`)
  console.log(`   Container Name: ${metadata.containerName}`)
  console.log(`   Port: ${metadata.port}`)
  console.log(`   Volume: ${metadata.volumeName}`)
  console.log(`   Created: ${metadata.createdAt}`)

  // Check if container is actually running
  try {
    const output = execSync(
      `docker inspect --format='{{.State.Running}}' ${metadata.containerId}`,
      {
        encoding: 'utf-8',
        stdio: 'pipe',
      }
    ).trim()

    if (output === 'true') {
      console.log('\n✅ Container is running')
      console.log(`\n📋 Connection:`)
      console.log(`   ${metadata.databaseUrl}`)
    } else {
      console.log('\n⚠️  Container exists but is not running')
    }
  } catch {
    console.log('\n❌ Container not found in Docker')
    console.log('   Metadata file exists but container may have been manually removed')
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]

  switch (command) {
    case 'start':
      await startContainer()
      break
    case 'stop':
      await stopContainer()
      break
    case 'status':
      await statusCheck()
      break
    default:
      console.error('Usage:')
      console.error('  pnpm tsx scripts/explorer-harness.ts start   # Start container')
      console.error('  pnpm tsx scripts/explorer-harness.ts stop    # Stop and cleanup')
      console.error('  pnpm tsx scripts/explorer-harness.ts status  # Check status')
      process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Error:', error.message)
  process.exit(1)
})
