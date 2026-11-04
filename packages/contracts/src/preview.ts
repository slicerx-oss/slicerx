// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The SXPV preview buffer format (docs/architecture.md, "SXPV
// preview buffer format") and a zero-copy reader. Rust writes it in sx-core.

export const SXPV_MAGIC = 0x56505853 // "SXPV" as a little-endian u32
export const SXPV_VERSION = 1
/**
 * SXPV v2: the v1 buffer in about a fifth of the bytes, layer by layer, which {@link readPreview} expands back into
 * the exact v1 bytes (docs/architecture.md, "SXPV v2"). A slice writes it only when the request asks for it
 * (`options.previewFormat: 'v2'`).
 */
export const SXPV_VERSION_2 = 2
export const SXPV_HEADER_BYTES = 32
export const SXPV_SEGMENT_BYTES = 32
export const SXPV_TRAVEL_BYTES = 16
export const SXPV_FLAG_TRAVELS = 1
/** Per-segment extras follow the travels; only present together with travels and G-code. */
export const SXPV_FLAG_EXTRAS = 2
export const SXPV_EXTRA_BYTES = 8
/**
 * Per-segment object index follows the extras (or the travels when there are none): one u16 per segment, the
 * index in the request's `plate.objects`, padded to four bytes. Written when the plate has two or more objects;
 * readers that do not know the flag skip it.
 */
export const SXPV_FLAG_OBJECTS = 4
export const SXPV_OBJECT_BYTES = 2
/**
 * With the extras: their G-code lines count from the segment's layer's `;LAYER_CHANGE` line (0xffffffff when
 * unknown), as one shard of a parallel slice writes them. Stitching makes them absolute with the finished file's
 * layer lines (0 when those are missing) and clears the flag, so only raw shard buffers carry it.
 */
export const SXPV_FLAG_LAYER_LINES = 8
/** The object index of the skirt, a brim shared by several objects, the prime tower and custom G-code. */
export const SXPV_OBJECT_NONE = 0xffff

/** Byte offsets inside one 32-byte segment record. */
export const SXPV_SEGMENT = {
  x0: 0, y0: 4, x1: 8, y1: 12, z: 16,
  widthUm: 20, heightUm: 22,
  feature: 24, tool: 25, speedDeciMmS: 26,
  flowMm3S: 28,
} as const

/** Byte offsets inside one 8-byte extras record (one per segment, in segment order). */
export const SXPV_EXTRA = { fan: 0, flags: 1, nozzleC: 2, gcodeLine: 4 } as const
/** Bits of the extras `flags` byte. They sit on the first segment of a path (seam: of a closed wall loop). */
export const SXPV_EXTRA_FLAG = { retract: 1, lift: 2, seam: 4, pathStart: 8 } as const
/** Travel flag bytes (one per travel) use the retract and lift bits: the nozzle retracted or lifted for that move. */

export const FEATURE = {
  outerWall: 0,
  innerWall: 1,
  overhangWall: 2,
  topSurface: 3,
  bottomSurface: 4,
  internalSolid: 5,
  sparseInfill: 6,
  bridge: 7,
  support: 8,
  supportInterface: 9,
  brimSkirt: 10,
  ironing: 11,
  gapFill: 12,
  primeTower: 13,
  custom: 14,
  skirt: 15,
  internalBridge: 16,
} as const
export type FeatureId = (typeof FEATURE)[keyof typeof FEATURE]

export interface PreviewBuffers {
  /** The buffer in the v1 layout (a v2 buffer arrives expanded). */
  raw: ArrayBuffer
  /** The layout of `raw`: always 1. */
  version: number
  /** The version of the buffer that was read: 1, or 2 when it was expanded. */
  encodedVersion?: number
  segmentCount: number
  layerCount: number
  travelCount: number
  toolCount: number
  layerHeight: number
  /** First segment index of each layer; length layerCount + 1, last entry = segmentCount. */
  layerStart: Uint32Array
  layerZ: Float32Array
  layerTimeS: Float32Array
  /** First travel index of each layer, or null when the buffer has no travels. */
  travelStart: Uint32Array | null
  /** Byte offset of the first segment record in raw (4-byte aligned). */
  segmentsOffset: number
  /** Byte offset of the first travel record, or -1 when there are none. */
  travelsOffset: number
  /**
   * Byte offset of the first segment's 8-byte extras record (fan 0 to 255, flags, nozzle temperature in C,
   * G-code line, 1-based, 0 when unknown), or -1 when the buffer has no extras.
   */
  extrasOffset: number
  /** Byte offset of the travel flag bytes (one per travel, retract and lift bits), or -1. */
  travelFlagsOffset: number
  /**
   * Byte offset of the per-segment object indices (u16, index in the request's objects, SXPV_OBJECT_NONE for none),
   * or -1 when the buffer has none (a plate of one object, or an older engine).
   */
  objectsOffset: number
}

