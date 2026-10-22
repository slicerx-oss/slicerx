// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check's worker (fit-worker.ts): one, started on the first check and kept warm, so a check never waits behind
// the shared geometry worker nor holds it up. The engine runs a check synchronously and nothing reaches it meanwhile,
// so a canceled check ends this worker, and the next check starts another from the compiled module the first one
// handed back. It ends when idle as the shared worker does (client.ts), and the module stays for the next one. A mesh
// goes over once and is named by its key after that, until keepFitMeshes says the plate dropped it.
import { BIG_BYTES, BIG_IDLE_MS, IDLE_MS, noteCall } from './client'

let worker: Worker | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let module: WebAssembly.Module | null = null
let seq = 0
let nextKey = 0
const keys = new WeakMap<object, number>()
/** The keys of the meshes the worker holds. */
let held = new Set<number>()
const pending = new Map<number, { request: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** The request with each mesh the worker holds named by its key, and each new one sent with its key. */
function keyed(v: unknown): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map(keyed) : v
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v
  const o = v as Record<string, unknown>
  const { positions, indices, ...rest } = o
  if (positions instanceof Float32Array && ArrayBuffer.isView(indices)) {
    let key = keys.get(positions)
    if (key === undefined) keys.set(positions, (key = ++nextKey))
    if (held.has(key)) return { ...rest, meshKey: key }
    held.add(key)
    return { ...o, meshKey: key }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = keyed(e)
  return out
}

function end(): void {
  if (idle) clearTimeout(idle)
  idle = null
  worker?.terminate()
  worker = null
  held = new Set()
}

function start(): Worker {
  if (idle) clearTimeout(idle)
  idle = null
  if (worker) return worker
  const current = new Worker(new URL('./fit-worker.ts', import.meta.url), { type: 'module' })
  worker = current
  current.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; memoryBytes?: number } | { module: WebAssembly.Module }>) => {
    if (worker !== current) return
    if ('module' in e.data) {
      module = e.data.module
      return
    }
    const p = pending.get(e.data.id)
    pending.delete(e.data.id)
    if (idle) clearTimeout(idle)
    // as the shared worker: one holding a lot of engine memory ends soon after its last answer
    idle = pending.size === 0 ? setTimeout(end, (e.data.memoryBytes ?? 0) > BIG_BYTES ? BIG_IDLE_MS : IDLE_MS) : null
    if (!p) return
    if (e.data.error !== undefined) p.reject(new Error(e.data.error))
    else p.resolve(e.data.result)
  }
  current.onerror = (e) => {
    if (worker !== current) return
    end()
    for (const p of pending.values()) p.reject(new Error(e.message || 'The fit check did not start'))
    pending.clear()
  }
  current.postMessage({ start: module })
  return current
}

function post(id: number, request: unknown): void {
  try {
    start().postMessage({ id, request: keyed(request) })
  } catch (e) {
    const p = pending.get(id)
    pending.delete(id)
    p?.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

/** A fit check (sx-geom fit.check) in the fit check's worker. */
export function fitCall<T>(request: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject<T>(new DOMException('Canceled', 'AbortError'))
  const id = ++seq
  const answer = new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!pending.delete(id)) return
      reject(new DOMException('Canceled', 'AbortError'))
      // the check may be the one running: its worker goes, and the checks behind it go to a new one
      end()
      for (const [k, p] of pending) post(k, p.request)
    }
    // the listener goes with the answer, as in client.ts
    const settle = () => signal?.removeEventListener('abort', onAbort)
    pending.set(id, {
      request,
      resolve: (v) => {
        settle()
        noteCall('fit.check')
        resolve(v as T)
      },
      reject: (e) => {
        settle()
        noteCall('fit.check', e)
        reject(e)
      },
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  post(id, request)
  return answer
}

/** Lets the fit check's worker drop every mesh but these (the parts' position arrays). */
export function keepFitMeshes(positions: readonly Float32Array[]): void {
  const keep = new Set(positions.flatMap((a) => keys.get(a) ?? []))
  held = new Set([...held].filter((k) => keep.has(k)))
  worker?.postMessage({ keep: [...keep] })
}

// Test hook: with localStorage 'slicerx.debug' set, scripts run a fit check here as window.__geom.fit, once this loads.
if (typeof window !== 'undefined') {
  const hook = (window as { __geom?: object }).__geom
  if (hook) Object.assign(hook, { fit: (request: unknown, signal?: AbortSignal) => fitCall(request, signal) })
}
