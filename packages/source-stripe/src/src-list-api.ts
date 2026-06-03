import type { Message } from '@stripe/sync-protocol'
import {
  streamingSubdivide,
  DEFAULT_SUBDIVISION_FACTOR,
  toUnixSeconds,
  toIso,
  mergeAsync,
} from '@stripe/sync-protocol'
import type { PageResult } from '@stripe/sync-protocol'
import type { ListFn } from '@stripe/sync-openapi'
import type { ResourceConfig } from './types.js'
import type { RemainingRange, StreamState } from './index.js'
import { msg } from './index.js'
import { log } from './logger.js'
import type { RateLimiter } from './rate-limiter.js'
import { StripeApiRequestError } from '@stripe/sync-openapi'
import type { StripeClient } from './client.js'
import { STRIPE_LAUNCH_TIMESTAMP } from './account-metadata.js'

// MARK: - Rate-limit wrapper

function waitForRateLimit(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(signal!.reason)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function withRateLimit(
  listFn: ListFn,
  rateLimiter: RateLimiter,
  signal?: AbortSignal
): ListFn {
  return async (params) => {
    signal?.throwIfAborted()
    const wait = await rateLimiter()
    if (wait > 0) {
      const wait_ms = Math.round(wait * 1000)
      log.debug({
        event: 'rate_limit_wait',
        wait_ms,
      })
      await waitForRateLimit(wait_ms, signal)
      log.debug({
        event: 'rate_limit_resumed',
        waited_ms: wait_ms,
      })
    }
    signal?.throwIfAborted()
    if (!signal) return listFn(params)

    // Race listFn (which includes withHttpRetry) against the abort signal
    // so retries don't block past pipeline teardown.
    // Always throw AbortError so callers can reliably detect pipeline shutdown.
    // Swallow the loser's rejection to avoid unhandled promise rejections.
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const listP = listFn(params)
    const abortP = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(abortError)
        return
      }
      signal.addEventListener('abort', () => reject(abortError), { once: true })
    })
    return Promise.race([listP, abortP]).finally(() => {
      listP.catch(() => {})
      abortP.catch(() => {})
    })
  }
}

// MARK: - Error helpers

/** Convert an error to a connection_status: failed message. */
export function errorToConnectionStatus(err: unknown): Message {
  return msg.connection_status({
    status: 'failed',
    message: err instanceof Error ? err.message : String(err),
  })
}

/**
 * Each pattern catches exactly one known permanent error for one stream.
 * Prefer false negatives (failing to skip) over false positives (accidentally
 * skipping a real error). When a new permanent error is discovered, add a new
 * entry with a comment naming the exact stream and the full raw error message.
 */
