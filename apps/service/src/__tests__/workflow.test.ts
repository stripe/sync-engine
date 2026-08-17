import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import type { SyncActivities } from '../temporal/activities/index.js'
import { CONTINUE_AS_NEW_THRESHOLD } from '../lib/utils.js'

type SourceInput = unknown

// Point directly at the workflow index to avoid resolving the legacy dist/temporal/workflows.js file.
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows/index.js')

const emptyState = {
  source: { streams: {}, global: {} },
  destination: { streams: {}, global: {} },
  engine: { streams: {}, global: {} },
}

const successEof = {
  has_more: false,
  ending_state: emptyState,
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

// Workflows now receive only the pipelineId string
const testPipelineId = 'test_pipe'

function stubActivities(overrides: Partial<SyncActivities> = {}): SyncActivities {
  const activities = {
    discoverCatalog: async () => ({ streams: [] }),
    pipelineSetup: async () => {},
    pipelineSync: async () => ({ eof: successEof }),
    pipelineTeardown: async () => {},
    updatePipelineStatus: async () => {},
    ...overrides,
  }

  return {
    ...activities,
    setup: activities.pipelineSetup,
    sync: activities.pipelineSync,
    teardown: activities.pipelineTeardown,
  } as SyncActivities
}

/** Cancel the workflow to trigger teardown. */
async function cancelWorkflow(handle: { cancel: () => Promise<void> }) {
  await handle.cancel()
}

async function signalSourceInput(
  handle: { signal: (name: string, arg: unknown) => Promise<void> },
  event: unknown
) {
  await handle.signal('source_input', event)
}

let testEnv: TestWorkflowEnvironment

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal()
}, 120_000)

afterAll(async () => {
  await testEnv?.teardown()
})

