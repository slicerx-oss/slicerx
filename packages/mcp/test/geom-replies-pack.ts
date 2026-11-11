// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The packed form of a fixture of recorded engine replies (geom-engine.ts records them, pack-geom-replies.ts converts a
// fixture written whole). It has no test runner in it, so the converter script can load it on its own.
import { createHash } from 'node:crypto'

/** One recorded engine call, as geom-engine.ts records it. */
export interface Recorded {
  op: string
  /** A hash of the request without its key salt; requests carry whole meshes, so the file keeps only this. */
  request: string
  reply?: unknown
  error?: string
}

/** The packed fixture form: each long run of numbers stored once, as binary, and referenced by its hash where it was. */
export const PACKED_FORMAT = 'geom-replies/2'
/** Number arrays shorter than this stay inline: a vertex, a bounds corner, a short list costs less as it is. */
const PACK_MIN = 32

type ArrayKind = 'i32' | 'u32' | 'f32' | 'f64'
interface PackedArray {
  t: ArrayKind
  /** The values as little-endian binary, base64. */
  b: string
}
export interface PackedReplies {
  format: typeof PACKED_FORMAT
  /** sha256 of the whole form's text (`wholeText`), so a test can check the packed file gives it back byte for byte. */
  source: string
  arrays: Record<string, PackedArray>
  replies: Record<string, Recorded[]>
}

/** The text a fixture held whole, before packing: the recording as JSON on one line. */
export const wholeText = (recorded: Record<string, Recorded[]>): string => `${JSON.stringify(recorded)}\n`
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const f32 = new Float32Array(1)
/** The narrowest binary kind that gives back every value exactly. */
function kindOf(a: readonly number[]): ArrayKind {
  // -0 is kept by f64 only: an integer array would give back 0
  const int = (v: number): boolean => Number.isInteger(v) && !Object.is(v, -0)
  if (a.every((v) => int(v) && v >= -0x80000000 && v <= 0x7fffffff)) return 'i32'
  if (a.every((v) => int(v) && v >= 0 && v <= 0xffffffff)) return 'u32'
  if (a.every((v) => ((f32[0] = v), f32[0] === v && !Object.is(v, -0)))) return 'f32'
  return 'f64'
}
const VIEW = { i32: Int32Array, u32: Uint32Array, f32: Float32Array, f64: Float64Array } as const

/**
 * `recorded` with every long array of plain numbers (a mesh's positions, indices and face ids) moved into one table, each
 * distinct array once: a reply's tool mesh and a saved file's parts repeat the step meshes, and binary is about a third
 * the size of decimal text. Unpacked, every value comes back exactly as recorded.
 */
export function packReplies(recorded: Record<string, Recorded[]>): PackedReplies {
  const arrays: Record<string, PackedArray> = {}
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      if (v.length >= PACK_MIN && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        const nums = v as number[]
        const t = kindOf(nums)
        const b = Buffer.from(new VIEW[t](nums).buffer).toString('base64')
        const key = createHash('sha256').update(`${t}:${b}`).digest('hex').slice(0, 16)
        arrays[key] ??= { t, b }
        return { $array: key }
      }
      return v.map(walk)
    }
    if (!v || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, walk(c)]))
  }
  return { format: PACKED_FORMAT, source: sha256(wholeText(recorded)), arrays, replies: walk(recorded) as Record<string, Recorded[]> }
}

/** A fixture file's replies, packed (`packReplies`) or recorded whole as before. */
export function unpackReplies(file: unknown): Record<string, Recorded[]> {
  const f = file as Partial<PackedReplies>
  if (f.format !== PACKED_FORMAT) return file as Record<string, Recorded[]>
  const arrays = f.arrays ?? {}
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== 'object') return v
    const ref = (v as { $array?: unknown }).$array
    if (typeof ref === 'string' && Object.keys(v).length === 1) {
      const a = arrays[ref]
      if (!a) throw new Error(`a packed fixture names array ${ref} and does not hold it`)
      const bytes = Buffer.from(a.b, 'base64')
      return Array.from(new VIEW[a.t](bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
    }
    return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, walk(c)]))
  }
  return walk(f.replies ?? {}) as Record<string, Recorded[]>
}
