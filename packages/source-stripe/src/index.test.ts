import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StripeEvent } from './spec.js'
import { makeClient, StripeRequestError, type StripeClient } from './client.js'
import type {
  ConfiguredCatalog,
  Message,
  RecordMessage,
  SourceStateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { collectFirst, drain } from '@stripe/sync-protocol'
import source, { createStripeSource, discoverCache } from './index.js'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'
import { fromStripeEvent } from './process-event.js'
import { buildResourceRegistry } from './resourceRegistry.js'
import type { ResourceConfig } from './types.js'
import type { StripeWebhookEvent, StripeWebSocketClient } from './src-websocket.js'
import type { StreamState } from './index.js'
import { listApiBackfill } from './src-list-api.js'
import { createInMemoryRateLimiter } from './rate-limiter.js'
import type { RateLimiter } from './rate-limiter.js'

/** Matches engine defaults passed into `listApiBackfill` from `read()`. */
const LIST_BACKFILL_OPTS = { maxConcurrentStreams: 5 } as const

const TEST_RANGE_GTE = '2010-01-01T00:00:00.000Z'
const TEST_RANGE_LT = '2030-01-01T00:00:00.000Z'

function remainingInProgress(cursor: string | null): StreamState {
  return {
    remaining: [{ gte: TEST_RANGE_GTE, lt: TEST_RANGE_LT, cursor }],
  }
}

function expectRemainingShape(data: unknown): void {
  expect(data).toEqual(
    expect.objectContaining({
      remaining: expect.any(Array),
    })
  )
  const rem = (data as StreamState).remaining
  for (const r of rem) {
    expect(r).toMatchObject({ gte: expect.any(String), lt: expect.any(String) })
    expect(r).toHaveProperty('cursor')
  }
}

/** Type-safe helper to find stream_status messages by status and optional stream name. */
function hasStreamStatus(messages: Message[], status: string, stream?: string): boolean {
  return messages.some(
    (m) =>
      m.type === 'stream_status' &&
      m.stream_status.status === status &&
      (stream === undefined || m.stream_status.stream === stream)
  )
}

/** Type-safe helper to find a stream_status message. */
function findStreamStatus(
  messages: Message[],
  status: string,
  stream?: string
): StreamStatusMessage | undefined {
  return messages.find(
    (m): m is StreamStatusMessage =>
      m.type === 'stream_status' &&
      m.stream_status.status === status &&
      (stream === undefined || m.stream_status.stream === stream)
  )
}

/** Advance iterator until `stream_status` complete for a stream (default `customers`). */
async function drainUntilStreamBackfillComplete(
  iter: AsyncIterator<Message | undefined>,
  stream = 'customers'
): Promise<void> {
  for (;;) {
    const { value, done } = await iter.next()
    if (done) return
    if (value?.type !== 'stream_status') continue
    if (value.stream_status.status !== 'complete' || value.stream_status.stream !== stream) continue
    return
  }
}

// Mock the WebSocket module
const mockClose = vi.fn()
let capturedOnEvent: ((event: StripeWebhookEvent) => void) | null = null
const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

vi.mock('./src-websocket', () => ({
  createStripeWebSocketClient: vi.fn(
    async (opts: { onEvent: (event: StripeWebhookEvent) => void }) => {
      capturedOnEvent = opts.onEvent
      return { close: mockClose, isConnected: () => true } satisfies StripeWebSocketClient
    }
  ),
}))

vi.mock('./resourceRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resourceRegistry.js')>()),
  buildResourceRegistry: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client.js')>()),
  makeClient: vi.fn(() => ({
    getAccount: vi.fn(async () => ({ id: 'acct_test_fake123' })),
  })),
}))

/** Wrap a single item as an AsyncIterable for source.read()'s $stdin param. */
async function* toIter<T>(item: T): AsyncIterable<T> {
  yield item
}

function makeConfig(
  overrides: Partial<ResourceConfig> & { order: number; tableName: string }
): ResourceConfig {
  return {
    supportsCreatedFilter: false,
    listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
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

/** Build a ConfiguredCatalog from stream specs for tests. */
function catalog(...streams: Array<{ name: string; primary_key?: string[][] }>): {
  streams: Array<{
    stream: { name: string; primary_key: string[][]; newer_than_field: string }
    sync_mode: 'full_refresh'
    destination_sync_mode: 'overwrite'
  }>
} {
  return {
    streams: streams.map((s) => ({
      stream: {
        name: s.name,
        primary_key: s.primary_key ?? [['id']],
        newer_than_field: '_updated_at',
      },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'overwrite' as const,
    })),
  }
}

/** Collect all messages from an async iterator into an array. */
async function collect(iter: AsyncIterable<Message>): Promise<Message[]> {
  const results: Message[] = []
  for await (const msg of iter) {
    results.push(msg)
  }
  return results
}

/** Recursively collect all .ts files in a directory. */
function getAllTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full))
    } else if (entry.name.endsWith('.ts')) {
      results.push(full)
    }
  }
  return results
}

