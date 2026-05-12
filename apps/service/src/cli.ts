import { Readable } from 'node:stream'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { createPrettyFormatter } from './cli/pretty-output.js'
import { serve } from '@hono/node-server'
import { createConnectorResolver, startApiServer, type ApiServerHandle } from '@stripe/sync-engine'
import sourceStripe from '@stripe/sync-source-stripe'
import sourceMetronome from '@stripe/sync-source-metronome'
import sourcePostgres from '@stripe/sync-source-postgres'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationRedis from '@stripe/sync-destination-redis'
import destinationSqlite from '@stripe/sync-destination-sqlite'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import destinationStripe from '@stripe/sync-destination-stripe'
import { createApp } from './api/app.js'
import {
  wrapPipelineConnectorShorthand,
  extractConnectorOverrides,
  mergeConnectorOverrides,
} from './lib/cli-connector-shorthand.js'
import { filePipelineStore } from './lib/stores-fs.js'
import { memoryPipelineStore } from './lib/stores-memory.js'
import type { WorkflowClient } from '@temporalio/client'
import type { StreamConfig } from './lib/createSchemas.js'
import { homedir } from 'node:os'
import { log } from './logger.js'

const defaultDataDir = process.env.DATA_DIR ?? `${homedir()}/.stripe-sync`

const resolverPromise = createConnectorResolver({
  sources: { stripe: sourceStripe, metronome: sourceMetronome, postgres: sourcePostgres },
  destinations: {
    postgres: destinationPostgres,
    redis: destinationRedis,
    sqlite: destinationSqlite,
    google_sheets: destinationGoogleSheets,
    stripe: destinationStripe,
  },
})

async function buildCliSpec() {
  const resolver = await resolverPromise
  const app = createApp({
    resolver,
    pipelineStore: memoryPipelineStore(),
  })
  const response = await app.request('/openapi.json')
  return response.json()
}

function parseStreamsArg(raw: string | undefined): StreamConfig[] | undefined {
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array')
    }
    return parsed.map((item) =>
      typeof item === 'string' ? ({ name: item } satisfies StreamConfig) : (item as StreamConfig)
    )
  } catch {
    return raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }))
  }
}

async function createTemporalClient(
  address: string,
  taskQueue: string
): Promise<{ client: WorkflowClient; taskQueue: string }> {
  const { Client, Connection } = await import('@temporalio/client')
  // Retry connection — Temporal may not accept connections immediately after
  // its health check passes (Docker Compose depends_on race).
  let lastErr: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const connection = await Connection.connect({ address })
      const client = new Client({ connection })
      return { client: client.workflow, taskQueue }
    } catch (err) {
      lastErr = err
      if (attempt < 9) await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw lastErr
}

async function maybeCreateTemporalClient(
  address: string | undefined,
  taskQueue: string
): Promise<{ client: WorkflowClient; taskQueue: string } | undefined> {
  if (!address) return undefined
  return createTemporalClient(address, taskQueue)
}

function checkPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') {
        resolve(false)
        return
      }
      reject(error)
    })
  })
}

