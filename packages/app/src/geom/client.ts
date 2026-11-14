// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine (sx-geom) for the app: cut, repair, simplify, hollow, emboss, orient and
// booleans. Loads on first use in a worker. A host can provide its own (for example native code in
// the desktop app) with setGeomProvider.
import { withTooBig } from '@slicerx/cad-history'
import type { FaceSurface, MeshPart } from '@slicerx/contracts'
import { geomCallLimitMs, geomStuckMessage } from '@slicerx/contracts/geom-limits'
import { setKeptBodiesRelease } from '../cad/waiting'
import type { LoadError } from './modules'
import { workerAnswered, workerEnded, workerStarted } from './worker-memory'

export interface GeomProvider {
  call<T = unknown>(op: string, request: unknown, signal?: AbortSignal): Promise<T>
  /** It runs the worker's jobs (history.replay) and takes meshes as typed arrays, as the worker does (native-provider.ts). */
  runsJobs?: boolean
}

let provider: GeomProvider | null = null

export function setGeomProvider(p: GeomProvider | null): void {
  provider = p
}

/**
 * The worker ends this long after its last answer. A WebAssembly module's memory only grows: a fit check of a mesh of
 * millions of triangles leaves the engine holding hundreds of megabytes until the worker goes, so a worker holding more
 * than BIG_BYTES ends soon after; a new one starts in a fraction of a second.
 */
export const IDLE_MS = 30_000
export const BIG_IDLE_MS = 2_000
export const BIG_BYTES = 256 * 1024 * 1024

/**
 * A canceled call still running in the engine this long ends the shared worker: a synchronous engine call (a merged
 * array can run for minutes) cannot read a cancel message, and every later call would wait behind it. A quick call
 * canceled mid-way (a preview) answers well within it, so its worker, and the bodies it keeps, stay.
 */
export const CANCEL_GRACE_MS = 500

const INTERRUPTED = 'The geometry engine was interrupted by a canceled edit. Retry the operation.'

/**
 * How long a call may run in the engine once it starts, by operation (@slicerx/contracts geom-limits.ts): at the limit
 * its worker ends, the calls queued behind it go to a fresh one, and the call is refused with what to try. A replay's
 * limit counts from each of its steps. A test sets a shorter one with setGeomCallLimit.
 */
let limitOf: (op: string) => number = geomCallLimitMs

export function setGeomCallLimit(limit: ((op: string) => number) | null): void {
  limitOf = limit ?? geomCallLimitMs
}

/** The refusal of a call stopped at its limit. It is never sent again: the same call would stop the same way. */
const stuck = (op: string, ms: number, name?: string): Error => new Error(geomStuckMessage(op, ms, name))

/**
 * The app's own geometry worker: its answers and failures so far, by operation, the last failure's message, and the
 * last engine build that did not load.
 */
const calls = { answered: {} as Record<string, number>, failed: {} as Record<string, number>, lastError: null as string | null, loadError: null as LoadError | null }

/**
 * What the app's own geometry worker has answered, for the agent bridge: a session whose answers stay empty after a
 * mesh file opened, or with no fit.check after an object of several parts, never loaded the engine; `loadError` says
 * which build did not load and why.
 */
export function geomCalls(): { answered: Record<string, number>; failed: Record<string, number>; lastError: string | null; loadError: LoadError | null } {
  return { answered: { ...calls.answered }, failed: { ...calls.failed }, lastError: calls.lastError, loadError: calls.loadError && { ...calls.loadError } }
}

/** Counts an answer of `op`, or with `error` its failure, for geomCalls (the fit check's worker, fit-client.ts). */
export function noteCall(op: string, error?: Error): void {
  if (!error) {
    calls.answered[op] = (calls.answered[op] ?? 0) + 1
    return
  }
  calls.failed[op] = (calls.failed[op] ?? 0) + 1
  calls.lastError = error.message
}

/** Load failures already logged, so a worker that starts again and fails the same way is not logged again. */
const logged = new Set<string>()

