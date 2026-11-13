// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine served as a process of its own (packages/geom/src/serve.rs), as a host talks to it: calls and answers as
// frames of a JSON text and its buffers, meshes in the engine's raw form both ways, and kernel body numbers named by
// the process that made them, so a number from an ended process never reaches the next one. The app's native provider
// (packages/app/src/geom/native-provider.ts) uses it, and any other host of the served engine can.

// --- frames: a u32 length and a JSON text, a u32 count of buffers, each buffer a u32 length and its bytes

/** A call as a frame: `{id, op, request}` and the buffers its `mem:N` paths name. */
export function encodeFrame(text: string, buffers: readonly Uint8Array[]): Uint8Array {
  const json = new TextEncoder().encode(text)
  const size = 8 + json.length + buffers.reduce((n, b) => n + 4 + b.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let at = 0
  const put = (b: Uint8Array) => {
    view.setUint32(at, b.length, true)
    out.set(b, at + 4)
    at += 4 + b.length
  }
  put(json)
  view.setUint32(at, buffers.length, true)
  at += 4
  for (const b of buffers) put(b)
  return out
}

/** A frame's JSON text, parsed, and its buffers as views of `frame`. */
export function decodeFrame(frame: Uint8Array): { answer: Record<string, unknown>; buffers: Uint8Array[] } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  let at = 0
  const take = () => {
    const len = view.getUint32(at, true)
    const b = frame.subarray(at + 4, at + 4 + len)
    if (b.length !== len) throw new Error('The geometry engine sent a short answer')
    at += 4 + len
    return b
  }
  const answer = JSON.parse(new TextDecoder().decode(take())) as Record<string, unknown>
  const count = view.getUint32(at, true)
  at += 4
  const buffers: Uint8Array[] = []
  for (let i = 0; i < count; i++) buffers.push(take())
  return { answer, buffers }
}

// --- requests and answers, as the app's worker hands them to the engine (packages/app/src/geom/engine-call.ts)

/** Each mesh of typed arrays (without faces) as a buffer in the engine's raw form, named by `rawPath`. */
export function rawMeshes(v: unknown, buffers: Uint8Array[]): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map((e) => rawMeshes(e, buffers)) : v
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v
  const o = v as Record<string, unknown>
  const { positions, indices, faces } = o
  if (positions instanceof Float32Array && (indices instanceof Uint32Array || indices instanceof Uint16Array) && !faces) {
    const nv = Math.floor(positions.length / 3)
    const nt = Math.floor(indices.length / 3)
    const raw = new Uint8Array(8 + 12 * nv + 12 * nt)
    new Uint32Array(raw.buffer, 0, 2).set([nv, nt])
    new Float32Array(raw.buffer, 8, nv * 3).set(positions.subarray(0, nv * 3))
    new Uint32Array(raw.buffer, 8 + 12 * nv, nt * 3).set(indices.subarray(0, nt * 3))
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'positions' && k !== 'indices' && k !== 'faces'))
    buffers.push(raw)
    return { ...rest, rawPath: `mem:${buffers.length - 1}` }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = rawMeshes(e, buffers)
  return out
}

/** A project's bytes (`data.bytes`) as a buffer named by `data.path`; other files go as base64, as the worker sends them. */
export function rawData(op: string, v: unknown, buffers: Uint8Array[]): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const bytes = (v as { data?: { bytes?: unknown } }).data?.bytes
  if (!(bytes instanceof Uint8Array)) return v
  if (op === 'format.read3mf') {
    buffers.push(bytes)
    return { ...v, data: { path: `mem:${buffers.length - 1}` } }
  }
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { ...v, data: { base64: btoa(text) } }
}