/** Create a minimal StripeEvent for testing fromStripeEvent(). */
function makeEvent(overrides: {
  id?: string
  type?: string
  created?: number
  dataObject: Record<string, unknown>
}): StripeEvent {
  return {
    id: overrides.id ?? 'evt_test_123',
    object: 'event',
    type: overrides.type ?? 'customer.updated',
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

const config = { api_key: 'sk_test_fake', api_version: BUNDLED_API_VERSION }

beforeEach(() => {
  vi.mocked(buildResourceRegistry).mockReset()
  discoverCache.clear()
  consoleInfo.mockClear()
  consoleError.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StripeSource', () => {
  describe('discover()', () => {
    it('returns a CatalogMessage with known streams', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
        invoices: makeConfig({ order: 2, tableName: 'invoices' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const cat = (await collectFirst(source.discover({ config }), 'catalog')).catalog

      expect(cat.streams).toHaveLength(2)
      expect(cat.streams.map((s) => s.name)).toEqual(['customers', 'invoices'])
      expect(
        (cat.streams[0].json_schema?.properties as Record<string, unknown>)._account_id
      ).toEqual({ type: 'string', enum: ['acct_test_fake123'] })
    })

    it('excludes resources with sync: false', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
        internal: makeConfig({ order: 2, tableName: 'internal', sync: false }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const cat = (await collectFirst(source.discover({ config }), 'catalog')).catalog

      expect(cat.streams).toHaveLength(1)
      expect(cat.streams[0].name).toBe('customers')
    })

    it('returns empty streams for empty registry', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue({} as any)
      const cat = (await collectFirst(source.discover({ config }), 'catalog')).catalog

      expect(cat.streams).toEqual([])
    })
  })

  describe('setup()', () => {
    it('resolves account_id and account_created together in one account fetch', async () => {
      const getAccount = vi.fn().mockResolvedValue({
        id: 'acct_test_123',
        object: 'account',
        created: 1_700_000_000,
      })
      vi.mocked(makeClient).mockReturnValueOnce({
        getAccount,
      } as unknown as StripeClient)

      const messages = await collect(
        source.setup({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(getAccount).toHaveBeenCalledTimes(1)
      expect(messages).toMatchObject([
        {
          type: 'control',
          control: {
            control_type: 'source_config',
            source_config: expect.objectContaining({
              api_key: config.api_key,
              api_version: config.api_version,
              account_id: 'acct_test_123',
              account_created: 1_700_000_000,
            }),
          },
        },
      ])
    })
  })

  describe('read() — backfill scenarios', () => {
    it('resolves account metadata once and reuses it for default backfill time ranges', async () => {
      const getAccount = vi.fn().mockResolvedValue({
        id: 'acct_test_123',
        object: 'account',
        created: 1_700_000_000,
      })
      vi.mocked(makeClient).mockReturnValueOnce({
        getAccount,
      } as unknown as StripeClient)

      const listFn = vi.fn().mockResolvedValue({
        data: [],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(getAccount).toHaveBeenCalledTimes(1)
      expect(messages.some((m) => m.type === 'stream_status')).toBe(true)
    })

    it('emits RecordMessage + SourceStateMessage in correct interleaving for multi-page stream', async () => {
      const listFn = vi
        .fn()
        // Page 1: 2 items, has_more = true
        .mockResolvedValueOnce({
          data: [
            { id: 'cus_1', name: 'Alice' },
            { id: 'cus_2', name: 'Bob' },
          ],
          has_more: true,
        })
        // Page 2: 1 item, has_more = false
        .mockResolvedValueOnce({
          data: [{ id: 'cus_3', name: 'Charlie' }],
          has_more: false,
        })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.status === 'start' &&
            m.stream_status.stream === 'customers'
        )
      ).toBe(true)
      for (const id of ['cus_1', 'cus_2', 'cus_3'] as const) {
        expect(
          messages.some(
            (m) =>
              m.type === 'record' &&
              (m as RecordMessage).record.stream === 'customers' &&
              (m as RecordMessage).record.data.id === id
          )
        ).toBe(true)
      }
      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.status === 'range_complete' &&
            m.stream_status.stream === 'customers'
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.status === 'complete' &&
            m.stream_status.stream === 'customers'
        )
      ).toBe(true)

      const streamStates = messages.filter(
        (m): m is SourceStateMessage => m.type === 'source_state'
      )
      expect(streamStates.length).toBeGreaterThanOrEqual(2)
      const custStates = streamStates.filter(
        (m) => (m.source_state as { stream?: string }).stream === 'customers'
      )
      // Checkpoints may use cursor: null while pages remain; assert progression + shape instead.
      custStates.forEach((m) => expectRemainingShape(m.source_state.data))
      expect(
        custStates.some((m) => ((m.source_state.data as StreamState).remaining?.length ?? 0) > 0)
      ).toBe(true)
      const finalState = custStates.at(-1)
      expect(finalState?.source_state.data).toMatchObject({ remaining: [] })

      // Verify pagination params
      expect(listFn).toHaveBeenCalledTimes(2)
      expect(listFn).toHaveBeenNthCalledWith(1, { limit: 100 })
      expect(listFn).toHaveBeenNthCalledWith(2, { limit: 100, starting_after: 'cus_2' })
    })

    it('processes multiple streams sequentially', async () => {
      const custListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })
      const invListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'inv_1', total: 100 }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: custListFn as ResourceConfig['listFn'],
        }),
        invoices: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: invListFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
        })
      )

      // Streams run in parallel — order is not fixed; each stream emits start, records,
      // checkpoints, range_complete, final state, and complete (counts vary with ranges).
      const custRecords = messages.filter(
        (m): m is RecordMessage => m.type === 'record' && m.record.stream === 'customers'
      )
      const invRecords = messages.filter(
        (m): m is RecordMessage => m.type === 'record' && m.record.stream === 'invoices'
      )
      expect(custRecords).toHaveLength(1)
      expect(invRecords).toHaveLength(1)

      const starts = messages.filter(
        (m) => m.type === 'stream_status' && m.stream_status.status === 'start'
      )
      expect(starts).toHaveLength(2)

      const completes = messages.filter(
        (m) => m.type === 'stream_status' && m.stream_status.status === 'complete'
      )
      expect(completes).toHaveLength(2)

      for (const name of ['customers', 'invoices'] as const) {
        const finalState = messages
          .filter((m): m is SourceStateMessage => m.type === 'source_state')
          .filter((m) => m.source_state.stream === name)
          .at(-1)
        expect(finalState?.source_state.data).toMatchObject({ remaining: [] })
      }
    })

    it('resumes from prior state cursor without re-emitting checkpointed records', async () => {
      const listFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_3', name: 'Charlie' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const priorState = {
        streams: { customers: remainingInProgress('cus_2') },
        global: {},
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: priorState,
        })
      )

      // Should call listFn with starting_after from the saved cursor
      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_2' })

      // Only cus_3 is emitted (cus_1 and cus_2 were already checkpointed)
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).toMatchObject({ id: 'cus_3' })
    })

    it('handles empty stream (listFn returns no data)', async () => {
      const listFn = vi.fn().mockResolvedValueOnce({
        data: [],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.stream === 'customers' &&
            m.stream_status.status === 'start'
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'source_state' &&
            (m as SourceStateMessage).source_state.stream === 'customers' &&
            ((m as SourceStateMessage).source_state.data as StreamState).remaining.length === 0
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.stream === 'customers' &&
            m.stream_status.status === 'range_complete'
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.stream === 'customers' &&
            m.stream_status.status === 'complete'
        )
      ).toBe(true)
    })

    // Covered by WebSocket streaming tests below — backfill + ws interleaved
    // test verifies this transition end-to-end.
  })

  describe('fromStripeEvent() — live mode scenarios', () => {
    it('webhook mode emits one RecordMessage + one SourceStateMessage per event', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        id: 'evt_1abc',
        type: 'customer.updated',
        created: 1700000000,
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const result = fromStripeEvent(event, registry, '_updated_at')

      expect(result).not.toBeNull()
      expect(result!.record.type).toBe('record')
      expect(result!.record.record.stream).toBe('customers')
      expect(result!.record.record.data).toMatchObject({
        id: 'cus_1',
        object: 'customer',
        name: 'Alice',
      })
      expect(result!.record.record.emitted_at).toBeTypeOf('string')

      expect(result!.state.type).toBe('source_state')
      expect(result!.state.source_state.stream).toBe('customers')
      expect(result!.state.source_state.data).toEqual({
        eventId: 'evt_1abc',
        eventCreated: 1700000000,
      })
    })

    it('returns null for unsupported object type', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        dataObject: { id: 'unknown_1', object: 'unknown_type' },
      })

      const result = fromStripeEvent(event, registry, '_updated_at')
      expect(result).toBeNull()
    })

    it('returns null for objects without id (preview/draft)', () => {
      const registry: Record<string, ResourceConfig> = {
        invoices: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      const event = makeEvent({
        type: 'invoice.upcoming',
        dataObject: { object: 'invoice', amount_due: 5000 },
      })

      const result = fromStripeEvent(event, registry, '_updated_at')
      expect(result).toBeNull()
    })

    it('passes through deleted flag from event data', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        type: 'customer.deleted',
        dataObject: { id: 'cus_1', object: 'customer', deleted: true },
      })

      const result = fromStripeEvent(event, registry, '_updated_at')

      expect(result).not.toBeNull()
      expect(result!.record.record.data).toMatchObject({
        id: 'cus_1',
        object: 'customer',
        deleted: true,
      })
    })

    it('returns null when event data.object has no object field', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        dataObject: { id: 'cus_1' },
      })

      const result = fromStripeEvent(event, registry, '_updated_at')
      expect(result).toBeNull()
    })

    it('WebSocket mode uses same fromStripeEvent conversion as webhook mode', () => {
      // WebSocket is a transport concern — the conversion is identical.
      // The same StripeEvent structure is received regardless of transport.
      // This test verifies fromStripeEvent works for any StripeEvent input.
      const registry: Record<string, ResourceConfig> = {
        invoices: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      const event = makeEvent({
        id: 'evt_ws_1',
        type: 'invoice.paid',
        created: 1700000001,
        dataObject: { id: 'inv_1', object: 'invoice', amount_paid: 1000 },
      })

      const result = fromStripeEvent(event, registry, '_updated_at')

      expect(result).not.toBeNull()
      expect(result!.record.record.stream).toBe('invoices')
      expect(result!.record.record.data).toMatchObject({ id: 'inv_1', amount_paid: 1000 })
      expect(result!.state.source_state.data).toEqual({
        eventId: 'evt_ws_1',
        eventCreated: 1700000001,
      })
    })
  })

  describe('read() — error scenarios', () => {
    it('emits stream_status error on rate limit', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(new Error('Rate limit exceeded'))

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
      expect(messages[1]).toMatchObject({
        type: 'stream_status',
        stream_status: {
          stream: 'customers',
          status: 'error',
          error: expect.stringContaining('Rate limit'),
        },
      })
    })

    it('emits stream_status error for unknown stream', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue({} as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'nonexistent', primary_key: [['id']] }),
        })
      )

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream_status: {
          stream: 'nonexistent',
          status: 'error',
          error: 'Unknown stream: nonexistent',
        },
      })
    })

    it('emits stream_status error on non-rate-limit error', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(new Error('Connection refused'))

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
      expect(messages[1]).toMatchObject({
        type: 'stream_status',
        stream_status: {
          stream: 'customers',
          status: 'error',
          error: expect.stringContaining('Connection refused'),
        },
      })
    })

    it('proceeds with backfill using fallback timestamp when getAccount fails (fault-tolerant)', async () => {
      // getAccountCreatedTimestamp swallows errors and falls back to STRIPE_LAUNCH_TIMESTAMP
      // so backfill should proceed even when getAccount is unavailable
      const listFn = vi.fn().mockResolvedValue({ data: [], has_more: false })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {
        getAccount: vi.fn().mockRejectedValue(
          new StripeRequestError(
            401,
            {
              error: {
                type: 'invalid_request_error',
                message: 'Invalid API Key provided: sk_test_bad',
              },
            },
            'GET',
            '/v1/account'
          )
        ),
      } as unknown as StripeClient

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'customers' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter: async () => 0,
          ...LIST_BACKFILL_OPTS,
        })
      )

      // Backfill proceeds with fallback timestamp: listFn is called
      expect(listFn).toHaveBeenCalled()
      expect(
        messages.some(
          (m) =>
            m.type === 'source_state' &&
            (m as { source_state: { data: StreamState } }).source_state.data.remaining?.length === 0
        )
      ).toBe(true)
    })

    it('emits stream error (not global) for 401 encountered mid-stream', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(
        new StripeRequestError(
          401,
          {
            error: {
              type: 'invalid_request_error',
              message: 'Invalid API Key provided: sk_test_bad',
            },
          },
          'GET',
          '/v1/tax_ids'
        )
      )

      const registry: Record<string, ResourceConfig> = {
        tax_ids: makeConfig({
          order: 1,
          tableName: 'tax_ids',
          supportsCreatedFilter: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'tax_ids', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream_status: { stream: 'tax_ids', status: 'start' },
      })
      expect(messages[1]).toMatchObject({
        type: 'stream_status',
        stream_status: {
          stream: 'tax_ids',
          status: 'error',
          error: expect.stringContaining('Invalid API Key'),
        },
      })
    })

    it('does not treat near-miss auth errors as skippable', async () => {
      const listFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Authentication failed: must provide a valid API key'))

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(2)
      expect(messages[1]).toMatchObject({
        type: 'stream_status',
        stream_status: {
          stream: 'customers',
          status: 'error',
          error: expect.stringContaining('Authentication failed'),
        },
      })
    })

    it.each([
      [
        'test_helpers test_clocks',
        'This endpoint is only available in testmode. Try using your test keys instead.',
        '/v1/test_helpers/test_clocks',
        'only available in testmode',
      ],
      [
        'testmode-only resource',
        'This object is only available in testmode',
        '/v1/invoices',
        'testmode',
      ],
      [
        'v2 core accounts in test mode',
        "Accounts v2 isn't available in test mode. Switch to a sandbox to test.",
        '/v2/core/accounts',
        "isn't available in test mode",
      ],
      [
        'sigma scheduled_query_runs testmode',
        'This API surface is not enabled for testmode usage.',
        '/v1/sigma/scheduled_query_runs',
        'API surface is not enabled',
      ],
      [
        'billing_alerts',
        'Your custom plan does not include alerts in livemode.',
        '/v1/billing/alerts',
        'does not include alerts in livemode',
      ],
      [
        'billing_credit_grants',
        'Your custom plan does not include billing credit grants in livemode.',
        '/v1/billing/credit_grants',
        'does not include billing credit grants in livemode',
      ],
    ])(
      'emits stream_status skip for known skippable Stripe list errors (%s)',
      async (_label, apiMessage, path, reasonSubstring) => {
        const { StripeApiRequestError } = await import('@stripe/sync-openapi')
        const listFn = vi.fn().mockRejectedValueOnce(
          new StripeApiRequestError(
            400,
            {
              error: {
                type: 'invalid_request_error',
                message: apiMessage,
              },
            },
            'GET',
            path
          )
        )

        const registry: Record<string, ResourceConfig> = {
          invoices: makeConfig({
            order: 1,
            tableName: 'invoices',
            listFn: listFn as ResourceConfig['listFn'],
          }),
        }

        vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
        const messages = await collect(
          source.read({ config, catalog: catalog({ name: 'invoices', primary_key: [['id']] }) })
        )

        expect(messages).toHaveLength(2)
        expect(messages[0]).toMatchObject({
          type: 'stream_status',
          stream_status: { stream: 'invoices', status: 'start' },
        })
        expect(messages[1]).toMatchObject({
          type: 'stream_status',
          stream_status: {
            stream: 'invoices',
            status: 'skip',
            reason: expect.stringContaining(reasonSubstring),
          },
        })
      }
    )

    it('continues to next stream after error on previous stream', async () => {
      const failingListFn = vi.fn().mockRejectedValueOnce(new Error('Connection refused'))
      const successListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'inv_1', total: 100 }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: failingListFn as ResourceConfig['listFn'],
        }),
        invoices: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: successListFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
        })
      )

      expect(hasStreamStatus(messages, 'error', 'customers')).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'record' &&
            (m as RecordMessage).record.stream === 'invoices' &&
            (m as RecordMessage).record.data.id === 'inv_1'
        )
      ).toBe(true)

      expect(hasStreamStatus(messages, 'complete', 'customers')).toBe(false)
      expect(hasStreamStatus(messages, 'complete', 'invoices')).toBe(true)
    })

    it('swallows AbortError without emitting stream_status error', async () => {
      // A listFn that blocks until the signal aborts, then throws AbortError
      // (simulates withRateLimit racing listFn against the signal)
      const listFn = vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            // Block for 10s — will be aborted much sooner
            setTimeout(() => reject(new Error('should not reach')), 10_000)
          })
      )

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const iter = source.read({
        config,
        catalog: catalog({ name: 'customers', primary_key: [['id']] }),
      })

      const messages: Message[] = []
      for await (const msg of iter) {
        messages.push(msg)
        // After stream starts, abort by breaking the consumer loop.
        // withAbortOnReturn fires the signal, withRateLimit's Promise.race
        // rejects with AbortError, and the catch block swallows it.
        if (
          msg.type === 'stream_status' &&
          (msg as StreamStatusMessage).stream_status.status === 'start'
        ) {
          break
        }
      }

      // Should only have stream_status:start, no error or complete
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
      // Notably absent: stream_status:error — the AbortError was swallowed
      expect(hasStreamStatus(messages, 'error')).toBe(false)
    })
  })

  describe('read() — error state persistence and skip/retry', () => {
    const skipListFn = vi.fn()
    const skipRegistry: Record<string, ResourceConfig> = {
      customers: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: skipListFn as ResourceConfig['listFn'],
      }),
    }

    beforeEach(() => {
      skipListFn.mockReset()
      vi.mocked(buildResourceRegistry).mockReturnValue(skipRegistry as any)
    })

    it('skips streams with auth_error state (permanent)', async () => {
      skipListFn.mockResolvedValueOnce({ data: [{ id: 'cus_1' }], has_more: false })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'auth_error' },
            },
            global: {},
          },
        })
      )

      // Legacy error-shaped state is discarded — backfill starts fresh.
      // (warning now logged via pino, not as a protocol message)
      expect(skipListFn).toHaveBeenCalled()
      expect(
        messages.some((m) => m.type === 'stream_status' && m.stream_status.status === 'start')
      ).toBe(true)
    })

    it('skips streams with system_error state (permanent)', async () => {
      skipListFn.mockResolvedValueOnce({ data: [{ id: 'cus_1' }], has_more: false })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'system_error' },
            },
            global: {},
          },
        })
      )

      expect(skipListFn).toHaveBeenCalled()
      expect(
        messages.some((m) => m.type === 'stream_status' && m.stream_status.status === 'start')
      ).toBe(true)
    })

    it('skips streams with config_error state (permanent)', async () => {
      skipListFn.mockResolvedValueOnce({ data: [{ id: 'cus_1' }], has_more: false })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'config_error' },
            },
            global: {},
          },
        })
      )

      expect(skipListFn).toHaveBeenCalled()
      expect(
        messages.some((m) => m.type === 'stream_status' && m.stream_status.status === 'start')
      ).toBe(true)
    })

    it('retries streams with transient_error state (same as pending)', async () => {
      skipListFn.mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'transient_error' },
            },
            global: {},
          },
        })
      )

      expect(skipListFn).toHaveBeenCalled()
      expect(messages.some((m) => m.type === 'record')).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.stream === 'customers' &&
            m.stream_status.status === 'complete'
        )
      ).toBe(true)
    })

    it('preserves backfill progress in error state for later resume', async () => {
      const failAfterOne = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'cus_1', created: 1400000000 }],
          has_more: true,
        })
        .mockRejectedValueOnce(new Error('Connection refused'))

      const failRegistry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: false,
          listFn: failAfterOne as ResourceConfig['listFn'],
        }),
      }
      vi.mocked(buildResourceRegistry).mockReturnValue(failRegistry as any)

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
        })
      )

      const errorIdx = messages.findIndex(
        (m) => m.type === 'stream_status' && m.stream_status.status === 'error'
      )
      expect(errorIdx).toBeGreaterThan(-1)

      const checkpointBeforeError = messages
        .slice(0, errorIdx)
        .filter((m): m is SourceStateMessage => m.type === 'source_state')
        .filter((m) => m.source_state.stream === 'customers')
        .at(-1)
      expect(checkpointBeforeError).toBeDefined()
      const rem = (checkpointBeforeError!.source_state.data as StreamState).remaining
      expect(rem.length).toBeGreaterThan(0)
      expect(rem.some((r) => r.cursor === 'cus_1')).toBe(true)
    })
  })

  describe('read() — invocation modes', () => {
    // Shared registry for these tests
    const listFn = vi.fn()
    const registry: Record<string, ResourceConfig> = {
      customers: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: listFn as ResourceConfig['listFn'],
      }),
    }

    beforeEach(() => {
      listFn.mockReset()
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
    })

    it('backfill only: no input, no state → paginates from beginning', async () => {
      listFn.mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          // no input, no state
        })
      )

      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.stream === 'customers' &&
            m.stream_status.status === 'start'
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'record' &&
            (m as RecordMessage).record.stream === 'customers' &&
            (m as RecordMessage).record.data.id === 'cus_1'
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'source_state' &&
            (m as SourceStateMessage).source_state.stream === 'customers' &&
            ((m as SourceStateMessage).source_state.data as StreamState).remaining.length === 0
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.stream === 'customers' &&
            m.stream_status.status === 'range_complete'
        )
      ).toBe(true)
      expect(
        messages.some(
          (m) =>
            m.type === 'stream_status' &&
            m.stream_status.stream === 'customers' &&
            m.stream_status.status === 'complete'
        )
      ).toBe(true)

      // No starting_after on first call
      expect(listFn).toHaveBeenCalledWith({ limit: 100 })
    })

    it('stream via webhook (input): single event → record + state, no pagination', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_wh_1',
        type: 'customer.updated',
        created: 1700000000,
        dataObject: { id: 'cus_1', object: 'customer', name: 'Updated Alice' },
      })

      const messages = await collect(
        source.read(
          { config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) },
          toIter(event)
        )
      )

      // Live mode: exactly 1 record + 1 state
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_1', name: 'Updated Alice' } },
      })
      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: {
          stream: 'customers',
          data: { eventId: 'evt_wh_1', eventCreated: 1700000000 },
        },
      })

      // listFn should NOT be called — no pagination in live mode
      expect(listFn).not.toHaveBeenCalled()
    })

    it('stream via websocket (input): same code path as webhook', async () => {
      // WebSocket is a transport concern — the StripeEvent is identical.
      // read() with input= behaves the same regardless of transport.
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_ws_1',
        type: 'customer.created',
        created: 1700000001,
        dataObject: { id: 'cus_2', object: 'customer', name: 'Bob via WS' },
      })

      const messages = await collect(
        source.read(
          { config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) },
          toIter(event)
        )
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_2', name: 'Bob via WS' } },
      })
      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: { data: { eventId: 'evt_ws_1' } },
      })

      expect(listFn).not.toHaveBeenCalled()
    })

    it('stream via input: filters out events for streams not in catalog', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_other',
        type: 'invoice.paid',
        dataObject: { id: 'inv_1', object: 'invoice', amount: 100 },
      })

      // Catalog only has customers, but event is for invoices
      const messages = await collect(
        source.read(
          { config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) },
          toIter(event)
        )
      )

      // Event is for a stream not in catalog → no output
      expect(messages).toHaveLength(0)
    })

    it('backfill + prior webhook state: resumes pagination from cursor', async () => {
      // Simulates: webhook events were processed (state has eventId),
      // then backfill is invoked with that state to fill historical data.
      // The backfill reads page_cursor from state, ignoring webhook-specific fields.
      listFn.mockResolvedValueOnce({
        data: [{ id: 'cus_3', name: 'Charlie' }],
        has_more: false,
      })

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: { customers: remainingInProgress('cus_2') },
            global: {},
          },
          // no input → backfill mode, but with state from prior run
        })
      )

      // Resumes from cus_2
      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_2' })

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).toMatchObject({ id: 'cus_3' })
    })

    it('backfill + prior websocket state: resumes pagination from cursor', async () => {
      // Same as above — transport doesn't matter, state shape determines resume behavior
      listFn.mockResolvedValueOnce({
        data: [
          { id: 'cus_4', name: 'Dana' },
          { id: 'cus_5', name: 'Eve' },
        ],
        has_more: false,
      })

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: { customers: remainingInProgress('cus_3') },
            global: {},
          },
        })
      )

      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_3' })

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(2)
      expect(records.map((r) => r.record.data.id)).toEqual(['cus_4', 'cus_5'])

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      expect(states.at(-1)?.source_state.data).toMatchObject({ remaining: [] })
    })
  })

  describe('read(input) — enriched webhook processing', () => {
    it('delete event yields record with deleted: true', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_del_1',
        type: 'customer.deleted',
        created: 1700000000,
        dataObject: { id: 'cus_1', object: 'customer', deleted: true },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers' }) }, toIter(event))
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        record: {
          stream: 'customers',
          recordDeleted: true,
          data: { id: 'cus_1', object: 'customer' },
        },
      })

      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: {
          stream: 'customers',
          data: { eventId: 'evt_del_1', eventCreated: 1700000000 },
        },
      })
    })

    it('delete event detected by event type (not just deleted flag)', async () => {
      const registry: Record<string, ResourceConfig> = {
        products: makeConfig({ order: 1, tableName: 'products' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      // product.deleted event: the object may not have deleted: true in its body.
      const event = makeEvent({
        id: 'evt_del_2',
        type: 'product.deleted',
        created: 1700000000,
        dataObject: { id: 'prod_1', object: 'product', name: 'Old Product' },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'products' }) }, toIter(event))
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        record: {
          stream: 'products',
          recordDeleted: true,
          data: { id: 'prod_1', object: 'product' },
        },
      })
    })

    it('subscription event yields subscription_items from nested items.data', async () => {
      const registry: Record<string, ResourceConfig> = {
        subscriptions: makeConfig({ order: 1, tableName: 'subscriptions' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_sub_1',
        type: 'customer.subscription.updated',
        created: 1700000000,
        dataObject: {
          id: 'sub_1',
          object: 'subscription',
          status: 'active',
          items: {
            data: [
              { id: 'si_1', object: 'subscription_item', price: 'price_1' },
              { id: 'si_2', object: 'subscription_item', price: 'price_2' },
            ],
          },
        },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'subscriptions' }) }, toIter(event))
      )

      // 1 subscription record + 2 subscription_item records + 1 state
      expect(messages).toHaveLength(4)
      expect(messages[0]).toMatchObject({
        type: 'record',
        record: { stream: 'subscriptions', data: { id: 'sub_1' } },
      })
      expect(messages[1]).toMatchObject({
        type: 'record',
        record: { stream: 'subscription_items', data: { id: 'si_1', price: 'price_1' } },
      })
      expect(messages[2]).toMatchObject({
        type: 'record',
        record: { stream: 'subscription_items', data: { id: 'si_2', price: 'price_2' } },
      })
      expect(messages[3]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'subscriptions', data: { eventId: 'evt_sub_1' } },
      })
    })

    it('entitlement summary event yields individual entitlement records', async () => {
      const registry: Record<string, ResourceConfig> = {
        active_entitlements: makeConfig({ order: 1, tableName: 'active_entitlements' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_ent_1',
        type: 'entitlements.active_entitlement_summary.updated',
        created: 1700000000,
        dataObject: {
          id: 'entsummary_1',
          object: 'entitlements.active_entitlement_summary',
          customer: 'cus_1',
          entitlements: {
            data: [
              {
                id: 'ent_1',
                object: 'entitlements.active_entitlement',
                feature: 'feat_premium',
                livemode: false,
                lookup_key: 'premium',
              },
              {
                id: 'ent_2',
                object: 'entitlements.active_entitlement',
                feature: { id: 'feat_basic' },
                livemode: false,
                lookup_key: 'basic',
              },
            ],
          },
        },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'active_entitlements' }) }, toIter(event))
      )

      // 2 entitlement records + 1 state
      expect(messages).toHaveLength(3)
      expect(messages[0]).toMatchObject({
        type: 'record',
        record: {
          stream: 'active_entitlements',
          data: {
            id: 'ent_1',
            feature: 'feat_premium',
            customer: 'cus_1',
            lookup_key: 'premium',
          },
        },
      })
      expect(messages[1]).toMatchObject({
        type: 'record',
        record: {
          stream: 'active_entitlements',
          data: {
            id: 'ent_2',
            feature: 'feat_basic',
            customer: 'cus_1',
            lookup_key: 'basic',
          },
        },
      })
      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'active_entitlements', data: { eventId: 'evt_ent_1' } },
      })
    })

    it('revalidation re-fetches from Stripe API when object is not in final state', async () => {
      const retrieveFn = vi.fn().mockResolvedValueOnce({
        id: 'sub_1',
        object: 'subscription',
        status: 'active',
        extra: 'revalidated',
      })

      const registry: Record<string, ResourceConfig> = {
        subscriptions: makeConfig({
          order: 1,
          tableName: 'subscriptions',
          retrieveFn: retrieveFn as ResourceConfig['retrieveFn'],
          isFinalState: (s: { status: string }) => s.status === 'canceled',
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_reval_1',
        type: 'customer.subscription.updated',
        created: 1700000000,
        dataObject: { id: 'sub_1', object: 'subscription', status: 'active' },
      })

      const messages = await collect(
        source.read(
          {
            config: { ...config, revalidate_objects: ['subscription'] },
            catalog: catalog({ name: 'subscriptions' }),
          },
          toIter(event)
        )
      )

      expect(retrieveFn).toHaveBeenCalledWith('sub_1')
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records[0].record.data).toMatchObject({ id: 'sub_1', extra: 'revalidated' })
    })

    it('revalidation skips re-fetch when object is in final state', async () => {
      const retrieveFn = vi.fn()

      const registry: Record<string, ResourceConfig> = {
        subscriptions: makeConfig({
          order: 1,
          tableName: 'subscriptions',
          retrieveFn: retrieveFn as ResourceConfig['retrieveFn'],
          isFinalState: (s: { status: string }) => s.status === 'canceled',
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_reval_2',
        type: 'customer.subscription.deleted',
        created: 1700000000,
        dataObject: { id: 'sub_1', object: 'subscription', status: 'canceled' },
      })

      const messages = await collect(
        source.read(
          {
            config: { ...config, revalidate_objects: ['subscription'] },
            catalog: catalog({ name: 'subscriptions' }),
          },
          toIter(event)
        )
      )

      // Should NOT re-fetch because isFinalState returns true
      expect(retrieveFn).not.toHaveBeenCalled()
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records[0].record.data).toMatchObject({ id: 'sub_1', status: 'canceled' })
    })

    it('preview objects (no id) produce no output', async () => {
      const registry: Record<string, ResourceConfig> = {
        invoices: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_preview_1',
        type: 'invoice.upcoming',
        dataObject: { object: 'invoice', amount_due: 5000 },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'invoices' }) }, toIter(event))
      )

      expect(messages).toHaveLength(0)
    })

    it('normalizes aliased object types (checkout.session → checkout_sessions)', async () => {
      const registry: Record<string, ResourceConfig> = {
        checkout_sessions: makeConfig({ order: 1, tableName: 'checkout_sessions' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const event = makeEvent({
        id: 'evt_cs_1',
        type: 'checkout.session.completed',
        created: 1700000000,
        dataObject: { id: 'cs_1', object: 'checkout.session', amount_total: 1000 },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'checkout_sessions' }) }, toIter(event))
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        record: { stream: 'checkout_sessions', data: { id: 'cs_1' } },
      })
    })

    it('throws when raw webhook input is provided without webhook_secret', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const rawInput = { body: '{"id":"evt_1"}', signature: 'sig_test' }

      await expect(
        collect(
          source.read(
            { config, catalog: catalog({ name: 'customers' }) }, // no webhook_secret
            toIter(rawInput)
          )
        )
      ).rejects.toThrow('webhook_secret is required for raw webhook signature verification')
    })
  })

  describe('read() — WebSocket streaming', () => {
    const registry: Record<string, ResourceConfig> = {
      customers: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
      }),
      invoices: makeConfig({
        order: 2,
        tableName: 'invoices',
        listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
      }),
    }

    /** Push a synthetic event through the captured onEvent callback. */
    function pushWsEvent(event: StripeEvent) {
      capturedOnEvent!({
        type: 'webhook_event',
        webhook_id: 'wh_' + event.id,
        webhook_conversation_id: 'whc_1',
        event_payload: JSON.stringify(event),
        http_headers: {},
        endpoint: { url: 'stripe-sync-engine', status: 'enabled' },
      })
    }

    beforeEach(() => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
    })

    afterEach(() => {
      capturedOnEvent = null
      mockClose.mockClear()
    })

    it('read() creates WebSocket client when websocket: true', async () => {
      const { createStripeWebSocketClient } = await import('./src-websocket.js')

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: BUNDLED_API_VERSION,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // First iter.next() triggers createStripeWebSocketClient inside read()
      await iter.next() // stream_status started

      expect(createStripeWebSocketClient).toHaveBeenCalledWith(
        expect.objectContaining({ stripeApiKey: 'sk_test_fake' })
      )
      expect(capturedOnEvent).toBeTypeOf('function')

      // Clean up — triggers finally block which calls wsClient.close()
      await iter.return()
    })

    it("read()'s finally block closes WebSocket client", async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: BUNDLED_API_VERSION,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      await iter.next() // stream_status started — triggers createStripeWebSocketClient

      // Returning the iterator triggers the finally block, which calls wsClient.close()
      await iter.return()
      expect(mockClose).toHaveBeenCalled()
    })

    it('streams WebSocket events after empty backfill', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: BUNDLED_API_VERSION,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      const m1 = await iter.next()
      expect(m1.value).toMatchObject({ type: 'stream_status', stream_status: { status: 'start' } })
      await drainUntilStreamBackfillComplete(iter, 'customers')

      // Now push a WebSocket event — capturedOnEvent is set, read() should yield it
      pushWsEvent(
        makeEvent({
          id: 'evt_ws_1',
          type: 'customer.updated',
          created: 1700000001,
          dataObject: { id: 'cus_1', object: 'customer', name: 'Alice via WS' },
        })
      )

      const m4 = await iter.next() // record
      const m5 = await iter.next() // state
      expect(m4.value).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_1', name: 'Alice via WS' } },
      })
      expect(m5.value).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers', data: { eventId: 'evt_ws_1' } },
      })

      // Clean up — triggers finally block which calls wsClient.close()
      await iter.return()
    })

    it('interleaves queued WebSocket events during backfill', async () => {
      const listFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'cus_1', name: 'Alice' }],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'cus_2', name: 'Bob' }],
          has_more: false,
        })

      const wsRegistry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(wsRegistry as any)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: BUNDLED_API_VERSION,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // stream_status started — also triggers createStripeWebSocketClient, setting capturedOnEvent
      const m1 = await iter.next()
      expect(m1.value).toMatchObject({ type: 'stream_status', stream_status: { status: 'start' } })

      // Queue an event AFTER stream_status started — capturedOnEvent is now set.
      // The generator is paused before the drain, so this event will be drained before page 1.
      pushWsEvent(
        makeEvent({
          id: 'evt_ws_queued',
          type: 'customer.created',
          created: 1700000000,
          dataObject: { id: 'cus_ws_1', object: 'customer', name: 'WS Queued' },
        })
      )

      // Before page 1: queued WS event is drained
      const m2 = await iter.next() // ws record
      const m3 = await iter.next() // ws state
      expect(m2.value).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_ws_1', name: 'WS Queued' } },
      })
      expect(m3.value).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers', data: { eventId: 'evt_ws_queued' } },
      })

      // Page 1: backfill record + state
      const m4 = await iter.next() // record cus_1
      const m5 = await iter.next() // state pending
      expect(m4.value).toMatchObject({ type: 'record', record: { data: { id: 'cus_1' } } })
      expect(m5.value).toMatchObject({
        type: 'source_state',
        source_state: {
          stream: 'customers',
          data: expect.objectContaining({
            remaining: expect.arrayContaining([expect.objectContaining({ cursor: 'cus_1' })]),
          }),
        },
      })

      const tail: Message[] = []
      for (;;) {
        const n = await iter.next()
        if (n.done) break
        tail.push(n.value!)
        if (
          n.value?.type === 'stream_status' &&
          n.value.stream_status.status === 'complete' &&
          n.value.stream_status.stream === 'customers'
        ) {
          break
        }
      }
      expect(
        tail.some((m) => m.type === 'record' && (m as RecordMessage).record.data.id === 'cus_2')
      ).toBe(true)
      expect(
        tail.some((m) => m.type === 'stream_status' && m.stream_status.status === 'range_complete')
      ).toBe(true)
      expect(
        tail.some(
          (m) =>
            m.type === 'source_state' &&
            (m as SourceStateMessage).source_state.stream === 'customers' &&
            ((m as SourceStateMessage).source_state.data as StreamState).remaining.length === 0
        )
      ).toBe(true)

      // After backfill: push another WS event, verify it's yielded
      pushWsEvent(
        makeEvent({
          id: 'evt_ws_live',
          type: 'customer.updated',
          created: 1700000002,
          dataObject: { id: 'cus_live', object: 'customer', name: 'Live Event' },
        })
      )

      const m9 = await iter.next() // record
      const m10 = await iter.next() // state
      expect(m9.value).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_live', name: 'Live Event' } },
      })
      expect(m10.value).toMatchObject({
        type: 'source_state',
        source_state: { data: { eventId: 'evt_ws_live' } },
      })

      await iter.return()
    })

    it('filters out WebSocket events for streams not in catalog', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: BUNDLED_API_VERSION,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      await iter.next() // start
      await drainUntilStreamBackfillComplete(iter, 'customers')

      // Push event for invoices (not in catalog) — should be skipped
      pushWsEvent(
        makeEvent({
          id: 'evt_inv',
          type: 'invoice.paid',
          dataObject: { id: 'inv_1', object: 'invoice', amount: 100 },
        })
      )

      // Push event for customers (in catalog) — should be yielded
      pushWsEvent(
        makeEvent({
          id: 'evt_cus',
          type: 'customer.updated',
          created: 1700000003,
          dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
        })
      )

      const m1 = await iter.next()
      expect(m1.value).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_1' } },
      })

      await iter.return()
    })

    it('read() with websocket: true creates WebSocket client (combined config)', async () => {
      const { createStripeWebSocketClient } = await import('./src-websocket.js')
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      vi.mocked(createStripeWebSocketClient).mockClear()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: BUNDLED_API_VERSION,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      await iter.next() // stream_status started — triggers createStripeWebSocketClient

      expect(createStripeWebSocketClient).toHaveBeenCalledTimes(1)
      await iter.return()
    })

    it('return() stops an idle websocket stream without waiting for another event', async () => {
      const listFn = vi.fn().mockResolvedValue({ data: [], has_more: false })
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers', listFn }),
      }
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: BUNDLED_API_VERSION,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
          state: { streams: {}, global: {} },
        })
        [Symbol.asyncIterator]()

      await iter.next()
      await drainUntilStreamBackfillComplete(iter, 'customers')

      const blockedNext = iter.next()
      void blockedNext.catch(() => undefined)

      const returnPromise = iter.return()

      try {
        await expect(
          Promise.race([
            returnPromise,
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('timed out waiting for websocket teardown')), 50)
            }),
          ])
        ).resolves.toEqual({ value: undefined, done: true })
      } finally {
        capturedOnEvent?.({
          event_payload: JSON.stringify(
            makeEvent({
              id: 'evt_teardown_cleanup',
              type: 'customer.updated',
              dataObject: { id: 'cus_cleanup', object: 'customer' },
            })
          ),
        })
        await Promise.race([
          returnPromise.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 50)),
        ])
      }

      expect(mockClose).toHaveBeenCalled()
    })

    it('teardown() is safe when no websocket was configured', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      // No setup() call — teardown should not throw
      await drain(
        source.teardown!({
          config: { api_key: 'sk_test_fake', api_version: BUNDLED_API_VERSION },
        })
      )
      expect(mockClose).not.toHaveBeenCalled()
    })
  })

  describe('read() — HTTP server mode', () => {
    it('starts an HTTP server on webhook_port and processes POSTed webhooks', async () => {
      const listFn = vi.fn().mockResolvedValue({ data: [], has_more: false })
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers', listFn }),
      }
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const cat = catalog({ name: 'customers' })

      // Use port 0 so the OS picks a free port
      const cfg = {
        api_key: 'sk_test_fake',
        api_version: BUNDLED_API_VERSION,
        webhook_secret: 'whsec_test',
        webhook_port: 0,
      }

      const messages: Message[] = []
      const iter = source.read({ config: cfg, catalog: cat, state: { streams: {}, global: {} } })

      for (;;) {
        const { value, done } = await iter.next()
        if (done) break
        messages.push(value)
        if (value?.type === 'stream_status' && value.stream_status.status === 'complete') {
          break
        }
      }

      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream_status: { status: 'start' },
      })
      expect(
        messages.some(
          (m) => m.type === 'stream_status' && m.stream_status.status === 'range_complete'
        )
      ).toBe(true)
      expect(messages.some((m) => m.type === 'source_state')).toBe(true)

      // Clean up: return the iterator which triggers the finally block
      await iter.return(undefined as unknown as Message)
    })
  })

  describe('read() — events polling', () => {
    it('skips backfill when all streams are already complete', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { streams: { customers: { remaining: [] } }, global: {} },
        })
      )

      // listFn should NOT be called — stream is already complete
      expect(listFn).not.toHaveBeenCalled()

      const started = messages.filter(
        (m): m is StreamStatusMessage =>
          m.type === 'stream_status' && m.stream_status.status === 'start'
      )
      expect(started).toHaveLength(0)

      expect(
        messages.some(
          (m) =>
            m.type === 'source_state' &&
            (m as SourceStateMessage).source_state.state_type === 'global' &&
            (m as SourceStateMessage).source_state.data &&
            typeof (m as { source_state: { data: { events_cursor?: number } } }).source_state.data
              .events_cursor === 'number'
        )
      ).toBe(true)
    })

    it('stamps initial events_cursor after first backfill completes', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const now = Math.floor(Date.now() / 1000)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { streams: { customers: { remaining: [] } }, global: {} },
        })
      )

      const globalStates = messages.filter(
        (m): m is SourceStateMessage =>
          m.type === 'source_state' && m.source_state.state_type === 'global'
      )
      expect(globalStates).toHaveLength(1)
      expect(
        (globalStates[0].source_state.data as { events_cursor: number }).events_cursor
      ).toBeGreaterThanOrEqual(now)
    })

    it('does not run events polling when poll_events is false/absent', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config, // no poll_events
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { streams: { customers: { remaining: [] } }, global: {} },
        })
      )

      // No events_cursor should appear in output
      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      const withCursor = states.filter(
        (s) => (s.source_state.data as { events_cursor?: number }).events_cursor != null
      )
      expect(withCursor).toHaveLength(0)
    })

    it('does not poll when some streams are still pending', async () => {
      const custListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: custListFn as ResourceConfig['listFn'],
        }),
        invoices: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: (() =>
            Promise.resolve({
              data: [{ id: 'inv_1' }],
              has_more: false,
            })) as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
          // customers is complete, but invoices has no checkpoint yet
          state: { streams: { customers: { remaining: [] } }, global: {} },
        })
      )

      // Invoices should be backfilled (listFn called)
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records.some((r) => r.record.stream === 'invoices')).toBe(true)

      // customers listFn should NOT be called (already complete)
      expect(custListFn).not.toHaveBeenCalled()

      // No events_cursor should appear — not all streams were complete at start
      // (invoices was pending, so pollEvents returns early)
      // But after backfill, invoices is now complete. However, pollEvents checks
      // the input state, not the post-backfill state, so it won't stamp cursors.
      const statesWithCursor = messages
        .filter((m): m is SourceStateMessage => m.type === 'source_state')
        .filter((s) => (s.source_state.data as { events_cursor?: number }).events_cursor != null)
      expect(statesWithCursor).toHaveLength(0)
    })
  })

  describe('read() — parallel backfill (segment checkpoint/resume)', () => {
    it('resumes only incomplete segments from prior segment state', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'cus_resumed', name: 'Resumed' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const rangeGteSec = 1_100_000_000
      const rangeLtSec = 1_200_000_000
      const priorRemaining: StreamState['remaining'] = [
        {
          gte: new Date(rangeGteSec * 1000).toISOString(),
          lt: new Date(rangeLtSec * 1000).toISOString(),
          cursor: 'cus_halfway',
        },
      ]

      const mockClient = {} as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'customers' }),
          state: {
            customers: { remaining: priorRemaining },
          },
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
          ...LIST_BACKFILL_OPTS,
        })
      )

      expect(listFn).toHaveBeenCalledTimes(1)
      expect(listFn).toHaveBeenCalledWith(
        expect.objectContaining({
          created: { gte: rangeGteSec, lt: rangeLtSec },
          starting_after: 'cus_halfway',
          limit: 100,
        })
      )

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).toMatchObject({ id: 'cus_resumed' })

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      const lastState = states[states.length - 1]
      expect(lastState.source_state.data).toMatchObject({ remaining: [] })
    })

    it('emits state with full segment snapshots after each page for resumability', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'item_1' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {
        getAccount: vi
          .fn()
          .mockResolvedValue({ id: 'acct_test', object: 'account', created: 1000000 }),
      } as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'customers' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
          ...LIST_BACKFILL_OPTS,
        })
      )

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      expect(states.length).toBeGreaterThan(0)

      for (const state of states) {
        expectRemainingShape(state.source_state.data)
      }

      const lastData = states[states.length - 1].source_state.data as StreamState
      expect(lastData.remaining).toEqual([])
    })
  })

  describe('read() — streams without supportsCreatedFilter sync sequentially', () => {
    it('subdivides after first page and fetches two older halves in parallel', async () => {
      const listFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'cus_1', created: 1_500_000_000 }],
          has_more: true,
        })
        .mockResolvedValue({
          data: [],
          has_more: false,
        })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const messages = await collect(
        listApiBackfill({
          catalog: {
            streams: [
              {
                stream: { name: 'customers', newer_than_field: '_updated_at' },
                time_range: { gte: TEST_RANGE_GTE, lt: TEST_RANGE_LT },
              },
            ],
          },
          state: undefined,
          registry,
          client: {} as unknown as StripeClient,
          accountId: 'acct_test',
          rateLimiter: async () => 0,
          maxConcurrentStreams: 5,
        })
      )

      // First call: full range → has_more + created=1_500_000_000.
      // streamingSubdivide splits into 2 older halves; the newest half widens
      // its lt to splitPoint+1 and inherits the cursor, so the boundary second
      // is drained inline instead of via a separate request.
      // Both child ranges return has_more=false → exhausted → range_complete for each.
      expect(listFn).toHaveBeenCalledTimes(3)
      expect(listFn).toHaveBeenNthCalledWith(1, {
        limit: 100,
        created: {
          gte: Math.floor(new Date(TEST_RANGE_GTE).getTime() / 1000),
          lt: Math.floor(new Date(TEST_RANGE_LT).getTime() / 1000),
        },
      })

      const rangeCompletes = messages.filter(
        (m): m is StreamStatusMessage =>
          m.type === 'stream_status' && m.stream_status.status === 'range_complete'
      )
      // Head range (already-fetched portion) should complete
      expect(rangeCompletes).toContainEqual(
        expect.objectContaining({
          stream_status: expect.objectContaining({
            stream: 'customers',
            range_complete: {
              gte: new Date((1_500_000_000 + 1) * 1000).toISOString(),
              lt: TEST_RANGE_LT,
            },
          }),
        })
      )
      // The newest older half absorbs the boundary: its lt extends to
      // splitPoint+1 so the cursor paginates any shared-second records inline.
      expect(rangeCompletes).toContainEqual(
        expect.objectContaining({
          stream_status: expect.objectContaining({
            stream: 'customers',
            range_complete: expect.objectContaining({
              lt: new Date(1_500_000_001 * 1000).toISOString(),
            }),
          }),
        })
      )
      // Head + 2 older halves = 3 range_complete events
      expect(rangeCompletes).toHaveLength(3)
    })

    it('uses sequential pagination (no created filter) for non-parallel streams', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'item_1', name: 'Sequential' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        tax_ids: makeConfig({
          order: 1,
          tableName: 'tax_ids',
          supportsCreatedFilter: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {} as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'tax_ids' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
          ...LIST_BACKFILL_OPTS,
        })
      )

      expect(listFn).toHaveBeenCalledTimes(1)
      expect(listFn).toHaveBeenCalledWith({ limit: 100 })

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      for (const state of states) {
        expectRemainingShape(state.source_state.data)
      }
    })

    it('does not assume cursor pagination when the endpoint does not support it', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'report_type_1', name: 'One shot' }],
        has_more: true,
      })

      const registry: Record<string, ResourceConfig> = {
        reporting_report_types: makeConfig({
          order: 1,
          tableName: 'reporting_report_types',
          supportsCreatedFilter: false,
          supportsLimit: false,
          supportsForwardPagination: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {} as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'reporting_report_types' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
          ...LIST_BACKFILL_OPTS,
        })
      )

      expect(listFn).toHaveBeenCalledTimes(1)
      expect(listFn).toHaveBeenCalledWith({})

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      expect(states.at(-1)?.source_state.data).toMatchObject({ remaining: [] })
    })

    it('parallel and sequential streams coexist in the same catalog', async () => {
      const parallelListFn = vi.fn().mockResolvedValue({
        data: [{ id: 'cus_1' }],
        has_more: false,
      })
      const sequentialListFn = vi.fn().mockResolvedValue({
        data: [{ id: 'tax_1' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: parallelListFn as ResourceConfig['listFn'],
        }),
        tax_ids: makeConfig({
          order: 2,
          tableName: 'tax_ids',
          supportsCreatedFilter: false,
          listFn: sequentialListFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {
        getAccount: vi
          .fn()
          .mockResolvedValue({ id: 'acct_test', object: 'account', created: 1000000 }),
      } as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: {
            streams: [
              { stream: { name: 'customers', newer_than_field: '_updated_at' } },
              { stream: { name: 'tax_ids', newer_than_field: '_updated_at' } },
            ],
          },
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
          ...LIST_BACKFILL_OPTS,
        })
      )

      expect(parallelListFn).toHaveBeenCalled()
      for (const call of parallelListFn.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ created: expect.any(Object) }))
      }

      for (const call of sequentialListFn.mock.calls) {
        expect(call[0]).not.toHaveProperty('created')
      }

      const statusMsgs = messages.filter(
        (m): m is StreamStatusMessage => m.type === 'stream_status'
      )
      const completes = statusMsgs.filter((m) => m.stream_status.status === 'complete')
      expect(completes).toHaveLength(2)
    })

    it('respects maxConcurrentStreams when scheduling stream backfills', async () => {
      const callOrder: string[] = []
      const firstListFn = vi.fn(async () => {
        callOrder.push('customers')
        return {
          data: [{ id: 'cus_1', created: 1_500_000_000 }],
          has_more: false,
        }
      })
      const secondListFn = vi.fn(async () => {
        callOrder.push('invoices')
        return {
          data: [{ id: 'cus_2', created: 1_500_000_100 }],
          has_more: false,
        }
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: firstListFn as ResourceConfig['listFn'],
        }),
        invoices: makeConfig({
          order: 2,
          tableName: 'invoices',
          supportsCreatedFilter: true,
          listFn: secondListFn as ResourceConfig['listFn'],
        }),
      }

      const messagesPromise = collect(
        listApiBackfill({
          catalog: {
            streams: [
              { stream: { name: 'customers', newer_than_field: '_updated_at' } },
              { stream: { name: 'invoices', newer_than_field: '_updated_at' } },
            ],
          },
          state: undefined,
          registry,
          client: {} as unknown as StripeClient,
          accountId: 'acct_test',
          rateLimiter: async () => 0,
          maxConcurrentStreams: 1,
        })
      )

      const messages = await messagesPromise

      // With maxConcurrentStreams: 1, streams run sequentially
      expect(firstListFn).toHaveBeenCalledTimes(1)
      expect(secondListFn).toHaveBeenCalledTimes(1)
      expect(callOrder).toEqual(['customers', 'invoices'])

      const statusMsgs = messages.filter(
        (m): m is StreamStatusMessage => m.type === 'stream_status'
      )
      expect(statusMsgs.map((m) => `${m.stream_status.stream}:${m.stream_status.status}`)).toEqual(
        expect.arrayContaining([
          'customers:start',
          'customers:range_complete',
          'customers:complete',
          'invoices:start',
          'invoices:range_complete',
          'invoices:complete',
        ])
      )
    })
  })

  describe('rate limiting', () => {
    describe('createInMemoryRateLimiter', () => {
      it('returns 0 (no wait) when tokens are available', async () => {
        const limiter = createInMemoryRateLimiter(10)
        const wait = await limiter()
        expect(wait).toBe(0)
      })

      it('returns positive wait time when tokens are depleted', async () => {
        const limiter = createInMemoryRateLimiter(2)
        await limiter()
        await limiter()
        const wait = await limiter()
        expect(wait).toBeGreaterThan(0)
      })

      it('wait time scales inversely with RPS', async () => {
        const fastLimiter = createInMemoryRateLimiter(100)
        const slowLimiter = createInMemoryRateLimiter(1)

        for (let i = 0; i < 100; i++) await fastLimiter()
        const fastWait = await fastLimiter()

        await slowLimiter()
        const slowWait = await slowLimiter()

        expect(slowWait).toBeGreaterThan(fastWait)
      })
    })

    it('rate limiter is called before each list API page during backfill', async () => {
      const rateLimiterSpy = vi.fn().mockResolvedValue(0) as unknown as RateLimiter

      const listFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'item_1' }],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'item_2' }],
          has_more: false,
        })

      const registry: Record<string, ResourceConfig> = {
        items: makeConfig({
          order: 1,
          tableName: 'items',
          supportsCreatedFilter: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      await collect(
        listApiBackfill({
          catalog: catalog({ name: 'items' }),
          state: undefined,
          registry,
          client: {} as unknown as StripeClient,
          accountId: 'acct_test',
          rateLimiter: rateLimiterSpy,
          ...LIST_BACKFILL_OPTS,
        })
      )

      expect(rateLimiterSpy).toHaveBeenCalledTimes(2)
    })

    it('return() interrupts a pending rate-limit wait before the next page fetch', async () => {
      vi.useFakeTimers()

      const externalLimiter = vi.fn().mockResolvedValue(60) as unknown as RateLimiter
      const customSource = createStripeSource({ rateLimiter: externalLimiter })
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'cus_1' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      const iter = customSource
        .read({
          config: { api_key: 'sk_test_fake', api_version: BUNDLED_API_VERSION },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { streams: {}, global: {} },
        })
        [Symbol.asyncIterator]()

      expect((await iter.next()).value).toMatchObject({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })

      const blockedNext = iter.next()
      void blockedNext.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(listFn).not.toHaveBeenCalled()

      const settled = vi.fn()
      const returnPromise = iter.return()
      returnPromise.then((result) => settled(result))

      await vi.advanceTimersByTimeAsync(0)

      expect(settled).toHaveBeenCalledWith({ value: undefined, done: true })
      expect(listFn).not.toHaveBeenCalled()
    })

    it('createStripeSource uses external rate limiter when provided via deps', async () => {
      const externalLimiter = vi.fn().mockResolvedValue(0) as unknown as RateLimiter
      const customSource = createStripeSource({ rateLimiter: externalLimiter })

      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'cus_1' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      await collect(
        customSource.read({
          config: { api_key: 'sk_test_fake', api_version: BUNDLED_API_VERSION },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
        })
      )

      expect(externalLimiter).toHaveBeenCalled()
    })
  })

  describe('architecture purity', () => {
    it('source never imports from or references any destination module', () => {
      const srcDir = path.resolve(import.meta.dirname, '..')
      const sourceFiles = getAllTsFiles(srcDir)

      // Type-only imports are allowed (no runtime dependency)
      const destinationPatterns = [
        /(?<!import type .*)from\s+['"].*destination/,
        /(?<!type\s.*)import\s+(?!type\s).*['"].*destination/,
        /require\s*\(\s*['"].*destination/,
      ]

      const violations: string[] = []

      for (const file of sourceFiles) {
        // Skip test files
        if (file.includes('__tests__')) continue

        const content = fs.readFileSync(file, 'utf-8')
        const lines = content.split('\n')
        for (const line of lines) {
          // Skip type-only imports
          if (/import\s+type\s/.test(line)) continue
          for (const pattern of destinationPatterns) {
            if (pattern.test(line)) {
              violations.push(`${path.relative(srcDir, file)}: ${line.trim()}`)
            }
          }
        }
      }

      expect(violations).toEqual([])
    })
  })
})
