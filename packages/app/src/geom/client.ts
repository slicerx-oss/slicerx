// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine (sx-geom) for the app: cut, repair, simplify, hollow, emboss, orient and
// booleans. Loads on first use in a worker. A host can provide its own (for example native code in
// the desktop app) with setGeomProvider.
import type { MeshPart } from '@slicerx/contracts'

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

export function geom(): GeomProvider {
  return (provider ??= own = workerProvider())
}

/** Whether calls go to the app's own worker, which also runs jobs written in TypeScript (history.replay). */
export function usesWorker(): boolean {
  return provider === null || provider === own
}

/** The engine's mesh shape: flat arrays. */
export interface GeomMesh {
  positions: number[]
  indices: number[]
}

export function toGeom(part: Pick<MeshPart, 'positions' | 'indices'>): GeomMesh {
  return { positions: Array.from(part.positions), indices: Array.from(part.indices) }
}

export function fromGeom(mesh: GeomMesh, name: string, slot: number): MeshPart {
  return { name, slot, positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) }
}
