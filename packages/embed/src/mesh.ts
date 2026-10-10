// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model decoders for the viewport: STL and the quantized sample JSON. Positions
// in mm, Z up. The app uses these too (@slicerx/embed/mesh).
import type { MeshPart } from '@slicerx/contracts'
import { z } from 'zod'

/** The quantized mesh JSON (Z up, mm, uint16 positions). */
const quantizedSchema = z.object({
  slug: z.string(),
  name: z.string(),
  bboxMm: z.tuple([z.number(), z.number(), z.number()]),
  tris: z.number(),
  qMin: z.tuple([z.number(), z.number(), z.number()]),
  qMax: z.tuple([z.number(), z.number(), z.number()]),
  parts: z.array(
    z.object({
      name: z.string(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      extruder: z.number().int().min(1).max(64).optional(),
      pos: z.string(),
      idx: z.string(),
      idx32: z.boolean().optional(),
    }),
  ),
})

export interface DecodedModel {
  name: string
  bboxMm: [number, number, number]
  triangles: number
  parts: MeshPart[]
  colors: string[]
  /**
   * What was taken off the file's coordinates, mm: an STL is centered in X and Y and set down on Z 0. Turn a
   * viewport transform into one for the file itself with `fileTransform` before a slice request names the file.
   */
  offset: [number, number, number]
}

/**
 * A plate transform for a decoded model (4x4 column-major, mm) turned into the transform of the model file it came
 * from, for an `sx slice` request that names the file: the same placement, with the decoder's `offset` put back.
 */
export function fileTransform(transform: readonly number[], offset: readonly [number, number, number]): number[] {
  const m = Array.from(transform)
  const [x, y, z] = offset
  for (let r = 0; r < 3; r++) m[12 + r] = (m[12 + r] ?? 0) - ((m[r] ?? 0) * x + (m[4 + r] ?? 0) * y + (m[8 + r] ?? 0) * z)
  return m
}

function b64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function decodeQuantized(json: unknown): DecodedModel {
  const m = quantizedSchema.parse(json)
  const [x0, y0, z0] = m.qMin
  const sx = (m.qMax[0] - x0) / 65535
  const sy = (m.qMax[1] - y0) / 65535
  const sz = (m.qMax[2] - z0) / 65535
  const parts: MeshPart[] = m.parts.map((p, i) => {
    const pb = b64(p.pos)
    const q = new Uint16Array(pb.buffer, 0, pb.length >> 1)
    const positions = new Float32Array(q.length)
    for (let v = 0; v + 2 < q.length; v += 3) {
      positions[v] = x0 + (q[v] ?? 0) * sx
      positions[v + 1] = y0 + (q[v + 1] ?? 0) * sy
      positions[v + 2] = z0 + (q[v + 2] ?? 0) * sz
    }
    const ib = b64(p.idx)
    const indices = p.idx32 ? new Uint32Array(ib.buffer, 0, ib.length >> 2) : Uint32Array.from(new Uint16Array(ib.buffer, 0, ib.length >> 1))
    return { name: p.name, slot: p.extruder ?? i + 1, positions, indices }
  })
  return { name: m.name, bboxMm: m.bboxMm, triangles: m.tris, parts, colors: m.parts.map((p) => p.color), offset: [0, 0, 0] }
}

/** Binary or ASCII STL to one part, vertices unwelded. */
export function decodeStl(buf: ArrayBuffer, name: string): DecodedModel {
  const view = new DataView(buf)
  const count = buf.byteLength >= 84 ? view.getUint32(80, true) : 0
  const isBinary = buf.byteLength === 84 + count * 50
  let positions: Float32Array
  if (isBinary) {
    positions = new Float32Array(count * 9)
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50 + 12
      for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(o + k * 4, true)
    }
  } else {
    const text = new TextDecoder().decode(buf)
    const nums: number[] = []
    for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]))
    if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) throw new Error(`${name} is not a readable STL file`)
    positions = Float32Array.from(nums)
  }
  const indices = new Uint32Array(positions.length / 3)
  for (let i = 0; i < indices.length; i++) indices[i] = i
  // Center in X and Y and drop onto the bed, as the reference models are stored.
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a] ?? 0
      if (v < (min[a] ?? 0)) min[a] = v
      if (v > (max[a] ?? 0)) max[a] = v
    }
  }
  const [minX = 0, minY = 0, minZ = 0] = min
  const [maxX = 0, maxY = 0, maxZ = 0] = max
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] ?? 0) - cx
    positions[i + 1] = (positions[i + 1] ?? 0) - cy
    positions[i + 2] = (positions[i + 2] ?? 0) - minZ
  }
  return {
    name: name.replace(/\.[^.]+$/, ''),
    bboxMm: [maxX - minX, maxY - minY, maxZ - minZ],
    triangles: indices.length / 3,
    parts: [{ name: 'Part 1', slot: 1, positions, indices }],
    // white PLA: a part in the accent color would hide the accent selection outline
    colors: ['#ebebe6'],
    offset: [cx, cy, minZ],
  }
}
