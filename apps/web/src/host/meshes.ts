// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A SlicerHost for a browser build without the slicing engine (SLICERX_WEB_SLICING=0, the CAD-only studio). The app
// registers every mesh it makes or opens with its host to get a handle (an id, a content hash, the size and the parts),
// and the modeling tools, the plate and the Vault all do; this host keeps those meshes and answers with real hashes and
// sizes. Slicing, previews and G-code are refused with a plain message: they run in the SlicerX app.
import type { MeshHandle, MeshPart, SlicerHost } from '@slicerx/contracts'
import { meshStats, type MeshStats, type MeshStatsReply, type MeshStatsRequest } from './mesh-stats'

/** Why the browser build answers no slice. */
export const NO_SLICING = 'Slicing runs in the SlicerX app. Open this design there to slice and print it.'

/**
 * Measures meshes: their hash, size and open edges (mesh-stats.ts). Each reads every triangle, and for a project of
 * 1.3 million triangles that held the page for about half a second, so they are worked out in a worker, started with
 * the first mesh, from a copy handed over to it. On the page only where there is no worker, or when it failed.
 */
function statsMeasurer(): (parts: MeshPart[]) => Promise<MeshStats> {
  let worker: Worker | null = null
  let broken = typeof Worker === 'undefined'
  let seq = 0
  const waiting = new Map<number, { parts: MeshPart[]; resolve: (s: MeshStats) => void }>()
  const fail = (): void => {
    worker?.terminate()
    worker = null
    broken = true
    for (const w of waiting.values()) w.resolve(meshStats(w.parts))
    waiting.clear()
  }
  const start = (): Worker | null => {
    if (worker || broken) return worker
    try {
      worker = new Worker(new URL('./mesh-stats-worker.ts', import.meta.url), { type: 'module', name: 'mesh-stats' })
    } catch {
      fail()
      return null
    }
    worker.onmessage = (e: MessageEvent<MeshStatsReply>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      w.resolve(e.data.ok ? e.data.stats : meshStats(w.parts))
    }
    worker.onerror = fail
    return worker
  }
  return (parts) => {
    const w = start()
    if (!w) return Promise.resolve(meshStats(parts))
    const id = ++seq
    const copy = parts.map((p) => ({ name: p.name, slot: p.slot, positions: p.positions.slice(), indices: p.indices.slice() }))
    return new Promise((resolve) => {
      waiting.set(id, { parts, resolve })
      try {
        w.postMessage({ id, parts: copy } satisfies MeshStatsRequest, copy.flatMap((p) => [p.positions.buffer, p.indices.buffer]))
      } catch {
        waiting.delete(id)
        resolve(meshStats(parts))
      }
    })
  }
}

/** A binary STL as one part, three corners per triangle; null when the bytes are not one. */
function binaryStl(data: ArrayBuffer, name: string): MeshPart | null {
  if (data.byteLength < 84) return null
  const view = new DataView(data)
  const count = view.getUint32(80, true)
  if (data.byteLength !== 84 + count * 50) return null
  const positions = new Float32Array(count * 9)
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(84 + t * 50 + 12 + k * 4, true)
  }
  return { name, slot: 1, positions, indices: Uint32Array.from({ length: count * 3 }, (_, i) => i) }
}

export function createMeshHost(): SlicerHost {
  const meshes = new Map<string, { handle: MeshHandle; parts: MeshPart[] }>()
  const measure = statsMeasurer()
  let next = 1
  const register = async (name: string, parts: MeshPart[]): Promise<MeshHandle> => {
    // The id is taken now, so meshes are numbered in the order they came, whichever is measured first.
    const id = `mesh-${next++}`
    const stats = await measure(parts)
    const handle: MeshHandle = {
      id,
      hash: stats.hash,
      name,
      triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0),
      bboxMm: stats.bboxMm,
      openEdges: stats.openEdges,
      parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })),
    }
    meshes.set(handle.id, { handle, parts })
    return handle
  }
  const refuse = () => Promise.reject(new Error(NO_SLICING))
  return {
    async loadModel(data, fileName) {
      // A binary STL reads here; the app opens every other format with the geometry engine first.
      const part = binaryStl(data, fileName)
      if (!part) throw new Error(`${fileName}: the browser build opens this file with the geometry engine`)
      return register(fileName, [part])
    },
    loadParts: (name, parts) => register(name, parts),
    meshParts: async (id) => {
      const m = meshes.get(id)
      if (!m) throw new Error(`mesh ${id} is not loaded`)
      return m.parts
    },
    slice: refuse,
    getPreview: refuse,
    exportGcode: refuse,
    release(id) {
      meshes.delete(id)
    },
  }
}
