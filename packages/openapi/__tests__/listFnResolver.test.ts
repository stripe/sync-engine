import { describe, expect, it, vi } from 'vitest'
import { buildListFn, buildRetrieveFn } from '../listFnResolver'
import { SpecParser } from '../specParser'
import { isDeprecatedOperation } from '../specCleaning'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'

describe('SpecParser.discoverListEndpoints', () => {
  const parser = new SpecParser()

  it('maps table names to their API paths', () => {
    const endpoints = parser.discoverListEndpoints(minimalStripeOpenApiSpec)

    expect(endpoints.get('customer')).toEqual({
      tableName: 'customer',
      resourceId: 'customer',
      apiPath: '/v1/customers',
      supportsCreatedFilter: true,
      supportsLimit: true,
      supportsStartingAfter: true,
      supportsEndingBefore: true,
    })
    expect(endpoints.get('checkout_session')).toEqual({
      tableName: 'checkout_session',
      resourceId: 'checkout.session',
      apiPath: '/v1/checkout/sessions',
      supportsCreatedFilter: true,
      supportsLimit: true,
      supportsStartingAfter: true,
      supportsEndingBefore: true,
    })
    expect(endpoints.get('early_fraud_warning')).toEqual({
      tableName: 'early_fraud_warning',
      resourceId: 'radar.early_fraud_warning',
      apiPath: '/v1/radar/early_fraud_warnings',
      supportsCreatedFilter: true,
      supportsLimit: true,
      supportsStartingAfter: true,
      supportsEndingBefore: true,
    })
  })

  it('discovers v2 list endpoints using next_page_url format', () => {
    const endpoints = parser.discoverListEndpoints(minimalStripeOpenApiSpec)

    expect(endpoints.get('v2_core_account')).toEqual({
      tableName: 'v2_core_account',
      resourceId: 'v2.core.account',
      apiPath: '/v2/core/accounts',
      supportsCreatedFilter: false,
      supportsLimit: false,
      supportsStartingAfter: false,
      supportsEndingBefore: false,
    })
    expect(endpoints.get('v2_core_event_destination')).toEqual({
      tableName: 'v2_core_event_destination',
      resourceId: 'v2.core.event_destination',
      apiPath: '/v2/core/event_destinations',
      supportsCreatedFilter: false,
      supportsLimit: false,
      supportsStartingAfter: false,
      supportsEndingBefore: false,
    })
  })

  it('skips paths with path parameters', () => {
    const spec = {
      ...minimalStripeOpenApiSpec,
      paths: {
        ...minimalStripeOpenApiSpec.paths,
        '/v1/customers/{customer}/sources': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object' as const,
                      properties: {
                        object: { type: 'string' as const, enum: ['list'] },
                        data: {
                          type: 'array' as const,
                          items: { $ref: '#/components/schemas/customer' },
                        },
                        has_more: { type: 'boolean' as const },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const endpoints = parser.discoverListEndpoints(spec)
    const paths = Array.from(endpoints.values()).map((e) => e.apiPath)
    expect(paths).not.toContain('/v1/customers/{customer}/sources')
  })

  it('skips endpoints with deprecated: true on the operation', () => {
    const endpoints = parser.discoverListEndpoints(minimalStripeOpenApiSpec)
    const tables = Array.from(endpoints.keys())
    expect(tables).not.toContain('deprecated_widget')
  })

  it('skips endpoints with [Deprecated] in the description', () => {
    const endpoints = parser.discoverListEndpoints(minimalStripeOpenApiSpec)
    const tables = Array.from(endpoints.keys())
    expect(tables).not.toContain('exchange_rate')
  })

  it('skips endpoints that appear in the generated global deprecated paths set', () => {
    const endpoints = parser.discoverListEndpoints(minimalStripeOpenApiSpec)
    const tables = Array.from(endpoints.keys())
    expect(tables).not.toContain('recipient')
    expect(tables).toContain('customer')
  })

  it('returns empty map when spec has no paths', () => {
    const endpoints = parser.discoverListEndpoints({ openapi: '3.0.0' })
    expect(endpoints.size).toBe(0)
  })
})

describe('buildListFn / buildRetrieveFn', () => {
  it('uses the injected fetch for list and retrieve calls', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
    )
    const list = buildListFn('sk_test_fake', '/v1/customers', fetchMock)
    const retrieve = buildRetrieveFn('sk_test_fake', '/v1/customers', fetchMock)
    await list({ limit: 1 })
    await retrieve('cus_123')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses the injected fetch for localhost base URLs', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
    )
    const list = buildListFn(
      'sk_test_fake',
      '/v1/customers',
      fetchMock,
      undefined,
      'http://localhost:12111'
    )
    await list({ limit: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:12111'),
      expect.anything()
    )
  })

  it('throws the Stripe error message for non-2xx list responses', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'Invalid API Key provided: sk_test_bad',
            },
          }),
          { status: 401 }
        )
    )
    const list = buildListFn('sk_test_bad', '/v1/customers', fetchMock)

    await expect(list({ limit: 1 })).rejects.toThrow('Invalid API Key provided: sk_test_bad')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws for v2 non-2xx list responses', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'api_error', message: 'Injected page failure' },
          }),
          { status: 500 }
        )
    )
    const list = buildListFn('sk_test_fake', '/v2/core/accounts', fetchMock)

    await expect(list({ limit: 1 })).rejects.toThrow('Injected page failure')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('encodes created filters for v2 list requests', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'evt_123' }],
            next_page_url: '/v2/core/events?page=cur_next&limit=1',
          }),
          { status: 200, headers: { date: 'Wed, 01 Jan 2025 00:00:00 GMT' } }
        )
    )
    const list = buildListFn('sk_test_fake', '/v2/core/events', fetchMock)

    await expect(
      list({
        limit: 1,
        starting_after: 'cur_prev',
        created: {
          gte: 1735689600,
          lt: 1735776000,
        },
      })
    ).resolves.toEqual({
      data: [{ id: 'evt_123' }],
      has_more: true,
      pageCursor: 'cur_next',
      responseAt: 1735689600,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v2/core/events?'),
      expect.anything()
    )

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.searchParams.get('limit')).toBe('1')
    expect(parsed.searchParams.get('page')).toBe('cur_prev')
    expect(parsed.searchParams.get('created[gte]')).toBe('2025-01-01T00:00:00.000Z')
    expect(parsed.searchParams.get('created[lt]')).toBe('2025-01-02T00:00:00.000Z')
  })

  it('appends extraQueryParams to v1 list calls', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
    )
    const list = buildListFn(
      'sk_test_fake',
      '/v1/subscriptions',
      fetchMock,
      '2024-06-20',
      undefined,
      { status: 'all' }
    )
    await list({ limit: 1 })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).searchParams.get('status')).toBe('all')
  })

  it('appends extraQueryParams to v2 list calls', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [], next_page_url: null }), { status: 200 })
    )
    const list = buildListFn(
      'sk_test_fake',
      '/v2/core/events',
      fetchMock,
      '2024-06-20',
      undefined,
      { foo: 'bar' }
    )
    await list({ limit: 1 })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).searchParams.get('foo')).toBe('bar')
  })

  it('throws the Stripe error message for non-2xx retrieve responses', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'invalid_request_error', message: "No such customer: 'cus_missing'" },
          }),
          { status: 404 }
        )
    )
    const retrieve = buildRetrieveFn('sk_test_fake', '/v1/customers', fetchMock)

    await expect(retrieve('cus_missing')).rejects.toThrow("No such customer: 'cus_missing'")
  })
})

describe('isDeprecatedOperation', () => {
  it('returns true for deprecated: true', () => {
    expect(isDeprecatedOperation({ deprecated: true })).toBe(true)
  })

  it('returns false for deprecated: false', () => {
    expect(isDeprecatedOperation({ deprecated: false })).toBe(false)
  })

  it('returns true for description starting with <p>[Deprecated]', () => {
    expect(
      isDeprecatedOperation({
        description:
          '<p>[Deprecated] The ExchangeRate APIs are deprecated. Please use the FX Quotes API instead.</p>',
      })
    ).toBe(true)
  })

  it('returns false for description mentioning deprecated elsewhere', () => {
    expect(
      isDeprecatedOperation({
        description: '<p>Returns a list of things. Some fields are deprecated.</p>',
      })
    ).toBe(false)
  })

  it('returns false for a normal operation', () => {
    expect(isDeprecatedOperation({ description: '<p>Returns a list of customers.</p>' })).toBe(
      false
    )
  })

  it('returns false for an operation with no description or deprecated flag', () => {
    expect(isDeprecatedOperation({})).toBe(false)
  })
})