const SKIPPABLE_ERROR_MESSAGES = [
  // forwarding_requests
  // "Your account is not authorized to send Forwarding requests in livemode. To enable access,
  //  please contact us via https://support.stripe.com/contact. [GET /v1/forwarding/requests (400)]
  //  {request-id=req_BJBACn1FDAJcUM}"
  'Your account is not authorized to send Forwarding requests in livemode',

  // test_helpers_test_clocks
  // "This endpoint is only available in testmode. Try using your test keys instead.
  //  [GET /v1/test_helpers/test_clocks (400)] {request-id=req_OYx1Lh47ntlkvq}"
  'This endpoint is only available in testmode',

  // Other testmode-only list errors ("This object is only available in testmode", etc.)
  'only available in testmode',

  // treasury_financial_accounts
  // Variant 1 (with hint):
  // "Unrecognized request URL (GET: /v1/treasury/financial_accounts). Please see
  //  https://stripe.com/docs or we can help at https://support.stripe.com/.
  //  (Hint: Have you onboarded to Treasury? You can learn more about the steps needed at
  //  https://stripe.com/docs/treasury/access) [GET /v1/treasury/financial_accounts (400)]
  //  {request-id=req_IUY53toFOUrzG6}"
  'Have you onboarded to Treasury',
  // Variant 2 (without hint):
  // "Unrecognized request URL (GET: /v1/treasury/financial_accounts). Please see
  //  https://stripe.com/docs or we can help at https://support.stripe.com/.
  //  [GET /v1/treasury/financial_accounts (400)] {request-id=req_...}"
  'Unrecognized request URL (GET: /v1/treasury/financial_accounts)',

  // v2_core_accounts
  // "Accounts v2 is not enabled for your platform. If you're interested in using this API with
  //  your integration, please visit
  //  https://dashboard.stripe.com/acct_1DfwS2ClCIKljWvs/settings/connect/platform-setup.
  //  [GET /v2/core/accounts (400)] {request-id=req_v2HaQWYCiDgV6xQZ7, stripe-should-retry=false}"
  // "Accounts v2 is not enabled for your livemode merchant acct_1NIFdXLd02PKGbD5. Please visit
  //  https://docs.stripe.com/connect/use-accounts-as-customers to enable Accounts v2.
  //  [GET /v2/core/accounts (400)] {request-id=req_v2yowYQ7yMNDkuvFi, stripe-should-retry=false}"
  'Accounts v2 is not enabled',
  // Variant 2 (test mode / sandbox):
  // "Accounts v2 isn't available in test mode. Switch to a sandbox to test.
  //  [GET /v2/core/accounts (400)] {request-id=..., stripe-should-retry=false}"
  "isn't available in test mode",

  // sigma_scheduled_query_runs (test mode)
  // "This API surface is not enabled for testmode usage. [GET /v1/sigma/scheduled_query_runs (400)] ..."
  'API surface is not enabled',

  // issuing_authorizations, issuing_cardholders, issuing_cards, issuing_disputes, issuing_transactions
  // "Your account is not set up to use Issuing. Please visit
  //  https://dashboard.stripe.com/issuing/overview to get started.
  //  [GET /v1/issuing/authorizations (400)]"
  'Your account is not set up to use Issuing',

  // identity_verification_reports, identity_verification_sessions
  // "Your account is not set up to use Identity. Please have an account admin visit
  //  https://dashboard.stripe.com/identity to get started.
  //  [GET /v1/identity/verification_reports (400)]"
  'Your account is not set up to use Identity',

  // climate_order
  // "This account is not eligible for Climate Orders.
  //  [GET /v1/climate/orders (400)]"
  'This account is not eligible for Climate Orders',

  // billing_alerts
  // "Your custom plan does not include alerts in livemode.
  //  [GET /v1/billing/alerts (400)]"
  'does not include alerts in livemode',

  // billing_credit_grants
  // "Your custom plan does not include billing credit grants in livemode.
  //  [GET /v1/billing/credit_grants (400)]"
  'does not include billing credit grants in livemode',
]

export function isSkippableError(err: unknown): boolean {
  if (!(err instanceof StripeApiRequestError)) return false
  const body = err.body as { error?: { message?: string } } | undefined
  const message = (body?.error?.message ?? '').toLowerCase()
  return SKIPPABLE_ERROR_MESSAGES.some((p) => message.includes(p.toLowerCase()))
}

// MARK: - Log message helpers (use msg.log directly where possible)

// N-ary search functions and time helpers are imported from @stripe/sync-protocol.

// MARK: - Time range reconciliation

/**
 * Reconcile `remaining` ranges when the incoming `time_range` differs from
 * the previously `accounted_range`. Rules:
 *   1. Drop ranges fully outside the new time_range
 *   2. Trim ranges that partially overlap the new boundaries
 *   3. Add new ranges for uncovered territory
 *   4. Return the new accounted_range (= time_range)
 */
export function reconcileRanges(
  remaining: RemainingRange[],
  accounted: { gte: string; lt: string },
  incoming: { gte: string; lt: string }
): RemainingRange[] {
  const result: RemainingRange[] = []

  for (const range of remaining) {
    const rGte = range.gte
    const rLt = range.lt
    // Drop fully outside
    if (rLt <= incoming.gte || rGte >= incoming.lt) continue
    // Trim to fit
    result.push({
      gte: rGte < incoming.gte ? incoming.gte : rGte,
      lt: rLt > incoming.lt ? incoming.lt : rLt,
      cursor: rGte < incoming.gte ? null : range.cursor, // reset cursor if gte trimmed
    })
  }

  // Add uncovered territory below
  if (incoming.gte < accounted.gte) {
    result.push({ gte: incoming.gte, lt: accounted.gte, cursor: null })
  }
  // Add uncovered territory above
  if (incoming.lt > accounted.lt) {
    result.push({ gte: accounted.lt, lt: incoming.lt, cursor: null })
  }

  return result
}

