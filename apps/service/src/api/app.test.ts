import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import type { WorkflowClient } from '@temporalio/client'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { z } from 'zod'
import {
  createConnectorResolver,
  sourceTest,
  destinationTest,
  type ConnectorResolver,
} from '@stripe/sync-engine'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import type { SyncActivities } from '../temporal/activities/index.js'
import { createApp } from './app.js'
import { memoryPipelineStore } from '../lib/stores-memory.js'
import type { PipelineStore } from '../lib/stores.js'
import type { CheckOutput, Destination, Source } from '@stripe/sync-protocol'

let resolver: ConnectorResolver

beforeAll(async () => {
  resolver = await createConnectorResolver({
    sources: { test: sourceTest },
    destinations: { test: destinationTest, google_sheets: destinationGoogleSheets },
  })
})

// Lightweight app for spec/health tests (no Temporal needed)
function app() {
  return createApp({
    resolver,
    pipelineStore: memoryPipelineStore(),
  })
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const res = await app().request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes pipeline and webhook paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/pipelines')
    expect(paths).toContain('/pipelines/{id}')
    expect(paths).toContain('/webhooks/{pipeline_id}')
  })
})

describe('GET /docs', () => {
  it('returns HTML (Scalar API reference)', async () => {
    const res = await app().request('/docs')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/html')
  })
})

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, hostname: expect.any(String) })
  })
})

// ---------------------------------------------------------------------------
// Pipeline CRUD + pause/resume (in-memory Temporal, stub activities)
// ---------------------------------------------------------------------------

const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows')
const successEof = {
  has_more: false,
  ending_state: {
    source: { streams: {}, global: {} },
    destination: { streams: {}, global: {} },
    engine: { streams: {}, global: {} },
  },
  run_progress: {
    started_at: new Date().toISOString(),
    elapsed_ms: 100,
    global_state_count: 1,
    derived: {
      status: 'succeeded' as const,
      records_per_second: 10,
      states_per_second: 1,
      total_record_count: 0,
      total_state_count: 0,
    },
    streams: {},
  },
  request_progress: {
    started_at: new Date().toISOString(),
    elapsed_ms: 100,
    global_state_count: 1,
    derived: {
      status: 'succeeded' as const,
      records_per_second: 10,
      states_per_second: 1,
      total_record_count: 0,
      total_state_count: 0,
    },
    streams: {},
  },
}

function stubActivities(): SyncActivities {
  return {
    discoverCatalog: async () => ({ streams: [] }),
    pipelineSetup: async () => ({}),
    pipelineSync: async () => ({ eof: successEof }),
    pipelineTeardown: async () => {},
    updatePipelineStatus: async () => {},
  }
}

let testEnv: TestWorkflowEnvironment
let worker: Worker
let workerRunning: Promise<void>
let sharedStore: PipelineStore

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal()
  sharedStore = memoryPipelineStore()
  worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: 'test-api',
    workflowsPath,
    activities: stubActivities(),
  })
  workerRunning = worker.run()
}, 120_000)

afterAll(async () => {
  worker?.shutdown()
  await workerRunning
  await testEnv?.teardown()
})

function liveApp() {
  return createApp({
    temporal: { client: testEnv.client.workflow, taskQueue: 'test-api' },
    resolver,
    pipelineStore: sharedStore,
  })
}

function createStripeCheckSource(checkImpl: Source['check']): Source<Record<string, unknown>> {
  return {
    async *spec() {
      yield {
        type: 'spec',
        spec: {
          config: z.toJSONSchema(
            z.object({
              api_key: z.string(),
              api_version: z.string(),
            })
          ),
        },
      }
    },
    check: checkImpl,
    async *discover() {
      yield { type: 'catalog', catalog: { streams: [] } }
    },
    async *read() {},
  }
}

function createPostgresCheckDestination(
  checkImpl: Destination['check']
): Destination<Record<string, unknown>> {
  return {
    async *spec() {
      yield {
        type: 'spec',
        spec: {
          config: z.toJSONSchema(
            z.object({
              url: z.string(),
              schema: z.string().default('public'),
            })
          ),
        },
      }
    },
    check: checkImpl,
    async *write() {},
  }
}

