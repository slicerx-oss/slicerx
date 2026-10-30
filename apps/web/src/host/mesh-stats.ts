// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the mesh-only host (meshes.ts) tells the app about each mesh it keeps: a content hash, the size and the open
// edges. Each reads every triangle, so a big project's meshes are measured in a worker (mesh-stats-worker.ts); this
// module has no page or worker code of its own, so both run it.
import type { MeshPart } from '@slicerx/contracts'

export interface MeshStats {
  hash: string
  bboxMm: [number, number, number]
  openEdges: number
}

/** A mesh's parts, as the page sends them to the worker. */
export interface MeshStatsRequest {
  id: number
  parts: MeshPart[]
}

export type MeshStatsReply = { id: number; ok: true; stats: MeshStats } | { id: number; ok: false; error: string }

/** FNV-1a over the parts' names, slots, positions and triangles: the same parts give the same hash. */
function hashOf(parts: readonly MeshPart[]): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const enc = new TextEncoder()
  for (const p of parts) {
    for (const b of enc.encode(`${p.name}\0${p.slot}\0`)) {
      h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0
    }
    for (const a of [p.positions, p.indices]) {
      const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]!
        h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0
        h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0
      }
    }
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

function size(parts: readonly MeshPart[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    for (let i = 0; i + 2 < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.positions[i + k]!
        if (v < lo[k]!) lo[k] = v
        if (v > hi[k]!) hi[k] = v
      }
    }
  }
  return lo[0] === Infinity ? [0, 0, 0] : [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!]
}

/** Edges used by one triangle only: a closed mesh has none. */
function openEdges(parts: readonly MeshPart[]): number {
  let open = 0
  for (const p of parts) {
    let top = 0
    for (let i = 0; i < p.indices.length; i++) if (p.indices[i]! > top) top = p.indices[i]!
    // Each edge as one number, low corner times the vertex count plus the high one, while that stays exact.
    const n = top + 1
    const exact = n * n <= Number.MAX_SAFE_INTEGER
    const count = new Map<number | string, number>()
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = p.indices[t + k]!
        const b = p.indices[t + ((k + 1) % 3)]!
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const key = exact ? lo * n + hi : `${lo},${hi}`
        count.set(key, (count.get(key) ?? 0) + 1)
      }
    }
    for (const c of count.values()) if (c === 1) open++
  }
  return open
}

/** The hash, size and open edges of a mesh's parts. */
export function meshStats(parts: readonly MeshPart[]): MeshStats {
  return { hash: hashOf(parts), bboxMm: size(parts), openEdges: openEdges(parts) }
}

/** The worker's answer to one request. */
export function answerMeshStats(req: MeshStatsRequest): MeshStatsReply {
  try {
    return { id: req.id, ok: true, stats: meshStats(req.parts) }
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