/**
 * Reads an SXPV v1 or v2 buffer. A v2 buffer is expanded first ({@link expandPreview}) into a new v1 buffer, which
 * `raw` then holds; `encodedVersion` says which one arrived.
 */
export function readPreview(input: ArrayBuffer): PreviewBuffers {
  const head = input.byteLength >= SXPV_HEADER_BYTES ? new DataView(input) : null
  const encodedVersion = head && head.getUint32(0, true) === SXPV_MAGIC && head.getUint16(4, true) === SXPV_VERSION_2 ? SXPV_VERSION_2 : SXPV_VERSION
  const raw = encodedVersion === SXPV_VERSION_2 ? expandPreview(input) : input
  const v = new DataView(raw)
  if (raw.byteLength < SXPV_HEADER_BYTES || v.getUint32(0, true) !== SXPV_MAGIC) throw new Error('Not an SXPV buffer')
  const version = v.getUint16(4, true)
  if (version !== SXPV_VERSION) throw new Error(`Unsupported SXPV version ${version}`)
  const flags = v.getUint16(6, true)
  const segmentCount = v.getUint32(8, true)
  const layerCount = v.getUint32(12, true)
  const travelCount = v.getUint32(16, true)
  const toolCount = v.getUint32(20, true)
  const layerHeight = v.getFloat32(24, true)
  let o = SXPV_HEADER_BYTES
  const layerStart = new Uint32Array(raw, o, layerCount + 1); o += (layerCount + 1) * 4
  const layerZ = new Float32Array(raw, o, layerCount); o += layerCount * 4
  const layerTimeS = new Float32Array(raw, o, layerCount); o += layerCount * 4
  const hasTravels = (flags & SXPV_FLAG_TRAVELS) !== 0
  const travelStart = hasTravels ? new Uint32Array(raw, o, layerCount + 1) : null
  if (hasTravels) o += (layerCount + 1) * 4
  const segmentsOffset = o; o += segmentCount * SXPV_SEGMENT_BYTES
  const travelsOffset = hasTravels ? o : -1
  if (travelsOffset >= 0) o += travelCount * SXPV_TRAVEL_BYTES
  let extrasOffset = -1
  let travelFlagsOffset = -1
  if ((flags & SXPV_FLAG_EXTRAS) !== 0 && hasTravels) {
    extrasOffset = o; o += segmentCount * SXPV_EXTRA_BYTES
    travelFlagsOffset = o; o += travelCount
    o = (o + 3) & ~3
  }
  let objectsOffset = -1
  if ((flags & SXPV_FLAG_OBJECTS) !== 0) {
    objectsOffset = o; o += segmentCount * SXPV_OBJECT_BYTES
    o = (o + 3) & ~3
  }
  if (o > raw.byteLength) throw new Error('Truncated SXPV buffer')
  return { raw, version, encodedVersion, segmentCount, layerCount, travelCount, toolCount, layerHeight, layerStart, layerZ, layerTimeS, travelStart, segmentsOffset, travelsOffset, extrasOffset, travelFlagsOffset, objectsOffset }
}

/** The object index of a segment (index in the request's objects), or -1 when unknown or none. */
export function objectOfSegment(b: PreviewBuffers, segment: number): number {
  if (b.objectsOffset < 0 || segment < 0 || segment >= b.segmentCount) return -1
  const k = new DataView(b.raw).getUint16(b.objectsOffset + segment * SXPV_OBJECT_BYTES, true)
  return k === SXPV_OBJECT_NONE ? -1 : k
}