/**
 * An engine build that did not load (reported by the worker): kept for the bridge, logged once with its reason, and,
 * with localStorage 'slicerx.debug' set, shown as a notice. The person keeps working; calls that need the engine fail
 * on their own.
 */
export function noteLoadError(e: LoadError): void {
  calls.loadError = { ...e }
  const key = `${e.module}: ${e.message}`
  if (logged.has(key)) return
  logged.add(key)
  console.error(`The geometry engine's ${e.module} build did not load: ${e.message}`)
  if (typeof localStorage !== 'undefined' && localStorage.getItem('slicerx.debug')) {
    void import('../state/store').then(({ toast }) => toast(`The geometry engine did not load (${e.module}: ${e.message}).`, 'warn'))
  }
}

/** Ends the app's own geometry worker now when no call is waiting on it (endIdleGeomWorker). */
let endIfIdle: (() => boolean) | null = null

/**
 * Ends the app's own geometry worker at once when no other call is waiting on it, so the memory its WebAssembly grew
 * goes now rather than after its idle time; the next call starts a new one. True when it ended (or there was none).
 */
export function endIdleGeomWorker(): boolean {
  return endIfIdle?.() ?? true
}

/** Whether the app's own geometry worker runs now (releaseKept). */
let ownRunning: () => boolean = () => false

/**
 * Frees the solids the replays of a cleared plate kept (history.release), where the replays run and keep them. The
 * app's own worker keeps them inside it, so with none running there are none, and none is started for the call. A
 * provider that runs replays itself (runsJobs, the native engine) keeps them on the page and asks its engine only to
 * free bodies it holds. Any other provider runs no replay and is not asked.
 */
function releaseKept(): Promise<void> {
  const p = provider
  if (p === null || (p === own ? !ownRunning() : p.runsJobs !== true)) return Promise.resolve()
  return p.call('history.release', {}).then(
    () => undefined,
    () => undefined,
  )
}

// a cleared plate asks for it through cad/waiting.ts, so clearing does not load this module
setKeptBodiesRelease(releaseKept)

/** A call for the worker. `gate`: it can be canceled, so the worker asks before it runs it (worker-loop.ts). */
interface Call {
  id: number
  op: string
  request: unknown
  gate: boolean
}

