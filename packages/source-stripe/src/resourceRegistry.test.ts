import { describe, expect, it } from 'vitest'
import type { OpenApiSpec } from '@stripe/sync-openapi'
import { buildResourceRegistry } from './resourceRegistry.js'

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

  it('provides retrieveFn but no final-state predicate for ordinary subscription resources', () => {
    const subscriptionSpec: OpenApiSpec = {
      openapi: '3.0.0',
      info: { version: '2026-03-25.dahlia' },
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
      },
      components: {
        schemas: {
          subscription: {
            'x-resourceId': 'subscription',
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    }

    const registry = buildResourceRegistry(subscriptionSpec, 'sk_test_fake', '2026-03-25.dahlia')
    expect(registry.subscription?.retrieveFn).toBeTypeOf('function')
    expect(registry.subscription?.isFinalState).toBeUndefined()
  })
})