// ---- SXPV v2 (docs/architecture.md, "SXPV v2"); sx-core writes it in `preview_v2.rs`.

const V2_KNOWN_FLAGS = SXPV_FLAG_TRAVELS | SXPV_FLAG_EXTRAS | SXPV_FLAG_OBJECTS | SXPV_FLAG_LAYER_LINES
/** Positions are integers of this many per millimeter, the engine's own grid. */
const V2_GRID = 10000
const V2_STREAMS = 17
const V2_ATTR_BYTES = 12
const V2_CONTINUES = 1
const V2_RAW_POSITIONS = 2
const V2_LISTED_LINES = 4
// stream ids, in the order a layer block writes them
const S_RUNS = 0, S_CTRL = 1, S_ATTR = 2, S_Z = 3, S_START = 4, S_VERT = 5, S_RAW = 6, S_FAN = 7, S_TEMP = 8, S_FLAGS = 9
const S_LINE = 10, S_LINES = 11, S_OBJ = 12, S_TRAV = 13, S_TRAV_RAW = 14, S_TRAV_FLAGS = 15, S_DICT = 16

function v2Error(reason: string): Error {
  return new Error(`Bad SXPV v2 buffer: ${reason}`)
}

/** One stream of a layer block: unsigned and zigzag varints of at most 8 bytes, below 2^53. */
class V2Stream {
  p = 0
  readonly b: Uint8Array
  constructor(b: Uint8Array) {
    this.b = b
  }
  u(): number {
    const b = this.b
    let x = b[this.p++]
    if (x === undefined) throw v2Error('a stream ends early')
    if (x < 0x80) return x
    let v = x & 0x7f
    let m = 128
    for (let i = 1; i < 8; i++) {
      x = b[this.p++]
      if (x === undefined) throw v2Error('a stream ends early')
      v += (x & 0x7f) * m
      if (x < 0x80) {
        if (v >= 2 ** 53) throw v2Error('a varint is too large')
        return v
      }
      m *= 128
    }
    throw v2Error('a varint is too long')
  }
  s(): number {
    const v = this.u()
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2
  }
  byte(): number {
    const x = this.b[this.p++]
    if (x === undefined) throw v2Error('a stream ends early')
    return x
  }
  take(n: number): Uint8Array {
    if (this.p + n > this.b.length) throw v2Error('a stream ends early')
    const r = this.b.subarray(this.p, this.p + n)
    this.p += n
    return r
  }
}

/** Rounds half up onto the grid, as the engine does. */
function v2Grid(x: number): number {
  return Math.floor(x * V2_GRID + 0.5)
}

function v2CheckTable(t: Uint32Array, total: number): void {
  let prev = 0
  for (let k = 0; k < t.length; k++) {
    const v = t[k] ?? 0
    if ((k === 0 && v !== 0) || v < prev || (k === t.length - 1 && v !== total)) throw v2Error('a layer table is out of order')
    prev = v
  }
}

/**
 * Expands an SXPV v2 buffer into the v1 buffer the engine wrote it from, byte for byte. Throws on a buffer that is
 * not v2 or is damaged anywhere.
 */
