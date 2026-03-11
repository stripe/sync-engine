import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SpecParser, RUNTIME_REQUIRED_TABLES, OPENAPI_RESOURCE_TABLE_ALIASES } from '../specParser'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'
import { resolveOpenApiSpec } from '../specFetchHelper'

describe('SpecParser', () => {
  it('parses aliased resources into deterministic tables and column types', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['checkout_sessions', 'customers', 'early_fraud_warnings'],
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'checkout_sessions',
      'customers',
      'early_fraud_warnings',
    ])

    const customers = parsed.tables.find((table) => table.tableName === 'customers')
    expect(customers?.columns).toEqual([
      { name: 'created', type: 'bigint', nullable: false },
      { name: 'deleted', type: 'boolean', nullable: false },
      { name: 'object', type: 'text', nullable: false },
    ])

    const checkoutSessions = parsed.tables.find((table) => table.tableName === 'checkout_sessions')
    expect(checkoutSessions?.columns).toContainEqual({
      name: 'amount_total',
      type: 'bigint',
      nullable: false,
    })
  })

  it('injects compatibility columns for runtime-critical tables', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: { schemas: {} },
      },
      { allowedTables: ['active_entitlements', 'subscription_items'] }
    )

    const activeEntitlements = parsed.tables.find(
      (table) => table.tableName === 'active_entitlements'
    )
    expect(activeEntitlements?.columns).toContainEqual({
      name: 'customer',
      type: 'text',
      nullable: true,
    })

    const subscriptionItems = parsed.tables.find(
      (table) => table.tableName === 'subscription_items'
    )
    expect(subscriptionItems?.columns).toContainEqual({
      name: 'deleted',
      type: 'boolean',
      nullable: true,
    })
    expect(subscriptionItems?.columns).toContainEqual({
      name: 'subscription',
      type: 'text',
      nullable: true,
    })
  })

  it('is deterministic regardless of schema key order', () => {
    const parser = new SpecParser()
    const normal = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['customers', 'plans', 'prices'],
    })

    const reversedSchemas = Object.fromEntries(
      Object.entries(minimalStripeOpenApiSpec.components?.schemas ?? {}).reverse()
    )
    const reversed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: reversedSchemas,
        },
      },
      { allowedTables: ['customers', 'plans', 'prices'] }
    )

    expect(reversed).toEqual(normal)
  })

  it('marks expandable references from x-expansionResources metadata', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            charge: {
              'x-resourceId': 'charge',
              type: 'object',
              properties: {
                id: { type: 'string' },
                customer: {
                  anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/customer' }],
                  'x-expansionResources': {
                    oneOf: [{ $ref: '#/components/schemas/customer' }],
                  },
                },
              },
            },
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['charges'] }
    )

    const charges = parsed.tables.find((table) => table.tableName === 'charges')
    expect(charges?.columns).toContainEqual({
      name: 'customer',
      type: 'json',
      nullable: false,
      expandableReference: true,
    })
  })
})

