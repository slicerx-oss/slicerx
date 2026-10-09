// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paint block of the raw parts format (packages/core/src/mesh.rs, `from_raw`): each painted triangle's text, so a
// painted object reaches the engine as its parts. Kept out of parts.ts, which loads with the app: only painted parts
// need it.
import type { MeshPart } from '@slicerx/contracts'
import { decodePartsAt, encodeParts } from './parts'

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

/** The paint block for these parts, or nothing when none is painted. */
export function paintBlock(parts: readonly MeshPart[]): Uint8Array | undefined {
  const entries = paintEntries(parts)
  if (!entries.length) return undefined
  const buf = new Uint8Array(paintBytes(entries))
  writePaint(buf, new DataView(buf.buffer), 0, entries)
  return buf
}

/** Raw parts with their paint block. */
export function encodePaintedParts(parts: MeshPart[]): Uint8Array {
  return encodeParts(parts, paintBlock(parts))
}

/** Reads raw parts and their paint block (the inverse of `encodePaintedParts`). A block cut short is refused. */
export function decodePaintedParts(raw: Uint8Array): MeshPart[] {
  const { parts, end } = decodePartsAt(raw)
  if (end + 4 <= raw.length && PAINT_MAGIC.every((b, i) => raw[end + i] === b)) readPaint(raw, new DataView(raw.buffer, raw.byteOffset, raw.byteLength), end, parts)
  return parts
}
