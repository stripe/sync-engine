import { describe, expect, it } from 'vitest'
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
  it('omitting allowedTables parses every resolvable minimal-spec table', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'active_entitlements',
      'checkout_sessions',
      'customers',
      'early_fraud_warnings',
      'features',
      'plans',
      'prices',
      'products',
      'subscription_items',
    ])
  })

  it('keeps explicit allowedTables filtering and compatibility fallbacks', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['checkout_session_line_items', 'customers'],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'checkout_session_line_items',
      'customers',
    ])

    const checkoutSessionLineItems = parsed.tables.find(
      (table) => table.tableName === 'checkout_session_line_items'
    )
    expect(checkoutSessionLineItems?.columns).toContainEqual({
      name: 'checkout_session',
      type: 'text',
      nullable: true,
    })
    expect(checkoutSessionLineItems?.columns).toContainEqual({
      name: 'amount_discount',
      type: 'bigint',
      nullable: true,
    })
  })

  it('all_projected expands beyond runtime_required on the real Stripe 2020-08-27 spec', async () => {
    const apiVersion = '2020-08-27'
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion,
    })

    const parser = new SpecParser()
    const runtimeParsed = parser.parse(resolvedSpec.spec, {
      allowedTables: [...RUNTIME_REQUIRED_TABLES],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })
    const allProjectedParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    expect(runtimeParsed.tables.map((table) => table.tableName)).toEqual(
      [...RUNTIME_REQUIRED_TABLES].sort()
    )
    expect(allProjectedParsed.tables.length).toBeGreaterThan(runtimeParsed.tables.length)
    expect(allProjectedParsed.tables.length).toBeGreaterThan(100)
    expect(
      allProjectedParsed.tables.some((table) => !RUNTIME_REQUIRED_TABLES.includes(table.tableName))
    ).toBe(true)
  }, 60000) // 60 second timeout for fetching real spec
})