function workerProvider(): GeomProvider {
  let worker: Worker | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  // calls the worker said it started and has not answered yet
  const started = new Set<number>()
  // calls sent and not started, kept to go to the next worker if this one ends; a replay until it answers, since it
  // runs again from its start. A big mesh is held only that long.
  const unstarted = new Map<number, Call>()
  // calls the worker reached and was told to run
  const going = new Set<number>()
  // canceled calls the worker has not answered yet, with the timer that ends the worker once one has started
  const canceled = new Map<number, ReturnType<typeof setTimeout> | null>()
  // calls made while a canceled one may still end the worker: sent once it answers, or to the next worker
  let held: Call[] = []
  // the time limit of each call running in the engine (limitOf)
  const deadlines = new Map<number, ReturnType<typeof setTimeout>>()
  const unlimit = (id: number) => {
    clearTimeout(deadlines.get(id))
    deadlines.delete(id)
  }
  // Each running replay's step: its operation and name, whether the replay is between steps (it said {yielded}), and
  // what is left of the step's limit while it is stopped. The worker runs other calls, another replay's steps among
  // them, while a replay waits between its steps, so a replay's limit is off between steps, stops while another call
  // runs, and goes on with what was left after.
  // A known limit: when two replays each wait inside a step for the same load, both limits keep running, and the
  // worker does not say which one goes on first once the load is in. One replay's step can then be charged the other's
  // engine time, and a step that hangs there may be stopped under the other replay's step name.
  const steps = new Map<number, { op: string; name?: string; between?: boolean; left?: number; since?: number }>()
  const othersRunning = () => [...started].some((id) => !steps.has(id))
  const armStep = (id: number) => {
    const step = steps.get(id)
    if (!step || step.between || othersRunning() || !pending.has(id)) return
    step.since = Date.now()
    limit(id, step.op, step.name, step.left)
  }
  const stopStep = (id: number) => {
    const step = steps.get(id)
    if (!step || !deadlines.has(id)) return
    // a clock set back cannot give a step more than its whole limit
    step.left = Math.min(limitOf(step.op), Math.max(0, (step.left ?? limitOf(step.op)) - (Date.now() - (step.since ?? Date.now()))))
    unlimit(id)
  }
  const release = () => {
    if (idle) clearTimeout(idle)
    idle = null
    for (const t of canceled.values()) if (t) clearTimeout(t)
    canceled.clear()
    for (const t of deadlines.values()) clearTimeout(t)
    deadlines.clear()
    steps.clear()
    started.clear()
    unstarted.clear()
    going.clear()
    held = []
    const ended = worker
    worker = null
    ended?.terminate()
    workerEnded(ended)
  }
  const stop = () => {
    if (pending.size === 0) release()
  }
  const failAll = (error: Error) => {
    release()
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  const send = (c: Call) => {
    // a request that cannot be sent fails the call
    try {
      start().postMessage(c.gate ? { id: c.id, op: c.op, request: c.request, gate: true } : { id: c.id, op: c.op, request: c.request })
      unstarted.set(c.id, c)
    } catch (e) {
      const p = pending.get(c.id)
      pending.delete(c.id)
      p?.reject(e instanceof Error ? e : new Error(String(e)))
    }
  }
  const ending = () => [...canceled.values()].some((t) => t !== null)
  const sendHeld = () => {
    if (ending()) return
    const waiting = held
    held = []
    for (const c of waiting) if (pending.has(c.id)) send(c)
  }
  // Ends the worker. The calls it never started and the ones held back go to the next worker, in order; only a call
  // that was running there and nobody canceled fails.
  const interrupt = () => {
    const again = [...unstarted.values(), ...held].filter((c) => pending.has(c.id)).sort((a, b) => a.id - b.id)
    const keep = again.map((c) => [c, pending.get(c.id)] as const)
    for (const [c] of keep) pending.delete(c.id)
    failAll(new Error(INTERRUPTED))
    for (const [c, p] of keep) if (p) pending.set(c.id, p)
    for (const [c] of keep) send(c)
  }
  const interruptAfterGrace = (id: number) => {
    canceled.set(id, setTimeout(interrupt, CANCEL_GRACE_MS))
  }
  // A call still running at its limit is refused and its worker ends, as for a cancel: nobody may be there to cancel
  // it (a mimir run), and every call queued behind it would wait for good.
  // `wait`: what is left of the limit, for a replay's step that went on after a stop; the refusal names the whole limit
  const limit = (id: number, op: string, name?: string, wait?: number) => {
    unlimit(id)
    const ms = limitOf(op)
    deadlines.set(
      id,
      setTimeout(() => {
        deadlines.delete(id)
        const p = pending.get(id)
        pending.delete(id)
        unstarted.delete(id)
        p?.reject(stuck(op, ms, name))
        interrupt()
      }, wait ?? ms),
    )
  }
  ownRunning = () => worker !== null
  endIfIdle = () => {
    if (pending.size > 0) return false
    release()
    return true
  }
  const start = () => {
    if (idle) clearTimeout(idle)
    idle = null
    if (worker) return worker
    const current = new Worker(new URL('./geom-worker.ts', import.meta.url), { type: 'module' })
    worker = current
    workerStarted(current, 'shared')
    current.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; tooBig?: unknown; memoryBytes?: number } | { loadError: LoadError } | { started: number } | { ready: number } | { step: number; op?: string; name?: string } | { yielded: number }>) => {
      if (worker !== current) return
      if ('loadError' in e.data) {
        noteLoadError(e.data.loadError)
        return
      }
      if ('ready' in e.data) {
        // the worker reached a call it may skip: one canceled meanwhile never runs, whatever it was waiting behind
        const id = e.data.ready
        if (pending.has(id)) {
          going.add(id)
          current.postMessage({ go: id })
        } else current.postMessage({ skip: id })
        return
      }
      if ('started' in e.data) {
        const id = e.data.started
        const op = unstarted.get(id)?.op
        started.add(id)
        if (op !== 'history.replay') unstarted.delete(id)
        if (op === 'history.replay') {
          if (canceled.has(id) || !pending.has(id)) return
          steps.set(id, { op })
          armStep(id)
          return
        }
        // another call runs: every replay's limit stops until it is done
        for (const r of steps.keys()) stopStep(r)
        if (canceled.has(id)) interruptAfterGrace(id)
        else if (op !== undefined && pending.has(id)) limit(id, op)
        return
      }
      if ('yielded' in e.data) {
        // a replay between its steps: no limit until its next step starts
        const step = steps.get(e.data.yielded)
        if (!step) return
        step.between = true
        unlimit(e.data.yielded)
        return
      }
      if ('step' in e.data) {
        // a replay's next step: a whole limit of that step's class
        const id = e.data.step
        if (!steps.has(id)) return
        steps.set(id, { op: e.data.op ?? 'history.replay', ...(e.data.name ? { name: e.data.name } : {}) })
        armStep(id)
        return
      }
      const other = started.has(e.data.id) && !steps.has(e.data.id)
      unlimit(e.data.id)
      started.delete(e.data.id)
      steps.delete(e.data.id)
      // the last other call is done: each replay in a step goes on with what was left of its limit
      if (other && !othersRunning()) for (const r of steps.keys()) armStep(r)
      unstarted.delete(e.data.id)
      going.delete(e.data.id)
      const grace = canceled.get(e.data.id)
      if (grace) clearTimeout(grace)
      if (canceled.delete(e.data.id)) sendHeld()
      workerAnswered(current, e.data.memoryBytes)
      const p = pending.get(e.data.id)
      if (pending.size <= 1) {
        if (idle) clearTimeout(idle)
        idle = setTimeout(stop, (e.data.memoryBytes ?? 0) > BIG_BYTES ? BIG_IDLE_MS : IDLE_MS)
      }
      if (!p) return
      pending.delete(e.data.id)
      // a body too big for the engine carries its size and limit (withTooBig)
      if (e.data.error !== undefined) p.reject(withTooBig(new Error(e.data.error), e.data))
      else p.resolve(e.data.result)
    }
    current.onerror = (e) => {
      if (worker !== current) return
      failAll(new Error(e.message || 'The geometry engine did not start'))
    }
    return current
  }
  return {
    call<T>(op: string, request: unknown, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject<T>(new DOMException('Canceled', 'AbortError'))
      const id = ++seq
      const answer = new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          const p = pending.get(id)
          if (!p) return
          pending.delete(id)
          unstarted.delete(id)
          unlimit(id)
          p.reject(new DOMException('Canceled', 'AbortError'))
          if (held.some((c) => c.id === id)) {
            held = held.filter((c) => c.id !== id)
            return
          }
          // a synchronous kernel call cannot read a cancel message; ending its worker also releases kept bodies.
          if (op === 'history.replay') return interrupt()
          // still running: its worker ends if it has not answered after the grace time
          if (started.has(id)) {
            worker?.postMessage({ cancel: id })
            return interruptAfterGrace(id)
          }
          // told to run, maybe waiting for an engine build: the worker reads this before it starts the call
          if (going.has(id)) worker?.postMessage({ cancel: id })
          // not reached yet: the worker is told to skip it when it is
          canceled.set(id, null)
        }
        // The abort listener goes once the call is answered: a signal that outlives the call (a fit check's lives
        // until the plate changes) would otherwise keep this closure, and what it can reach, alive.
        const settle = () => signal?.removeEventListener('abort', onAbort)
        pending.set(id, {
          resolve: (v) => {
            settle()
            calls.answered[op] = (calls.answered[op] ?? 0) + 1
            resolve(v as T)
          },
          reject: (e) => {
            settle()
            calls.failed[op] = (calls.failed[op] ?? 0) + 1
            calls.lastError = e.message
            reject(e)
          },
        })
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      // Posted outside the promise's closures, so none of them holds the request (it can be a big mesh); a held one is
      // kept only until the canceled call answers or its worker ends.
      const c: Call = { id, op, request, gate: signal !== undefined && op !== 'history.replay' }
      if (ending()) held.push(c)
      else send(c)
      return answer
    },
  }
}

