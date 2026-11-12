// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine run natively by a host (the desktop app runs sx-geom, with the exact kernel, in a process of its
// own), in place of the app's worker: the same calls with the same answers. Calls go to the engine one at a time, in
// order, as frames (packages/geom/src/serve.rs): a JSON text and its buffers, so a mesh of typed arrays goes in and
// comes back in the engine's raw form and never as JSON numbers. history.replay runs here, in TypeScript, as the
// worker runs it, with the kernel's bodies kept in the engine between calls.
//
// Cancel and time limits work as the worker's do (client.ts): a call canceled before it starts never runs, and a call
// still running past CANCEL_GRACE_MS after its cancel, or past its time limit, ends the engine process; the next call
// starts another. A crash in the engine ends only its process and fails the call it was running. The process also
// ends after IDLE_MS with nothing to do, as the worker does, and with it every kernel body it held: each body number
// the page sees names the process that made it, so a number from an ended process is never sent to the next one.
import { clearReplayCache, replayHistory, withTooBig, type ReplayRequest } from '@slicerx/cad-history'
import { decodeFrame, encodeFrame, namesBody, ownBodies, plainArrays, rawData, rawMeshes, readBuffers, tagBodies } from '@slicerx/cad-history/served'
import { geomCallLimitMs, geomStuckMessage } from '@slicerx/contracts/geom-limits'
import { askFaces, CANCEL_GRACE_MS, IDLE_MS, noteCall, setGeomProvider, type GeomProvider } from './client'
import { trapMessage } from './engine-call'
import { replayStepOf, type ReplayStep } from './worker-loop'

/** The engine process, as the host runs it. */
export interface NativeEngine {
  /**
   * Sends one call's frame and answers with the answer's frame and the number of the process that ran it (each new
   * process gets the next number). Rejects with EngineEnded when the process ended before it answered. The answer's
   * frame is the provider's from then on: what it hands to the page may be views of it, so it is never written again.
   */
  call(frame: Uint8Array): Promise<{ generation: number; frame: Uint8Array }>
  /** Ends the engine process now, if one runs; the next call starts another. */
  end(): Promise<void>
}

/** The engine process ended before it answered: a crash, or the host ended it. `code` is its exit code when it had one. */
export class EngineEnded extends Error {
  constructor(readonly code: number | null) {
    super(`the engine process ended${code === null ? '' : ` with code ${code}`}`)
  }
}

/** What a call answers when its engine process was ended under it; the worker's own words (client.ts). */
const INTERRUPTED = 'The geometry engine was interrupted by a canceled edit. Retry the operation.'

const abortError = () => new DOMException('Canceled', 'AbortError')

// the frames and body numbers live in cad-history (served.ts); tests and callers read them here as before
export { decodeFrame, encodeFrame }

/** A call that is answered without the engine. */
class Answered {
  constructor(readonly result: unknown) {}
}

export interface NativeOptions {
  /** How long a call may run in the engine, by operation (client.ts, setGeomCallLimit). */
  limit?: (op: string) => number
}

interface Job {
  op: string
  request: unknown
  /** The replay step this call is part of: its time limit and the name its refusal gives. */
  step?: ReplayStep
  /** The replay this call is part of, so a canceled replay can end its running call. */
  owner?: object
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  settled: boolean
}

/**
 * The engine `engine` runs, as the app's geometry provider (setGeomProvider). `runsJobs`: it runs history.replay and
 * takes meshes as typed arrays, as the app's worker does (client.ts, usesWorker).
 */