// MARK: - Account created timestamp

async function getAccountCreatedTimestamp(client: StripeClient): Promise<number> {
  try {
    const account = await client.getAccount({ maxRetries: 0 })
    return account.created ?? STRIPE_LAUNCH_TIMESTAMP
  } catch {
    return STRIPE_LAUNCH_TIMESTAMP
  }
}

// mergeAsync is imported from @stripe/sync-protocol above

// MARK: - Resource config lookup

function findConfigByTableName(
  registry: Record<string, ResourceConfig>,
  tableName: string
): ResourceConfig | undefined {
  return Object.values(registry).find((cfg) => cfg.tableName === tableName)
}

// MARK: - Detect and discard legacy state

function isLegacyState(data: unknown): boolean {
  if (data == null || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return 'backfill' in obj || 'segments' in obj || 'status' in obj || 'page_cursor' in obj
}

// MARK: - Page fetching for streamingSubdivide

/**
 * Fetch one page for a time range — satisfies streamingSubdivide's fetchPage contract.
 * Mutates range.cursor in-place. Returns stamped data + lastObserved.
 */
async function fetchPageForRange(opts: {
  range: RemainingRange
  listFn: ListFn
  streamName: string
  newerThanField: string
  supportsLimit: boolean
  supportsForwardPagination: boolean
}): Promise<PageResult<Record<string, unknown>>> {
  const { range, listFn, streamName, newerThanField, supportsLimit, supportsForwardPagination } =
    opts

  const created: Record<string, number> = {}
  if (range.gte) created.gte = toUnixSeconds(range.gte)
  if (range.lt) created.lt = toUnixSeconds(range.lt)
  const params: Record<string, unknown> = {
    ...(Object.keys(created).length > 0 && { created }),
  }
  if (supportsForwardPagination && supportsLimit) params.limit = 100
  if (supportsForwardPagination && range.cursor) params.starting_after = range.cursor

  const response = await listFn(params as Parameters<typeof listFn>[0])
  const responseAt =
    typeof response.responseAt === 'number' ? response.responseAt : Math.floor(Date.now() / 1000)

  const hasMore = supportsForwardPagination && response.has_more
  let nextCursor: string | null = null
  if (response.pageCursor) {
    nextCursor = response.pageCursor
  } else if (response.data.length > 0) {
    nextCursor = (response.data[response.data.length - 1] as { id: string }).id
  }

  // lastObserved = oldest record's created timestamp on this page.
  // Stripe returns newest-first, so the last record is the oldest.
  let lastObserved: number | null = null
  const data: Record<string, unknown>[] = []
  for (const item of response.data) {
    const record = item as Record<string, unknown>
    const created = record.created
    if (typeof created === 'number') lastObserved = created
    data.push({
      ...record,
      [newerThanField]: typeof record.updated === 'number' ? record.updated : responseAt,
    })
  }

  log.trace({
    event: 'page_fetched',
    stream: streamName,
    range_gte: range.gte,
    range_lt: range.lt,
    range_span_s: toUnixSeconds(range.lt) - toUnixSeconds(range.gte),
    had_cursor: range.cursor !== null,
    records: response.data.length,
    has_more: hasMore,
  })

  range.cursor = hasMore ? nextCursor : null

  return {
    range,
    data,
    hasMore,
    lastObserved,
  }
}

// MARK: - Sequential pagination (no subdivision)

/**
 * Paginate a single range to exhaustion — for resources that don't support
 * created-time filtering and can't be subdivided.
 */
async function* paginateSequential(opts: {
  range: RemainingRange
  accountedRange: { gte: string; lt: string }
  listFn: ListFn
  streamName: string
  newerThanField: string
  accountId: string
  supportsLimit: boolean
  supportsForwardPagination: boolean
  backfillLimit?: number
  totalEmitted: { count: number }
  totalApiCalls: { count: number }
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const {
    range,
    accountedRange,
    listFn,
    streamName,
    newerThanField,
    accountId,
    supportsLimit,
    supportsForwardPagination,
    backfillLimit,
    totalEmitted,
    totalApiCalls,
    drainQueue,
  } = opts

  let cursor = range.cursor
  let hasMore = true
  let prefetchedResponse: Promise<Awaited<ReturnType<ListFn>>> | null = null

  while (hasMore) {
    if (drainQueue) yield* drainQueue()

    const params: Record<string, unknown> = {}
    if (supportsForwardPagination && supportsLimit) params.limit = 100
    if (supportsForwardPagination && cursor) params.starting_after = cursor

    const response = prefetchedResponse
      ? await prefetchedResponse
      : await listFn(params as Parameters<typeof listFn>[0])
    const responseAt =
      typeof response.responseAt === 'number' ? response.responseAt : Math.floor(Date.now() / 1000)
    prefetchedResponse = null
    totalApiCalls.count++

    const responseHasMore = supportsForwardPagination && response.has_more
    let nextCursor: string | null = null
    if (response.pageCursor) {
      nextCursor = response.pageCursor
    } else if (response.data.length > 0) {
      nextCursor = (response.data[response.data.length - 1] as { id: string }).id
    }

    // Prefetch next page to hide latency
    if (backfillLimit == null && responseHasMore && nextCursor) {
      const nextParams: Record<string, unknown> = {}
      if (supportsForwardPagination && supportsLimit) nextParams.limit = 100
      if (supportsForwardPagination) nextParams.starting_after = nextCursor
      prefetchedResponse = listFn(nextParams as Parameters<typeof listFn>[0])
      // Attach a no-op catch to prevent unhandled rejection when the generator
      // returns early (e.g. pipeline shutdown via abort signal). The actual error
      // is still available via the original promise stored in the map.
      prefetchedResponse.catch(() => {})
    }

    log.trace({
      event: 'page_fetched',
      stream: streamName,
      records: response.data.length,
      has_more: responseHasMore,
    })

    for (const item of response.data) {
      const record = item as Record<string, unknown>
      yield msg.record({
        stream: streamName,
        data: {
          ...record,
          [newerThanField]: typeof record.updated === 'number' ? record.updated : responseAt,
          _account_id: accountId,
        },
        emitted_at: new Date().toISOString(),
      })
      totalEmitted.count++
    }

    hasMore = responseHasMore
    cursor = nextCursor
    if (backfillLimit && totalEmitted.count >= backfillLimit) hasMore = false

    range.cursor = hasMore ? cursor : null

    yield msg.source_state({
      state_type: 'stream',
      stream: streamName,
      data: {
        accounted_range: accountedRange,
        remaining: hasMore ? [range] : [],
      },
    })
  }

  yield msg.stream_status({
    stream: streamName,
    status: 'range_complete',
    range_complete: { gte: range.gte, lt: range.lt },
  })
}

// MARK: - Single-stream backfill

async function* iterateStream(opts: {
  streamName: string
  /** Catalog-declared staleness column (cs.stream.newer_than_field). */
  newerThanField: string
  timeRange: { gte: string; lt: string }
  streamState: StreamState | undefined
  resourceConfig: ResourceConfig & { listFn: ListFn }
  accountId: string
  rateLimiter: RateLimiter
  backfillLimit?: number
  signal?: AbortSignal
  drainQueue?: () => AsyncGenerator<Message>
  subdivisionFactor: number
}): AsyncGenerator<Message> {
  const {
    streamName,
    newerThanField,
    timeRange,
    resourceConfig,
    accountId,
    rateLimiter,
    backfillLimit,
    drainQueue,
    subdivisionFactor,
  } = opts

  let remaining: RemainingRange[]
  const accountedRange = { gte: timeRange.gte, lt: timeRange.lt }

  log.debug({
    event: 'stream_state_check',
    stream: streamName,
    has_state: !!opts.streamState,
    is_legacy: opts.streamState ? isLegacyState(opts.streamState) : null,
    state_keys: opts.streamState ? Object.keys(opts.streamState as Record<string, unknown>) : null,
  })

  if (opts.streamState && !isLegacyState(opts.streamState)) {
    const existingAccounted = opts.streamState.accounted_range
    if (
      existingAccounted &&
      (existingAccounted.gte !== timeRange.gte || existingAccounted.lt !== timeRange.lt)
    ) {
      // time_range changed — reconcile remaining against new range
      remaining = reconcileRanges(
        opts.streamState.remaining.map((r) => ({ ...r })),
        existingAccounted,
        timeRange
      )
      log.debug({
        event: 'state_reconcile',
        stream: streamName,
        old_gte: existingAccounted.gte,
        old_lt: existingAccounted.lt,
        new_gte: timeRange.gte,
        new_lt: timeRange.lt,
        old_remaining: opts.streamState.remaining.length,
        new_remaining: remaining.length,
        new_ranges: remaining.map((r) => ({ gte: r.gte, lt: r.lt, cursor: !!r.cursor })),
      })
    } else {
      remaining = opts.streamState.remaining.map((r) => ({ ...r }))
    }
    if (remaining.length === 0) return
  } else {
    if (opts.streamState && isLegacyState(opts.streamState)) {
      log.warn(`${streamName}: discarding legacy state, starting fresh`)
    }
    remaining = [{ gte: timeRange.gte, lt: timeRange.lt, cursor: null }]
  }

  yield msg.stream_status({ stream: streamName, status: 'start', time_range: timeRange })

  const rateLimitedListFn = withRateLimit(resourceConfig.listFn!, rateLimiter, opts.signal)
  const supportsCreatedFilter = resourceConfig.supportsCreatedFilter
  const supportsLimit = resourceConfig.supportsLimit !== false
  const supportsForwardPagination = resourceConfig.supportsForwardPagination !== false
  const totalEmitted = { count: 0 }
  const totalApiCalls = { count: 0 }
  const syncStart = Date.now()

  if (supportsCreatedFilter) {
    // Streaming subdivision: each page completion immediately subdivides and
    // enqueues children, keeping the pipeline full. Rate limiter controls concurrency.
    const pages = streamingSubdivide<Record<string, unknown>>({
      initial: remaining,
      fetchPage: (range) =>
        fetchPageForRange({
          range,
          listFn: rateLimitedListFn,
          streamName,
          newerThanField,
          supportsLimit,
          supportsForwardPagination,
        }),
      //concurrency: 100, // rate limiter is the real bottleneck
      concurrency: 1, // serialized for reliability; parallelism re-enabled if data gaps are due to parallelism
      subdivisionFactor,
    })

    for await (const event of pages) {
      totalApiCalls.count++

      if (drainQueue) yield* drainQueue()

      for (const item of event.data) {
        yield msg.record({
          stream: streamName,
          data: { ...item, _account_id: accountId },
          emitted_at: new Date().toISOString(),
        })
        totalEmitted.count++
      }

      yield msg.source_state({
        state_type: 'stream',
        stream: streamName,
        data: { accounted_range: accountedRange, remaining: event.remaining },
      })

      if (event.exhausted) {
        // Range fully drained — mark the whole range complete
        yield msg.stream_status({
          stream: streamName,
          status: 'range_complete',
          range_complete: { gte: event.range.gte, lt: event.range.lt },
        })
      } else if (event.hasMore && event.data.length > 0) {
        // Range was subdivided — the fetched head (from oldest record to range.lt)
        // is already accounted for. Emit range_complete so the progress bar fills.
        const oldest = event.data.findLast((r) => typeof r.created === 'number') as
          | { created: number }
          | undefined
        if (oldest) {
          const headGte = toIso(oldest.created + 1)
          if (headGte < event.range.lt) {
            yield msg.stream_status({
              stream: streamName,
              status: 'range_complete',
              range_complete: { gte: headGte, lt: event.range.lt },
            })
          }
        }
      }

      if (backfillLimit && totalEmitted.count >= backfillLimit) break
    }
  } else {
    // No created filter — paginate sequentially (no subdivision possible)
    yield* paginateSequential({
      range: remaining[0],
      accountedRange,
      listFn: rateLimitedListFn,
      streamName,
      newerThanField,
      accountId,
      supportsLimit,
      supportsForwardPagination,
      backfillLimit,
      totalEmitted,
      totalApiCalls,
      drainQueue,
    })
  }

  log.debug({
    event: 'subdivision_complete',
    stream: streamName,
    total_api_calls: totalApiCalls.count,
    total_records: totalEmitted.count,
    elapsed_ms: Date.now() - syncStart,
    effective_rps: totalApiCalls.count / ((Date.now() - syncStart) / 1000),
  })

  // Emit final state with empty remaining so consumers always see the completed state,
  // regardless of what intermediate state messages were emitted during subdivision rounds.
  yield msg.source_state({
    state_type: 'stream',
    stream: streamName,
    data: {
      accounted_range: accountedRange,
      remaining: [],
    },
  })

  yield msg.stream_status({ stream: streamName, status: 'complete' })
}

// MARK: - Main entry point

export async function* listApiBackfill(opts: {
  catalog: {
    streams: Array<{
      stream: { name: string; newer_than_field: string }
      backfill_limit?: number | undefined
      time_range?: { gte?: string; lt?: string } | undefined
    }>
  }
  state: Record<string, unknown> | undefined
  registry: Record<string, ResourceConfig>
  client: StripeClient
  accountCreated?: number
  accountId: string
  rateLimiter: RateLimiter
  backfillLimit?: number
  maxConcurrentStreams: number
  drainQueue?: () => AsyncGenerator<Message>
  signal?: AbortSignal
}): AsyncGenerator<Message> {
  const {
    catalog,
    state,
    registry,
    client,
    accountCreated: initialAccountCreated,
    accountId,
    rateLimiter,
    backfillLimit,
    maxConcurrentStreams,
    drainQueue,
  } = opts

  let accountCreated: number | null = initialAccountCreated ?? null

  const streamRuns: AsyncGenerator<Message>[] = []

  for (const configuredStream of catalog.streams) {
    const stream = configuredStream.stream
    const streamBackfillLimit = configuredStream.backfill_limit ?? backfillLimit
    const resourceConfig = findConfigByTableName(registry, stream.name)
    if (!resourceConfig) {
      streamRuns.push(
        (async function* () {
          yield msg.stream_status({
            stream: stream.name,
            status: 'error',
            error: `Unknown stream: ${stream.name}`,
          })
        })()
      )
      continue
    }

    if (!resourceConfig.listFn) continue

    // Resolve time_range: fill missing bounds from account metadata
    const catalogRange = configuredStream.time_range
    let gte = catalogRange?.gte
    let lt = catalogRange?.lt
    if (!gte) {
      if (accountCreated === null) {
        accountCreated = await getAccountCreatedTimestamp(client)
      }
      gte = toIso(accountCreated)
    }
    if (!lt) {
      lt = toIso(Math.floor(Date.now() / 1000) + 1)
    }
    const timeRange = { gte, lt }

    const streamState = state?.[stream.name] as StreamState | undefined

    streamRuns.push(
      (async function* () {
        try {
          yield* iterateStream({
            streamName: stream.name,
            newerThanField: stream.newer_than_field,
            timeRange,
            streamState,
            resourceConfig: { ...resourceConfig, listFn: resourceConfig.listFn! },
            accountId,
            rateLimiter,
            backfillLimit: streamBackfillLimit,
            signal: opts.signal,
            drainQueue,
            subdivisionFactor: Number(process.env.SUBDIVISION_FACTOR) || DEFAULT_SUBDIVISION_FACTOR,
          })
        } catch (err) {
          if (isSkippableError(err)) {
            yield msg.stream_status({
              stream: stream.name,
              status: 'skip',
              reason: err instanceof Error ? err.message : String(err),
            })
            return
          }

          // Abort means the pipeline is shutting down (chunk time limit).
          // The stream stays 'started' so it will retry on the next chunk.
          if (err instanceof Error && err.name === 'AbortError') {
            log.warn(
              { stream: stream.name },
              'Stream aborted during retry — will retry on next chunk; may loop if first page consistently exceeds chunk time limit'
            )
            return
          }

          log.error(
            {
              stream: stream.name,
              err,
            },
            'Stripe list page failed'
          )

          yield msg.stream_status({
            stream: stream.name,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    )
  }

  yield* mergeAsync(streamRuns, Math.min(maxConcurrentStreams, streamRuns.length))
}
