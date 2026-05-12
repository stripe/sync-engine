import type {
  CatalogPayload,
  Source,
  SpecOutput,
  CheckOutput,
  DiscoverOutput,
  Message,
} from '@stripe/sync-protocol'
import { createSourceMessageFactory } from '@stripe/sync-protocol'
import defaultSpec from './spec.js'
import type { Config, StreamState } from './spec.js'
import { MetronomeClient } from './client.js'
import { resources } from './resources.js'
import { log } from './logger.js'
import { startWebhookServer } from './webhook.js'
import type { MetronomeWebhookEvent } from './webhook.js'

export { configSchema, type Config } from './spec.js'

export const msg = createSourceMessageFactory<
  StreamState,
  Record<string, unknown>,
  Record<string, unknown>
>()

function buildCatalog(): CatalogPayload {
  return {
    streams: resources.map((r) => ({
      name: r.name,
      primary_key: r.primaryKey,
      newer_than_field: '_synced_at',
      json_schema: r.jsonSchema,
    })),
  }
}

/** Event types that affect credit/commit balances */
const BALANCE_EVENT_TYPES = new Set([
  'commit.create',
  'commit.edit',
  'commit.segment.start',
  'commit.segment.end',
  'credit.create',
  'credit.edit',
  'credit.segment.start',
  'credit.segment.end',
])

/** Event types that affect contract entitlements */
const ENTITLEMENT_EVENT_TYPES = new Set([
  'contract.create',
  'contract.start',
  'contract.edit',
  'contract.end',
  'contract.archive',
])

/** All webhook event types we handle */
const WEBHOOK_EVENT_TYPES = new Set([...BALANCE_EVENT_TYPES, ...ENTITLEMENT_EVENT_TYPES])

/**
 * On a webhook event, re-fetch affected data from Metronome and yield updated records.
 */
async function* processWebhookEvent(
  event: MetronomeWebhookEvent,
  client: MetronomeClient,
  configuredStreamNames: Set<string>
): AsyncGenerator<Message> {
  const customerId = event.customer_id ?? (event.properties?.customer_id as string | undefined)
  if (!customerId) {
    log.warn({ eventType: event.type }, 'metronome: webhook event has no customer_id, skipping')
    return
  }

  log.info(
    { eventType: event.type, customerId, eventId: event.id },
    'metronome: processing webhook event'
  )

  const now = Math.floor(Date.now() / 1000)

  // Re-fetch net balance only for balance-affecting events
  if (configuredStreamNames.has('net_balance') && BALANCE_EVENT_TYPES.has(event.type)) {
    const result = await client.post<{ data: Record<string, unknown> }>(
      '/v1/contracts/customerBalances/getNetBalance',
      { customer_id: customerId }
    )
    yield msg.record({
      stream: 'net_balance',
      data: { ...result.data, customer_id: customerId, _synced_at: now },
      emitted_at: new Date().toISOString(),
    })
  }

  // Re-fetch entitlements only for contract-affecting events
  if (configuredStreamNames.has('entitlements') && ENTITLEMENT_EVENT_TYPES.has(event.type)) {
    const contractId = event.contract_id ?? (event.properties?.contract_id as string | undefined)
    const contractIds: string[] = []

    if (contractId) {
      contractIds.push(contractId)
    } else {
      // Fetch all contracts for this customer
      for await (const page of client.paginate<{ id: string }>('POST', '/v2/contracts/list', {
        customer_id: customerId,
      })) {
        for (const c of page.data) contractIds.push(c.id)
      }
    }

    for (const cid of contractIds) {
      for await (const page of client.paginate('POST', '/v1/contracts/getContractRateSchedule', {
        customer_id: customerId,
        contract_id: cid,
        at: new Date().toISOString(),
      })) {
        for (const record of page.data) {
          yield msg.record({
            stream: 'entitlements',
            data: {
              ...(record as Record<string, unknown>),
              customer_id: customerId,
              contract_id: cid,
              _synced_at: now,
            },
            emitted_at: new Date().toISOString(),
          })
        }
      }
    }
  }
}

