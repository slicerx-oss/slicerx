// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshPart } from '@slicerx/contracts'

/**
 * Encodes geometry buffers and their paint in the raw parts format sx-core reads (`Mesh::from_raw`): the bytes
 * `Mesh::to_raw` writes for the same parts, so the engine's copy has the same content hash and slices the same.
 */
export function encodeParts(parts: MeshPart[]): Uint8Array {
  const enc = new TextEncoder()
  const names = parts.map((p) => enc.encode(p.name).slice(0, 65535))
  const paint = paintEntries(parts)
  let size = 8 + paintBytes(paint)
  parts.forEach((p, i) => {
    size += 1 + 2 + (names[i]?.length ?? 0) + 4 + p.positions.length * 4 + 4 + p.indices.length * 4
  })
  const buf = new Uint8Array(size)
  const v = new DataView(buf.buffer)
  buf.set(enc.encode('SXMP'))
  v.setUint32(4, parts.length, true)
  let o = 8
  parts.forEach((p, i) => {
    const name = names[i] ?? new Uint8Array()
    v.setUint8(o, Math.max(1, Math.min(255, p.slot)))
    v.setUint16(o + 1, name.length, true)
    buf.set(name, o + 3)
    o += 3 + name.length
    const nv = Math.floor(p.positions.length / 3)
    v.setUint32(o, nv, true)
    o += 4
    o = putArray(buf, v, o, p.positions, nv * 3, 'float')
    const nt = Math.floor(p.indices.length / 3)
    v.setUint32(o, nt, true)
    o += 4
    o = putArray(buf, v, o, p.indices, nt * 3, 'uint')
  })
  o = writePaint(buf, v, o, paint)
  return buf.subarray(0, o)
}

/** The paint layers in the order of their numbers in the paint block. */
const PAINT_LAYERS = ['color', 'seam', 'support', 'fuzzy'] as const
const PAINT_MAGIC = new Uint8Array([0x53, 0x58, 0x50, 0x54])

interface PaintEntry {
  part: number
  layer: number
  /** Triangle index and paint text, ascending by triangle. Texts are ASCII hex. */
  tris: [number, Uint8Array][]
}

/** Every painted layer of every part, with a text, as the paint block lists them. */
function paintEntries(parts: readonly MeshPart[]): PaintEntry[] {
  const enc = new TextEncoder()
  const out: PaintEntry[] = []
  parts.forEach((p, part) => {
    PAINT_LAYERS.forEach((name, layer) => {
      const texts = p.paint?.[name]
      if (!texts) return
      const nt = Math.floor(p.indices.length / 3)
      const tris: [number, Uint8Array][] = []
      for (const [k, text] of Object.entries(texts)) {
        const t = Number(k)
        if (!text || !Number.isInteger(t) || t < 0 || t >= nt) continue
        tris.push([t, enc.encode(text).slice(0, 65535)])
      }
      if (tris.length) out.push({ part, layer, tris: tris.sort((a, b) => a[0] - b[0]) })
    })
  })
  return out
}

function paintBytes(entries: readonly PaintEntry[]): number {
  if (!entries.length) return 0
  let n = 4 + 4
  for (const e of entries) {
    n += 4 + 1 + 4
    for (const [, text] of e.tris) n += 4 + 2 + text.length
  }
  return n
}

/**
 * The optional paint block after the parts (packages/core/src/mesh.rs, `from_raw`, and `Mesh::to_raw` writes the
 * same): magic `SXPT`, u32 entry count, then per entry u32 part, u8 layer (0 color, 1 seam, 2 support, 3 fuzzy), u32
 * triangle count, and per triangle u32 triangle index, u16 text length and the text. Nothing is written when nothing
 * is painted, so a plain mesh's bytes are what they were.
 */
function writePaint(buf: Uint8Array, v: DataView, at: number, entries: readonly PaintEntry[]): number {
  if (!entries.length) return at
  let o = at
  buf.set(PAINT_MAGIC, o)
  v.setUint32(o + 4, entries.length, true)
  o += 8
  for (const e of entries) {
    v.setUint32(o, e.part, true)
    v.setUint8(o + 4, e.layer)
    v.setUint32(o + 5, e.tris.length, true)
    o += 9
    for (const [t, text] of e.tris) {
      v.setUint32(o, t, true)
      v.setUint16(o + 4, text.length, true)
      buf.set(text, o + 6)
      o += 6 + text.length
    }
  }
  return o
}

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/**
 * Writes the first `n` values of a float or uint array little-endian at `o`, and returns the offset after them. A
 * little-endian machine (every one the app runs on) copies the bytes in one go: a model of millions of triangles took
 * a DataView call per value.
 */
function putArray(buf: Uint8Array, v: DataView, o: number, a: ArrayLike<number>, n: number, kind: 'float' | 'uint'): number {
  if (LITTLE && (kind === 'float' ? a instanceof Float32Array : a instanceof Uint32Array)) {
    const t = a as Float32Array | Uint32Array
    buf.set(new Uint8Array(t.buffer, t.byteOffset, n * 4), o)
    return o + n * 4
  }
  for (let k = 0; k < n; k++, o += 4) {
    if (kind === 'float') v.setFloat32(o, a[k] ?? 0, true)
    else v.setUint32(o, a[k] ?? 0, true)
  }
  return o
}

/** A 20 mm cube as one part on slot 1, for warming up workers. */
export function cubePart(): MeshPart {
  const positions = new Float32Array([0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  return { name: 'warm-up cube', slot: 1, positions, indices }
}

/** Reads the raw parts format back into geometry buffers (the inverse of `encodeParts` for the geometry; it stops before the paint block). */
export function decodeParts(raw: Uint8Array): MeshPart[] {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw.length < 8 || new TextDecoder().decode(raw.subarray(0, 4)) !== 'SXMP') throw new Error('Not a raw parts buffer')
  const count = v.getUint32(4, true)
  const dec = new TextDecoder()
  const parts: MeshPart[] = []
  let o = 8
  for (let i = 0; i < count; i++) {
    const slot = v.getUint8(o)
    const nameLen = v.getUint16(o + 1, true)
    const name = dec.decode(raw.subarray(o + 3, o + 3 + nameLen))
    o += 3 + nameLen
    const nv = v.getUint32(o, true)
    o += 4
    // slice() copies into a fresh buffer, so the typed arrays are aligned.
    const positions = new Float32Array(raw.slice(o, o + nv * 12).buffer)
    o += nv * 12
    const nt = v.getUint32(o, true)
    o += 4
    const indices = new Uint32Array(raw.slice(o, o + nt * 12).buffer)
    o += nt * 12
    parts.push({ name, slot, positions, indices })
  }
  return parts
}
