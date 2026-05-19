/**
 * Stripe HTTP API plumbing: list/retrieve callable builders + error types.
 *
 * Spec-derived metadata (list endpoints, nested endpoints, table-name resolution)
 * lives in `specParser.ts` — this module is purely runtime concerns.
 */

export type ListParams = {
  limit?: number
  starting_after?: string
  ending_before?: string
  created?: { gt?: number; gte?: number; lt?: number; lte?: number }
}

export type ListResult = {
  data: unknown[]
  has_more: boolean
  pageCursor?: string
  /** Response timestamp in unix seconds: Stripe HTTP Date, falling back to local now(). */
  responseAt: number
}

export type ListFn = (params: ListParams) => Promise<ListResult>

export type RetrieveFn = (id: string) => Promise<unknown>

export function isV2Path(apiPath: string): boolean {
  return apiPath.startsWith('/v2/')
}

// ---------------------------------------------------------------------------
// HTTP-based list / retrieve builders (no Stripe SDK dependency)
// ---------------------------------------------------------------------------

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com'

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

export class StripeApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    method: string,
    path: string,
    public readonly responseHeaders?: Record<string, string>
  ) {
    super(extractErrorMessage(body, status, method, path, responseHeaders))
    this.name = 'StripeApiRequestError'
  }
}

/** Headers worth surfacing in error messages for debugging. */
const DEBUG_HEADERS = [
  'request-id',
  'retry-after',
  'stripe-should-retry',
  'stripe-action-id',
  'stripe-server-environment',
]

/**
 * Extract only the debug-relevant headers from a Response, avoiding
 * `Object.fromEntries(headers.entries())` which materializes every header
 * and can silently drop duplicate keys like `set-cookie`.
 */
export function pickDebugHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of DEBUG_HEADERS) {
    const v = headers.get(key)
    if (v) out[key] = v
  }
  return out
}

function extractErrorMessage(
  body: unknown,
  status: number,
  method: string,
  path: string,
  responseHeaders?: Record<string, string>
): string {
  const context = `${method.toUpperCase()} ${path} (${status})`

  const headerParts: string[] = []
  if (responseHeaders) {
    for (const key of DEBUG_HEADERS) {
      const value = responseHeaders[key]
      if (value) headerParts.push(`${key}=${value}`)
    }
  }
  const headerStr = headerParts.length > 0 ? ` {${headerParts.join(', ')}}` : ''

  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    body.error &&
    typeof body.error === 'object' &&
    'message' in body.error &&
    typeof body.error.message === 'string'
  ) {
    return `${body.error.message} [${context}]${headerStr}`
  }

  return `Stripe API request failed: ${context}${headerStr}`
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Parse HTTP Date into unix seconds, falling back to local now(). */
export function parseHttpDateHeader(headers: Headers): number {
  const raw = headers.get('date')
  if (!raw) return Math.floor(Date.now() / 1000)
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000)
  return Math.floor(ms / 1000)
}

function assertOk(response: Response, body: unknown, method: string, path: string): void {
  if (!response.ok) {
    throw new StripeApiRequestError(
      response.status,
      body,
      method,
      path,
      pickDebugHeaders(response.headers)
    )
  }
}

/**
 * Build a callable list function that hits the Stripe HTTP API directly.
 * Supports both v1 (has_more pagination) and v2 (next_page_url pagination).
 */
export function buildListFn(
  apiKey: string,
  apiPath: string,
  fetch: typeof globalThis.fetch,
  apiVersion: string,
  baseUrl?: string,
  extraQueryParams?: Record<string, string>
): ListFn {
  const base = baseUrl ?? DEFAULT_STRIPE_API_BASE

  if (isV2Path(apiPath)) {
    return async (params) => {
      const qs = new URLSearchParams()
      qs.set('limit', String(Math.min(params.limit ?? 20, 20)))
      if (params.starting_after) qs.set('page', params.starting_after)
      if (params.created) {
        for (const [op, val] of Object.entries(params.created)) {
          if (val != null) qs.set(`created[${op}]`, toV2CreatedParam(val))
        }
      }
      if (extraQueryParams) {
        for (const [k, v] of Object.entries(extraQueryParams)) qs.set(k, v)
      }

      const headers = authHeaders(apiKey)
      headers['Stripe-Version'] = apiVersion

      const response = await fetch(`${base}${apiPath}?${qs}`, { headers })
      const parsed = (await readJson(response)) as {
        data: unknown[]
        next_page_url?: string | null
      }
      assertOk(response, parsed, 'GET', apiPath)
      const pageCursor = extractPageToken(parsed.next_page_url)
      const responseAt = parseHttpDateHeader(response.headers)
      return {
        data: parsed.data ?? [],
        has_more: !!parsed.next_page_url,
        ...(pageCursor !== undefined ? { pageCursor } : {}),
        responseAt,
      }
    }
  }

  return async (params) => {
    const qs = new URLSearchParams()
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.starting_after) qs.set('starting_after', params.starting_after)
    if (params.ending_before) qs.set('ending_before', params.ending_before)
    if (params.created) {
      for (const [op, val] of Object.entries(params.created)) {
        if (val != null) qs.set(`created[${op}]`, String(val))
      }
    }
    if (extraQueryParams) {
      for (const [k, v] of Object.entries(extraQueryParams)) qs.set(k, v)
    }

    const headers = authHeaders(apiKey)
    headers['Stripe-Version'] = apiVersion

    const response = await fetch(`${base}${apiPath}?${qs}`, { headers })
    const body = (await readJson(response)) as { data: unknown[]; has_more: boolean }
    assertOk(response, body, 'GET', apiPath)
    const responseAt = parseHttpDateHeader(response.headers)
    return {
      data: body.data ?? [],
      has_more: body.has_more,
      responseAt,
    }
  }
}

function toV2CreatedParam(value: number): string {
  return new Date(value * 1000).toISOString()
}

/**
 * Build a callable retrieve function that hits the Stripe HTTP API directly.
 */
export function buildRetrieveFn(
  apiKey: string,
  apiPath: string,
  fetch: typeof globalThis.fetch,
  apiVersion: string,
  baseUrl?: string
): RetrieveFn {
  const base = baseUrl ?? DEFAULT_STRIPE_API_BASE

  if (isV2Path(apiPath)) {
    return async (id) => {
      const headers = authHeaders(apiKey)
      headers['Stripe-Version'] = apiVersion

      const response = await fetch(`${base}${apiPath}/${id}`, { headers })
      const body = await readJson(response)
      assertOk(response, body, 'GET', `${apiPath}/${id}`)
      return body
    }
  }

  return async (id) => {
    const headers = authHeaders(apiKey)
    headers['Stripe-Version'] = apiVersion

    const response = await fetch(`${base}${apiPath}/${id}`, { headers })
    const body = await readJson(response)
    assertOk(response, body, 'GET', `${apiPath}/${id}`)
    return body
  }
}

function extractPageToken(nextPageUrl: string | null | undefined): string | undefined {
  if (!nextPageUrl) return undefined
  try {
    const url = new URL(nextPageUrl, DEFAULT_STRIPE_API_BASE)
    return url.searchParams.get('page') ?? undefined
  } catch {
    return undefined
  }
}
