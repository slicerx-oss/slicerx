// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshPart } from '@slicerx/contracts'

/** Encodes geometry buffers in the raw parts format sx-core reads (`Mesh::from_raw`). */
export function encodeParts(parts: MeshPart[]): Uint8Array {
  const enc = new TextEncoder()
  const names = parts.map((p) => enc.encode(p.name).slice(0, 65535))
  let size = 8
  parts.forEach((p, i) => {
    size += 1 + 2 + (names[i]?.length ?? 0) + 4 + p.positions.length * 4 + 4 + p.indices.length * 4
  })
  const paint = paintEntries(parts)
  size += paintBytes(paint)
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
    for (let k = 0; k < nv * 3; k++, o += 4) v.setFloat32(o, p.positions[k] ?? 0, true)
    const nt = Math.floor(p.indices.length / 3)
    v.setUint32(o, nt, true)
    o += 4
    for (let k = 0; k < nt * 3; k++, o += 4) v.setUint32(o, p.indices[k] ?? 0, true)
  })
  o = writePaint(buf, v, o, paint)
  return buf.subarray(0, o)
}

/** The paint layers in the order of their numbers in the paint block. */
const PAINT_LAYERS = ['color', 'seam', 'support', 'fuzzy'] as const

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
 * The optional paint block after the parts (packages/core/src/mesh.rs, `from_raw`): magic `SXPT`, u32 entry count,
 * then per entry u32 part, u8 layer (0 color, 1 seam, 2 support, 3 fuzzy), u32 triangle count, and per triangle u32
 * triangle index, u16 text length and the text. Nothing is written when nothing is painted.
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

const PAINT_MAGIC = new Uint8Array([0x53, 0x58, 0x50, 0x54])

/** Reads the paint block into the parts' paint. Lengths that run past the end of the buffer are refused. */
function readPaint(raw: Uint8Array, v: DataView, at: number, parts: MeshPart[]): void {
  const need = (o: number, n: number) => {
    if (o + n > raw.length) throw new Error('Truncated paint block in a raw parts buffer')
  }
  const dec = new TextDecoder()
  let o = at + 4
  need(o, 4)
  const count = v.getUint32(o, true)
  o += 4
  for (let i = 0; i < count; i++) {
    need(o, 9)
    const part = v.getUint32(o, true)
    const layer = PAINT_LAYERS[v.getUint8(o + 4)]
    const n = v.getUint32(o + 5, true)
    o += 9
    const texts: Record<number, string> = {}
    for (let k = 0; k < n; k++) {
      need(o, 6)
      const t = v.getUint32(o, true)
      const len = v.getUint16(o + 4, true)
      need(o + 6, len)
      texts[t] = dec.decode(raw.subarray(o + 6, o + 6 + len))
      o += 6 + len
    }
    const p = parts[part]
    if (p && layer) p.paint = { ...p.paint, [layer]: texts }
  }
}

/** A 20 mm cube as one part on slot 1, for warming up workers. */
export function cubePart(): MeshPart {
  const positions = new Float32Array([0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  return { name: 'warm-up cube', slot: 1, positions, indices }
}

/** Reads the raw parts format back into geometry buffers (the inverse of `encodeParts`). */
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
  if (o + 4 <= raw.length && raw[o] === PAINT_MAGIC[0] && raw[o + 1] === PAINT_MAGIC[1] && raw[o + 2] === PAINT_MAGIC[2] && raw[o + 3] === PAINT_MAGIC[3]) readPaint(raw, v, o, parts)
  return parts
}