const newWorker = (): Worker => new Worker(new URL('./geom-worker.ts', import.meta.url), { type: 'module' })

/** A worker started ahead of its call, its core engine loading or loaded, and the timer that ends it unused. */
let spare: { worker: Worker; unused: ReturnType<typeof setTimeout> } | null = null

function takeSpare(): Worker | null {
  if (!spare) return null
  clearTimeout(spare.unused)
  const { worker } = spare
  spare = null
  return worker
}

/**
 * Starts a geometry worker for the next call in a worker of its own (soloCall, the project reader's), and has it load
 * the core engine now. A project handed over at launch reads in it without first waiting for a worker and the engine's
 * compile (about 200 ms on a Mac), which then happen while the app is still starting. Ends unused after IDLE_MS.
 */
export function startSpareGeomWorker(): void {
  if (spare || !usesWorker() || typeof Worker === 'undefined') return
  const worker = newWorker()
  worker.onmessage = (e: MessageEvent<{ loadError?: LoadError }>) => {
    if (e.data.loadError) noteLoadError(e.data.loadError)
  }
  worker.postMessage({ id: 0, op: 'engine.core', request: null })
  workerStarted(worker, 'spare')
  spare = {
    worker,
    unused: setTimeout(() => {
      const unused = takeSpare()
      unused?.terminate()
      workerEnded(unused)
    }, IDLE_MS),
  }
}

