// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A SlicerHost for a browser build without the slicing engine (SLICERX_WEB_SLICING=0, the CAD-only studio). The app
// registers every mesh it makes or opens with its host to get a handle (an id, a content hash, the size and the parts),
// and the modeling tools, the plate and the Vault all do; this host keeps those meshes and answers with real hashes and
// sizes. Slicing, previews and G-code are refused with a plain message: they run in the SlicerX app.
import type { MeshHandle, MeshPart, SlicerHost } from '@slicerx/contracts'

/** Why the browser build answers no slice. */
export const NO_SLICING = 'Slicing runs in the SlicerX app. Open this design there to slice and print it.'

/** FNV-1a over the parts' names, slots, positions and triangles: the same parts give the same hash. */
function hashOf(parts: readonly MeshPart[]): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const eat = (b: number) => {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0
  }
  const enc = new TextEncoder()
  for (const p of parts) {
    for (const b of enc.encode(`${p.name}\0${p.slot}\0`)) eat(b)
    for (const a of [p.positions, p.indices]) {
      const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
      for (let i = 0; i < bytes.length; i++) eat(bytes[i]!)
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
    const count = new Map<string, number>()
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = p.indices[t + k]!
        const b = p.indices[t + ((k + 1) % 3)]!
        const key = a < b ? `${a},${b}` : `${b},${a}`
        count.set(key, (count.get(key) ?? 0) + 1)
      }
    }
    for (const n of count.values()) if (n === 1) open++
  }
  return open
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
  let next = 1
  const register = (name: string, parts: MeshPart[]): MeshHandle => {
    const handle: MeshHandle = {
      id: `mesh-${next++}`,
      hash: hashOf(parts),
      name,
      triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0),
      bboxMm: size(parts),
      openEdges: openEdges(parts),
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
    loadParts: async (name, parts) => register(name, parts),
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
