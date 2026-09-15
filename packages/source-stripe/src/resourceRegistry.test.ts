import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenApiSpec } from '@stripe/sync-openapi'
import { buildResourceRegistry } from './resourceRegistry.js'

const subscriptionSpec: OpenApiSpec = {
  openapi: '3.0.0',
  paths: {
    '/v1/subscriptions': {
      get: {
        parameters: [{ name: 'limit', in: 'query' }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', enum: ['list'] },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/subscription' },
                    },
                    has_more: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/subscription_schedules': {
      get: {
        parameters: [{ name: 'limit', in: 'query' }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', enum: ['list'] },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/subscription_schedule' },
                    },
                    has_more: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      subscription: {
        'x-resourceId': 'subscription',
        type: 'object',
        properties: { id: { type: 'string' } },
      },
      subscription_schedule: {
        'x-resourceId': 'subscription_schedule',
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  },
}

const v2CreatedSpec: OpenApiSpec = {
  openapi: '3.0.0',
  paths: {
    '/v2/core/accounts': {
      get: {
        parameters: [{ name: 'limit', in: 'query' }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/v2.core.account' },
                    },
                    next_page_url: { type: 'string', nullable: true },
                    previous_page_url: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v2/core/events': {
      get: {
        parameters: [
          {
            name: 'created',
            in: 'query',
            schema: {
              type: 'object',
              properties: {
                gte: { type: 'string', format: 'date-time' },
                lt: { type: 'string', format: 'date-time' },
              },
            },
          },
          { name: 'limit', in: 'query' },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/v2.core.event' },
                    },
                    next_page_url: { type: 'string', nullable: true },
                    previous_page_url: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      'v2.core.account': {
        'x-resourceId': 'v2.core.account',
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
      'v2.core.event': {
        'x-resourceId': 'v2.core.event',
        type: 'object',
        properties: {
          id: { type: 'string' },
          created: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
}

describe('buildResourceRegistry', () => {
  it('keeps v2 created filter support when the spec advertises it', () => {
    const registry = buildResourceRegistry(v2CreatedSpec, 'sk_test_fake', '2026-03-25.dahlia')

    expect(registry.v2_core_account?.supportsCreatedFilter).toBe(false)
    expect(registry.v2_core_event?.supportsCreatedFilter).toBe(true)
  })

  describe('list extra query params (issue #336)', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('passes status=all when listing subscriptions so canceled rows are included', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
        )

      const registry = buildResourceRegistry(subscriptionSpec, 'sk_test_fake', '2026-03-25.dahlia')
      await registry.subscription!.listFn!({ limit: 10 })

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(new URL(url).searchParams.get('status')).toBe('all')
    })

    it('passes scope=all when listing subscription schedules so canceled rows are included', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
        )

      const registry = buildResourceRegistry(subscriptionSpec, 'sk_test_fake', '2026-03-25.dahlia')
      await registry.subscription_schedule!.listFn!({ limit: 10 })

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(new URL(url).searchParams.get('scope')).toBe('all')
    })
  })
})