/**
 * Starts the geometry engine for a file the app is about to open (one handed over at launch), in the worker that file's
 * open will use: a project's reader runs in a worker of its own, a mesh file's import in the app's shared one.
 */
export function startGeomFor(fileName: string): void {
  if (!usesWorker() || typeof Worker === 'undefined') return
  if (/\.(3mf|sx3mf)$/i.test(fileName)) startSpareGeomWorker()
  else if (/\.(stl|obj|amf)$/i.test(fileName)) void geom().call('engine.core', null).catch(() => undefined)
}

/**
 * One call in a geometry worker of its own, which ends with its answer, its failure or `end`. For a long call (the
 * sleipnir layer plan takes seconds on a big plate) that the shared worker would make every other call wait behind:
 * the fit check and the modeling tools keep answering meanwhile, and a call no longer wanted stops at once rather than
 * running on. Its engine memory goes with the worker. `transfer` hands buffers the caller no longer needs (a mesh made for
 * this call) to the worker rather than copying them.
 */
export function soloCall<T>(op: string, request: unknown, transfer: Transferable[] = []): { answer: Promise<T>; end: () => void } {
  let worker: Worker | null = takeSpare() ?? newWorker()
  const w = worker
  workerStarted(w, 'solo')
  let fail: (e: Error) => void = () => undefined
  // its time limit, from when the engine starts it (limitOf)
  let deadline: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(deadline)
    worker?.terminate()
    workerEnded(worker)
    worker = null
  }
  const answer = new Promise<T>((resolve, reject) => {
    fail = (e) => {
      stop()
      calls.failed[op] = (calls.failed[op] ?? 0) + 1
      calls.lastError = e.message
      reject(e)
    }
    w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; tooBig?: unknown } | { loadError: LoadError } | { started: number }>) => {
      if ('loadError' in e.data) return noteLoadError(e.data.loadError)
      if ('started' in e.data) {
        if (e.data.started !== 1 || !worker) return
        const ms = limitOf(op)
        deadline = setTimeout(() => fail(stuck(op, ms)), ms)
        return
      }
      // a spare's own start-up answer (startSpareGeomWorker) is not this call's
      if (e.data.id !== 1) return
      if (e.data.error !== undefined) return fail(withTooBig(new Error(e.data.error), e.data))
      stop()
      calls.answered[op] = (calls.answered[op] ?? 0) + 1
      resolve(e.data.result as T)
    }
    w.onerror = (e) => fail(new Error(e.message || 'The geometry engine did not start'))
  })
  // Posted outside the closures above, so none of them holds the request (it can be a big mesh).
  try {
    w.postMessage({ id: 1, op, request }, transfer)
  } catch (e) {
    fail(e instanceof Error ? e : new Error(String(e)))
  }
  return {
    answer,
    end: () => {
      if (worker) fail(new DOMException('Canceled', 'AbortError'))
    },
  }
}

