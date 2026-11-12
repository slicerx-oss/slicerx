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
import { clearReplayCache, replayHistory, type ReplayRequest } from '@slicerx/cad-history'
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

// --- frames: a u32 length and a JSON text, a u32 count of buffers, each buffer a u32 length and its bytes

/** A call as a frame: `{id, op, request}` and the buffers its `mem:N` paths name. */
export function encodeFrame(text: string, buffers: readonly Uint8Array[]): Uint8Array {
  const json = new TextEncoder().encode(text)
  const size = 8 + json.length + buffers.reduce((n, b) => n + 4 + b.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let at = 0
  const put = (b: Uint8Array) => {
    view.setUint32(at, b.length, true)
    out.set(b, at + 4)
    at += 4 + b.length
  }
  put(json)
  view.setUint32(at, buffers.length, true)
  at += 4
  for (const b of buffers) put(b)
  return out
}

/** A frame's JSON text, parsed, and its buffers as views of `frame`. */
export function decodeFrame(frame: Uint8Array): { answer: Record<string, unknown>; buffers: Uint8Array[] } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  let at = 0
  const take = () => {
    const len = view.getUint32(at, true)
    const b = frame.subarray(at + 4, at + 4 + len)
    if (b.length !== len) throw new Error('The geometry engine sent a short answer')
    at += 4 + len
    return b
  }
  const answer = JSON.parse(new TextDecoder().decode(take())) as Record<string, unknown>
  const count = view.getUint32(at, true)
  at += 4
  const buffers: Uint8Array[] = []
  for (let i = 0; i < count; i++) buffers.push(take())
  return { answer, buffers }
}

// --- requests and answers, as the worker hands them to the engine (engine-call.ts)

/** Each mesh of typed arrays (without faces) as a buffer in the engine's raw form, named by `rawPath`. */
function rawMeshes(v: unknown, buffers: Uint8Array[]): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map((e) => rawMeshes(e, buffers)) : v
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v
  const o = v as Record<string, unknown>
  const { positions, indices, faces } = o
  if (positions instanceof Float32Array && (indices instanceof Uint32Array || indices instanceof Uint16Array) && !faces) {
    const nv = Math.floor(positions.length / 3)
    const nt = Math.floor(indices.length / 3)
    const raw = new Uint8Array(8 + 12 * nv + 12 * nt)
    new Uint32Array(raw.buffer, 0, 2).set([nv, nt])
    new Float32Array(raw.buffer, 8, nv * 3).set(positions.subarray(0, nv * 3))
    new Uint32Array(raw.buffer, 8 + 12 * nv, nt * 3).set(indices.subarray(0, nt * 3))
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'positions' && k !== 'indices' && k !== 'faces'))
    buffers.push(raw)
    return { ...rest, rawPath: `mem:${buffers.length - 1}` }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = rawMeshes(e, buffers)
  return out
}

/** A project's bytes (`data.bytes`) as a buffer named by `data.path`; other files go as base64, as the worker sends them. */
function rawData(op: string, v: unknown, buffers: Uint8Array[]): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const bytes = (v as { data?: { bytes?: unknown } }).data?.bytes
  if (!(bytes instanceof Uint8Array)) return v
  if (op === 'format.read3mf') {
    buffers.push(bytes)
    return { ...v, data: { path: `mem:${buffers.length - 1}` } }
  }
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { ...v, data: { base64: btoa(text) } }
}

/** Typed arrays left in a request as plain arrays, for the engine's JSON. */
function plainArrays(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map(plainArrays) : v
  if (v === null || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = plainArrays(x)
  return out
}

/** A copy of `b` that owns its own aligned buffer, for a typed array of it. */
const own = (b: Uint8Array): ArrayBuffer => b.slice().buffer

/**
 * `b` as values of `size` bytes: a view of the frame itself when they start lined up in it, else a copy that is; none
 * when `b` is not a whole number of them.
 */
function values<T>(b: Uint8Array, size: 2 | 4, make: (buffer: ArrayBufferLike, offset?: number, length?: number) => T): T | undefined {
  if (b.byteLength % size) return undefined
  return b.byteOffset % size ? make(own(b)) : make(b.buffer, b.byteOffset, b.byteLength / size)
}

/**
 * A held solid's triangles come with more buffers beside the mesh (packages/geom/src/exact.rs, tessellate): packed
 * corner normals (`normalsOut`, six i16 per triangle) and each triangle's face (`faceIdsOut`, one u32 per triangle),
 * handed on as `normals` and `faceIds`, the names cad-history's reader takes (exact.ts, tessellated). One of any other
 * length belongs to other triangles and is left out.
 */
function solidBuffers(o: Record<string, unknown>, triangles: number, at: (n: unknown) => Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof o['normalsOut'] === 'number') {
    const normals = values(at(o['normalsOut']), 2, (b, offset, length) => new Int16Array(b, offset, length))
    if (normals?.length === triangles * 6) out['normals'] = normals
  }
  if (typeof o['faceIdsOut'] === 'number') {
    const faceIds = values(at(o['faceIdsOut']), 4, (b, offset, length) => new Uint32Array(b, offset, length))
    if (faceIds?.length === triangles) out['faceIds'] = faceIds
  }
  return out
}

