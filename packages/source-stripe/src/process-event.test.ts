import { describe, expect, it } from 'vitest'
import type { Message, RecordMessage } from '@stripe/sync-protocol'
import type { StripeEvent } from './spec.js'
import type { Config } from './index.js'
import type { ResourceConfig } from './types.js'
import { fromStripeEvent, processStripeEvent } from './process-event.js'

function makeEvent(overrides: {
  id?: string
  type?: string
  created?: number
  account?: string
  dataObject: Record<string, unknown>
}): StripeEvent {
  return {
    id: overrides.id ?? 'evt_test_123',
    object: 'event',
    type: overrides.type ?? 'customer.updated',
    account: overrides.account,
    created: overrides.created ?? 1700000000,
    api_version: '2025-04-30.basil',
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: overrides.dataObject,
    },
  } satisfies StripeEvent
}

function makeConfig(
  overrides: Partial<ResourceConfig> & { order: number; tableName: string }
): ResourceConfig {
  return {
    supportsCreatedFilter: false,
    listFn: (() =>
      Promise.resolve({ data: [], has_more: false, responseAt: 0 })) as ResourceConfig['listFn'],
    retrieveFn: (() => Promise.resolve({})) as ResourceConfig['retrieveFn'],
    parsedTable: {
      tableName: overrides.tableName,
      resourceId: overrides.tableName,
      sourceSchemaName: overrides.tableName,
      columns: [{ name: 'id', type: 'text' as const, nullable: false }],
    },
    ...overrides,
  } as ResourceConfig
}

function catalog(...streams: Array<{ name: string }>) {
  return {
    streams: streams.map((s) => ({
      stream: { name: s.name, primary_key: [['id']], newer_than_field: '_updated_at' },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'overwrite' as const,
    })),
  }
}

async function collect(iter: AsyncIterable<Message>): Promise<Message[]> {
  const results: Message[] = []
  for await (const message of iter) {
    results.push(message)
  }
  return results
}

const config = { api_key: 'sk_test_fake' } as Config

describe('Connect account guard', () => {
  describe('processStripeEvent()', () => {
    it('drops a Connect event whose event.account differs from the pipeline account', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customer' }),
      }
      const streamNames = new Set(['customer'])

      // A signed Connect customer.updated event where event.account identifies
      // the connected account and data.object carries no account field at all.
      const event = makeEvent({
        type: 'customer.updated',
        account: 'acct_connected_victim',
        dataObject: { id: 'cus_1', object: 'customer', name: 'Victim Co' },
      })

      const messages = await collect(
        processStripeEvent(
          event,
          config,
          catalog({ name: 'customer' }),
          registry,
          streamNames,
          'acct_platform_allowed'
        )
      )

      expect(messages).toHaveLength(0)
    })

    it('processes the event when event.account matches the pipeline account', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customer' }),
      }
      const streamNames = new Set(['customer'])

      const event = makeEvent({
        type: 'customer.updated',
        account: 'acct_platform_allowed',
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const messages = await collect(
        processStripeEvent(
          event,
          config,
          catalog({ name: 'customer' }),
          registry,
          streamNames,
          'acct_platform_allowed'
        )
      )

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).toMatchObject({
        id: 'cus_1',
        _account_id: 'acct_platform_allowed',
      })
    })

    it('processes the event when event.account is absent (non-Connect event)', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customer' }),
      }
      const streamNames = new Set(['customer'])

      const event = makeEvent({
        type: 'customer.updated',
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const messages = await collect(
        processStripeEvent(
          event,
          config,
          catalog({ name: 'customer' }),
          registry,
          streamNames,
          'acct_platform_allowed'
        )
      )

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).toMatchObject({
        id: 'cus_1',
        _account_id: 'acct_platform_allowed',
      })
    })

    it('processes the event when the pipeline has no accountId to compare against', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customer' }),
      }
      const streamNames = new Set(['customer'])

      const event = makeEvent({
        type: 'customer.updated',
        account: 'acct_connected_victim',
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const messages = await collect(
        processStripeEvent(event, config, catalog({ name: 'customer' }), registry, streamNames)
      )

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).not.toHaveProperty('_account_id')
    })

    it('drops an entitlements summary event whose event.account differs from the pipeline account', async () => {
      const registry: Record<string, ResourceConfig> = {}
      const streamNames = new Set(['active_entitlement'])

      const event = makeEvent({
        type: 'entitlements.active_entitlement_summary.updated',
        account: 'acct_connected_victim',
        dataObject: {
          customer: 'cus_1',
          entitlements: { data: [{ id: 'ent_1', object: 'entitlement', feature: 'feat_1' }] },
        },
      })

      const messages = await collect(
        processStripeEvent(
          event,
          config,
          catalog({ name: 'active_entitlement' }),
          registry,
          streamNames,
          'acct_platform_allowed'
        )
      )

      expect(messages).toHaveLength(0)
    })
  })

  describe('fromStripeEvent()', () => {
    it('returns null for a Connect event whose event.account differs from the pipeline account', () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customer' }),
      }

      const event = makeEvent({
        account: 'acct_connected_victim',
        dataObject: { id: 'cus_1', object: 'customer', name: 'Victim Co' },
      })

      const result = fromStripeEvent(event, registry, '_updated_at', 'acct_platform_allowed')
      expect(result).toBeNull()
    })

    it('returns a record when event.account matches the pipeline account', () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customer' }),
      }

      const event = makeEvent({
        account: 'acct_platform_allowed',
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const result = fromStripeEvent(event, registry, '_updated_at', 'acct_platform_allowed')
      expect(result).not.toBeNull()
      expect(result!.record.record.data).toMatchObject({
        id: 'cus_1',
        _account_id: 'acct_platform_allowed',
      })
    })

    it('returns a record when event.account is absent (non-Connect event)', () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customer' }),
      }

      const event = makeEvent({
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const result = fromStripeEvent(event, registry, '_updated_at', 'acct_platform_allowed')
      expect(result).not.toBeNull()
      expect(result!.record.record.data).toMatchObject({
        id: 'cus_1',
        _account_id: 'acct_platform_allowed',
      })
    })
  })
})
