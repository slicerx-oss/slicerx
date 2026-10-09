// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One call of the engine for the geometry worker (geom-worker.ts), with meshes between the worker and the engine's
// memory without JSON: a mesh of typed arrays goes in through a buffer the engine reads as `rawPath`, and a mesh the
// engine wrote to an output buffer (`rawOut`, a request's `meshOutput: "raw"`) comes back as typed arrays. Both use the
// raw form of `TriMesh::from_raw`: the vertex and triangle counts as little-endian u32, then the positions as f32 and
// the triangles as u32.
import { askFaces } from './client'

/** The engine module's exports (packages/geom/wasm/src/lib.rs). */
export interface GeomExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  /** Reserves a buffer the next call reads as `mem:N`. */
  geom_file(len: number): number
  geom_call(): number
  geom_ops(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
  /** The last call's output buffers (`meshOutput: "raw"`): how many, and where each is. */
  geom_out_files?(): number
  geom_out_file_ptr?(n: number): number
  geom_out_file_len?(n: number): number
}

/**
 * The request with each mesh that came as typed arrays (and without faces) written into an engine buffer in the raw
 * form (`TriMesh::from_raw`) and named by `rawPath`, so a big mesh never becomes JSON: as numbers in a JSON text and
 * then in the engine's parse of it, a mesh of 1.4 million triangles took the engine's memory to about 800 MB, which a
 * WebAssembly module never hands back. The buffers are numbered in the order they are reserved.
 */
export function rawMeshes(x: GeomExports, v: unknown, files = { n: 0 }): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map((e) => rawMeshes(x, e, files)) : v
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v
  const o = v as Record<string, unknown>
  const { positions, indices, faces } = o
  if (positions instanceof Float32Array && (indices instanceof Uint32Array || indices instanceof Uint16Array) && !faces) {
    const nv = Math.floor(positions.length / 3)
    const nt = Math.floor(indices.length / 3)
    const at = x.geom_file(8 + 12 * nv + 12 * nt)
    // Views made after the reservation, which may have grown the memory.
    new Uint32Array(x.memory.buffer, at, 2).set([nv, nt])
    new Float32Array(x.memory.buffer, at + 8, nv * 3).set(positions.subarray(0, nv * 3))
    new Uint32Array(x.memory.buffer, at + 8 + 12 * nv, nt * 3).set(indices.subarray(0, nt * 3))
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'positions' && k !== 'indices' && k !== 'faces'))
    return { ...rest, rawPath: `mem:${files.n++}` }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = rawMeshes(x, e, files)
  return out
}

/**
 * The answer with each mesh the engine wrote to an output buffer (`rawOut: N`, a request's `meshOutput: "raw"`) as
 * typed arrays read from that buffer, so a big mesh never becomes JSON on its way out either.
 */
export function rawOut(x: GeomExports, v: unknown): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map((e) => rawOut(x, e)) : v
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  if (typeof o['rawOut'] === 'number') {
    const n = o['rawOut']
    const at = x.geom_out_file_ptr!(n)
    const [nv, nt] = new Uint32Array(x.memory.buffer.slice(at, at + 8))
    // Copies, since a buffer of the engine's need not be aligned for a view and its memory is reused by the next call.
    const positions = new Float32Array(x.memory.buffer.slice(at + 8, at + 8 + 12 * nv!))
    const indices = new Uint32Array(x.memory.buffer.slice(at + 8 + 12 * nv!, at + 8 + 12 * nv! + 12 * nt!))
    const { rawOut: _n, ...rest } = o
    return { ...rest, positions, indices }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = rawOut(x, e)
  return out
}

/** The buffers of the typed arrays in an answer, handed to the page rather than copied. */
export function transferables(v: unknown, out: ArrayBuffer[] = []): ArrayBuffer[] {
  if (ArrayBuffer.isView(v)) {
    // A shared buffer cannot be handed over; any other one can.
    const b = v.buffer
    if (!(typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer) && !out.includes(b as ArrayBuffer)) out.push(b as ArrayBuffer)
  } else if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object') for (const e of v) transferables(e, out)
  } else if (v !== null && typeof v === 'object') for (const e of Object.values(v)) transferables(e, out)
  return out
}

/**
 * The request with its typed arrays as plain arrays, for the engine's JSON. A caller may send a mesh's Float32Array and
 * Uint32Array as they are (a structured clone of them is one copy), so the conversion of a big mesh happens here
 * instead of on the page.
 */
function plainArrays(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map(plainArrays) : v
  if (v === null || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = plainArrays(x)
  return out
}

/**
 * One call of the engine: the request with its typed-array meshes in raw buffers and the rest as JSON, every mesh asked
 * for with its faces (which the parts keep and send again with the next call); the answer with any raw output
 * buffers read back as typed arrays. Throws the engine's message when the call fails.
 */
export function callEngine(x: GeomExports, op: string, request: unknown): unknown {
  const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(askFaces(plainArrays(rawMeshes(x, request))))}`)
  const at = x.geom_input(bytes.length)
  new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
  const code = x.geom_call()
  const text = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
  if (code === 0) {
    const answer = JSON.parse(text(x.geom_out_ptr(), x.geom_out_len())) as unknown
    return (x.geom_out_files?.() ?? 0) > 0 ? rawOut(x, answer) : answer
  }
  let message = text(x.geom_error_ptr(), x.geom_error_len())
  try {
    message = (JSON.parse(message) as { error?: string }).error ?? message
  } catch {
    // A plain message stays as it is.
  }
  throw new Error(message)
}
