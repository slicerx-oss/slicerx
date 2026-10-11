// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A few workers that make big parts' creased normals and feature edges (mesh-worker.ts), so opening a model of millions
// of triangles does not hold the page's main thread for seconds. Workers start when the first job comes and are kept
// for the next ones. A worker that fails takes its jobs down with it; the caller then builds those parts itself.
import type { CreasedArrays } from './mesh-math'
import type { MeshBuildReply, MeshBuildRequest } from './mesh-worker'

/** What the pool needs of a Worker. */
export interface MeshWorkerLike {
  postMessage(message: MeshBuildRequest): void
  onmessage: ((e: MessageEvent<MeshBuildReply>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
  terminate(): void
}

interface Slot {
  worker: MeshWorkerLike
  jobs: Set<number>
}

interface Wait {
  slot: Slot
  resolve(reply: MeshBuildReply & { ok: true }): void
  reject(e: Error): void
}

/** How many workers suit this machine: a couple of cores stay for the page and the engine, never more than four. */
export function meshPoolSize(cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0): number {
  return Math.max(1, Math.min(4, (cores || 4) - 2))
}

export class MeshBuildPool {
  private readonly slots: Slot[] = []
  private readonly waits = new Map<number, Wait>()
  private seq = 0
  private disposed = false

  constructor(
    private readonly make: () => MeshWorkerLike,
    private readonly size = meshPoolSize(),
  ) {}

  /** The creased geometry of a part (creasedArrays). The part's arrays are copied to the worker, not moved. */
  crease(positions: Float32Array, indices: Uint32Array | Uint16Array, deg: number): Promise<CreasedArrays> {
    return this.run('crease', positions, indices, deg).then((r) => {
      if (!r.crease) throw new Error('the mesh worker sent no geometry')
      return r.crease
    })
  }

  /** The feature edges of a part (featureEdges), as line segment positions. */
  edges(positions: Float32Array, indices: Uint32Array | Uint16Array, deg: number): Promise<Float32Array> {
    return this.run('edges', positions, indices, deg).then((r) => {
      if (!r.edges) throw new Error('the mesh worker sent no edges')
      return r.edges
    })
  }

  /** Jobs sent and not answered yet. */
  get pending(): number {
    return this.waits.size
  }

  dispose(): void {
    this.disposed = true
    for (const s of this.slots.splice(0)) this.fail(s, 'the viewport was disposed')
  }

  private run(kind: MeshBuildRequest['kind'], positions: Float32Array, indices: Uint32Array | Uint16Array, deg: number): Promise<MeshBuildReply & { ok: true }> {
    if (this.disposed) return Promise.reject(new Error('the viewport was disposed'))
    let slot: Slot
    try {
      slot = this.pick()
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.waits.set(id, { slot, resolve, reject })
      slot.jobs.add(id)
      try {
        slot.worker.postMessage({ id, kind, positions, indices, deg })
      } catch (e) {
        this.waits.delete(id)
        slot.jobs.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** The least busy worker, starting another while the pool has room and every running one has work. */
  private pick(): Slot {
    const idle = this.slots.reduce<Slot | null>((best, s) => (!best || s.jobs.size < best.jobs.size ? s : best), null)
    if (idle && (idle.jobs.size === 0 || this.slots.length >= this.size)) return idle
    const worker = this.make()
    const slot: Slot = { worker, jobs: new Set() }
    worker.onmessage = (e) => this.answer(slot, e.data)
    worker.onerror = (e) => {
      const i = this.slots.indexOf(slot)
      if (i >= 0) this.slots.splice(i, 1)
      this.fail(slot, e?.message || 'the mesh worker failed')
    }
    this.slots.push(slot)
    return slot
  }

  private answer(slot: Slot, reply: MeshBuildReply): void {
    const w = this.waits.get(reply.id)
    if (!w) return
    this.waits.delete(reply.id)
    slot.jobs.delete(reply.id)
    if (reply.ok) w.resolve(reply)
    else w.reject(new Error(reply.error))
  }

  private fail(slot: Slot, message: string): void {
    for (const id of slot.jobs) {
      const w = this.waits.get(id)
      this.waits.delete(id)
      w?.reject(new Error(message))
    }
    slot.jobs.clear()
    slot.worker.onmessage = null
    slot.worker.onerror = null
    slot.worker.terminate()
  }
}
