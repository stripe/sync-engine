import { log } from './logger.js'

export interface MetronomeClientOptions {
  apiKey: string
  baseUrl?: string
  rateLimitPerSecond?: number
  fetch?: typeof globalThis.fetch
}

export interface MetronomePageResponse<T = Record<string, unknown>> {
  data: T[]
  next_page: string | null
}

const DEFAULT_BASE_URL = 'https://api.metronome.com'
const MAX_RETRIES = 3
const PAGE_SIZE = 100

export class MetronomeClient {
  private apiKey: string
  private baseUrl: string
  private rateLimitPerSecond?: number
  private lastRequestAt = 0
  private fetchFn: typeof globalThis.fetch

  constructor(opts: MetronomeClientOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.rateLimitPerSecond = opts.rateLimitPerSecond
    this.fetchFn = opts.fetch ?? globalThis.fetch
  }

  private async rateLimit(): Promise<void> {
    if (!this.rateLimitPerSecond) return
    const minInterval = 1000 / this.rateLimitPerSecond
    const elapsed = Date.now() - this.lastRequestAt
    if (elapsed < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - elapsed))
    }
    this.lastRequestAt = Date.now()
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    await this.rateLimit()
    const url = `${this.baseUrl}${path}`
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 1000 * 2 ** (attempt - 1)
        log.debug({ attempt, delay, path }, 'metronome: retrying request')
        await new Promise((r) => setTimeout(r, delay))
      }

      const res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after')
        if (retryAfter && attempt < MAX_RETRIES) {
          const delaySec = Number(retryAfter)
          if (Number.isFinite(delaySec)) {
            await new Promise((r) => setTimeout(r, delaySec * 1000))
          }
        }
        lastError = new Error(`Metronome API ${res.status}: ${await res.text()}`)
        continue
      }

      if (!res.ok) {
        throw new Error(`Metronome API ${res.status}: ${await res.text()}`)
      }

      return await res.json()
    }

    throw lastError ?? new Error('Metronome API: max retries exceeded')
  }

  async get<T = unknown>(path: string): Promise<T> {
    return (await this.request('GET', path)) as T
  }

  async post<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    return (await this.request('POST', path, body)) as T
  }

  async *paginate<T = Record<string, unknown>>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    startCursor?: string | null,
    options?: { skipLimit?: boolean }
  ): AsyncGenerator<MetronomePageResponse<T>> {
    let nextPage: string | undefined = startCursor ?? undefined

    while (true) {
      let page: MetronomePageResponse<T>

      if (method === 'GET') {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
        if (nextPage) params.set('next_page', nextPage)
        page = await this.get<MetronomePageResponse<T>>(`${path}?${params.toString()}`)
      } else {
        const reqBody: Record<string, unknown> = {
          ...(body ?? {}),
        }
        if (!options?.skipLimit) reqBody['limit'] = PAGE_SIZE
        if (nextPage) reqBody['next_page'] = nextPage
        page = await this.post<MetronomePageResponse<T>>(path, reqBody)
      }

      yield page

      if (!page.next_page) break
      nextPage = page.next_page
    }
  }
}
