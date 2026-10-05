// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The SXPV preview buffer format (docs/architecture.md, "SXPV
// preview buffer format") and a zero-copy reader. Rust writes it in sx-core.

export const SXPV_MAGIC = 0x56505853 // "SXPV" as a little-endian u32
export const SXPV_VERSION = 1
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
  raw: ArrayBuffer
  version: number
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

export function readPreview(raw: ArrayBuffer): PreviewBuffers {
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
  return { raw, version, segmentCount, layerCount, travelCount, toolCount, layerHeight, layerStart, layerZ, layerTimeS, travelStart, segmentsOffset, travelsOffset, extrasOffset, travelFlagsOffset, objectsOffset }
}

/** The object index of a segment (index in the request's objects), or -1 when unknown or none. */
export function objectOfSegment(b: PreviewBuffers, segment: number): number {
  if (b.objectsOffset < 0 || segment < 0 || segment >= b.segmentCount) return -1
  const k = new DataView(b.raw).getUint16(b.objectsOffset + segment * SXPV_OBJECT_BYTES, true)
  return k === SXPV_OBJECT_NONE ? -1 : k
}