function mockTemporalClient() {
  return {
    start: vi.fn(async () => undefined),
    getHandle: vi.fn(() => ({
      signal: vi.fn(async () => undefined),
      query: vi.fn(async () => ({})),
      terminate: vi.fn(async () => undefined),
    })),
    list: vi.fn(async function* () {}),
  } as unknown as WorkflowClient & { start: ReturnType<typeof vi.fn> }
}

/** Poll GET /pipelines/:id until the workflow is queryable (not 404). */
async function waitForPipeline(a: ReturnType<typeof liveApp>, id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await a.request(`/pipelines/${id}`)
    if (res.status === 200) {
      const body = await res.json()
      if (body.status) return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Pipeline ${id} not queryable after ${timeoutMs}ms`)
}

describe('pipeline CRUD', () => {
  it('create succeeds without temporal configured', async () => {
    const pipelineStore = memoryPipelineStore()
    const temporalFreeApp = createApp({
      resolver,
      pipelineStore,
    })

    const res = await temporalFreeApp.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
      }),
    })

    expect(res.status).toBe(201)
    const pipeline = await res.json()
    expect(pipeline.id).toMatch(/^pipe_/)
    expect(await pipelineStore.list()).toHaveLength(1)
  })

  it('create accepts a caller-provided pipeline id', async () => {
    const pipelineStore = memoryPipelineStore()
    const temporalFreeApp = createApp({
      resolver,
      pipelineStore,
    })

    const res = await temporalFreeApp.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'friendly-sync-1',
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
      }),
    })

    expect(res.status).toBe(201)
    const pipeline = await res.json()
    expect(pipeline.id).toBe('friendly-sync-1')
    expect((await pipelineStore.get('friendly-sync-1')).id).toBe('friendly-sync-1')
  })

  it('create rejects duplicate caller-provided pipeline ids', async () => {
    const pipelineStore = memoryPipelineStore()
    const temporalFreeApp = createApp({
      resolver,
      pipelineStore,
    })

    const body = JSON.stringify({
      id: 'friendly-sync-1',
      source: { type: 'test', test: {} },
      destination: { type: 'test', test: {} },
    })

    const first = await temporalFreeApp.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(first.status).toBe(201)

    const second = await temporalFreeApp.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({
      error: 'Pipeline friendly-sync-1 already exists',
    })
  })

  it('create validates caller-provided pipeline id format', async () => {
    const temporalFreeApp = createApp({
      resolver,
      pipelineStore: memoryPipelineStore(),
    })

    const res = await temporalFreeApp.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'Not Friendly',
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
      }),
    })

    expect(res.status).toBe(400)
    const payload = await res.json()
    expect(payload.error).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['id'],
        }),
      ])
    )
  })

  it('runs stripe and postgres checks before creating a pipeline', async () => {
    const stripeCheck = vi.fn(() =>
      (async function* (): AsyncIterable<CheckOutput> {
        yield {
          type: 'connection_status',
          connection_status: { status: 'succeeded' as const },
        }
      })()
    )
    const postgresCheck = vi.fn(() =>
      (async function* (): AsyncIterable<CheckOutput> {
        yield {
          type: 'connection_status',
          connection_status: { status: 'succeeded' as const },
        }
      })()
    )
    const checkedResolver = await createConnectorResolver({
      sources: { stripe: createStripeCheckSource(stripeCheck) },
      destinations: { postgres: createPostgresCheckDestination(postgresCheck) },
    })
    const pipelineStore = memoryPipelineStore()
    const temporalClient = mockTemporalClient()
    const checkedApp = createApp({
      temporal: { client: temporalClient, taskQueue: 'test-checks' },
      resolver: checkedResolver,
      pipelineStore,
    })

    const res = await checkedApp.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          type: 'stripe',
          stripe: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
        },
        destination: {
          type: 'postgres',
          postgres: { url: 'postgres://localhost/db' },
        },
      }),
    })

    expect(res.status).toBe(201)
    expect(stripeCheck).toHaveBeenCalledWith({
      config: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
    })
    expect(postgresCheck).toHaveBeenCalledWith({
      config: { url: 'postgres://localhost/db', schema: 'public' },
    })
    expect(temporalClient.start).toHaveBeenCalledOnce()
    expect(await pipelineStore.list()).toHaveLength(1)
  })

  it('returns 400 and does not create a pipeline when stripe check fails', async () => {
    const stripeCheck = vi.fn(() =>
      (async function* (): AsyncIterable<CheckOutput> {
        yield {
          type: 'connection_status',
          connection_status: { status: 'failed' as const, message: 'invalid api key' },
        }
      })()
    )
    const postgresCheck = vi.fn(() =>
      (async function* (): AsyncIterable<CheckOutput> {
        yield {
          type: 'connection_status',
          connection_status: { status: 'succeeded' as const },
        }
      })()
    )
    const checkedResolver = await createConnectorResolver({
      sources: { stripe: createStripeCheckSource(stripeCheck) },
      destinations: { postgres: createPostgresCheckDestination(postgresCheck) },
    })
    const pipelineStore = memoryPipelineStore()
    const temporalClient = mockTemporalClient()
    const checkedApp = createApp({
      temporal: { client: temporalClient, taskQueue: 'test-checks' },
      resolver: checkedResolver,
      pipelineStore,
    })

    const res = await checkedApp.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          type: 'stripe',
          stripe: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
        },
        destination: {
          type: 'postgres',
          postgres: { url: 'postgres://localhost/db' },
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Source check failed (stripe): invalid api key',
    })
    expect(temporalClient.start).not.toHaveBeenCalled()
    expect(await pipelineStore.list()).toEqual([])
  })

  it('create returns full pipeline', async () => {
    const res = await liveApp().request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
        streams: [{ name: 'customer' }],
      }),
    })
    expect(res.status).toBe(201)
    const pipeline = await res.json()
    expect(pipeline.id).toMatch(/^pipe_/)
    expect(pipeline.source.type).toBe('test')
    expect(pipeline.destination.type).toBe('test')
  })

  it('sync applies stream overrides and persists sync_state', async () => {
    const pipelineStore = memoryPipelineStore()
    const initialSyncState = {
      source: { streams: { customer: { cursor: 'cus_initial' } }, global: {} },
      destination: {},
      sync_run: { progress: successEof.run_progress },
    }
    await pipelineStore.set('pipe_sync', {
      id: 'pipe_sync',
      source: { type: 'test', test: {} },
      destination: { type: 'test', test: {} },
      streams: [{ name: 'original' }],
      desired_status: 'active',
      status: 'ready',
      sync_state: initialSyncState,
    } as Pipeline)

    let seenPipeline: Record<string, unknown> | undefined
    let seenState: Record<string, unknown> | undefined
    let seenBody: Record<string, unknown> | undefined

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'POST' || url.pathname !== '/pipeline_sync') {
        res.writeHead(404)
        res.end('not found')
        return
      }

      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      seenBody = JSON.parse(Buffer.concat(chunks).toString())
      seenPipeline = seenBody!.pipeline as Record<string, unknown>
      seenState = seenBody!.state as Record<string, unknown> | undefined

      const runProgress = {
        ...successEof.run_progress,
        global_state_count: 2,
      }
      const endingState = {
        source: { streams: { customer: { cursor: 'cus_final' } }, global: {} },
        destination: {},
        sync_run: { run_id: 'run_demo', progress: runProgress },
      }

      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(
        [
          JSON.stringify({ type: 'progress', progress: runProgress }),
          JSON.stringify({
            type: 'eof',
            eof: {
              has_more: false,
              ending_state: endingState,
              run_progress: runProgress,
              request_progress: runProgress,
            },
          }),
        ].join('\n') + '\n'
      )
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const engineUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const syncApp = createApp({
      resolver,
      pipelineStore,
      engineUrl,
    })

    const res = await syncApp.request('/pipelines/pipe_sync/sync?run_id=run_demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streams: [{ name: 'customer' }] }),
    })
    expect(res.status).toBe(200)
    await res.text()

    expect(seenPipeline).toMatchObject({
      source: { type: 'test', test: {} },
      destination: { type: 'test', test: {} },
      streams: [{ name: 'customer' }],
    })
    expect(seenState).toEqual(initialSyncState)
    expect(seenBody?.run_id).toBe('run_demo')

    const updated = await pipelineStore.get('pipe_sync')
    expect(updated.sync_state).toEqual({
      source: { streams: { customer: { cursor: 'cus_final' } }, global: {} },
      destination: {},
      sync_run: {
        run_id: 'run_demo',
        progress: { ...successEof.run_progress, global_state_count: 2 },
      },
    })

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  })

  it('sync with reset_state does not read or persist sync_state', async () => {
    const pipelineStore = memoryPipelineStore()
    const initialSyncState = {
      source: { streams: { customer: { cursor: 'cus_initial' } }, global: {} },
      destination: {},
      sync_run: { progress: successEof.run_progress },
    }
    await pipelineStore.set('pipe_sync', {
      id: 'pipe_sync',
      source: { type: 'test', test: {} },
      destination: { type: 'test', test: {} },
      desired_status: 'active',
      status: 'ready',
      sync_state: initialSyncState,
    } as Pipeline)

    let seenState: Record<string, unknown> | undefined

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'POST' || url.pathname !== '/pipeline_sync') {
        res.writeHead(404)
        res.end('not found')
        return
      }

      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const reqBody = JSON.parse(Buffer.concat(chunks).toString())
      seenState = reqBody.state

      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(
        JSON.stringify({
          type: 'eof',
          eof: {
            has_more: false,
            ending_state: {
              source: { streams: { customer: { cursor: 'cus_final' } }, global: {} },
              destination: {},
              sync_run: { progress: successEof.run_progress },
            },
            run_progress: successEof.run_progress,
            request_progress: successEof.run_progress,
          },
        }) + '\n'
      )
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const engineUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const syncApp = createApp({
      resolver,
      pipelineStore,
      engineUrl,
    })

    const res = await syncApp.request('/pipelines/pipe_sync/sync?reset_state=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streams: [{ name: 'customer' }] }),
    })
    expect(res.status).toBe(200)
    await res.text()

    // reset_state means don't read stored state — engine sees no state
    expect(seenState).toBeUndefined()

    // But ending state IS still persisted back
    const updated = await pipelineStore.get('pipe_sync')
    expect(updated.sync_state).toEqual({
      source: { streams: { customer: { cursor: 'cus_final' } }, global: {} },
      destination: {},
      sync_run: { progress: successEof.run_progress },
    })

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  })

  it('sync runs in-process when engineUrl is not configured', async () => {
    const pipelineStore = memoryPipelineStore()
    await pipelineStore.set('pipe_sync', {
      id: 'pipe_sync',
      source: { type: 'test', test: {} },
      destination: { type: 'test', test: {} },
      desired_status: 'active',
      status: 'ready',
    } as Pipeline)

    const syncApp = createApp({
      resolver,
      pipelineStore,
    })

    const res = await syncApp.request('/pipelines/pipe_sync/sync', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('"type":"eof"')

    const updated = await pipelineStore.get('pipe_sync')
    expect(updated.sync_state).toBeDefined()
  })

  it('sync emits an error log message when the engine request fails', async () => {
    const pipelineStore = memoryPipelineStore()
    await pipelineStore.set('pipe_sync', {
      id: 'pipe_sync',
      source: {
        type: 'stripe',
        stripe: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
      },
      destination: {
        type: 'postgres',
        postgres: { url: 'postgres://localhost/db', schema: 'public' },
      },
      desired_status: 'active',
      status: 'ready',
    } as Pipeline)

    const syncApp = createApp({
      resolver,
      pipelineStore,
      engineUrl: 'http://127.0.0.1:1',
    })

    const res = await syncApp.request('/pipelines/pipe_sync/sync', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('"type":"log"')
    expect(body).toContain('"level":"error"')
  })

  it('update returns updated pipeline with status', async () => {
    const a = liveApp()

    // Create
    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
        streams: [{ name: 'customer' }],
      }),
    })
    const created = await createRes.json()
    await waitForPipeline(a, created.id)

    // Update
    const updateRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streams: [{ name: 'product' }] }),
    })
    expect(updateRes.status).toBe(200)
    const updated = await updateRes.json()
    expect(updated.id).toBe(created.id)
    expect(updated.source.type).toBe('test')
    expect(typeof updated.status).toBe('string')

    // Cleanup
    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })

  it('pause and resume return pipeline with updated status', async () => {
    const a = liveApp()

    // Create
    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
      }),
    })
    const created = await createRes.json()
    await waitForPipeline(a, created.id)

    // Pause
    const pauseRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desired_status: 'paused' }),
    })
    expect(pauseRes.status).toBe(200)
    const paused = await pauseRes.json()
    expect(paused.id).toBe(created.id)
    expect(paused.desired_status).toBe('paused')

    // Resume
    const resumeRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desired_status: 'active' }),
    })
    expect(resumeRes.status).toBe(200)
    const resumed = await resumeRes.json()
    expect(resumed.id).toBe(created.id)
    expect(resumed.desired_status).toBe('active')

    // Cleanup
    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })
})

// ---------------------------------------------------------------------------
// Webhook ingress
// ---------------------------------------------------------------------------

describe('POST /webhooks/{pipeline_id}', () => {
  const webhookSecret = 'whsec_test_secret'

  function signPayload(
    payload: string,
    secret = webhookSecret,
    timestamp = Math.floor(Date.now() / 1000)
  ) {
    const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
    return `t=${timestamp},v1=${signature}`
  }

  function stripeEventPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id: 'evt_test_1',
      object: 'event',
      api_version: '2025-03-31.basil',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'cus_test_1', object: 'customer' } },
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'customer.created',
      ...overrides,
    })
  }

  // Unlike mockTemporalClient() above, keeps a stable `signal` mock across
  // getHandle() calls so assertions can target it directly.
  function mockTemporalClientWithHandle() {
    const signal = vi.fn(async () => undefined)
    const client = {
      start: vi.fn(async () => undefined),
      getHandle: vi.fn(() => ({
        signal,
        query: vi.fn(async () => ({})),
        terminate: vi.fn(async () => undefined),
      })),
      list: vi.fn(async function* () {}),
    } as unknown as WorkflowClient
    return { client, signal }
  }

  async function seedStripePipeline(pipelineStore: PipelineStore, id: string) {
    await pipelineStore.set(id, {
      id,
      source: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test_123',
          api_version: '2025-03-31.basil',
          webhook_secret: webhookSecret,
        },
      },
      destination: { type: 'test', test: {} },
      desired_status: 'active',
      status: 'ready',
    } as Pipeline)
  }

  it('signals the workflow with source_input on a validly signed event', async () => {
    const pipelineStore = memoryPipelineStore()
    await seedStripePipeline(pipelineStore, 'pipe_webhook_1')
    const { client: temporalClient, signal } = mockTemporalClientWithHandle()
    const webhookApp = createApp({
      temporal: { client: temporalClient, taskQueue: 'test-webhooks' },
      resolver,
      pipelineStore,
    })

    const payload = stripeEventPayload()
    const res = await webhookApp.request('/webhooks/pipe_webhook_1', {
      method: 'POST',
      headers: { 'stripe-signature': signPayload(payload) },
      body: payload,
    })

    expect(res.status).toBe(200)
    // This is the regression this test guards against: the route used to signal
    // 'stripe_event', which the workflow has no handler for, so events were
    // silently dropped even though Stripe saw a 200.
    expect(signal).toHaveBeenCalledWith('source_input', {
      type: 'source_input',
      source_input: expect.objectContaining({ id: 'evt_test_1', type: 'customer.created' }),
    })
  })

  it('rejects an incorrectly signed event without signaling the workflow', async () => {
    const pipelineStore = memoryPipelineStore()
    await seedStripePipeline(pipelineStore, 'pipe_webhook_2')
    const { client: temporalClient, signal } = mockTemporalClientWithHandle()
    const webhookApp = createApp({
      temporal: { client: temporalClient, taskQueue: 'test-webhooks' },
      resolver,
      pipelineStore,
    })

    const payload = stripeEventPayload()
    const res = await webhookApp.request('/webhooks/pipe_webhook_2', {
      method: 'POST',
      headers: { 'stripe-signature': signPayload(payload, 'whsec_wrong_secret') },
      body: payload,
    })

    expect(res.status).toBe(401)
    expect(signal).not.toHaveBeenCalled()
  })

  it('returns a non-2xx response when the workflow signal fails, so Stripe retries', async () => {
    const pipelineStore = memoryPipelineStore()
    await seedStripePipeline(pipelineStore, 'pipe_webhook_3')
    const { client: temporalClient, signal } = mockTemporalClientWithHandle()
    signal.mockRejectedValueOnce(new Error('workflow not found'))
    const webhookApp = createApp({
      temporal: { client: temporalClient, taskQueue: 'test-webhooks' },
      resolver,
      pipelineStore,
    })

    const payload = stripeEventPayload()
    const res = await webhookApp.request('/webhooks/pipe_webhook_3', {
      method: 'POST',
      headers: { 'stripe-signature': signPayload(payload) },
      body: payload,
    })

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(signal).toHaveBeenCalledOnce()
  })
})