describe('SpecParser - Table Modes (runtime_required vs all_projected)', () => {
  it('runtime_required mode produces expected table count from minimal spec', () => {
    const parser = new SpecParser()

    // Test with the minimal spec - should only include tables that are in RUNTIME_REQUIRED_TABLES
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: [...RUNTIME_REQUIRED_TABLES],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    // The minimal spec has limited schemas, so we expect only the intersection
    // of what's defined in minimalSpec AND what's in RUNTIME_REQUIRED_TABLES
    expect(parsed.tables.length).toBeGreaterThan(0)
    expect(parsed.tables.length).toBeLessThanOrEqual(RUNTIME_REQUIRED_TABLES.length)

    // Verify all returned tables are in RUNTIME_REQUIRED_TABLES
    const runtimeRequiredSet = new Set(RUNTIME_REQUIRED_TABLES)
    for (const table of parsed.tables) {
      expect(runtimeRequiredSet.has(table.tableName)).toBe(true)
    }
  })

  it('all_projected mode produces more or equal tables than runtime_required mode on minimal spec', () => {
    const parser = new SpecParser()

    // Parse with runtime_required mode (restricted)
    const runtimeParsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: [...RUNTIME_REQUIRED_TABLES],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    // Parse with all_projected mode (unrestricted - omit allowedTables)
    const allProjectedParsed = parser.parse(minimalStripeOpenApiSpec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    // all_projected mode should produce same or more tables
    expect(allProjectedParsed.tables.length).toBeGreaterThanOrEqual(runtimeParsed.tables.length)

    // All runtime_required tables should be present in all_projected
    const allProjectedTableNames = new Set(allProjectedParsed.tables.map((t) => t.tableName))
    for (const runtimeTable of runtimeParsed.tables) {
      expect(allProjectedTableNames.has(runtimeTable.tableName)).toBe(true)
    }
  })

  /**
   * Integration test: fetches real Stripe OpenAPI spec for API version 2020-08-27
   * and tests both table modes against it. This test may be slow as it fetches
   * from GitHub or cache.
   *
   * Expected results for API version 2020-08-27:
   * - runtime_required mode: ~22 tables (based on RUNTIME_REQUIRED_TABLES)
   * - all_projected mode: significantly more tables (all resolvable x-resourceId schemas)
   */
  it('verifies table counts for both modes using real Stripe OpenAPI spec 2020-08-27', async () => {
    const apiVersion = '2020-08-27'
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion,
    })

    const parser = new SpecParser()

    // Test runtime_required mode
    const runtimeParsed = parser.parse(resolvedSpec.spec, {
      allowedTables: [...RUNTIME_REQUIRED_TABLES],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    // Test all_projected mode (no allowedTables restriction)
    const allProjectedParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    // Verify runtime_required produces ~22 tables
    // RUNTIME_REQUIRED_TABLES may have 22+ entries, but not all may be in OpenAPI spec
    expect(runtimeParsed.tables.length).toBeGreaterThanOrEqual(19)
    expect(runtimeParsed.tables.length).toBeLessThanOrEqual(25)

    // Document the exact count for runtime_required mode
    console.log(`runtime_required mode table count: ${runtimeParsed.tables.length}`)
    console.log('runtime_required tables:', runtimeParsed.tables.map((t) => t.tableName).sort())

    // PHASE 1 CHECKPOINT FINDING:
    // For API version 2020-08-27, all_projected mode produces the SAME number of tables
    // as runtime_required mode. This indicates that the OpenAPI spec only contains
    // x-resourceId schemas for the tables already in RUNTIME_REQUIRED_TABLES.
    // The parser scope (what's in the spec) is the bottleneck, not the migration filtering.
    //
    // Decision point: Either expand parser to discover more schemas, or ship explorer
    // with the current 23 projectable tables.
    expect(allProjectedParsed.tables.length).toBeGreaterThanOrEqual(runtimeParsed.tables.length)

    // Document the exact count for all_projected mode
    console.log(`all_projected mode table count: ${allProjectedParsed.tables.length}`)
    console.log('all_projected tables:', allProjectedParsed.tables.map((t) => t.tableName).sort())

    // Verify all runtime tables are in all_projected
    const allProjectedTableNames = new Set(allProjectedParsed.tables.map((t) => t.tableName))
    for (const runtimeTable of runtimeParsed.tables) {
      expect(allProjectedTableNames.has(runtimeTable.tableName)).toBe(true)
    }

    // Create machine-readable inventory artifact
    const tmpDir = path.resolve(process.cwd(), '.tmp')
    await fs.mkdir(tmpDir, { recursive: true })

    const inventory = {
      apiVersion,
      generatedAt: new Date().toISOString(),
      source: resolvedSpec.source,
      commitSha: resolvedSpec.commitSha,
      modes: {
        runtime_required: {
          tableCount: runtimeParsed.tables.length,
          tables: runtimeParsed.tables.map((t) => ({
            tableName: t.tableName,
            resourceId: t.resourceId,
            sourceSchemaName: t.sourceSchemaName,
            columnCount: t.columns.length,
            columns: t.columns.map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable,
              expandableReference: c.expandableReference ?? false,
            })),
          })),
        },
        all_projected: {
          tableCount: allProjectedParsed.tables.length,
          tables: allProjectedParsed.tables.map((t) => ({
            tableName: t.tableName,
            resourceId: t.resourceId,
            sourceSchemaName: t.sourceSchemaName,
            columnCount: t.columns.length,
            columns: t.columns.map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable,
              expandableReference: c.expandableReference ?? false,
            })),
          })),
        },
      },
    }

    const inventoryPath = path.join(tmpDir, 'table-inventory.json')
    await fs.writeFile(inventoryPath, JSON.stringify(inventory, null, 2), 'utf8')

    console.log(`Table inventory written to: ${inventoryPath}`)

    // Verify the inventory was written successfully
    const inventoryExists = await fs
      .access(inventoryPath)
      .then(() => true)
      .catch(() => false)
    expect(inventoryExists).toBe(true)
  }, 60000) // 60 second timeout for fetching real spec
})
