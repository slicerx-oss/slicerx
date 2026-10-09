// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A painted object for the engine: its parts in the raw parts format with the paint block after them
// (packages/core/src/mesh.rs, `from_raw`), loaded through the slicer's loadModel, which takes raw parts as it takes
// a file. Only painted objects need it, so it loads with them and not with the app.
import type { MeshPart } from '@slicerx/contracts'

const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/** Copies the values into the buffer as little-endian 32-bit numbers. */
function put(buf: Uint8Array, v: DataView, at: number, a: Float32Array | Uint32Array, float: boolean): number {
  if (LITTLE) {
    buf.set(new Uint8Array(a.buffer, a.byteOffset, a.length * 4), at)
    return at + a.length * 4
  }
  for (let k = 0; k < a.length; k++, at += 4) {
    if (float) v.setFloat32(at, a[k] ?? 0, true)
    else v.setUint32(at, a[k] ?? 0, true)
  }
  return at
}

/** The parts and their paint in the raw parts format: what `Mesh::from_raw` reads. */
export function encodePaintedParts(parts: readonly MeshPart[]): Uint8Array {
  const enc = new TextEncoder()
  const names = parts.map((p) => enc.encode(p.name).slice(0, 65535))
  const paint = paintEntries(parts)
  let size = 8 + paintBytes(paint)
  parts.forEach((p, i) => {
    size += 3 + (names[i]?.length ?? 0) + 4 + Math.floor(p.positions.length / 3) * 12 + 4 + Math.floor(p.indices.length / 3) * 12
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
    o = put(buf, v, o + 4, p.positions.subarray(0, nv * 3), true)
    const nt = Math.floor(p.indices.length / 3)
    v.setUint32(o, nt, true)
    o = put(buf, v, o + 4, p.indices.subarray(0, nt * 3), false)
  })
  writePaint(buf, v, o, paint)
  return buf
}

/** The paint of each part in raw parts bytes, by part, or a part's undefined when it has none. A block cut short is refused. */
export function decodePartPaint(raw: Uint8Array): (MeshPart['paint'] | undefined)[] {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const count = v.getUint32(4, true)
  let o = 8
  const parts: MeshPart[] = []
  for (let i = 0; i < count; i++) {
    o += 3 + v.getUint16(o + 1, true)
    o += 4 + v.getUint32(o, true) * 12
    o += 4 + v.getUint32(o, true) * 12
    parts.push({ name: '', slot: 1, positions: new Float32Array(), indices: new Uint32Array() })
  }
  if (o + 4 <= raw.length && PAINT_MAGIC.every((b, i) => raw[o + i] === b)) readPaint(raw, v, o, parts)
  return parts.map((p) => p.paint)
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