/** The answer with each output buffer it names read as typed arrays, as the worker reads them (engine-call.ts, rawOut). */
function readBuffers(v: unknown, buffers: readonly Uint8Array[]): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map((e) => readBuffers(e, buffers)) : v
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  const at = (n: unknown) => {
    const b = typeof n === 'number' ? buffers[n] : undefined
    if (!b) throw new Error(`The geometry engine named a buffer it did not send: ${String(n)}`)
    return b
  }
  if (typeof o['rawBytes'] === 'number') return new Uint8Array(own(at(o['rawBytes'])))
  if (typeof o['positionsOut'] === 'number' && typeof o['trianglesOut'] === 'number') {
    const { positionsOut, trianglesOut, ...rest } = o
    return { ...(readBuffers(rest, buffers) as Record<string, unknown>), positions: new Float32Array(own(at(positionsOut))), indices: new Uint32Array(own(at(trianglesOut))) }
  }
  if (typeof o['rawOut'] === 'number') {
    const b = at(o['rawOut'])
    const head = new DataView(b.buffer, b.byteOffset, 8)
    const nv = head.getUint32(0, true)
    const nt = head.getUint32(4, true)
    const { rawOut: _n, ...rest } = o
    const solid = solidBuffers(rest, nt, at)
    // the buffer numbers they came under name nothing on the page
    if (typeof rest['normalsOut'] === 'number') delete rest['normalsOut']
    if (typeof rest['faceIdsOut'] === 'number') delete rest['faceIdsOut']
    return { ...rest, positions: new Float32Array(own(b.subarray(8, 8 + 12 * nv))), indices: new Uint32Array(own(b.subarray(8 + 12 * nv, 8 + 12 * nv + 12 * nt))), ...solid }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = readBuffers(e, buffers)
  return out
}

// --- kernel bodies: a body number the page sees is the process's number times 2^32 plus the kernel's own

const PER_PROCESS = 2 ** 32
/** The request fields that name a kernel body (packages/brep/cpp/sx_brep.cpp), and the answer fields that hand one out. */
const BODY_IN = ['body', 'target', 'a', 'b'] as const
const BODY_OUT = ['body', 'below', 'above'] as const

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
        for (const k of BODY_IN) {
          const n = fields[k]
          if (typeof n !== 'number') continue
          const from = Math.floor(n / PER_PROCESS)
          if (from !== generation || generation === 0) {
            if (job.op === 'brep.free') throw new Answered({ freed: false })
            throw new Error(INTERRUPTED)
          }
          fields[k] = n - from * PER_PROCESS
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
      throw new Error(job.op.startsWith('brep.') ? answer['error'].replace(/^brep: /, '') : answer['error'])
    }
    const result = buffers.length ? readBuffers(answer['result'], buffers) : answer['result']
    // a body comes from a kernel op, or from another op asked to keep the body it makes (`withKeys`, an exact loft)
    const keeps = job.request !== null && typeof job.request === 'object' && (job.request as Record<string, unknown>)['withKeys'] === true
    if ((job.op.startsWith('brep.') || keeps) && result !== null && typeof result === 'object') {
      const fields = result as Record<string, unknown>
      for (const k of BODY_OUT) if (typeof fields[k] === 'number') fields[k] = from * PER_PROCESS + (fields[k] as number)
    }
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
          if (sentTo !== 0 && job.op.startsWith('brep.') && BODY_IN.some((k) => typeof (job.request as Record<string, unknown> | null)?.[k] === 'number')) {
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
    const run = replayHistory((o, r) => engineCall(o, r, undefined, step, owner), request as ReplayRequest, {
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