export function nativeProvider(engine: NativeEngine, options: NativeOptions = {}): GeomProvider & { runsJobs: true } {
  const limitOf = options.limit ?? geomCallLimitMs
  const queue: Job[] = []
  let running: Job | null = null
  // the process that answered last; 0 when none runs (none yet, or it ended)
  let generation = 0
  let idle: ReturnType<typeof setTimeout> | null = null
  let replays = 0

  const settle = (job: Job, error: Error | null, value?: unknown) => {
    if (job.settled) return
    job.settled = true
    noteCall(job.op, error ?? undefined)
    if (error) job.reject(error)
    else job.resolve(value)
  }
  // The process went: the replay results kept on the page name its bodies, so they go too, as they go with a worker.
  const gone = () => {
    generation = 0
    clearReplayCache()
  }
  const clearIdle = () => {
    if (idle) clearTimeout(idle)
    idle = null
  }
  const armIdle = () => {
    clearIdle()
    if (running || queue.length || replays > 0 || generation === 0) return
    idle = setTimeout(() => {
      idle = null
      gone()
      void engine.end()
    }, IDLE_MS)
  }
  const endRunning = (job: Job) => {
    if (running === job) void engine.end()
  }

  /** The request as the engine reads it, with its buffers; a body number of an ended process is answered here. */
  const encode = (job: Job, id: number): Uint8Array => {
    const buffers: Uint8Array[] = []
    let request: unknown
    if (job.op.startsWith('brep.')) {
      // the kernel takes the request as it is, as the worker's kernel module does (brep.ts)
      const r = job.request !== null && typeof job.request === 'object' ? { ...(job.request as Record<string, unknown>) } : job.request
      if (r !== null && typeof r === 'object') {
        const fields = r as Record<string, unknown>
        if (!ownBodies(fields, generation)) {
          if (job.op === 'brep.free') throw new Answered({ freed: false })
          throw new Error(INTERRUPTED)
        }
        // a solid's triangles come back as buffers: normals and face ids too for a body the engine holds itself; a
        // body of the kernel's own table, or one sent as text, answers as before
        if (job.op === 'brep.tessellate' && !('meshOutput' in fields)) fields['meshOutput'] = 'raw'
      }
      request = r
    } else {
      request = askFaces(plainArrays(rawMeshes(rawData(job.op, job.request, buffers), buffers)))
    }
    return encodeFrame(JSON.stringify({ id, op: job.op, request: request ?? null }), buffers)
  }

  /** The answer as the worker gives it: buffers read back, body numbers named by their process, the kernel's own words. */
  const decode = (job: Job, frame: Uint8Array, from: number): unknown => {
    const { answer, buffers } = decodeFrame(frame)
    if (typeof answer['panic'] === 'string') throw new Error(trapMessage(answer['panic'], 0))
    if (typeof answer['error'] === 'string') {
      // the native engine names the kernel in its message ("brep: ..."); the worker's kernel does not
      throw withTooBig(new Error(job.op.startsWith('brep.') ? answer['error'].replace(/^brep: /, '') : answer['error']), answer)
    }
    const result = buffers.length ? readBuffers(answer['result'], buffers) : answer['result']
    // a body comes from a kernel op, or from another op asked to keep the body it makes (`withKeys`, an exact loft)
    const keeps = job.request !== null && typeof job.request === 'object' && (job.request as Record<string, unknown>)['withKeys'] === true
    if ((job.op.startsWith('brep.') || keeps) && result !== null && typeof result === 'object') tagBodies(result as Record<string, unknown>, from)
    return result
  }

  let seq = 0
  const pump = () => {
    if (running) return
    const job = queue.shift()
    if (!job) return armIdle()
    clearIdle()
    running = job
    let frame: Uint8Array
    try {
      frame = encode(job, ++seq)
    } catch (e) {
      running = null
      if (e instanceof Answered) settle(job, null, e.result)
      else settle(job, e instanceof Error ? e : new Error(String(e)))
      return pump()
    }
    const sentTo = generation
    const ms = limitOf(job.step?.op ?? job.op)
    const deadline = setTimeout(() => {
      settle(job, new Error(geomStuckMessage(job.step?.op ?? job.op, ms, job.step?.name)))
      endRunning(job)
    }, ms)
    engine.call(frame).then(
      ({ generation: from, frame: answer }) => {
        if (from !== generation) {
          // a new process ran it: what the page kept of the one before is gone
          if (generation !== 0) gone()
          generation = from
          // a body of the process the request was made for could not be in this one
          if (sentTo !== 0 && job.op.startsWith('brep.') && namesBody(job.request)) {
            settle(job, new Error(INTERRUPTED))
            return
          }
        }
        try {
          settle(job, null, decode(job, answer, from))
        } catch (e) {
          settle(job, e instanceof Error ? e : new Error(String(e)))
        }
      },
      (e: unknown) => {
        if (e instanceof EngineEnded) {
          gone()
          settle(job, new Error(trapMessage(e.message, 0)))
        } else settle(job, e instanceof Error ? e : new Error(String(e)))
      },
    ).finally(() => {
      clearTimeout(deadline)
      running = null
      pump()
    })
  }

  const engineCall = (op: string, request: unknown, signal?: AbortSignal, step?: ReplayStep, owner?: object): Promise<unknown> => {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const job: Job = { op, request, resolve, reject, settled: false, ...(step ? { step } : {}), ...(owner ? { owner } : {}) }
      if (signal) {
        const onAbort = () => {
          const waiting = queue.indexOf(job)
          if (waiting >= 0) queue.splice(waiting, 1)
          const wasRunning = running === job
          if (!job.settled) {
            job.settled = true
            noteCall(op, abortError())
            reject(abortError())
          }
          // still running: its process ends if it has not answered after the grace time
          if (wasRunning) setTimeout(() => endRunning(job), CANCEL_GRACE_MS)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        const done = () => signal.removeEventListener('abort', onAbort)
        job.resolve = (v) => (done(), resolve(v))
        job.reject = (e) => (done(), reject(e))
      }
      queue.push(job)
      pump()
    })
  }

  const replay = (request: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) return Promise.reject(abortError())
    const owner = {}
    let step: ReplayStep | undefined
    replays++
    clearIdle()
    // a new lofted body is asked exact here without the developer flag; the worker's replays never ask
    const run = replayHistory((o, r) => engineCall(o, r, undefined, step, owner), { ...(request as ReplayRequest), exactLofts: true }, {
      keepsBodies: true,
      yieldStep: async (s) => {
        // between steps other calls get the engine, as in the worker (worker-loop.ts)
        await new Promise((r) => setTimeout(r, 0))
        if (signal?.aborted) throw Object.assign(new Error('Canceled'), { name: 'AbortError' })
        step = replayStepOf(s)
      },
    }).finally(() => {
      replays--
      armIdle()
    })
    if (!signal) return run.then((v) => (noteCall('history.replay'), v), (e: Error) => (noteCall('history.replay', e), Promise.reject(e)))
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(abortError())
        // the step running in the engine stops within the grace time; the replay stops before its next step
        const job = running
        if (job?.owner === owner) setTimeout(() => endRunning(job), CANCEL_GRACE_MS)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      run.then(
        (v) => {
          signal.removeEventListener('abort', onAbort)
          noteCall('history.replay')
          resolve(v)
        },
        (e: Error) => {
          signal.removeEventListener('abort', onAbort)
          noteCall('history.replay', e)
          reject(e)
        },
      )
    })
  }

  return {
    runsJobs: true,
    call<T>(op: string, request: unknown, signal?: AbortSignal): Promise<T> {
      // the engine is native and whole: nothing to load
      if (op === 'engine.core' || op === 'engine.full') return Promise.resolve(true as T)
      if (op === 'history.replay') return replay(request, signal) as Promise<T>
      return engineCall(op, request, signal) as Promise<T>
    },
  }
}

/** Makes the engine `engine` runs the app's geometry provider, in place of the worker. */
export function useNativeEngine(engine: NativeEngine, options: NativeOptions = {}): void {
  setGeomProvider(nativeProvider(engine, options))
}
