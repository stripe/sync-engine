import {
  CancellationScope,
  condition,
  continueAsNew,
  executeChild,
  isCancellation,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow'

import type { EofPayload, SourceInputMessage, SyncState } from '@stripe/sync-protocol'
import { emptySyncState } from '@stripe/sync-protocol'
import type { PipelineStatus } from '../../lib/createSchemas.js'
import {  pausedSignal,
  pipelineSetup,
  sourceInputSignal,
  pipelineSync,
  pipelineTeardown,
  updatePipelineStatus,
} from './_shared.js'
import { pipelineBackfill } from './pipeline-backfill.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const LIVE_EVENT_BATCH_SIZE = 10
const LIVE_BATCH_RETRY_BASE_MS = 1_000
const LIVE_BATCH_RETRY_MAX_MS = 5 * 60 * 1000
const PIPELINE_CONTINUE_AS_NEW_THRESHOLD = 1000

function liveBatchFailed(eof: EofPayload): boolean {
  if (eof.status === 'failed') return true
  return Object.values(eof.run_progress.streams).some((stream) => stream.status === 'errored')
}

function liveBatchRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(
    LIVE_BATCH_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1),
    LIVE_BATCH_RETRY_MAX_MS
  )
}

export interface PipelineWorkflowState {
  setupComplete?: boolean
  backfilling?: boolean  backfillCount: number
  teardown?: boolean
}

export interface PipelineWorkflowOpts {
  syncState?: SyncState
  inputQueue?: SourceInputMessage[]
  state?: PipelineWorkflowState
  paused?: boolean
}

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  // Persisted through continue-as-new.
  const inputQueue: SourceInputMessage[] = opts?.inputQueue ? [...opts.inputQueue] : []
  let paused = opts?.paused ?? false
  let syncState: SyncState = opts?.syncState ?? emptySyncState()
  const state: PipelineWorkflowState = { backfillCount: 0, ...opts?.state }

  // Transient workflow-local state.
  let operationCount = 0

  setHandler(sourceInputSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(pausedSignal, (value: boolean) => {
    paused = value
  })

  // MARK: - Status

  function derivePipelineStatus(): PipelineStatus {
    if (state.teardown) return 'teardown'
    if (paused) return 'paused'
    if (!state.setupComplete) return 'setup'
    if (state.backfilling) return 'backfill'
    // ready once we've completed at least one backfill
    return state.backfillCount > 0 ? 'ready' : 'backfill'
  }

  async function emitStatus() {
    await updatePipelineStatus(pipelineId, derivePipelineStatus())
  }

  function runInterrupted() {
    return paused || operationCount >= PIPELINE_CONTINUE_AS_NEW_THRESHOLD
  }

  // MARK: - Live loop

  async function waitForLiveEvents(): Promise<SourceInputMessage[] | null> {
    await condition(() => inputQueue.length > 0 || runInterrupted())

    if (runInterrupted()) {
      return null
    }

    return inputQueue.splice(0, LIVE_EVENT_BATCH_SIZE)
  }

  async function liveLoop(): Promise<void> {
    let consecutiveFailures = 0

    while (true) {
      const events = await waitForLiveEvents()
      if (!events) return

      const { eof } = await pipelineSync(pipelineId, {
        input: events,
        run_id: workflowInfo().runId,
      })
      operationCount++

      if (liveBatchFailed(eof)) {
        inputQueue.unshift(...events)
        consecutiveFailures++
        await condition(() => runInterrupted(), liveBatchRetryDelayMs(consecutiveFailures))
        continue
      }

      consecutiveFailures = 0
    }
  }
  // MARK: - Backfill (child workflow)

  async function runBackfill(workflowId: string): Promise<void> {
    state.backfilling = true
    await emitStatus()

    const result = await executeChild(pipelineBackfill, {
      workflowId,
      args: [pipelineId, { syncState }],
    })
    operationCount++
    syncState = result.eof.ending_state ?? syncState

    state.backfilling = false
    state.backfillCount++
    await emitStatus()
  }

  async function reconcileScheduler(): Promise<void> {
    while (!runInterrupted()) {
      await condition(() => runInterrupted(), ONE_WEEK_MS)
      if (runInterrupted()) return

      await runBackfill(`reconcile-${pipelineId}-${Date.now()}`)
    }
  }

  // MARK: - Main logic

  try {
    if (!state.setupComplete) {
      await emitStatus()
      await pipelineSetup(pipelineId)
      state.setupComplete = true
    }

    // Initial backfill
    if (state.backfillCount === 0) {
      await runBackfill(`backfill-${pipelineId}`)
    }

    // Main loop — runs until cancelled or continueAsNew threshold
    while (true) {
      if (paused) {
        await emitStatus()
        await condition(() => !paused)
        await emitStatus()
        continue
      }

      await Promise.all([liveLoop(), reconcileScheduler()])

      if (operationCount >= PIPELINE_CONTINUE_AS_NEW_THRESHOLD) {
        return await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
          syncState,
          inputQueue,
          state,
          paused,
        })
      }
    }
  } catch (err) {
    if (!isCancellation(err)) throw err

    // Cancellation = delete. Run teardown in a non-cancellable scope.
    await CancellationScope.nonCancellable(async () => {
      state.teardown = true
      await emitStatus()
      await pipelineTeardown(pipelineId)
    })
  }
}