let own: GeomProvider | null = null
// The salt of the history step a tool is about to record (cad/history/record.ts, reserveStepId): every call meanwhile
// gives it to the engine, so the faces the step makes get the keys a replay of the step will give them.
let keySalt: number | null = null

export function setKeySalt(salt: number | null): void {
  keySalt = salt
}

export function geom(): GeomProvider {
  const p = (provider ??= own = workerProvider())
  const salt = keySalt
  if (salt === null) return p
  return {
    call: <T,>(op: string, request: unknown, signal?: AbortSignal) =>
      p.call<T>(op, request !== null && typeof request === 'object' && !Array.isArray(request) && !('keySalt' in request) ? { ...request, keySalt: salt } : request, signal),
  }
}

/**
 * Whether calls go to the app's own worker, which also runs jobs written in TypeScript (history.replay), or to a
 * provider that runs them as it does. Calls in a worker of their own (soloCall, the fit check) still go to one.
 */
export function usesWorker(): boolean {
  return provider === null || provider === own || provider.runsJobs === true
}

/** The engine's mesh shape: flat arrays, and the faces when the engine sent them. */
export interface GeomMesh {
  positions: number[]
  indices: number[]
  /** `keys` name the faces for history steps (docs/cad-history.md, "Face keys"). */
  faces?: { ids: number[]; table: FaceSurface[]; keys?: number[] }
  /** Packed exact corner normals, six per triangle (MeshPart.normals). */
  normals?: number[]
}

export function toGeom(part: Pick<MeshPart, 'positions' | 'indices' | 'faces' | 'normals'>): GeomMesh {
  const mesh: GeomMesh = { positions: Array.from(part.positions), indices: Array.from(part.indices) }
  if (part.faces) mesh.faces = { ids: Array.from(part.faces.ids), table: part.faces.table, ...(part.faces.keys?.length ? { keys: part.faces.keys } : {}) }
  if (part.normals && part.normals.length === part.indices.length * 2) mesh.normals = Array.from(part.normals)
  return mesh
}

/** A mesh of the engine's that came back as typed arrays (geom-worker.ts reads raw output buffers so). */
export interface TypedGeomMesh {
  positions: Float32Array
  indices: Uint32Array
  faces?: GeomMesh['faces']
  normals?: Int16Array | number[]
}

export function fromGeom(mesh: GeomMesh | TypedGeomMesh, name: string, slot: number): MeshPart {
  // Typed arrays from the worker are the part's own; plain ones are copied into typed arrays.
  const part: MeshPart = {
    name,
    slot,
    positions: mesh.positions instanceof Float32Array ? mesh.positions : new Float32Array(mesh.positions),
    indices: mesh.indices instanceof Uint32Array ? mesh.indices : new Uint32Array(mesh.indices),
  }
  if (mesh.faces) part.faces = { ids: new Uint32Array(mesh.faces.ids), table: mesh.faces.table, ...(mesh.faces.keys?.length ? { keys: mesh.faces.keys } : {}) }
  // six per triangle, or they belong to other triangles and are left out
  if (mesh.normals && mesh.normals.length === part.indices.length * 2) part.normals = mesh.normals instanceof Int16Array ? mesh.normals : Int16Array.from(mesh.normals)
  return part
}

/** The request with the engine asked to send each mesh's faces (the app's worker asks on every call). */
export function askFaces(request: unknown): unknown {
  return request !== null && typeof request === 'object' && !Array.isArray(request) ? { ...request, withFaces: true } : request
}

// Test hook: with localStorage 'slicerx.debug' set (as for window.__sx), scripts reach the engine as window.__geom, to
// run a worker job such as history.replay directly and time it.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined' && localStorage.getItem('slicerx.debug')) {
  Object.assign(window, { __geom: { call: (op: string, request: unknown) => geom().call(op, request) } })
}