export function expandPreview(input: ArrayBuffer): ArrayBuffer {
  const u8 = new Uint8Array(input)
  const dv = new DataView(input)
  if (input.byteLength < SXPV_HEADER_BYTES || dv.getUint32(0, true) !== SXPV_MAGIC || dv.getUint16(4, true) !== SXPV_VERSION_2) throw v2Error('not an SXPV v2 buffer')
  const flags = dv.getUint16(6, true)
  if ((flags & ~V2_KNOWN_FLAGS) !== 0) throw v2Error('unknown flags')
  const S = dv.getUint32(8, true)
  const N = dv.getUint32(12, true)
  const T = dv.getUint32(16, true)
  const hasT = (flags & SXPV_FLAG_TRAVELS) !== 0
  const hasX = hasT && (flags & SXPV_FLAG_EXTRAS) !== 0
  const hasO = (flags & SXPV_FLAG_OBJECTS) !== 0
  const tables = SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + (hasT ? (N + 1) * 4 : 0)
  const blocksAt = tables + (N + 1) * 4
  if (blocksAt > input.byteLength) throw v2Error('truncated tables')
  if (S > input.byteLength || T > input.byteLength) throw v2Error('counts past the buffer')
  let size = tables
  const segAt = size; size += S * SXPV_SEGMENT_BYTES
  const travAt = size; if (hasT) size += T * SXPV_TRAVEL_BYTES
  const exAt = size; if (hasX) size = (size + S * SXPV_EXTRA_BYTES + T + 3) & ~3
  const tfAt = exAt + S * SXPV_EXTRA_BYTES
  const objAt = size; if (hasO) size = (size + S * SXPV_OBJECT_BYTES + 3) & ~3
  const out = new ArrayBuffer(size)
  const o8 = new Uint8Array(out)
  o8.set(u8.subarray(0, tables))
  new DataView(out).setUint16(4, SXPV_VERSION, true)
  const layerStart = new Uint32Array(out, SXPV_HEADER_BYTES, N + 1)
  const layerZ = new Float32Array(out, SXPV_HEADER_BYTES + (N + 1) * 4, N)
  const travelStart = hasT ? new Uint32Array(out, SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8, N + 1) : null
  v2CheckTable(layerStart, S)
  if (travelStart) v2CheckTable(travelStart, T)
  const blocks = u8.subarray(blocksAt)
  const index = new DataView(input, tables, (N + 1) * 4)
  for (let k = 0, prev = 0; k <= N; k++) {
    const at = index.getUint32(k * 4, true)
    if ((k === 0 && at !== 0) || at < prev || (k === N && at !== blocks.length)) throw v2Error('the layer index is out of order')
    prev = at
  }
  const seg = new Float32Array(out, segAt, S * 8)
  const segW = new Uint32Array(out, segAt, S * 8)
  const trav = hasT ? new Float32Array(out, travAt, T * 4) : null
  const ex16 = hasX ? new Uint16Array(out, exAt, S * 4) : null
  const ex32 = hasX ? new Uint32Array(out, exAt, S * 2) : null
  const obj = hasO ? new Uint16Array(out, objAt, S) : null
  const zf = new Float32Array(1)
  const zu = new Uint32Array(zf.buffer)
  const f4 = new DataView(new ArrayBuffer(4))
  const f32of = (b: Uint8Array, at: number): number => {
    for (let i = 0; i < 4; i++) f4.setUint8(i, b[at + i] ?? 0)
    return f4.getFloat32(0, true)
  }
  for (let k = 0; k < N; k++) {
    const block = blocks.subarray(index.getUint32(k * 4, true), index.getUint32(k * 4 + 4, true))
    const head = new V2Stream(block)
    const lens: number[] = []
    for (let i = 0; i < V2_STREAMS; i++) lens.push(head.u())
    let at = head.p
    const s: V2Stream[] = lens.map((n) => {
      if (at + n > block.length) throw v2Error('a stream runs past its layer')
      const r = new V2Stream(block.subarray(at, at + n))
      at += n
      return r
    })
    if (at !== block.length) throw v2Error('a layer block has bytes after its streams')
    const [runs, ctrlS, attr, zs, start, vert, raw, fanS, tempS, flagsS, lineS, linesS, objS, travS, travRaw, travFlags, dictS] = s as [V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream, V2Stream]
    if (dictS.b.length % V2_ATTR_BYTES !== 0) throw v2Error('a dictionary entry is cut off')
    const dict = new Uint32Array(dictS.b.length / 4)
    new Uint8Array(dict.buffer).set(dictS.b)
    const entries = dictS.b.length / V2_ATTR_BYTES
    const end = layerStart[k + 1] ?? 0
    let i = layerStart[k] ?? 0
    let cx = 0, cy = 0
    zf[0] = layerZ[k] ?? 0
    let z = zu[0] ?? 0
    let temp = 0, ob = 0, lineNext = 0
    while (i < end) {
      const n = runs.u()
      if (n === 0 || n > end - i) throw v2Error('a run does not fit its layer')
      const ctrl = ctrlS.byte()
      if ((ctrl & ~(V2_CONTINUES | V2_RAW_POSITIONS | V2_LISTED_LINES)) !== 0) throw v2Error('unknown run bits')
      const id = attr.u()
      if (id >= entries) throw v2Error('a dictionary index is out of range')
      z += zs.s()
      if (z < 0 || z > 0xffffffff) throw v2Error('a z is out of range')
      zu[0] = z
      const zz = zf[0] ?? 0
      const a0 = dict[id * 3] ?? 0, a1 = dict[id * 3 + 1] ?? 0, a2 = dict[id * 3 + 2] ?? 0
      if (ctrl & V2_RAW_POSITIONS) {
        let prev = raw.take(8)
        for (let t = i; t < i + n; t++) {
          const next = raw.take(8)
          const q = t * 8
          o8.set(prev, segAt + t * SXPV_SEGMENT_BYTES)
          o8.set(next, segAt + t * SXPV_SEGMENT_BYTES + 8)
          seg[q + 4] = zz
          segW[q + 5] = a0; segW[q + 6] = a1; segW[q + 7] = a2
          prev = next
        }
        cx = v2Grid(f32of(prev, 0))
        cy = v2Grid(f32of(prev, 4))
      } else {
        if (!(ctrl & V2_CONTINUES)) { cx += start.s(); cy += start.s() }
        let px = cx / V2_GRID, py = cy / V2_GRID
        for (let t = i; t < i + n; t++) {
          cx += vert.s(); cy += vert.s()
          const x1 = cx / V2_GRID, y1 = cy / V2_GRID
          const q = t * 8
          seg[q] = px; seg[q + 1] = py; seg[q + 2] = x1; seg[q + 3] = y1; seg[q + 4] = zz
          segW[q + 5] = a0; segW[q + 6] = a1; segW[q + 7] = a2
          px = x1; py = y1
        }
      }
      if (ex16 && ex32) {
        const fan = fanS.byte()
        const fl = flagsS.byte()
        temp += tempS.s()
        if (temp < 0 || temp > 0xffff) throw v2Error('a temperature is out of range')
        let line = lineNext + lineS.s()
        const listed = (ctrl & V2_LISTED_LINES) !== 0
        for (let t = i; t < i + n; t++) {
          if (t > i) line = listed ? line + 1 + linesS.s() : line + 1
          ex16[t * 4] = t === i ? fan | (fl << 8) : fan
          ex16[t * 4 + 1] = temp
          ex32[t * 2 + 1] = line >>> 0
        }
        lineNext = line + 1
      }
      if (obj) {
        ob += objS.s()
        if (ob < 0 || ob > 0xffff) throw v2Error('an object index is out of range')
        obj.fill(ob, i, i + n)
      }
      i += n
    }
    if (trav && travelStart) {
      const ta = travelStart[k] ?? 0
      const tz = travelStart[k + 1] ?? 0
      let rawLeft = travRaw.u()
      if (rawLeft > tz - ta) throw v2Error('more raw travels than travels')
      let nextRaw = rawLeft > 0 ? ta + travRaw.u() : -1
      let tx = 0, ty = 0
      for (let t = ta; t < tz; t++) {
        if (t === nextRaw) {
          o8.set(travRaw.take(SXPV_TRAVEL_BYTES), travAt + t * SXPV_TRAVEL_BYTES)
          rawLeft--
          if (rawLeft > 0) {
            const g = travRaw.u()
            if (g === 0) throw v2Error('raw travels out of order')
            nextRaw = t + g
          } else nextRaw = -1
        } else {
          const x0 = tx + travS.s(), y0 = ty + travS.s()
          const x1 = x0 + travS.s(), y1 = y0 + travS.s()
          const q = t * 4
          trav[q] = x0 / V2_GRID; trav[q + 1] = y0 / V2_GRID; trav[q + 2] = x1 / V2_GRID; trav[q + 3] = y1 / V2_GRID
          tx = x1; ty = y1
        }
        if (hasX) o8[tfAt + t] = travFlags.byte()
      }
      if (nextRaw !== -1) throw v2Error('a raw travel is past its layer')
    }
    dictS.p = dictS.b.length // read by index, not in order
    if (!s.every((r) => r.p === r.b.length)) throw v2Error('a layer block has unread bytes')
  }
  return out
}
