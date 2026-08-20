import type {
  ConfiguredCatalog,
  Message,
  RecordMessage,
  SourceStateMessage,
} from '@stripe/sync-protocol'
import type { StripeEvent } from './spec.js'
import type { Config } from './index.js'
import { msg } from './index.js'
import { log } from './logger.js'
import type { ResourceConfig } from './types.js'
import { normalizeStripeObjectName } from './resourceRegistry.js'

// MARK: - Delete event detection

const RESOURCE_DELETE_EVENTS: ReadonlySet<string> = new Set([
  'customer.deleted',
  'product.deleted',
  'price.deleted',
  'plan.deleted',
  'invoice.deleted',
  'coupon.deleted',
  'customer.tax_id.deleted',
])

function isDeleteEvent(event: StripeEvent): boolean {
  if (
    'deleted' in event.data.object &&
    (event.data.object as { deleted?: boolean }).deleted === true
  ) {
    return true
  }
  return RESOURCE_DELETE_EVENTS.has(event.type)
}

/**
 * Stripe sets `event.account` to the connected account an event actually
 * came from (docs.stripe.com/connect/webhooks). Each pipeline handles only
 * one account, so if `event.account` is set and doesn't match, the event
 * belongs to a different account and must not be saved here. If either
 * value is missing there's nothing to compare, so the event is let through
 * because there's no evidence it belongs to any other account.
 */
function eventBelongsToAccount(event: StripeEvent, accountId?: string): boolean {
  return !accountId || !event.account || event.account === accountId
}

// MARK: - fromStripeEvent

/**
 * Convert a single Stripe webhook event into protocol messages.
 *
 * Returns { record, state } for supported events, or null if the event's
 * object type is not in the registry or the object has no id.
 *
 * This is the building block for live mode. The orchestrator/webhook server
 * pushes events in; this method converts them to protocol messages.
 *
 * `newerThanField` is the catalog-declared staleness column; records are
 * stamped from native `.updated` when present, else `event.created`.
 */
export function fromStripeEvent(
  event: StripeEvent,
  registry: Record<string, ResourceConfig>,
  newerThanField: string,
  accountId?: string
): { record: RecordMessage; state: SourceStateMessage } | null {
  const dataObject = event.data?.object as unknown as
    | { id?: string; object?: string; deleted?: boolean; [key: string]: unknown }
    | undefined
  if (!dataObject?.object) return null
  if (!eventBelongsToAccount(event, accountId)) return null

  const objectType = normalizeStripeObjectName(dataObject.object)
  const config = registry[objectType]
  if (!config) return null

  // Skip objects without an id (preview/draft objects like invoice.upcoming)
  if (!dataObject.id) return null
  const updated = dataObject.updated
  const _updated_at = typeof updated === 'number' ? updated : event.created
  const baseData = dataObject as Record<string, unknown>
  const data: Record<string, unknown> = {
    ...baseData,
    [newerThanField]: _updated_at,
    ...(accountId ? { _account_id: accountId } : {}),
  }
  const record = msg.record({
    stream: config.tableName,
    data,
    emitted_at: new Date().toISOString(),
  })
  const state: SourceStateMessage = msg.source_state({
    state_type: 'stream',
    stream: config.tableName,
    data: {
      eventId: event.id,
      eventCreated: event.created,
    },
  })

  return { record, state }
}

// MARK: - processStripeEvent

/**
 * Process a single verified StripeEvent through the full pipeline:
 * entitlements, registry filter, delete detection, revalidation,
 * subscription items.
 *
 * This is the canonical function — all event paths (webhook, events API,
 * WebSocket) converge here once a StripeEvent is in hand.
 */