const source: Source<Config, StreamState> = {
  async *spec(): AsyncGenerator<SpecOutput> {
    yield { type: 'spec' as const, spec: defaultSpec }
  },

  async *check({ config }: { config: Config }): AsyncGenerator<CheckOutput> {
    const client = new MetronomeClient({
      apiKey: config.api_key,
      baseUrl: config.base_url,
    })
    try {
      await client.get('/v1/customers?limit=1')
      yield msg.connection_status({ status: 'succeeded' })
    } catch (err) {
      yield msg.connection_status({
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  },

  async *discover(): AsyncGenerator<DiscoverOutput> {
    yield { type: 'catalog' as const, catalog: buildCatalog() }
  },

  async *read({
    config,
    catalog,
    state,
  }: {
    config: Config
    catalog: import('@stripe/sync-protocol').ConfiguredCatalog
    state?: { streams: Record<string, StreamState>; global: Record<string, unknown> }
  }) {
    const client = new MetronomeClient({
      apiKey: config.api_key,
      baseUrl: config.base_url,
      rateLimitPerSecond: config.rate_limit,
    })
    const streamStates = state?.streams ?? {}
    const configuredStreamNames = new Set(catalog.streams.map((s) => s.stream.name))

    // For per-customer and per-contract resources, we need parent IDs
    let customerIds: string[] | undefined
    let customerContracts: Map<string, string[]> | undefined

    /** Lazy-load all customer IDs */
    async function ensureCustomerIds() {
      if (customerIds) return customerIds
      customerIds = []
      for await (const page of client.paginate<{ id: string }>('GET', '/v1/customers')) {
        for (const c of page.data) {
          customerIds.push(c.id)
        }
      }
      log.info({ count: customerIds.length }, 'metronome: loaded customer IDs')
      return customerIds
    }

    /** Lazy-load all customer → contract ID mappings */
    async function ensureCustomerContracts() {
      if (customerContracts) return customerContracts
      const custIds = await ensureCustomerIds()
      customerContracts = new Map()
      for (const customerId of custIds) {
        const contractIds: string[] = []
        for await (const page of client.paginate<{ id: string }>('POST', '/v2/contracts/list', {
          customer_id: customerId,
        })) {
          for (const c of page.data) {
            contractIds.push(c.id)
          }
        }
        if (contractIds.length > 0) {
          customerContracts.set(customerId, contractIds)
        }
      }
      log.info(
        {
          customers: customerContracts.size,
          contracts: [...customerContracts.values()].reduce((s, c) => s + c.length, 0),
        },
        'metronome: loaded customer→contract mappings'
      )
      return customerContracts
    }

    for (const resource of resources) {
      if (!configuredStreamNames.has(resource.name)) continue

      const streamName = resource.name
      yield msg.stream_status({ stream: streamName, status: 'start' })

      try {
        let recordCount = 0
        const existingState = streamStates[streamName]
        const startCursor = existingState?.next_page

        if (resource.perContract) {
          // Per-contract: iterate customers → contracts → rate schedule
          const mapping = await ensureCustomerContracts()

          outer_contract: for (const [customerId, contractIds] of mapping) {
            for (const contractId of contractIds) {
              for await (const page of client.paginate(resource.method, resource.endpoint, {
                customer_id: customerId,
                contract_id: contractId,
                at: new Date().toISOString(),
              })) {
                for (const record of page.data) {
                  const data = {
                    ...(record as Record<string, unknown>),
                    customer_id: customerId,
                    contract_id: contractId,
                    _synced_at: Math.floor(Date.now() / 1000),
                  }
                  yield msg.record({
                    stream: streamName,
                    data,
                    emitted_at: new Date().toISOString(),
                  })
                  recordCount++
                  if (config.backfill_limit && recordCount >= config.backfill_limit)
                    break outer_contract
                }
                if (config.backfill_limit && recordCount >= config.backfill_limit) break
              }
            }
          }
        } else if (resource.perCustomer) {
          // Per-customer: iterate customers
          const custIds = await ensureCustomerIds()

          if (resource.singleObject) {
            // Endpoint returns a single object, not a paginated list
            outer_single: for (const customerId of custIds) {
              const result = await client.post<{ data: Record<string, unknown> }>(
                resource.endpoint,
                { customer_id: customerId }
              )
              const data = {
                ...result.data,
                customer_id: customerId,
                _synced_at: Math.floor(Date.now() / 1000),
              }
              yield msg.record({
                stream: streamName,
                data,
                emitted_at: new Date().toISOString(),
              })
              recordCount++
              if (config.backfill_limit && recordCount >= config.backfill_limit) break outer_single
            }
          } else {
            outer: for (const customerId of custIds) {
              for await (const page of client.paginate(resource.method, resource.endpoint, {
                customer_id: customerId,
              }, undefined, { skipLimit: resource.skipLimit })) {
                for (const record of page.data) {
                  const data = {
                    ...(record as Record<string, unknown>),
                    _synced_at: Math.floor(Date.now() / 1000),
                  }
                  yield msg.record({
                    stream: streamName,
                    data,
                    emitted_at: new Date().toISOString(),
                  })
                  recordCount++
                  if (config.backfill_limit && recordCount >= config.backfill_limit) break outer
                }
                if (config.backfill_limit && recordCount >= config.backfill_limit) break
              }
            }
          }
        } else {
          for await (const page of client.paginate(
            resource.method,
            resource.endpoint,
            undefined,
            startCursor,
            { skipLimit: resource.skipLimit }
          )) {
            for (const record of page.data) {
              const data = {
                ...(record as Record<string, unknown>),
                _synced_at: Math.floor(Date.now() / 1000),
              }
              yield msg.record({
                stream: streamName,
                data,
                emitted_at: new Date().toISOString(),
              })
              recordCount++
              if (config.backfill_limit && recordCount >= config.backfill_limit) break
            }

            // Checkpoint after each page
            yield msg.source_state({
              state_type: 'stream',
              stream: streamName,
              data: { next_page: page.next_page },
            })

            if (config.backfill_limit && recordCount >= config.backfill_limit) break
          }
        }

        // Final state: null cursor means complete
        yield msg.source_state({
          state_type: 'stream',
          stream: streamName,
          data: { next_page: null },
        })

        log.info({ stream: streamName, records: recordCount }, 'metronome: stream complete')
        yield msg.stream_status({ stream: streamName, status: 'complete' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ stream: streamName, error: message }, 'metronome: stream error')
        yield msg.stream_status({ stream: streamName, status: 'error', error: message })
      }
    }

    // After backfill: start webhook server for live updates
    if (config.webhook_port) {
      log.info(
        { port: config.webhook_port },
        'metronome: starting webhook listener for live updates'
      )

      type QueueItem = { event: MetronomeWebhookEvent; resolve: () => void }
      const queue: QueueItem[] = []
      let waiter: ((item: QueueItem) => void) | null = null

      const server = startWebhookServer(config.webhook_port, config.webhook_secret, (input) => {
        if (!WEBHOOK_EVENT_TYPES.has(input.event.type)) {
          log.debug({ eventType: input.event.type }, 'metronome: ignoring unhandled event type')
          return
        }
        const { promise, resolve } = Promise.withResolvers<void>()
        const item = { event: input.event, resolve }
        if (waiter) {
          const w = waiter
          waiter = null
          w(item)
        } else {
          queue.push(item)
        }
        // Block HTTP response until we've processed the event
        return promise
      })

      try {
        // Process webhook events forever (until abort)
        while (true) {
          const item: QueueItem = await new Promise((resolve) => {
            if (queue.length > 0) {
              resolve(queue.shift()!)
            } else {
              waiter = resolve
            }
          })

          try {
            yield* processWebhookEvent(item.event, client, configuredStreamNames)
            // Emit state checkpoint so destination flushes immediately
            if (configuredStreamNames.has('net_balance')) {
              yield msg.source_state({
                state_type: 'stream',
                stream: 'net_balance',
                data: { next_page: null },
              })
            }
            if (configuredStreamNames.has('entitlements')) {
              yield msg.source_state({
                state_type: 'stream',
                stream: 'entitlements',
                data: { next_page: null },
              })
            }
            item.resolve()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            log.error(
              { error: message, eventType: item.event.type },
              'metronome: webhook event processing error'
            )
            item.resolve() // still resolve to unblock HTTP response
          }
        }
      } finally {
        server.close()
      }
    }
  },
}

export default source
