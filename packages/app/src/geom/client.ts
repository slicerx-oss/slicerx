// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine (sx-geom) for the app: cut, repair, simplify, hollow, emboss, orient and
// booleans. Loads on first use in a worker. A host can provide its own (for example native code in
// the desktop app) with setGeomProvider.
import type { FaceSurface, MeshPart } from '@slicerx/contracts'
import type { LoadError } from './modules'

export interface GeomProvider {
  call<T = unknown>(op: string, request: unknown, signal?: AbortSignal): Promise<T>
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
const IDLE_MS = 30_000
const BIG_IDLE_MS = 2_000
const BIG_BYTES = 256 * 1024 * 1024

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

function workerProvider(): GeomProvider {
  let worker: Worker | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const stop = () => {
    idle = null
    if (pending.size > 0) return
    worker?.terminate()
    worker = null
  }
  const start = () => {
    if (idle) clearTimeout(idle)
    idle = null
    if (worker) return worker
    worker = new Worker(new URL('./geom-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; memoryBytes?: number } | { loadError: LoadError }>) => {
      if ('loadError' in e.data) {
        noteLoadError(e.data.loadError)
        return
      }
      const p = pending.get(e.data.id)
      if (pending.size <= 1) {
        if (idle) clearTimeout(idle)
        idle = setTimeout(stop, (e.data.memoryBytes ?? 0) > BIG_BYTES ? BIG_IDLE_MS : IDLE_MS)
      }
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.error !== undefined) p.reject(new Error(e.data.error))
      else p.resolve(e.data.result)
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'The geometry engine did not start'))
      pending.clear()
      worker = null
    }
    return worker
  }
  return {
    call<T>(op: string, request: unknown, signal?: AbortSignal) {
      const id = ++seq
      const answer = new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          if (pending.delete(id)) reject(new DOMException('Canceled', 'AbortError'))
          // A history replay stops at its next step; single calls just lose their answer.
          if (op === 'history.replay') worker?.postMessage({ cancel: id })
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
      // Posted outside the promise's closures, so none of them holds the request (it can be a big mesh). A request
      // that cannot be sent fails the call, as before.
      try {
        start().postMessage({ id, op, request })
      } catch (e) {
        const p = pending.get(id)
        pending.delete(id)
        p?.reject(e instanceof Error ? e : new Error(String(e)))
      }
      return answer
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

/** Whether calls go to the app's own worker, which also runs jobs written in TypeScript (history.replay). */
export function usesWorker(): boolean {
  return provider === null || provider === own
}

/** The engine's mesh shape: flat arrays, and the faces when the engine sent them. */
export interface GeomMesh {
  positions: number[]
  indices: number[]
  /** `keys` name the faces for history steps (docs/cad-history.md, "Face keys"). */
  faces?: { ids: number[]; table: FaceSurface[]; keys?: number[] }
}

export function toGeom(part: Pick<MeshPart, 'positions' | 'indices' | 'faces'>): GeomMesh {
  const mesh: GeomMesh = { positions: Array.from(part.positions), indices: Array.from(part.indices) }
  if (part.faces) mesh.faces = { ids: Array.from(part.faces.ids), table: part.faces.table, ...(part.faces.keys?.length ? { keys: part.faces.keys } : {}) }
  return mesh
}

export function fromGeom(mesh: GeomMesh, name: string, slot: number): MeshPart {
  const part: MeshPart = { name, slot, positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) }
  if (mesh.faces) part.faces = { ids: new Uint32Array(mesh.faces.ids), table: mesh.faces.table, ...(mesh.faces.keys?.length ? { keys: mesh.faces.keys } : {}) }
  return part
}

/** The request with the engine asked to send each mesh's faces (the app's worker asks on every call). */
export function askFaces(request: unknown): unknown {
  return request !== null && typeof request === 'object' && !Array.isArray(request) ? { ...request, withFaces: true } : request
}
