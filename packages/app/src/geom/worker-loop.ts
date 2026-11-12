// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry worker's message loop (geom-worker.ts), apart from the engine it drives, so a test runs the real loop
// with a stand-in engine. The page (client.ts) sends {id, op, request} and, for a call it may cancel, `gate`: the
// worker then sends {ready} when it reaches the call and runs it on the page's {go}, or answers it canceled on {skip},
// so a call canceled while it waited behind a running one never runs. The worker says when each call starts, right
// before the engine runs it and after any build it needs has loaded, so the page can end a worker stuck in a canceled
// call, or in one past its time limit; a replay also says when it waits between steps ({yielded}) and when each of its
// steps starts ({step}).
import { stepName, tooBigOf, type Step } from '@slicerx/cad-history'

export interface WorkerJobs {
  /** Waits for what the call needs (an engine build, the B-rep kernel), then hands back the engine call itself (its answer, or a promise of it). */
  prepare(op: string, request: unknown): Promise<() => unknown>
  /**
   * history.replay, in TypeScript: `yieldStep` runs before each of its steps, with the step's operation and the name a
   * person knows it by, and throws once the call is canceled.
   */
  replay(request: unknown, yieldStep: (step?: ReplayStep) => Promise<void>): Promise<unknown>
  /** What the engine modules hold, sent with each answer. */
  memoryBytes(): number
  /** Buffers of a result that go to the page rather than being copied. */
  transfer(op: string, result: unknown): Transferable[]
}

/** A history step a replay is about to run: its operation, for its time limit, and its name, for a refusal. */
export interface ReplayStep {
  op: string
  name: string
}

/** What the page is told of a history step a replay is about to run. */
export function replayStepOf(step: Pick<Step, 'params' | 'label'>): ReplayStep {
  return { op: step.params.op, name: stepName(step) }
}

export type WorkerPost = (message: unknown, transfer?: Transferable[]) => void

export type WorkerMessage = { id: number; op: string; request: unknown; gate?: boolean } | { cancel: number } | { go: number } | { skip: number }

/** The handler for each message the worker gets. */
export function workerLoop(post: WorkerPost, jobs: WorkerJobs): (data: WorkerMessage) => Promise<void> {
  const canceled = new Set<number>()
  // calls waiting for the page's go
  const waiting = new Map<number, { op: string; request: unknown }>()
  const answer = (id: number, m: { result: unknown } | { error: string; tooBig?: { size: number; limit: number } }, transfer?: Transferable[]) => post({ id, ...m, memoryBytes: jobs.memoryBytes() }, transfer)
  const run = async (id: number, op: string, request: unknown) => {
    try {
      if (op === 'history.replay') {
        post({ started: id })
        const result = await jobs.replay(request, async (step) => {
          // between steps the worker answers other calls, so the page holds this replay's limit until its next step
          post({ yielded: id })
          await new Promise((r) => setTimeout(r, 0))
          if (canceled.has(id)) throw Object.assign(new Error('Canceled'), { name: 'AbortError' })
          // each step has a time limit of its own on the page (client.ts, setGeomCallLimit)
          post(step ? { step: id, op: step.op, name: step.name } : { step: id })
        })
        canceled.delete(id)
        answer(id, { result })
        return
      }
      const call = await jobs.prepare(op, request)
      // canceled while its engine build or the kernel loaded
      if (canceled.delete(id)) {
        answer(id, { error: 'Canceled' })
        return
      }
      // the page ends this worker when a canceled call is still running here (client.ts, CANCEL_GRACE_MS)
      post({ started: id })
      // a call tried once more after its engine ran out of memory waits for the engine to load again
      const result = await call()
      answer(id, { result }, jobs.transfer(op, result))
    } catch (err) {
      canceled.delete(id)
      const tooBig = tooBigOf(err)
      answer(id, { error: err instanceof Error ? err.message : String(err), ...(tooBig ? { tooBig } : {}) })
    }
  }
  return async (data) => {
    if ('cancel' in data) {
      canceled.add(data.cancel)
      // Cancels of quick calls arrive after their answer; keep only the latest few.
      if (canceled.size > 256) canceled.delete(canceled.values().next().value as number)
      return
    }
    if ('skip' in data) {
      if (waiting.delete(data.skip)) answer(data.skip, { error: 'Canceled' })
      return
    }
    if ('go' in data) {
      const call = waiting.get(data.go)
      if (!call) return
      waiting.delete(data.go)
      await run(data.go, call.op, call.request)
      return
    }
    if (data.gate) {
      waiting.set(data.id, { op: data.op, request: data.request })
      post({ ready: data.id })
      return
    }
    await run(data.id, data.op, data.request)
  }
}
