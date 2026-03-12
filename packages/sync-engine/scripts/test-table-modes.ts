#!/usr/bin/env tsx
/**
 * Test script to compare table counts between 'runtime_required' and 'all_projected' modes.
 *
 * Usage:
 *   TEST_POSTGRES_DB_URL=postgresql://localhost:5432/test_db tsx scripts/test-table-modes.ts
 */
import {
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
  RUNTIME_REQUIRED_TABLES,
  resolveOpenApiSpec,
} from '../src/openapi'

async function main() {
  console.log('Testing table mode differences...\n')

  // Resolve the OpenAPI spec
  const resolvedSpec = await resolveOpenApiSpec({
    apiVersion: '2020-08-27',
  })

  console.log(`OpenAPI spec resolved from: ${resolvedSpec.source}`)
  if (resolvedSpec.commitSha) {
    console.log(`Commit SHA: ${resolvedSpec.commitSha}`)
  }
  console.log()

  // Test runtime_required mode
  const parser = new SpecParser()
  const runtimeRequiredSpec = parser.parse(resolvedSpec.spec, {
    resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    allowedTables: [...RUNTIME_REQUIRED_TABLES],
  })

  console.log('=== runtime_required mode ===')
  console.log(`Tables parsed: ${runtimeRequiredSpec.tables.length}`)
  console.log(`Table names: ${runtimeRequiredSpec.tables.map((t) => t.tableName).join(', ')}`)
  console.log()

  // Test all_projected mode (omit allowedTables to parse all resolvable x-resourceId entries)
  const allProjectedSpec = parser.parse(resolvedSpec.spec, {
    resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    // No allowedTables property - all resolvable x-resourceId entries are parsed
  })

  console.log('=== all_projected mode ===')
  console.log(`Tables parsed: ${allProjectedSpec.tables.length}`)
  console.log(`Table names: ${allProjectedSpec.tables.map((t) => t.tableName).join(', ')}`)
  console.log()

  // Compare
  const diff = allProjectedSpec.tables.length - runtimeRequiredSpec.tables.length
  console.log('=== Comparison ===')
  console.log(`Difference: ${diff > 0 ? '+' : ''}${diff} tables`)
  console.log()

  // Find tables that are in all_projected but not in runtime_required
  const runtimeTableNames = new Set(runtimeRequiredSpec.tables.map((t) => t.tableName))
  const additionalTables = allProjectedSpec.tables
    .filter((t) => !runtimeTableNames.has(t.tableName))
    .map((t) => t.tableName)

  if (additionalTables.length > 0) {
    console.log('Additional tables in all_projected mode:')
    additionalTables.forEach((name) => console.log(`  - ${name}`))
  } else {
    console.log('No additional tables found in all_projected mode.')
  }
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