export async function* processStripeEvent(
  event: StripeEvent,
  config: Config,
  catalog: ConfiguredCatalog,
  registry: Record<string, ResourceConfig>,
  streamNames: Set<string>,
  accountId?: string
): AsyncGenerator<Message> {
  log.info({ eventId: event.id, eventType: event.type }, 'webhook event received')

  // 1. Extract object
  const dataObject = event.data?.object as unknown as
    | { id?: string; object?: string; deleted?: boolean; [key: string]: unknown }
    | undefined
  if (!dataObject?.object) return

  if (!eventBelongsToAccount(event, accountId)) {
    log.warn(
      {
        eventId: event.id,
        eventType: event.type,
        pipelineAccountId: accountId,
        eventAccountId: event.account,
      },
      "Skipping webhook event: event.account does not match this pipeline's account"
    )
    return
  }

  const newerThanField = (streamName: string) =>
    catalog.streams.find((cs) => cs.stream.name === streamName)!.stream.newer_than_field

  // 2. Entitlements special case — the summary object type doesn't map to a
  //    registry entry, so we must handle it before the registry lookup.
  if (event.type === 'entitlements.active_entitlement_summary.updated') {
    if (!streamNames.has('active_entitlement')) return
    const summary = dataObject as {
      customer: string
      entitlements: {
        data: Array<{
          id: string
          object: string
          feature: string | { id: string }
          livemode: boolean
          lookup_key: string
          updated?: number
        }>
      }
    }
    for (const e of summary.entitlements.data) {
      yield msg.record({
        stream: 'active_entitlement',
        emitted_at: new Date().toISOString(),
        data: {
          id: e.id,
          object: e.object,
          feature: typeof e.feature === 'string' ? e.feature : e.feature.id,
          customer: summary.customer,
          livemode: e.livemode,
          lookup_key: e.lookup_key,
          [newerThanField('active_entitlement')]:
            typeof e.updated === 'number' ? e.updated : event.created,
          ...(accountId ? { _account_id: accountId } : {}),
        },
      })
    }
    yield msg.source_state({
      state_type: 'stream',
      stream: 'active_entitlement',
      data: { eventId: event.id, eventCreated: event.created },
    })
    return
  }

  // 3. Filter by registry and catalog
  const objectType = normalizeStripeObjectName(dataObject.object)
  const resourceConfig = registry[objectType]
  if (!resourceConfig) return
  if (!dataObject.id) return // skip preview/draft objects
  if (!streamNames.has(resourceConfig.tableName)) return

  const _updated_at = typeof dataObject.updated === 'number' ? dataObject.updated : event.created

  // 4. Delete events — yield record with deleted: true
  if (isDeleteEvent(event)) {
    yield msg.record({
      stream: resourceConfig.tableName,
      emitted_at: new Date().toISOString(),
      recordDeleted: true,
      data: {
        ...dataObject,
        [newerThanField(resourceConfig.tableName)]: _updated_at,
        ...(accountId ? { _account_id: accountId } : {}),
      },
    })
    yield msg.source_state({
      state_type: 'stream',
      stream: resourceConfig.tableName,
      data: { eventId: event.id, eventCreated: event.created },
    })
    return
  }

  // 5. Revalidation — re-fetch from Stripe API if configured
  let data: Record<string, unknown> = dataObject
  if (
    config.revalidate_objects?.some((r) => normalizeStripeObjectName(r) === objectType) &&
    resourceConfig.isFinalState &&
    !resourceConfig.isFinalState(dataObject)
  ) {
    data = (await resourceConfig.retrieveFn!(dataObject.id)) as Record<string, unknown>
  }

  // 6. Yield main record
  const recordData: Record<string, unknown> = {
    ...data,
    [newerThanField(resourceConfig.tableName)]: _updated_at,
    ...(accountId ? { _account_id: accountId } : {}),
  }
  yield msg.record({
    stream: resourceConfig.tableName,
    data: recordData,
    emitted_at: new Date().toISOString(),
  })

  // 7. Yield subscription items if applicable.
  if (objectType === 'subscription' && (data as { items?: { data?: unknown[] } }).items?.data) {
    const subscriptionItemsNewerThanField =
      catalog.streams.find((cs) => cs.stream.name === 'subscription_item')?.stream
        .newer_than_field ?? newerThanField(resourceConfig.tableName)
    for (const item of (data as { items: { data: Record<string, unknown>[] } }).items.data) {
      yield msg.record({
        stream: 'subscription_item',
        data: {
          ...item,
          [subscriptionItemsNewerThanField]: _updated_at,
          ...(accountId ? { _account_id: accountId } : {}),
        },
        emitted_at: new Date().toISOString(),
      })
    }
  }

  yield msg.source_state({
    state_type: 'stream',
    stream: resourceConfig.tableName,
    data: { eventId: event.id, eventCreated: event.created },
  })
}