describe('pipelineWorkflow (unit — stubbed activities)', () => {
  it.skip('runs setup then continuous reconciliation until delete', async () => {
    let setupCalled = false
    let runCallCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-1',
      workflowsPath,
      activities: stubActivities({
        pipelineSetup: async () => {
          setupCalled = true
        },
        pipelineSync: async () => {
          runCallCount++
          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-1',
        taskQueue: 'test-queue-1',
      })

      // Let it sync several reconciliation pages
      await new Promise((r) => setTimeout(r, 2000))

      const status = await handle.query('status')
      expect((status as { iteration: number }).iteration).toBeGreaterThan(0)

      await cancelWorkflow(handle)
      await handle.result()

      expect(setupCalled).toBe(true)
      expect(runCallCount).toBeGreaterThan(1)
    })
  })

  it('processes source_input signals as optimistic updates', async () => {
    const syncCalls: { pipelineId: string; input?: SourceInput[] }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (pipelineId: string, opts?) => {
          syncCalls.push({ pipelineId, input: opts?.input ?? undefined })
          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-2',
        taskQueue: 'test-queue-2',
      })

      // Let reconciliation start
      await new Promise((r) => setTimeout(r, 1500))

      // Send events
      await signalSourceInput(handle, {
        id: 'evt_1',
        type: 'customer.created',
      })
      await signalSourceInput(handle, {
        id: 'evt_2',
        type: 'product.updated',
      })

      await new Promise((r) => setTimeout(r, 2000))
      await cancelWorkflow(handle)
      await handle.result()

      // Find event-bearing sync calls (input is defined)
      const eventCalls = syncCalls.filter((c) => c.input)
      expect(eventCalls.length).toBeGreaterThanOrEqual(1)

      const allEvents = eventCalls.flatMap((c) => c.input!)
      expect(allEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'evt_1' }),
          expect.objectContaining({ id: 'evt_2' }),
        ])
      )

      // All calls should use the test pipeline ID
      for (const call of syncCalls) {
        expect(call.pipelineId).toBe(testPipelineId)
      }
    })
  })

  it('processes queued live events after initial backfill completes', async () => {
    const syncCalls: { phase: 'backfill' | 'live' }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2b',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) {
            syncCalls.push({ phase: 'live' })
          } else {
            syncCalls.push({ phase: 'backfill' })
          }
          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [
          testPipelineId,
          {
            inputQueue: [{ id: 'evt_initial', type: 'customer.created' }],
          },
        ],
        workflowId: 'test-sync-2b',
        taskQueue: 'test-queue-2b',
      })

      await new Promise((r) => setTimeout(r, 2000))
      await cancelWorkflow(handle)
      await handle.result()

      // Backfill runs first (in child workflow), then live events are processed
      expect(syncCalls.length).toBeGreaterThanOrEqual(2)
      const backfillIdx = syncCalls.findIndex((c) => c.phase === 'backfill')
      const liveIdx = syncCalls.findIndex((c) => c.phase === 'live')
      expect(backfillIdx).toBeLessThan(liveIdx)
    })
  })

  it('drains all queued live events after backfill completes', async () => {
    let liveBatchCount = 0
    let liveEventCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2c',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) {
            liveBatchCount++
            liveEventCount += opts.input.length
            await new Promise((r) => setTimeout(r, 80))
          }
          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-2c',
        taskQueue: 'test-queue-2c',
      })

      // Send events while backfill is running — they queue up
      await new Promise((r) => setTimeout(r, 50))
      for (let i = 0; i < 12; i++) {
        await signalSourceInput(handle, {
          id: `evt_${i}`,
          type: 'customer.updated',
        })
      }

      // Wait for backfill + live processing
      await new Promise((r) => setTimeout(r, 3000))
      await cancelWorkflow(handle)
      await handle.result()

      expect(liveBatchCount).toBeGreaterThanOrEqual(1)
      expect(liveEventCount).toBe(12)
    })
  })

  it('pauses and resumes via paused signal', async () => {
    const statusWrites: string[] = []
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3',
      workflowsPath,
      activities: stubActivities({
        updatePipelineStatus: async (_id: string, status: string) => {
          statusWrites.push(status)
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3',
        taskQueue: 'test-queue-3',
      })

      await new Promise((r) => setTimeout(r, 1000))
      await handle.signal('paused', true)
      await new Promise((r) => setTimeout(r, 500))

      expect(statusWrites).toContain('paused')

      await handle.signal('paused', false)
      await new Promise((r) => setTimeout(r, 500))
      await cancelWorkflow(handle)
      await handle.result()
    })
  })

  it('reports phase-driven status transitions through teardown', async () => {
    const statusWrites: string[] = []
    let reconcileCalls = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3b',
      workflowsPath,
      activities: stubActivities({
        updatePipelineStatus: async (_id: string, status: string) => {
          statusWrites.push(status)
        },
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) return { eof: successEof }

          reconcileCalls++
          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3b',
        taskQueue: 'test-queue-3b',
      })

      await new Promise((r) => setTimeout(r, 500))
      await handle.signal('paused', true)
      await new Promise((r) => setTimeout(r, 500))
      await cancelWorkflow(handle)
      await handle.result()

      expect(statusWrites).toEqual(
        expect.arrayContaining(['backfill', 'ready', 'paused', 'teardown'])
      )
    })
  })

  // TODO: pipelineBackfill now throws ApplicationFailure instead of returning error state — update workflow error handling
  it.skip('transitions to error instead of ready when reconcile returns permanent sync errors', async () => {
    const statusWrites: string[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3b-error',
      workflowsPath,
      activities: stubActivities({
        updatePipelineStatus: async (_id: string, status: string) => {
          statusWrites.push(status)
        },
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) return { eof: successEof }
          return {
            eof: {
              ...successEof,
              run_progress: {
                ...successEof.run_progress,
                derived: { ...successEof.run_progress.derived, status: 'failed' as const },
                connection_status: { status: 'failed' as const, message: 'permanent sync failure' },
              },
            },
          }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3b-error',
        taskQueue: 'test-queue-3b-error',
      })

      await new Promise((r) => setTimeout(r, 500))
      await cancelWorkflow(handle)
      await handle.result()

      expect(statusWrites).toContain('error')
      expect(statusWrites).not.toContain('ready')
    })
  })

  it('retries transient sync activity failures and still reaches ready', async () => {
    const statusWrites: string[] = []
    let reconcileCalls = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3b-retry',
      workflowsPath,
      activities: stubActivities({
        updatePipelineStatus: async (_id: string, status: string) => {
          statusWrites.push(status)
        },
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) return { eof: successEof }

          reconcileCalls++
          if (reconcileCalls === 1) {
            throw new Error('transient sync failure')
          }

          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3b-retry',
        taskQueue: 'test-queue-3b-retry',
      })

      await new Promise((r) => setTimeout(r, 2500))
      await cancelWorkflow(handle)
      await handle.result()

      expect(reconcileCalls).toBeGreaterThanOrEqual(2)
      expect(statusWrites).toContain('ready')
      expect(statusWrites).not.toContain('error')
    })
  })

  it('queues live events while paused and drains them after resume', async () => {
    const syncCalls: { input?: SourceInput[] }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3c',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (_pipelineId: string, opts?) => {
          syncCalls.push({ input: opts?.input ?? undefined })
          await new Promise((r) => setTimeout(r, 50))
          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3c',
        taskQueue: 'test-queue-3c',
      })

      await new Promise((r) => setTimeout(r, 200))
      await handle.signal('paused', true)
      await new Promise((r) => setTimeout(r, 200))

      await signalSourceInput(handle, {
        id: 'evt_paused',
        type: 'customer.updated',
      })

      await new Promise((r) => setTimeout(r, 300))
      expect(syncCalls.filter((c) => c.input).length).toBe(0)

      await handle.signal('paused', false)
      await new Promise((r) => setTimeout(r, 400))
      await cancelWorkflow(handle)
      await handle.result()

      const liveCalls = syncCalls.filter((c) => c.input)
      expect(liveCalls).toHaveLength(1)
      expect(liveCalls[0].input).toEqual([
        expect.objectContaining({ id: 'evt_paused', type: 'customer.updated' }),
      ])
    })
  })

  it('triggers teardown on delete', async () => {
    let teardownCalled = false

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-4',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async () => {
          // Slow sync so delete arrives mid-reconciliation
          await new Promise((r) => setTimeout(r, 500))
          return { eof: successEof }
        },
        pipelineTeardown: async (): Promise<void> => {
          teardownCalled = true
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-4',
        taskQueue: 'test-queue-4',
      })

      await new Promise((r) => setTimeout(r, 300))
      await cancelWorkflow(handle)
      await handle.result()

      expect(teardownCalled).toBe(true)
    })
  })

  it('accumulates sync state across iterations', async () => {
    let syncCallCount = 0
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-7',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async () => {
          syncCallCount++
          return {
            eof: {
              ...successEof,
              ending_state: {
                source: { streams: { customer: { cursor: `cus_${syncCallCount}` } }, global: {} },
                destination: { streams: {}, global: {} },
                engine: { streams: {}, global: {} },
              },
            },
          }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-7',
        taskQueue: 'test-queue-7',
      })

      await new Promise((r) => setTimeout(r, 1500))

      expect(syncCallCount).toBeGreaterThan(0)

      await cancelWorkflow(handle)
      await handle.result()
    })
  })

  it.skip('runs setup only once across continue-as-new', async () => {
    let setupCalls = 0
    let syncCallCount = 0
    let crossedThresholdResolve: (() => void) | undefined
    const crossedThreshold = new Promise<void>((resolve) => {
      crossedThresholdResolve = resolve
    })

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-8',
      workflowsPath,
      activities: stubActivities({
        pipelineSetup: async () => {
          setupCalls++
        },
        pipelineSync: async () => {
          syncCallCount++
          if (syncCallCount > CONTINUE_AS_NEW_THRESHOLD) crossedThresholdResolve?.()
          await new Promise((r) => setTimeout(r, 1))
          return { eof: successEof }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-8',
        taskQueue: 'test-queue-8',
      })

      await crossedThreshold
      await cancelWorkflow(handle)
      await handle.result()

      expect(syncCallCount).toBeGreaterThan(CONTINUE_AS_NEW_THRESHOLD)
      expect(setupCalls).toBe(1)
    })
  })
})
