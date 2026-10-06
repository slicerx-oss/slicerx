// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine (sx-geom) for the app: cut, repair, simplify, hollow, emboss, orient and
// booleans. Loads on first use in a worker. A host can provide its own (for example native code in
// the desktop app) with setGeomProvider.
import type { FaceSurface, MeshPart } from '@slicerx/contracts'

export interface GeomProvider {
  call<T = unknown>(op: string, request: unknown, signal?: AbortSignal): Promise<T>
}

let provider: GeomProvider | null = null

export function setGeomProvider(p: GeomProvider | null): void {
  provider = p
}

function workerProvider(): GeomProvider {
  let worker: Worker | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const start = () => {
    if (worker) return worker
    worker = new Worker(new URL('./geom-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id)
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
      return new Promise<T>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        signal?.addEventListener('abort', () => {
          if (pending.delete(id)) reject(new DOMException('Canceled', 'AbortError'))
          // A history replay stops at its next step; single calls just lose their answer.
          if (op === 'history.replay') worker?.postMessage({ cancel: id })
        }, { once: true })
        start().postMessage({ id, op, request })
      })
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
