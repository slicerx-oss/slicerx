// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshPart } from '@slicerx/contracts'

/**
 * Encodes geometry buffers in the raw parts format sx-core reads (`Mesh::from_raw`). `tail` goes after the parts: the
 * paint block (`paintBlock` in parts-paint.ts, loaded only for painted parts).
 */
export function encodeParts(parts: MeshPart[], tail?: Uint8Array): Uint8Array {
  const enc = new TextEncoder()
  const names = parts.map((p) => enc.encode(p.name).slice(0, 65535))
  let size = 8
  parts.forEach((p, i) => {
    size += 1 + 2 + (names[i]?.length ?? 0) + 4 + p.positions.length * 4 + 4 + p.indices.length * 4
  })
  size += tail?.length ?? 0
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
  if (tail) buf.set(tail, o)
  return buf.subarray(0, o + (tail?.length ?? 0))
}

/** A 20 mm cube as one part on slot 1, for warming up workers. */
export function cubePart(): MeshPart {
  const positions = new Float32Array([0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  return { name: 'warm-up cube', slot: 1, positions, indices }
}

/** Reads the raw parts format back into geometry buffers (the inverse of `encodeParts`). */
export function decodeParts(raw: Uint8Array): MeshPart[] {
  return decodePartsAt(raw).parts
}

/** The parts, and where the bytes after them start (an optional paint block, read by parts-paint.ts). */
export function decodePartsAt(raw: Uint8Array): { parts: MeshPart[]; end: number } {
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
  return { parts, end: o }
}