/** Typed arrays left in a request as plain arrays, for the engine's JSON. */
export function plainArrays(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map(plainArrays) : v
  if (v === null || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = plainArrays(x)
  return out
}

/** A copy of `b` that owns its own aligned buffer, for a typed array of it. */
const own = (b: Uint8Array): ArrayBuffer => b.slice().buffer

/**
 * `b` as values of `size` bytes: a view of the frame itself when they start lined up in it, else a copy that is; none
 * when `b` is not a whole number of them.
 */
function values<T>(b: Uint8Array, size: 2 | 4, make: (buffer: ArrayBufferLike, offset?: number, length?: number) => T): T | undefined {
  if (b.byteLength % size) return undefined
  return b.byteOffset % size ? make(own(b)) : make(b.buffer, b.byteOffset, b.byteLength / size)
}

/**
 * A held solid's triangles come with more buffers beside the mesh (packages/geom/src/exact.rs, tessellate): packed
 * corner normals (`normalsOut`, six i16 per triangle) and each triangle's face (`faceIdsOut`, one u32 per triangle),
 * handed on as `normals` and `faceIds`, the names cad-history's reader takes (exact.ts, tessellated). One of any other
 * length belongs to other triangles and is left out.
 */
function solidBuffers(o: Record<string, unknown>, triangles: number, at: (n: unknown) => Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof o['normalsOut'] === 'number') {
    const normals = values(at(o['normalsOut']), 2, (b, offset, length) => new Int16Array(b, offset, length))
    if (normals?.length === triangles * 6) out['normals'] = normals
  }
  if (typeof o['faceIdsOut'] === 'number') {
    const faceIds = values(at(o['faceIdsOut']), 4, (b, offset, length) => new Uint32Array(b, offset, length))
    if (faceIds?.length === triangles) out['faceIds'] = faceIds
  }
  return out
}

/** The answer with each output buffer it names read as typed arrays, as the app's worker reads them (packages/app/src/geom/engine-call.ts, rawOut). */
export function readBuffers(v: unknown, buffers: readonly Uint8Array[]): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map((e) => readBuffers(e, buffers)) : v
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  const at = (n: unknown) => {
    const b = typeof n === 'number' ? buffers[n] : undefined
    if (!b) throw new Error(`The geometry engine named a buffer it did not send: ${String(n)}`)
    return b
  }
  if (typeof o['rawBytes'] === 'number') return new Uint8Array(own(at(o['rawBytes'])))
  if (typeof o['positionsOut'] === 'number' && typeof o['trianglesOut'] === 'number') {
    const { positionsOut, trianglesOut, ...rest } = o
    return { ...(readBuffers(rest, buffers) as Record<string, unknown>), positions: new Float32Array(own(at(positionsOut))), indices: new Uint32Array(own(at(trianglesOut))) }
  }
  if (typeof o['rawOut'] === 'number') {
    const b = at(o['rawOut'])
    const head = new DataView(b.buffer, b.byteOffset, 8)
    const nv = head.getUint32(0, true)
    const nt = head.getUint32(4, true)
    const { rawOut: _n, ...rest } = o
    const solid = solidBuffers(rest, nt, at)
    // the buffer numbers they came under name nothing on the page
    if (typeof rest['normalsOut'] === 'number') delete rest['normalsOut']
    if (typeof rest['faceIdsOut'] === 'number') delete rest['faceIdsOut']
    return { ...rest, positions: new Float32Array(own(b.subarray(8, 8 + 12 * nv))), indices: new Uint32Array(own(b.subarray(8 + 12 * nv, 8 + 12 * nv + 12 * nt))), ...solid }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = readBuffers(e, buffers)
  return out
}

// --- kernel bodies: a body number the page sees is the process's number times 2^32 plus the kernel's own

export const PER_PROCESS = 2 ** 32
/** The request fields that name a kernel body (packages/brep/cpp/sx_brep.cpp), and the answer fields that hand one out. */
export const BODY_IN = ['body', 'target', 'a', 'b'] as const
export const BODY_OUT = ['body', 'below', 'above'] as const

/**
 * Makes each body number a kernel request names (BODY_IN) the kernel's own number in process `generation`. False when
 * one names a body of another process, or no process runs (0): that body is gone, and the request must not go.
 */
export function ownBodies(fields: Record<string, unknown>, generation: number): boolean {
  for (const k of BODY_IN) {
    const n = fields[k]
    if (typeof n !== 'number') continue
    const from = Math.floor(n / PER_PROCESS)
    if (from !== generation || generation === 0) return false
    fields[k] = n - from * PER_PROCESS
  }
  return true
}

/** Names each body a kernel answer hands out (BODY_OUT) by process `from`, the one that made it. */
export function tagBodies(fields: Record<string, unknown>, from: number): void {
  for (const k of BODY_OUT) if (typeof fields[k] === 'number') fields[k] = from * PER_PROCESS + (fields[k] as number)
}

/** Whether a kernel request names a body by number. */
export const namesBody = (request: unknown): boolean => BODY_IN.some((k) => typeof (request as Record<string, unknown> | null)?.[k] === 'number')
