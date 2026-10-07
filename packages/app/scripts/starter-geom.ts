// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shape helpers for the Vault starters (vault-starters.ts): simple solids made here, joined, cut and labeled by
// sx-geom (packages/geom/wasm, the same engine the app runs), so every starter comes out as one closed body.
import { readFileSync } from 'node:fs'
import type { MeshPart } from '@slicerx/contracts'
import { bake, boxMesh, cylinderMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'

export type Pt = [number, number]
type V3 = [number, number, number]

interface FlatMesh {
  positions: number[]
  indices: number[]
}

interface GeomExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  geom_call(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
}

export interface Geom {
  /** One sx-geom operation: request in, response out. Throws with the engine's message. */
  call<T>(op: string, request: unknown): T
}

/** The full sx-geom build from packages/geom/wasm/pkg. */
export async function loadGeom(): Promise<Geom> {
  const url = new URL('../../geom/wasm/pkg/sx_geom_wasm.wasm', import.meta.url)
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(url)), {})
  const x = instance.exports as unknown as GeomExports
  const text = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
  return {
    call<T>(op: string, request: unknown): T {
      const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(request)}`)
      // geom_input may grow the memory, so the buffer is read after it.
      const at = x.geom_input(bytes.length)
      new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
      if (x.geom_call() !== 0) throw new Error(`${op}: ${text(x.geom_error_ptr(), x.geom_error_len())}`)
      return JSON.parse(text(x.geom_out_ptr(), x.geom_out_len())) as T
    },
  }
}

const flat = (m: MeshPart): FlatMesh => ({ positions: Array.from(m.positions), indices: Array.from(m.indices) })
const part = (name: string, m: FlatMesh, slot = 1): MeshPart => ({ name, slot, positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices) })

/** Moves and turns a solid (degrees about X, then Y, then Z). */
export function place(m: MeshPart, at: V3, rotation: V3 = [0, 0, 0]): MeshPart {
  return { ...bake(m, compose({ position: at, rotation, scale: [1, 1, 1] })), name: m.name, slot: m.slot }
}

/** A box between two corners. */
export function box(min: V3, max: V3): MeshPart {
  return place(boxMesh(max[0] - min[0], max[1] - min[1], max[2] - min[2]), [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]])
}

/** A cylinder, or a cone with `top`, standing on `at` along Z. */
export function cylinder(at: V3, diameter: number, height: number, top = diameter): MeshPart {
  return place(cylinderMesh(diameter, height, 48, top), at)
}

/** Turns the triangles to face outward: a mesh whose signed volume is negative is inside out. */
function outward(m: MeshPart): MeshPart {
  let v = 0
  const P = m.positions
  for (let i = 0; i + 2 < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i]! * 3, m.indices[i + 1]! * 3, m.indices[i + 2]! * 3]
    v += P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) - P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) + P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!)
  }
  if (v >= 0) return m
  const ix = new Uint32Array(m.indices.length)
  for (let i = 0; i + 2 < ix.length; i += 3) {
    ix[i] = m.indices[i]!
    ix[i + 1] = m.indices[i + 2]!
    ix[i + 2] = m.indices[i + 1]!
  }
  return { ...m, indices: ix }
}

/** A prism from a convex outline (u, v) extruded `depth`, centered on the plane: in XZ along Y, or in YZ along X. */
export function prism(plane: 'xz' | 'yz', outline: readonly Pt[], depth: number): MeshPart {
  const n = outline.length
  const p: number[] = []
  for (const side of [-depth / 2, depth / 2]) for (const [u, v] of outline) p.push(...(plane === 'xz' ? [u, side, v] : [side, u, v]))
  const ix: number[] = []
  for (let i = 1; i + 1 < n; i++) ix.push(0, i, i + 1, n, n + i + 1, n + i)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    ix.push(i, n + i, j, j, n + i, n + j)
  }
  return outward({ name: 'prism', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(ix) })
}

/** The outline of an arc, `steps` segments from `from` to `to` radians. */
export function arc(cx: number, cy: number, r: number, from: number, to: number, steps: number): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as Pt
  })
}

/** A flat outline (convex or not, no holes) extruded along Z from z0 to z1, through sx-geom's prism. */
export function extrudeZ(geom: Geom, outline: readonly Pt[], z0: number, z1: number): MeshPart {
  // A Z axis frame has u along +Y and v along -X, so (x, y) goes in as (y, -x).
  const points = outline.map(([x, y]) => [y, -x])
  const r = geom.call<{ mesh: FlatMesh }>('build', { solids: [{ type: 'prism', origin: [0, 0, z0], axis: [0, 0, 1], points, heightMm: z1 - z0 }] })
  return part('prism', r.mesh)
}

/** Everything joined into one body. */
export function union(geom: Geom, name: string, solids: readonly MeshPart[]): MeshPart {
  const r = geom.call<{ mesh: FlatMesh }>('boolean', { op: 'union', a: solids.map((m) => ({ mesh: flat(m) })), b: [] })
  return part(name, r.mesh)
}

/** `body` with the cutters taken out. */
export function cut(geom: Geom, body: MeshPart, cutters: readonly MeshPart[]): MeshPart {
  const r = geom.call<{ mesh: FlatMesh }>('boolean', { op: 'difference', a: [{ mesh: flat(body) }], b: cutters.map((m) => ({ mesh: flat(m) })) })
  return part(body.name, r.mesh, body.slot)
}

/** Text cut into (deboss) or raised from (emboss) the flat face at `point`, reading upright along `up`. */
export function label(geom: Geom, body: MeshPart, text: string, point: V3, normal: V3, up: V3, sizeMm: number, mode: 'deboss' | 'emboss' = 'deboss', depthMm = 0.6): MeshPart {
  const r = geom.call<{ mesh: FlatMesh }>('emboss', { mesh: flat(body), spec: { text, point, normal, up, sizeMm, depthMm, mode } })
  return part(body.name, r.mesh, body.slot)
}

/** A countersunk screw hole along `axis` (a unit axis), its head at `at` on the face the screw goes in from. */
export function screwHole(at: V3, axis: 'x' | 'y' | 'z', sign: 1 | -1, length: number, shaft = 4.2, head = 8.4): MeshPart[] {
  // Built along +Z from the head face, then turned onto the axis; the head cone is 90 degrees, as wood screws are.
  const rot: Record<'x' | 'y' | 'z', V3> = { x: [0, sign * 90, 0], y: [sign * -90, 0, 0], z: sign > 0 ? [0, 0, 0] : [180, 0, 0] }
  const sink = (head - shaft) / 2
  // The cone starts a little outside the face and the shaft runs a little past the far side, so both cut cleanly.
  return [cylinderMesh(head + 0.4, sink + 0.2, 48, shaft), cylinderMesh(shaft, length + 0.4, 48)].map((m) => place(place(m, [0, 0, -0.2]), at, rot[axis]))
}