async function waitForHealth(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
      lastError = new Error(`health responded ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `Timed out waiting for ${url}/health${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`
  )
}

async function assertMitmReverseProxyReady(timeoutMs: number) {
  const url = 'http://127.0.0.1:9091/flows'
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer sync-engine' },
      })
      if (res.ok) return
      lastError = new Error(`mitmweb responded ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `MITM reverse proxy is not healthy at ${url}${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`
  )
}

let mitmEngineServer: ApiServerHandle | null = null

async function setupEngineMitm(): Promise<string> {
  const engineUrl = 'http://127.0.0.1:3000'
  const proxyUrl = 'http://127.0.0.1:9090'

  await assertMitmReverseProxyReady(2000)

  if (await checkPortOpen(3000)) {
    throw new Error('Port 3000 already has a listener. Stop it before using --engine-mitm.')
  }

  if (!mitmEngineServer) {
    const resolver = await resolverPromise
    mitmEngineServer = await startApiServer({ resolver, port: 3000 })
  }

  await waitForHealth(engineUrl, 15000)
  await waitForHealth(proxyUrl, 10000)
  return proxyUrl
}

function closeMitmEngine() {
  if (mitmEngineServer) {
    mitmEngineServer.close()
    mitmEngineServer = null
  }
}

// Hand-written workflow command: start HTTP server
const serveCmd = defineCommand({
  meta: { name: 'serve', description: 'Start the HTTP API server' },
  args: {
    port: {
      type: 'string',
      default: '4020',
      description: 'HTTP server port',
    },
    'temporal-address': {
      type: 'string',
      description: 'Temporal server address (e.g. localhost:7233). Optional.',
    },
    'temporal-task-queue': {
      type: 'string',
      default: 'sync-engine',
      description: 'Temporal task queue name (default: sync-engine)',
    },
    'data-dir': {
      type: 'string',
      default: defaultDataDir,
      description: `Directory to persist pipeline configs as JSON files (default: ${defaultDataDir}).`,
    },
    'engine-url': {
      type: 'string',
      description:
        'Optional sync engine URL for ad-hoc sync execution. If omitted, runs in-process.',
    },
  },
  async run({ args }) {
    const port = Number(args.port)
    const taskQueue = args['temporal-task-queue'] || 'sync-engine'
    const temporal = await maybeCreateTemporalClient(args['temporal-address'], taskQueue)
    if (temporal) {
      log.info(
        {
          temporalAddress: args['temporal-address'],
          taskQueue,
        },
        'Temporal mode enabled'
      )
    } else {
      log.info('Temporal mode disabled')
    }

    const resolver = await resolverPromise
    const pipelineStore = filePipelineStore(args['data-dir'])
    log.info({ dataDir: args['data-dir'] }, 'Pipeline store enabled')

    const engineUrl = args['engine-url'] || undefined
    const app = createApp({ temporal, resolver, pipelineStore, engineUrl })

    serve({ fetch: app.fetch, port }, () => {
      log.info({ port }, `Sync Service listening on http://localhost:${port}`)
      log.info({ url: `http://localhost:${port}/docs` }, 'API docs available')
    })
  },
})

// Temporal worker command
const workerCmd = defineCommand({
  meta: { name: 'worker', description: 'Start a Temporal worker for sync workflows' },
  args: {
    'temporal-address': {
      type: 'string',
      description: 'Temporal server address (e.g. localhost:7233). Optional.',
    },
    'temporal-namespace': {
      type: 'string',
      default: 'default',
      description: 'Temporal namespace (default: default)',
    },
    'temporal-task-queue': {
      type: 'string',
      default: 'sync-engine',
      description: 'Temporal task queue name (default: sync-engine)',
    },
    'engine-url': {
      type: 'string',
      default: 'http://localhost:4010',
      description: 'Sync engine URL for sync execution (default: http://localhost:4010)',
    },
    'data-dir': {
      type: 'string',
      default: defaultDataDir,
      description: `Directory to persist pipeline configs as JSON files (default: ${defaultDataDir}).`,
    },
  },
  async run({ args }) {
    const { createWorker } = await import('./temporal/worker.js')
    const taskQueue = args['temporal-task-queue'] || 'sync-engine'
    const namespace = args['temporal-namespace'] || 'default'
    const engineUrl = args['engine-url'] || 'http://localhost:4010'
    const temporalAddress = args['temporal-address']
    const pipelineStore = filePipelineStore(args['data-dir'])

    // import.meta.url is the URL of cli.ts/cli.js, NOT the bin entry point:
    //   tsx:      file:///.../apps/service/src/cli.ts  → ./temporal/workflows/index.ts
    //   compiled: file:///.../apps/service/dist/cli.js → ./temporal/workflows/index.js
    const { fileURLToPath } = await import('node:url')
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
    const workflowsPath = fileURLToPath(
      new URL(`./temporal/workflows/index${ext}`, import.meta.url)
    )

    const worker = await createWorker({
      temporalAddress,
      namespace,
      taskQueue,
      engineUrl,
      pipelineStore,
      workflowsPath,
    })

    log.info({ temporalAddress, namespace, taskQueue, engineUrl }, 'Starting Temporal worker')

    await worker.run()
  },
})

// Standalone webhook ingress command (Temporal mode only)
const webhookCmd = defineCommand({
  meta: { name: 'webhook', description: 'Start the webhook ingress server' },
  args: {
    port: {
      type: 'string',
      default: '4030',
      description: 'HTTP server port (default: 4030)',
    },
    'temporal-address': {
      type: 'string',
      required: true,
      description: 'Temporal server address (e.g. localhost:7233)',
    },
    'temporal-task-queue': {
      type: 'string',
      default: 'sync-engine',
      description: 'Temporal task queue name (default: sync-engine)',
    },
    'data-dir': {
      type: 'string',
      default: defaultDataDir,
      description: `Directory to persist pipeline configs as JSON files (default: ${defaultDataDir}).`,
    },
  },
  async run({ args }) {
    const port = Number(args.port)
    const taskQueue = args['temporal-task-queue'] || 'sync-engine'
    const temporal = await maybeCreateTemporalClient(args['temporal-address'], taskQueue)
    const resolver = await resolverPromise
    const pipelineStore = filePipelineStore(args['data-dir'])
    const app = createApp({ temporal, resolver, pipelineStore })

    serve({ fetch: app.fetch, port }, () => {
      log.info(
        { port, temporalAddress: args['temporal-address'], taskQueue },
        `Webhook server listening on http://localhost:${port}`
      )
    })
  },
})

export async function createProgram() {
  const spec = await buildCliSpec()
  const resolver = await resolverPromise

  const serviceUrl = process.env.SERVICE_URL

  // Lazy real app — boots in-process when no SERVICE_URL is provided
  // --engine-url is a global option parsed early so all subcommands respect it
  let engineUrl: string | undefined =
    (() => {
      const idx = process.argv.indexOf('--engine-url')
      return idx !== -1 ? process.argv[idx + 1] : undefined
    })() || process.env.ENGINE_URL
  const engineMitm = process.argv.includes('--engine-mitm')
  let realApp: ReturnType<typeof createApp> | null = null
  async function getApp() {
    if (!realApp) {
      if (engineMitm) {
        if (serviceUrl) {
          throw new Error('--engine-mitm is only supported when running the service CLI in-process')
        }
        if (!engineUrl) {
          engineUrl = await setupEngineMitm()
        }
      }
      const address = process.env.TEMPORAL_ADDRESS
      const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'sync-engine'
      const temporal = await maybeCreateTemporalClient(address, taskQueue)
      const dataDir = process.env.DATA_DIR || defaultDataDir
      const pipelineStore = filePipelineStore(dataDir)
      realApp = createApp({ temporal, resolver, pipelineStore, engineUrl })
    }
    return realApp
  }

  const handler = serviceUrl
    ? async (req: Request) => {
        // Forward to a running service server
        const url = new URL(req.url)
        const target = new URL(url.pathname + url.search, serviceUrl)
        return fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          duplex: 'half',
        } as RequestInit)
      }
    : async (req: Request) => {
        const app = await getApp()
        return app.fetch(req)
      }

  // Use pretty formatting by default in TTY, raw JSON with --json or when piped
  const useJson = process.argv.includes('--json') || !process.stdout.isTTY
  const responseFormatter = useJson ? undefined : createPrettyFormatter()

  const specCli = createCliFromSpec({
    spec,
    handler,
    groupByTag: true,
    exclude: ['health'],
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    responseFormatter,
    rootArgs: {
      json: {
        type: 'boolean',
        default: false,
        description: 'Output raw JSON instead of pretty-printed format',
      },
      'engine-url': {
        type: 'string',
        description: 'Sync engine URL (overrides ENGINE_URL env var)',
      },
      'engine-mitm': {
        type: 'boolean',
        default: false,
        description:
          'Start a local engine on :3000 and route requests through mitm reverse proxy on :9090',
      },
    },
    meta: {
      name: 'sync-service',
      description: 'Stripe Sync Service — pipeline management and webhook ingress',
      version: '0.1.0',
    },
  })

  const subCommands = specCli.subCommands as Record<string, CommandDef> | undefined
  const pipelineGroup = subCommands?.['pipelines'] as CommandDef | undefined
  if (pipelineGroup?.subCommands) {
    const pipelineSubCommands = pipelineGroup.subCommands as Record<string, CommandDef>
    const sourceNames = [...resolver.sources()].map(([name]) => name)
    const destinationNames = [...resolver.destinations()].map(([name]) => name)
    for (const commandName of ['create', 'update']) {
      const command = pipelineSubCommands[commandName]
      if (command) {
        pipelineSubCommands[commandName] = wrapPipelineConnectorShorthand(command, {
          sources: sourceNames,
          destinations: destinationNames,
        })
      }
    }

    // Fetch a pipeline and merge connector overrides (e.g. --postgres.url) on top,
    // validating against the connector's OAS config schema.
    async function fetchAndMergeOverrides(
      pipelineId: string,
      overrides: { source?: Record<string, unknown>; destination?: Record<string, unknown> }
    ) {
      const res = await handler(new Request(`http://localhost/pipelines/${pipelineId}`))
      if (!res.ok) {
        const text = await res.text()
        process.stderr.write(`Error ${res.status}: ${text}\n`)
        process.exit(1)
      }
      const pipeline = await res.json()
      if (overrides.source || overrides.destination) {
        const configSchemas: {
          source?: import('zod').ZodType
          destination?: import('zod').ZodType
        } = {}
        if (overrides.source) {
          const name = (overrides.source.type ?? pipeline.source?.type) as string
          configSchemas.source = resolver.sources().get(name)?.configSchema
        }
        if (overrides.destination) {
          const name = (overrides.destination.type ?? pipeline.destination?.type) as string
          configSchemas.destination = resolver.destinations().get(name)?.configSchema
        }
        try {
          mergeConnectorOverrides(pipeline, overrides, configSchemas)
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
          process.exit(1)
        }
      }
      return pipeline
    }

    const getCommand = pipelineSubCommands['get']
    if (getCommand) {
      // Replace `get` to accept connector shorthand flags (e.g. --postgres.url)
      // and merge overrides into the displayed pipeline config
      pipelineSubCommands['get'] = defineCommand({
        meta: { name: 'get', description: 'Retrieve pipeline' },
        args: {
          id: { type: 'positional', required: true, description: 'Pipeline ID' },
          'reset-state': {
            type: 'boolean',
            default: false,
            description: 'Show pipeline as if sync state were cleared',
          },
        },
        async run({ args }) {
          const overrides = extractConnectorOverrides(args as Record<string, unknown>, {
            sources: sourceNames,
            destinations: destinationNames,
          })
          const pipeline = await fetchAndMergeOverrides(args.id as string, overrides)
          if (args['reset-state']) {
            delete pipeline.sync_state
          }
          if (responseFormatter) {
            await responseFormatter(
              new Response(JSON.stringify(pipeline), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
              {
                operationId: 'pipelines.get',
                method: 'get',
                path: '/pipelines/{id}',
                tags: ['Pipelines'],
                summary: 'Retrieve pipeline',
                pathParams: [],
                queryParams: [],
                headerParams: [],
                bodySchema: undefined,
                bodyRequired: false,
                ndjsonRequest: false,
                ndjsonResponse: false,
                noContent: false,
              }
            )
          } else {
            process.stdout.write(JSON.stringify(pipeline, null, 2) + '\n')
          }
        },
      }) as CommandDef

      /** Stream NDJSON from a pipeline endpoint, print status/log lines, exit on failure. */
      async function streamPipelineAction(
        pipelineId: string,
        action: string,
        only?: string
      ): Promise<never> {
        const qs = only ? `?only=${only}` : ''
        const res = await handler(
          new Request(`http://localhost/pipelines/${pipelineId}/${action}${qs}`, { method: 'POST' })
        )
        if (!res.ok) {
          const text = await res.text()
          process.stderr.write(`Error ${res.status}: ${text}\n`)
          process.exit(1)
        }
        if (!res.body) {
          process.stderr.write('No response body\n')
          process.exit(1)
        }

        let failed = false
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const msg = JSON.parse(line)
            if (msg.type === 'connection_status') {
              const s = msg.connection_status
              const tag = msg._emitted_by ?? ''
              if (s.status === 'succeeded') {
                process.stderr.write(`✓ ${tag}: connected\n`)
              } else {
                process.stderr.write(`✗ ${tag}: ${s.message ?? 'failed'}\n`)
                failed = true
              }
            } else if (msg.type === 'log') {
              process.stderr.write(`[${msg.log?.level ?? 'info'}] ${msg.log?.message ?? ''}\n`)
            }
            process.stdout.write(line + '\n')
          }
        }
        process.exit(failed ? 1 : 0)
      }

      const onlyArg = {
        only: {
          type: 'string' as const,
          description: 'Run only source or destination side (source|destination)',
        },
      }

      pipelineSubCommands['check'] = defineCommand({
        meta: { name: 'check', description: 'Check pipeline connectivity' },
        args: {
          id: { type: 'positional', required: true, description: 'Pipeline ID' },
          ...onlyArg,
        },
        async run({ args }) {
          await streamPipelineAction(args.id as string, 'check', args.only)
        },
      }) as CommandDef

      pipelineSubCommands['setup'] = defineCommand({
        meta: { name: 'setup', description: 'Run pipeline setup hooks (e.g. create tables)' },
        args: {
          id: { type: 'positional', required: true, description: 'Pipeline ID' },
          ...onlyArg,
        },
        async run({ args }) {
          await streamPipelineAction(args.id as string, 'setup', args.only)
        },
      }) as CommandDef

      pipelineSubCommands['teardown'] = defineCommand({
        meta: { name: 'teardown', description: 'Run pipeline teardown hooks (e.g. drop tables)' },
        args: {
          id: { type: 'positional', required: true, description: 'Pipeline ID' },
          ...onlyArg,
        },
        async run({ args }) {
          await streamPipelineAction(args.id as string, 'teardown', args.only)
        },
      }) as CommandDef
    }

    // Override the auto-generated sync command with an Ink-based progress display
    pipelineSubCommands['sync'] = defineCommand({
      meta: { name: 'sync', description: 'Run sync for a pipeline' },
      args: {
        id: { type: 'positional', required: true, description: 'Pipeline ID' },
        'chunk-time-limit': {
          type: 'string',
          description: 'Run sync in N-second chunks until complete',
        },
        'run-id': {
          type: 'string',
          description: 'Sync run identifier (resumes or starts fresh)',
        },
        streams: {
          type: 'string',
          description: 'Stream override as comma-separated names or JSON array',
        },
        'reset-state': {
          type: 'boolean',
          default: false,
          description: 'Ignore persisted sync state and start fresh',
        },
        plain: {
          type: 'boolean',
          default: false,
          description: 'Plain text output (no Ink/ANSI)',
        },
        raw: {
          type: 'boolean',
          default: false,
          description: 'Output raw NDJSON to stdout',
        },
      },
      async run({ args }) {
        const overrides = extractConnectorOverrides(args as Record<string, unknown>, {
          sources: sourceNames,
          destinations: destinationNames,
        })
        // When overrides are present, fetch the pipeline, merge + validate against
        // the connector's OAS schema, then pass full merged configs to sync.
        let connectorOverrides = overrides
        if (overrides.source || overrides.destination) {
          const pipeline = await fetchAndMergeOverrides(args.id as string, overrides)
          connectorOverrides = {
            source: overrides.source ? pipeline.source : undefined,
            destination: overrides.destination ? pipeline.destination : undefined,
          }
        }

        if (args.raw) {
          const params = new URLSearchParams()
          if (args['chunk-time-limit']) params.set('time_limit', args['chunk-time-limit'])
          if (args['run-id']) params.set('run_id', args['run-id'])
          if (args['reset-state']) params.set('reset_state', 'true')
          const qs = params.toString() ? `?${params}` : ''

          const body = {
            ...(parseStreamsArg(args.streams) ? { streams: parseStreamsArg(args.streams) } : {}),
            ...(connectorOverrides?.source ? { source: connectorOverrides.source } : {}),
            ...(connectorOverrides?.destination
              ? { destination: connectorOverrides.destination }
              : {}),
          }

          const res = await handler(
            new Request(`http://localhost/pipelines/${args.id}/sync${qs}`, {
              method: 'POST',
              ...(Object.keys(body).length > 0
                ? {
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                  }
                : {}),
            })
          )

          if (!res.ok) {
            process.stderr.write(`Error ${res.status}: ${await res.text()}\n`)
            process.exit(1)
          }

          const reader = res.body!.getReader()
          const decoder = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            process.stdout.write(decoder.decode(value, { stream: true }))
          }
          return
        }

        const { renderPipelineSync } = await import('./cli/pipeline-sync.js')
        await renderPipelineSync({
          handler,
          pipelineId: args.id as string,
          timeLimit: args['chunk-time-limit'] ? parseInt(args['chunk-time-limit']) : undefined,
          syncRunId: args['run-id'],
          streams: parseStreamsArg(args.streams),
          resetState: args['reset-state'] === true,
          plain: args.plain || !process.stderr.isTTY,
          connectorOverrides,
        })
      },
    }) as CommandDef

    pipelineSubCommands['sync_batch'] = defineCommand({
      meta: { name: 'sync_batch', description: 'Run sync for a pipeline (batch, returns JSON)' },
      args: {
        id: { type: 'positional', required: true, description: 'Pipeline ID' },
        'time-limit': {
          type: 'string',
          description: 'Stop after N seconds per request',
        },
        'state-limit': {
          type: 'string',
          description: 'Stop after N source_state messages per request',
        },
        'run-id': {
          type: 'string',
          description: 'Sync run identifier (resumes or starts fresh)',
        },
        streams: {
          type: 'string',
          description: 'Stream override as comma-separated names or JSON array',
        },
        'reset-state': {
          type: 'boolean',
          default: false,
          description: 'Ignore persisted sync state and start fresh',
        },
        loop: {
          type: 'string',
          default: '1',
          description: 'Number of iterations (0 = loop until has_more is false)',
        },
        raw: {
          type: 'boolean',
          default: false,
          description: 'Output raw JSON to stdout (no progress rendering)',
        },
      },
      async run({ args }) {
        const overrides = extractConnectorOverrides(args as Record<string, unknown>, {
          sources: sourceNames,
          destinations: destinationNames,
        })
        let connectorOverrides = overrides
        if (overrides.source || overrides.destination) {
          const pipeline = await fetchAndMergeOverrides(args.id as string, overrides)
          connectorOverrides = {
            source: overrides.source ? pipeline.source : undefined,
            destination: overrides.destination ? pipeline.destination : undefined,
          }
        }

        const bodyBase = {
          ...(parseStreamsArg(args.streams) ? { streams: parseStreamsArg(args.streams) } : {}),
          ...(connectorOverrides?.source ? { source: connectorOverrides.source } : {}),
          ...(connectorOverrides?.destination
            ? { destination: connectorOverrides.destination }
            : {}),
        }

        const raw = args.raw === true
        const maxIterations = parseInt(args.loop ?? '1')
        const { formatProgress } = await import('@stripe/sync-logger/progress')
        let prevProgress: import('@stripe/sync-protocol').ProgressPayload | undefined
        let isFirstIteration = true
        let iteration = 0

        while (true) {
          iteration++
          const params = new URLSearchParams()
          if (args['time-limit']) params.set('time_limit', args['time-limit'])
          if (args['state-limit']) params.set('state_limit', args['state-limit'])
          if (args['run-id']) params.set('run_id', args['run-id'])
          if (args['reset-state'] && isFirstIteration) params.set('reset_state', 'true')
          const qs = params.toString() ? `?${params}` : ''

          const res = await handler(
            new Request(`http://localhost/pipelines/${args.id}/sync_batch${qs}`, {
              method: 'POST',
              ...(Object.keys(bodyBase).length > 0
                ? {
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(bodyBase),
                  }
                : {}),
            })
          )

          if (!res.ok) {
            const text = await res.text()
            try {
              const json = JSON.parse(text)
              process.stderr.write(`Error ${res.status}: ${JSON.stringify(json, null, 2)}\n`)
            } catch {
              process.stderr.write(`Error ${res.status}: ${text}\n`)
            }
            process.exit(1)
          }

          const eof = (await res.json()) as import('@stripe/sync-protocol').EofPayload

          if (raw) {
            process.stdout.write(JSON.stringify(eof) + '\n')
          } else {
            if (maxIterations !== 1) process.stderr.write(`--- iteration ${iteration} ---\n`)
            process.stderr.write(formatProgress(eof.run_progress, prevProgress) + '\n')
            prevProgress = eof.run_progress
          }

          const reachedLimit = maxIterations > 0 && iteration >= maxIterations
          if (reachedLimit || !eof.has_more) {
            if (!raw) process.stderr.write(`Final status: ${eof.status}\n`)
            break
          }

          isFirstIteration = false
        }
      },
    }) as CommandDef

    pipelineSubCommands['simulate-webhook-sync'] = defineCommand({
      meta: {
        name: 'simulate-webhook-sync',
        description: 'Simulate webhook sync by fetching events from the Stripe API',
      },
      args: {
        id: { type: 'positional', required: true, description: 'Pipeline ID' },
        'created-after': {
          type: 'string',
          description:
            'Only events created after this (Unix timestamp or ISO date, default: 24h ago)',
        },
        limit: {
          type: 'string',
          description: 'Max events to fetch',
        },
        plain: {
          type: 'boolean',
          default: false,
          description: 'Plain text output (no Ink/ANSI)',
        },
      },
      async run({ args }) {
        const pipelineId = args.id as string
        const params = new URLSearchParams()
        if (args['created-after']) {
          const raw = args['created-after']
          // Accept Unix timestamp or ISO date
          const ts = /^\d+$/.test(raw) ? raw : String(Math.floor(new Date(raw).getTime() / 1000))
          params.set('created_after', ts)
        }
        if (args.limit) params.set('limit', args.limit)
        const qs = params.toString() ? `?${params}` : ''

        const res = await handler(
          new Request(`http://localhost/pipelines/${pipelineId}/simulate_webhook_sync${qs}`, {
            method: 'POST',
          })
        )

        if (!res.ok) {
          const text = await res.text()
          process.stderr.write(`Error ${res.status}: ${text}\n`)
          process.exit(1)
        }
        if (!res.body) {
          process.stderr.write('No response body\n')
          process.exit(1)
        }

        const { Message } = await import('@stripe/sync-protocol')
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.trim()) continue
            const msg = Message.parse(JSON.parse(line))

            if (msg.type === 'log' && msg.log.message) {
              process.stderr.write(`${msg.log.message}\n`)
            } else if (msg.type === 'eof') {
              const streams = msg.eof.run_progress?.streams ?? {}
              const totalRecords = Object.values(streams).reduce(
                (sum: number, s: { record_count?: number }) => sum + (s.record_count ?? 0),
                0
              )
              process.stderr.write(
                `Done: ${totalRecords} records synced, has_more=${msg.eof.has_more}\n`
              )
            }
          }
        }
        closeMitmEngine()
      },
    }) as CommandDef
  }

  return defineCommand({
    ...specCli,
    subCommands: {
      serve: serveCmd,
      worker: workerCmd,
      webhook: webhookCmd,
      ...specCli.subCommands,
    },
  })
}
