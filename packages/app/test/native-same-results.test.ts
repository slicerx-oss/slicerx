// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Same results from the native Model engine and the browser engine, step by step. Each design is replayed one step at a
// time through the native provider (native-provider.ts) on the engine process (SLICERX_GEOM_SERVE_BIN, as
// native-provider.test.ts runs it) and through the WebAssembly engine the way the app's worker calls it (geom-worker.ts:
// replayHistory over callEngine, bodies kept). After each step the parts are compared:
//
// - a mesh step: every part's triangles bit for bit (a sha256 of the positions as f32 and the indices as u32), its faces
//   (ids, table and keys) the same, and the step's status the same;
// - an exact step (the native part is a kernel body's tessellation, with the solid's normals) or a later step on such a
//   part: the same face count, bounds within TOLERANCE_MM, volume within TOLERANCE_MM times the surface area, and the
//   distance from each mesh to the other, both ways, under TOLERANCE_MM.
//
// Every difference is reported per step: the design, the step and its op, the request's digest, the field and both
// values, and for a mesh step the first engine call whose reply (or request) differs, with the place and both values.
// The designs: the bracket bench (native-provider.test.ts), every creative eval recording replayed on the WebAssembly
// engine (packages/mcp/evals/creative), and the real hull projects in SX_SAME_RESULTS_HULLS (a folder of .sx3mf files).
// SX_SAME_RESULTS_REQUIRE=1 (scripts/ci/native-same-results.mjs sets it) fails, rather than skips, when an engine is
// missing; SX_SAME_RESULTS_OUT names a JSON file for the full report.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { clearReplayCache, parseHistories, replayHistory, type Design, type EngineCall, type History, type HistoryMesh, type ReplayResult, type StepParams } from '@slicerx/cad-history'
import type { MeshPart } from '@slicerx/contracts'
import { evalGeom } from '@slicerx/pilot/evals/node'
import { runPrompt } from '@slicerx/mcp/evals/creative'
import { CREATIVE_PROMPTS } from '../../mcp/evals/creative/prompts'
import { loadRecording } from '../../mcp/evals/creative/recordings'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { decodeFrame, EngineEnded, nativeProvider, type NativeEngine } from '../src/geom/native-provider'
import { withStep } from '../src/cad/history/record'
import { unzipEntries } from '../src/export/unzip'
import { boxMesh } from '../src/plate/mesh-ops'
import { liveEngine, wasmPath } from './geom-engine'

/** How far an exact step's result may be from the mesh engine's, mm (exact-by-default-flip.md, section 3). */
export const TOLERANCE_MM = 0.01

// --- what a step gave on one engine

/** One engine call, as both engines see it: the op, the request and the reply, with meshes as plain numbers. */
interface CallLog {
  op: string
  request: unknown
  reply?: unknown
  error?: string
}

interface PartRecord {
  name: string
  slot: number
  vertices: number
  triangles: number
  /** sha256 of the positions as little-endian f32 and the indices as little-endian u32. */
  mesh: string
  /** sha256 of the face ids (u32), the table and the keys (JSON). */
  faces: string
  faceCount: number
  /** The part carries a solid's corner normals: the native engine made it as a kernel body. */
  normals: boolean
  volume: number
  area: number
  bounds: [number, number, number, number, number, number]
  /** Kept for the distance check on exact parts only. */
  positions?: Float32Array
  indices?: Uint32Array
}

interface StepRecord {
  status: string
  parts: PartRecord[]
  calls: CallLog[]
}

/** One difference: where (design, step, op, request digest, part), what (field) and both values. */
export interface Difference {
  design: string
  step: number
  steps: number
  id: string
  op: string
  request: string
  kind: 'mesh' | 'exact'
  part?: number
  field: string
  native: string
  wasm: string
  /** For a mesh step: the first engine call within it whose reply or request differs. */
  call?: { index: number; op: string; where: 'request' | 'reply' | 'calls'; path: string; native: string; wasm: string; ulps?: number }
}

const sha = (...parts: (Uint8Array | string)[]): string => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest('hex')
}
const bytes = (a: Float32Array | Uint32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

function partRecord(p: HistoryMesh, keepMesh: boolean): PartRecord {
  const positions = Float32Array.from(p.positions)
  const indices = Uint32Array.from(p.indices)
  const f = p.faces
  const faceIds = f ? Uint32Array.from(f.ids) : new Uint32Array(0)
  let volume = 0
  let area = 0
  const b: PartRecord['bounds'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k]!, positions[i + k]!)
    b[k + 3] = Math.max(b[k + 3]!, positions[i + k]!)
  }
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, c, d] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3]
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!
    const bx = positions[c]!, by = positions[c + 1]!, bz = positions[c + 2]!
    const cx = positions[d]!, cy = positions[d + 1]!, cz = positions[d + 2]!
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return {
    name: p.name,
    slot: p.slot,
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    mesh: sha(bytes(positions), bytes(indices)),
    faces: f ? sha(bytes(faceIds), JSON.stringify(f.table), JSON.stringify(f.keys ?? null)) : 'none',
    faceCount: f ? f.table.length : -1,
    normals: p.normals !== undefined,
    volume,
    area,
    bounds: b,
    ...(keepMesh ? { positions, indices } : {}),
  }
}

// --- the two-way distance between two meshes

/** The distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle(px: number, py: number, pz: number, t: Float64Array, o: number): number {
  const ax = t[o]!, ay = t[o + 1]!, az = t[o + 2]!
  const abx = t[o + 3]! - ax, aby = t[o + 4]! - ay, abz = t[o + 5]! - az
  const acx = t[o + 6]! - ax, acy = t[o + 7]! - ay, acz = t[o + 8]! - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  const at = (x: number, y: number, z: number) => Math.hypot(px - x, py - y, pz - z)
  if (d1 <= 0 && d2 <= 0) return at(ax, ay, az)
  const bpx = px - (ax + abx), bpy = py - (ay + aby), bpz = pz - (az + abz)
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return at(ax + abx, ay + aby, az + abz)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return at(ax + v * abx, ay + v * aby, az + v * abz)
  }
  const cpx = px - (ax + acx), cpy = py - (ay + acy), cpz = pz - (az + acz)
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return at(ax + acx, ay + acy, az + acz)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return at(ax + w * acx, ay + w * acy, az + w * acz)
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return at(ax + abx + w * (acx - abx), ay + aby + w * (acy - aby), az + abz + w * (acz - abz))
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return at(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w)
}

/**
 * The largest distance from a point of `from` (its vertices and its triangles' centers) to the surface of `to`, mm.
 * The triangles of `to` sit in a grid, and each point looks outward ring by ring until no nearer triangle can be left.
 */
export function oneWayDistance(from: { positions: Float32Array; indices: Uint32Array }, to: { positions: Float32Array; indices: Uint32Array }): number {
  const nt = to.indices.length / 3
  if (!nt) return from.indices.length ? Infinity : 0
  const tri = new Float64Array(nt * 9)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) {
    const v = to.positions[to.indices[3 * t + c]! * 3 + k]!
    tri[9 * t + 3 * c + k] = v
    lo[k] = Math.min(lo[k]!, v)
    hi[k] = Math.max(hi[k]!, v)
  }
  const span = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!, 1e-6)
  const h = Math.max(span / Math.max(1, Math.cbrt(nt)), span / 128)
  const n = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k]! - lo[k]!) / h)))
  const cellOf = (v: number, k: number) => Math.min(n[k]! - 1, Math.max(0, Math.floor((v - lo[k]!) / h)))
  const cells = new Map<number, number[]>()
  const key = (i: number, j: number, k: number) => (i * n[1]! + j) * n[2]! + k
  for (let t = 0; t < nt; t++) {
    const o = 9 * t
    const a = [0, 1, 2].map((k) => cellOf(Math.min(tri[o + k]!, tri[o + 3 + k]!, tri[o + 6 + k]!), k))
    const b = [0, 1, 2].map((k) => cellOf(Math.max(tri[o + k]!, tri[o + 3 + k]!, tri[o + 6 + k]!), k))
    for (let i = a[0]!; i <= b[0]!; i++) for (let j = a[1]!; j <= b[1]!; j++) for (let k = a[2]!; k <= b[2]!; k++) {
      const c = key(i, j, k)
      const list = cells.get(c)
      if (list) list.push(t)
      else cells.set(c, [t])
    }
  }
  const most = Math.max(n[0]!, n[1]!, n[2]!)
  const nearest = (px: number, py: number, pz: number): number => {
    // the cell of the point moved onto the grid's box: every point of a cell r + 1 rings out is at least r * h from it
    const c = [cellOf(px, 0), cellOf(py, 1), cellOf(pz, 2)]
    let best = Infinity
    for (let r = 0; r <= most; r++) {
      for (let i = c[0]! - r; i <= c[0]! + r; i++) for (let j = c[1]! - r; j <= c[1]! + r; j++) for (let k = c[2]! - r; k <= c[2]! + r; k++) {
        if (Math.max(Math.abs(i - c[0]!), Math.abs(j - c[1]!), Math.abs(k - c[2]!)) !== r) continue
        if (i < 0 || j < 0 || k < 0 || i >= n[0]! || j >= n[1]! || k >= n[2]!) continue
        for (const t of cells.get(key(i, j, k)) ?? []) best = Math.min(best, pointTriangle(px, py, pz, tri, 9 * t))
      }
      if (best <= r * h) break
    }
    return best
  }
  let worst = 0
  const p = from.positions
  for (let i = 0; i + 2 < p.length; i += 3) worst = Math.max(worst, nearest(p[i]!, p[i + 1]!, p[i + 2]!))
  const ix = from.indices
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const [a, b, c] = [ix[t]! * 3, ix[t + 1]! * 3, ix[t + 2]! * 3]
    worst = Math.max(worst, nearest((p[a]! + p[b]! + p[c]!) / 3, (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3, (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3))
  }
  return worst
}

// --- comparing the two engines' steps

/** How a value reads in a report line: numbers in full, long lists by their length and digest. */
function shown(v: unknown): string {
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v)
  if (v === undefined) return '(none)'
  if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    const a = Array.from(v as unknown as ArrayLike<unknown>)
    return a.length <= 6 ? JSON.stringify(a) : `list of ${a.length}, sha256 ${sha(JSON.stringify(a)).slice(0, 12)}`
  }
  const text = JSON.stringify(v) ?? String(v)
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`
}

/** Units in the last place between two numbers: as f32 when both are f32 values, else as f64. */
export function ulpsApart(a: number, b: number): number | undefined {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.sign(a) !== Math.sign(b)) return undefined
  if (Math.fround(a) === a && Math.fround(b) === b) {
    const f = new Float32Array([a, b])
    const u = new Uint32Array(f.buffer)
    return Math.abs(u[0]! - u[1]!)
  }
  const f = new Float64Array([a, b])
  const u = new BigInt64Array(f.buffer)
  const d = u[0]! - u[1]!
  return Number(d < 0n ? -d : d)
}

/** The first place two values differ, depth first in key order, with both values; null when they are the same. */
export function firstDifference(a: unknown, b: unknown, path = ''): { path: string; native: unknown; wasm: unknown } | null {
  const list = (v: unknown): ArrayLike<unknown> | null => (Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView)) ? (v as unknown as ArrayLike<unknown>) : null)
  const la = list(a)
  const lb = list(b)
  if (la || lb) {
    if (!la || !lb) return { path: path || '(root)', native: a, wasm: b }
    for (let i = 0; i < Math.min(la.length, lb.length); i++) {
      const d = firstDifference(la[i], lb[i], `${path}[${i}]`)
      if (d) return d
    }
    return la.length === lb.length ? null : { path: `${path}.length`, native: la.length, wasm: lb.length }
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k)
      if (d) return d
    }
    return null
  }
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || (a === 0 && b === 0) ? null : { path: path || '(root)', native: a, wasm: b }
  return a === b ? null : { path: path || '(root)', native: a, wasm: b }
}

/** The first engine call of a step whose request or reply differs between the engines. */
function firstCall(native: CallLog[], wasm: CallLog[]): Difference['call'] | undefined {
  for (let i = 0; i < Math.max(native.length, wasm.length); i++) {
    const n = native[i]
    const w = wasm[i]
    if (!n || !w || n.op !== w.op) return { index: i + 1, op: n?.op ?? w?.op ?? '?', where: 'calls', path: 'op', native: n?.op ?? '(no call)', wasm: w?.op ?? '(no call)' }
    for (const where of ['request', 'reply'] as const) {
      const d = where === 'request' ? firstDifference(n.request, w.request) : firstDifference(n.error ?? n.reply, w.error ?? w.reply)
      if (!d) continue
      const ulps = typeof d.native === 'number' && typeof d.wasm === 'number' && !(Number.isInteger(d.native) && Number.isInteger(d.wasm)) ? ulpsApart(d.native, d.wasm) : undefined
      return { index: i + 1, op: n.op, where, path: d.path, native: shown(d.native), wasm: shown(d.wasm), ...(ulps !== undefined ? { ulps } : {}) }
    }
  }
  return undefined
}

/** Whether a part at this step is exact (its native part is a kernel body) or follows from one. */
const isExact = (n: PartRecord | undefined, fromBody: boolean) => fromBody || n?.normals === true

/**
 * Every difference between the engines' steps of one design. `steps` are the design's steps (for the op and request
 * digest of each), `native` and `wasm` the records of each prefix replay. A part that was a kernel body at a step stays
 * an exact part from then on: the steps after it start from the solid's triangles, which differ from the mesh path's.
 */
export function compareSteps(design: string, steps: readonly { id: string; params: StepParams }[], native: readonly StepRecord[], wasm: readonly StepRecord[]): Difference[] {
  const out: Difference[] = []
  const fromBody = new Set<number>()
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s]!
    const n = native[s]
    const w = wasm[s]
    const at = { design, step: s + 1, steps: steps.length, id: step.id, op: step.params.op, request: sha(JSON.stringify(step.params)).slice(0, 12) }
    if (!n || !w) {
      out.push({ ...at, kind: 'mesh', field: 'replay', native: n ? 'ran' : '(did not run)', wasm: w ? 'ran' : '(did not run)' })
      continue
    }
    n.parts.forEach((p, i) => p.normals && fromBody.add(i))
    const exactStep = n.parts.some((p, i) => isExact(p, fromBody.has(i)))
    const kind = exactStep ? 'exact' : 'mesh'
    const call = exactStep ? undefined : firstCall(n.calls, w.calls)
    const add = (d: Omit<Difference, keyof typeof at | 'kind'> & { kind?: Difference['kind'] }) => out.push({ ...at, kind, ...d, ...(call && (d.kind ?? kind) === 'mesh' ? { call } : {}) })
    if (n.status !== w.status) add({ field: 'status', native: n.status, wasm: w.status })
    if (n.parts.length !== w.parts.length) add({ field: 'parts', native: String(n.parts.length), wasm: String(w.parts.length) })
    for (let i = 0; i < Math.min(n.parts.length, w.parts.length); i++) {
      const a = n.parts[i]!
      const b = w.parts[i]!
      if (a.name !== b.name) add({ part: i, field: 'name', native: a.name, wasm: b.name })
      if (b.normals) add({ part: i, field: 'normals', native: String(a.normals), wasm: String(b.normals) })
      if (!isExact(a, fromBody.has(i))) {
        if (a.mesh !== b.mesh) add({ part: i, kind: 'mesh', field: 'mesh', native: `${a.vertices} vertices, ${a.triangles} triangles, sha256 ${a.mesh.slice(0, 16)}`, wasm: `${b.vertices} vertices, ${b.triangles} triangles, sha256 ${b.mesh.slice(0, 16)}` })
        if (a.faces !== b.faces) add({ part: i, kind: 'mesh', field: 'faces', native: `${a.faceCount} faces, sha256 ${a.faces.slice(0, 16)}`, wasm: `${b.faceCount} faces, sha256 ${b.faces.slice(0, 16)}` })
        continue
      }
      if (a.faceCount !== b.faceCount) add({ part: i, kind: 'exact', field: 'face count', native: String(a.faceCount), wasm: String(b.faceCount) })
      const box = (r: PartRecord) => `[${r.bounds.map((v) => v.toFixed(4)).join(', ')}]`
      if (a.bounds.some((v, k) => !(Math.abs(v - b.bounds[k]!) < TOLERANCE_MM))) add({ part: i, kind: 'exact', field: 'bounds', native: box(a), wasm: box(b) })
      if (!(Math.abs(a.volume - b.volume) <= TOLERANCE_MM * Math.max(a.area, b.area))) {
        add({ part: i, kind: 'exact', field: 'volume', native: `${a.volume.toFixed(4)} mm3`, wasm: `${b.volume.toFixed(4)} mm3 (allowed ${(TOLERANCE_MM * Math.max(a.area, b.area)).toFixed(4)} mm3 apart: ${TOLERANCE_MM} mm times the area)` })
      }
      if (a.positions && a.indices && b.positions && b.indices) {
        const there = oneWayDistance({ positions: a.positions, indices: a.indices }, { positions: b.positions, indices: b.indices })
        const back = oneWayDistance({ positions: b.positions, indices: b.indices }, { positions: a.positions, indices: a.indices })
        if (!(there < TOLERANCE_MM) || !(back < TOLERANCE_MM)) add({ part: i, kind: 'exact', field: 'distance', native: `native to wasm ${there.toFixed(5)} mm`, wasm: `wasm to native ${back.toFixed(5)} mm (both must be under ${TOLERANCE_MM} mm)` })
      } else add({ part: i, kind: 'exact', field: 'distance', native: a.positions ? 'kept' : '(mesh not kept)', wasm: b.positions ? 'kept' : '(mesh not kept)' })
    }
  }
  return out
}

/** A difference as one report line. */
export function differenceLine(d: Difference): string {
  const where = `${d.design} step ${d.step}/${d.steps} ${d.op} (${d.id}, request ${d.request}, ${d.kind} step)${d.part === undefined ? '' : ` part ${d.part}`}`
  const call = d.call ? `; first differing engine call #${d.call.index} ${d.call.op}, ${d.call.where} at ${d.call.path}: native ${d.call.native} | wasm ${d.call.wasm}${d.call.ulps !== undefined ? ` (${d.call.ulps} ulp${d.call.ulps === 1 ? '' : 's'} apart)` : ''}` : ''
  return `${where}: ${d.field}: native ${d.native} | wasm ${d.wasm}${call}`
}

// --- the engines

/** A mesh in the engine's raw form (u32 vertex and triangle counts, f32 positions, u32 indices) as typed arrays. */
function rawMesh(b: Uint8Array): { positions: Float32Array; indices: Uint32Array } {
  const own = b.slice()
  const v = new DataView(own.buffer)
  const nv = v.getUint32(0, true)
  const nt = v.getUint32(4, true)
  return { positions: new Float32Array(own.buffer, 8, nv * 3), indices: new Uint32Array(own.buffer, 8 + 12 * nv, nt * 3) }
}

/** A native request or answer with its buffers read back in place of their numbers, for the call log; withFaces left out. */
function framed(v: unknown, buffers: readonly Uint8Array[]): unknown {
  if (Array.isArray(v)) return v.map((e) => framed(e, buffers))
  if (v === null || typeof v !== 'object') return v
  const o = { ...(v as Record<string, unknown>) }
  delete o['withFaces']
  const mem = typeof o['rawPath'] === 'string' ? /^mem:(\d+)$/.exec(o['rawPath']) : null
  if (mem) {
    delete o['rawPath']
    return { ...(framed(o, buffers) as Record<string, unknown>), ...rawMesh(buffers[Number(mem[1])]!) }
  }
  if (typeof o['rawOut'] === 'number') {
    const { rawOut, normalsOut, faceIdsOut, ...rest } = o
    const extra: Record<string, unknown> = {}
    if (typeof normalsOut === 'number') extra['normals'] = new Int16Array(buffers[normalsOut]!.slice().buffer)
    if (typeof faceIdsOut === 'number') extra['faceIds'] = new Uint32Array(buffers[faceIdsOut]!.slice().buffer)
    return { ...(framed(rest, buffers) as Record<string, unknown>), ...rawMesh(buffers[rawOut as number]!), ...extra }
  }
  if (typeof o['positionsOut'] === 'number' && typeof o['trianglesOut'] === 'number') {
    const { positionsOut, trianglesOut, ...rest } = o
    return { ...(framed(rest, buffers) as Record<string, unknown>), positions: new Float32Array(buffers[positionsOut as number]!.slice().buffer), indices: new Uint32Array(buffers[trianglesOut as number]!.slice().buffer) }
  }
  if (typeof o['rawBytes'] === 'number') return buffers[o['rawBytes']]!.slice()
  for (const [k, e] of Object.entries(o)) o[k] = framed(e, buffers)
  return o
}

/** A wasm request as the log keeps it: withFaces left out (callEngine adds it, as the native provider does). */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain)
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v
  const o: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(v)) if (k !== 'withFaces') o[k] = plain(e)
  return o
}

const serveBin = process.env['SLICERX_GEOM_SERVE_BIN']
// the desktop app's binary in its engine mode by default: started without it, the binary would open the whole app
const serveArgs = JSON.parse(process.env['SLICERX_GEOM_SERVE_ARGS'] ?? '["--sx-geom-engine"]') as string[]
const HELLO = Buffer.from('SXGEOM1\n')

/**
 * The engine's serve loop as a process, as the desktop app runs it (the same reader as native-provider.test.ts), with
 * each call and its answer handed to `log`.
 */
function processEngine(log: (c: CallLog) => void): NativeEngine {
  let child: ChildProcess | null = null
  let generation = 0
  let held: Buffer = Buffer.alloc(0)
  let hello = false
  let waiting: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void } | null = null
  const take = () => {
    if (!hello) {
      const at = held.indexOf(HELLO)
      if (at < 0) return
      held = held.subarray(at + HELLO.length)
      hello = true
    }
    if (!waiting || held.length < 4) return
    let at = 4 + held.readUInt32LE(0)
    if (held.length < at + 4) return
    const n = held.readUInt32LE(at)
    at += 4
    for (let i = 0; i < n; i++) {
      if (held.length < at + 4) return
      at += 4 + held.readUInt32LE(at)
    }
    if (held.length < at) return
    const frame = new Uint8Array(held.subarray(0, at))
    held = held.subarray(at)
    const w = waiting
    waiting = null
    w.resolve(frame)
  }
  const start = () => {
    const c = spawn(serveBin!, serveArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SX_GEOM_SERVE_CHILD: 'plain' } })
    generation++
    held = Buffer.alloc(0)
    hello = false
    // the end of what the engine wrote to stderr, shown when it ends without being asked to
    let said = ''
    c.stderr!.on('data', (d: Buffer) => void (said = (said + d.toString()).slice(-4000)))
    c.stdout!.on('data', (d: Buffer) => {
      held = held.length ? Buffer.concat([held, d]) : d
      take()
    })
    c.on('exit', (code, signal) => {
      if (child === c) {
        child = null
        console.warn(`the native engine process ended unasked (code ${code}, signal ${signal})${said ? `; its last stderr:
${said}` : ''}`)
      }
      waiting?.reject(new EngineEnded(code))
      waiting = null
    })
    return c
  }
  return {
    call(frame) {
      child ??= start()
      const from = generation
      const sent = decodeFrame(frame)
      return new Promise((resolve, reject) => {
        waiting = {
          resolve: (f) => {
            const got = decodeFrame(f)
            const answer = got.answer
            log({ op: sent.answer['op'] as string, request: framed(sent.answer['request'], sent.buffers), ...(typeof answer['error'] === 'string' || typeof answer['panic'] === 'string' ? { error: String(answer['error'] ?? answer['panic']) } : { reply: framed(answer['result'], got.buffers) }) })
            resolve({ generation: from, frame: f })
          },
          reject,
        }
        child!.stdin!.write(frame)
      })
    },
    async end() {
      const c = child
      child = null
      if (!c || c.exitCode !== null || c.signalCode !== null) return
      await new Promise((resolve) => {
        c.once('exit', resolve)
        c.kill()
      })
    },
  }
}

/** The WebAssembly engine as the app's worker calls it (geom-worker.ts): callEngine on the full module, each call logged. */
async function wasmEngine(log: (c: CallLog) => void, tamper?: (op: string, reply: unknown) => unknown): Promise<EngineCall> {
  const { instance } = (await WebAssembly.instantiate(readFileSync(wasmPath), {})) as unknown as { instance: WebAssembly.Instance }
  const x = instance.exports as unknown as GeomExports
  return async (op, request) => {
    if (op.startsWith('brep.')) throw new Error(`the browser engine's replay asked the kernel for ${op}, which the worker's replays never do`)
    const asked = plain(request)
    try {
      let reply = callEngine(x, op, request)
      if (tamper) reply = tamper(op, reply)
      log({ op, request: asked, reply })
      return reply
    } catch (e) {
      log({ op, request: asked, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }
}

// --- one design, step by step, on both engines

export interface DesignRun {
  name: string
  steps: number
  exactSteps: number
  differences: Difference[]
}

type ReplayFn = (history: History) => Promise<ReplayResult>
interface Engines {
  native: (log: (c: CallLog) => void) => { call: ReplayFn; end: () => Promise<void> }
  wasm: (log: (c: CallLog) => void) => Promise<EngineCall>
}

/** Replays the history one step longer each time on `replay`, keeping each step's record; calls go to `calls` by step. */
async function stepRecords(history: History, replay: ReplayFn, calls: { now: CallLog[] }, keepMesh: (step: number, part: number) => boolean, before?: (step: number) => void): Promise<StepRecord[]> {
  const out: StepRecord[] = []
  for (let k = 1; k <= history.steps.length; k++) {
    calls.now = []
    before?.(k)
    const r = await replay({ ...history, steps: history.steps.slice(0, k) })
    const status = r.status[k - 1]
    out.push({ status: JSON.stringify(status ?? null), parts: r.parts.map((p, i) => partRecord(p, keepMesh(k - 1, i))), calls: calls.now })
  }
  return out
}

/**
 * One design on both engines: the native provider on the engine process, then the WebAssembly engine as the worker
 * runs it, each from an empty replay cache.
 */
async function runDesign(name: string, history: History, engines: Engines, wasmStep?: (step: number) => void): Promise<DesignRun> {
  const calls = { now: [] as CallLog[] }
  const log = (c: CallLog) => {
    if (!c.op.startsWith('brep.')) calls.now.push(c)
  }
  clearReplayCache()
  const n = engines.native(log)
  let native: StepRecord[]
  try {
    native = await stepRecords(history, n.call, calls, () => true)
  } finally {
    await n.end()
  }
  // the meshes kept for the distance check: only exact parts, and every part after one on the native side
  const exactAt = new Set<string>()
  const fromBody = new Set<number>()
  native.forEach((s, k) =>
    s.parts.forEach((p, i) => {
      if (p.normals) fromBody.add(i)
      if (fromBody.has(i)) {
        exactAt.add(`${k}:${i}`)
        return
      }
      delete p.positions
      delete p.indices
    }),
  )
  clearReplayCache()
  const call = await engines.wasm(log)
  const wasm = await stepRecords(history, (h) => replayHistory(call, { history: h }, { keepsBodies: true }), calls, (k, i) => exactAt.has(`${k}:${i}`), wasmStep)
  clearReplayCache()
  const differences = compareSteps(name, history.steps, native, wasm)
  const exactSteps = native.filter((s, k) => s.parts.some((_, i) => exactAt.has(`${k}:${i}`))).length
  return { name, steps: history.steps.length, exactSteps, differences }
}

// --- the design set

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const top = (z: number) => ({ origin: [100, 100, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] })

/** The bench bracket of native-provider.test.ts and cad-history-bench.test.ts: an 80 by 40 by 6 mm foot with `n` steps. */
export function bracket(n: number): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(80, 40, 6)], transform: T }
  let pulls = 0
  for (let i = 0; i < n; i++) {
    const x = -36 + (i % 10) * 8
    const y = -16 + (Math.floor(i / 10) % 5) * 8
    let params: StepParams
    if (i % 5 === 4) params = { op: 'face.push', at: [140 + pulls++, 100, 3], normal: [1, 0, 0], distanceMm: 1 }
    else if (i % 2 === 0) params = { op: 'shape.extrude', frame: top(6), shape: { type: 'circle', diameterMm: 3 }, placement: { center: [x, y] }, spec: { distanceMm: 4, operation: 'cut' } }
    else params = { op: 'shape.extrude', frame: top(6), shape: { type: 'rectangle', widthMm: 4, heightMm: 3, cornerRadiusMm: 1 }, placement: { center: [x, y] }, spec: { distanceMm: 3, operation: 'join' } }
    e = { ...e, history: withStep(e, 0, params) }
  }
  return e.history!
}

/** The CAD histories saved in a project file, by object. */
async function projectHistories(file: string): Promise<Map<string, History>> {
  const files = await unzipEntries(new Uint8Array(readFileSync(file)))
  const text = new TextDecoder().decode(files.get('Metadata/slicerx_history.json') ?? new Uint8Array())
  const saved = text ? (JSON.parse(text) as { bodies?: { object?: string }[]; objects?: { object?: string }[] }) : {}
  const ids = new Set([...(saved.bodies ?? []), ...(saved.objects ?? [])].map((b) => b.object).filter((o): o is string => typeof o === 'string'))
  return parseHistories(files, ids)
}

/** The designs a creative recording builds when it replays on the WebAssembly engine, as the eval's design host keeps them. */
async function creativeDesigns(id: string): Promise<Design[]> {
  const p = CREATIVE_PROMPTS.find((x) => x.id === id)!
  const rec = loadRecording(id)
  if (rec.status !== 'recorded') return []
  let host: { list(): Design[] } | undefined
  await runPrompt(p, {
    geom: evalGeom(),
    steps: rec.steps,
    defaultAnswer: true,
    answerRecorded: rec.defaultAnswer === true,
    tabTools: rec.tabTools === true,
    samePart: rec.samePart === true,
    planGoesOn: rec.planGoesOn === true,
    timeoutMs: 600_000,
    before: async (env) => void (host = env.designs as unknown as { list(): Design[] }),
  })
  return (host?.list() ?? []).filter((d) => d.history.steps.length > 0)
}

const hullDir = process.env['SX_SAME_RESULTS_HULLS']
const hullFiles = hullDir && existsSync(hullDir) ? readdirSync(hullDir).filter((f) => f.endsWith('.sx3mf')).sort() : []
const mustRun = process.env['SX_SAME_RESULTS_REQUIRE'] === '1'
const ready = !!serveBin && existsSync(serveBin) && liveEngine
if (mustRun && !ready) throw new Error(`SX_SAME_RESULTS_REQUIRE=1 but an engine is missing: native ${serveBin ?? '(SLICERX_GEOM_SERVE_BIN unset)'}${serveBin && !existsSync(serveBin) ? ' (no such file)' : ''}, WebAssembly ${wasmPath}${liveEngine ? '' : ' (not built, or SX_GEOM_REPLAY=1)'}`)
if (mustRun && hullDir && !hullFiles.length) throw new Error(`SX_SAME_RESULTS_HULLS=${hullDir} holds no .sx3mf project`)

const engines: Engines = {
  native: (log: (c: CallLog) => void) => {
    const e = processEngine(log)
    const p = nativeProvider(e)
    return { call: (history: History) => p.call<ReplayResult>('history.replay', { history }), end: () => e.end() }
  },
  wasm: (log: (c: CallLog) => void) => wasmEngine(log),
}

const report: DesignRun[] = []
afterAll(() => {
  const out = process.env['SX_SAME_RESULTS_OUT']
  if (!out || !report.length) return
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify({ native: serveBin, wasm: wasmPath, tolerance: TOLERANCE_MM, designs: report }, null, 1)}\n`)
})

/** Fails with every difference of the run, one line each. */
function expectSame(run: DesignRun): void {
  report.push(run)
  expect(run.differences.map(differenceLine), `${run.name}: ${run.differences.length} differences over ${run.steps} steps (${run.exactSteps} exact)`).toEqual([])
}

// --- the comparison itself, without engines

const box = (dx: number): HistoryMesh => {
  const b = boxMesh(10 + dx, 10, 10)
  return { name: 'Box', slot: 0, positions: b.positions, indices: b.indices, faces: { ids: new Uint32Array(b.indices.length / 3), table: [{ kind: 'other' }] } }
}
const record = (parts: HistoryMesh[], keep = false): StepRecord => ({ status: JSON.stringify({ state: 'done' }), parts: parts.map((p) => partRecord(p, keep)), calls: [] })
const oneStep = [{ id: 's1', params: { op: 'face.push', at: [0, 0, 0], normal: [1, 0, 0], distanceMm: 1 } as StepParams }]

describe('the same-results comparison', () => {
  it('finds nothing between two equal steps', () => {
    expect(compareSteps('box', oneStep, [record([box(0)])], [record([box(0)])])).toEqual([])
  })

  it('names the design, step, op, field and both values when one triangle of a mesh step differs', () => {
    const changed = box(0)
    const indices = Uint32Array.from(changed.indices)
    ;[indices[0], indices[1]] = [indices[1]!, indices[0]!]
    changed.indices = indices
    const d = compareSteps('box', oneStep, [record([box(0)])], [record([changed])])
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ design: 'box', step: 1, op: 'face.push', id: 's1', kind: 'mesh', part: 0, field: 'mesh' })
    const line = differenceLine(d[0]!)
    expect(line).toMatch(/^box step 1\/1 face\.push \(s1, request [0-9a-f]{12}, mesh step\) part 0: mesh: native 8 vertices, 12 triangles, sha256 [0-9a-f]{16} \| wasm 8 vertices, 12 triangles, sha256 [0-9a-f]{16}$/)
    expect(d[0]!.native).not.toBe(d[0]!.wasm)
  })

  it('compares an exact part by face count, bounds, volume and distance, not by its triangles', () => {
    const exact = box(0)
    exact.normals = new Int16Array(exact.indices.length * 2)
    // the same block, its triangles split another way: no difference
    const other = box(0)
    const flipped = Uint32Array.from(other.indices)
    for (let t = 0; t < flipped.length; t += 3) [flipped[t], flipped[t + 1], flipped[t + 2]] = [flipped[t + 1]!, flipped[t + 2]!, flipped[t]!]
    other.indices = flipped
    expect(compareSteps('block', oneStep, [record([exact], true)], [record([other], true)])).toEqual([])
    // 0.005 mm longer: within all four
    expect(compareSteps('block', oneStep, [record([exact], true)], [record([box(0.005)], true)])).toEqual([])
    // 0.2 mm longer (0.1 mm at each end): the bounds, the volume (20 mm3 against 6 allowed) and the distance say so
    const d = compareSteps('block', oneStep, [record([exact], true)], [record([box(0.2)], true)])
    expect(d.map((x) => x.field)).toEqual(['bounds', 'volume', 'distance'])
    expect(d.every((x) => x.kind === 'exact')).toBe(true)
    expect(differenceLine(d[2]!)).toContain('wasm to native 0.10000 mm')
  })

  it('measures the distance both ways to the surface, not to the nearest corner', () => {
    const a = boxMesh(10, 10, 10)
    const m = { positions: Float32Array.from(a.positions), indices: Uint32Array.from(a.indices) }
    expect(oneWayDistance(m, m)).toBeLessThan(1e-12)
    // a point over the middle of a face is 1 mm from it and much farther from any corner
    const p = { positions: new Float32Array([0, 0, 11, 0, 0, 11, 0, 0, 11]), indices: new Uint32Array([0, 1, 2]) }
    expect(oneWayDistance(p, m)).toBeCloseTo(1, 6)
  })

  it('tells one unit in the last place from a larger difference', () => {
    expect(ulpsApart(0.9999999999977263, 0.9999999999977264)).toBe(1)
    expect(ulpsApart(Math.fround(1.5), Math.fround(1.5) + 2 ** -22)).toBe(2)
    expect(firstDifference({ a: [1, { r: 2 }] }, { a: [1, { r: 3 }] })).toEqual({ path: 'a[1].r', native: 2, wasm: 3 })
  })
})

// --- both engines

describe.skipIf(!ready)('the native engine and the browser engine, step by step', () => {
  it('give the same results on the 50 step bench bracket', async () => {
    expectSame(await runDesign('bracket-50', bracket(50), engines))
  }, 600_000)

  for (const file of hullFiles) {
    it(`give the same results on the hull project ${file}`, async () => {
      const histories = await projectHistories(join(hullDir!, file))
      expect(histories.size, `${file} holds no CAD history`).toBeGreaterThan(0)
      const runs: DesignRun[] = []
      for (const [object, h] of histories) runs.push(await runDesign(`${file} object ${object}`, h, engines))
      for (const r of runs) report.push(r)
      expect(runs.flatMap((r) => r.differences).map(differenceLine), `${file}: ${runs.reduce((n, r) => n + r.steps, 0)} steps`).toEqual([])
    }, 600_000)
  }

  for (const p of CREATIVE_PROMPTS) {
    if (loadRecording(p.id).status !== 'recorded') continue
    it(`give the same results on the designs the creative recording ${p.id} builds`, async () => {
      const designs = await creativeDesigns(p.id)
      const runs: DesignRun[] = []
      for (const d of designs) runs.push(await runDesign(`${p.id}/${d.name} (${d.id})`, d.history, engines))
      for (const r of runs) report.push(r)
      expect(runs.flatMap((r) => r.differences).map(differenceLine), `${p.id}: ${runs.length} designs, ${runs.reduce((n, r) => n + r.steps, 0)} steps`).toEqual([])
    }, 900_000)
  }

  it('turns red, naming the step, the field and both values, when one triangle of one engine reply changes', async () => {
    const h = bracket(5)
    // the steps both engines already agree on, from the first: one of them gets the changed triangle
    const clean = await runDesign('bracket-5', h, engines)
    const target = Math.min(...clean.differences.map((d) => d.step), h.steps.length + 1) - 1
    expect(target, `the engines differ from the bracket's first step, so no step is left to change:\n${clean.differences.map(differenceLine).join('\n')}`).toBeGreaterThan(0)
    // the browser engine's reply to that step's first call that has a mesh, one triangle turned the other way
    let step = 0
    let changed = ''
    const turnOne = (op: string, reply: unknown): unknown => {
      const mesh = (reply as { mesh?: { indices?: ArrayLike<number> } } | null)?.mesh
      if (step !== target || changed || !mesh?.indices || mesh.indices.length < 3) return reply
      const indices = Array.from(mesh.indices)
      ;[indices[0], indices[1]] = [indices[1]!, indices[0]!]
      changed = op
      return { ...(reply as object), mesh: { ...mesh, indices: ArrayBuffer.isView(mesh.indices) ? Uint32Array.from(indices) : indices } }
    }
    const run = await runDesign('bracket-5', h, { native: engines.native, wasm: (log) => wasmEngine(log, turnOne) }, (k) => (step = k))
    expect(changed, `no reply of step ${target} had a mesh to change`).not.toBe('')
    const lines = run.differences.map(differenceLine)
    const first = run.differences[0]!
    expect(first, lines.join('\n')).toMatchObject({ step: target, field: 'mesh', kind: 'mesh', part: 0 })
    expect(first.call).toMatchObject({ index: 1, op: changed, where: 'reply', path: 'mesh.indices[0]' })
    const line = differenceLine(first)
    expect(line.startsWith(`bracket-5 step ${target}/5 ${h.steps[target - 1]!.params.op} (`), line).toBe(true)
    expect(line).toMatch(/, mesh step\) part 0: mesh: native \d+ vertices, \d+ triangles, sha256 [0-9a-f]{16} \| wasm \d+ vertices, \d+ triangles, sha256 [0-9a-f]{16}; /)
    expect(line.endsWith(`; first differing engine call #1 ${changed}, reply at mesh.indices[0]: native ${first.call!.native} | wasm ${first.call!.wasm}`), line).toBe(true)
    expect(first.call!.native).toMatch(/^\d+$/)
    expect(first.call!.wasm).toMatch(/^\d+$/)
    expect(first.call!.native).not.toBe(first.call!.wasm)
    console.log(`one-triangle proof (step ${target} of the browser engine changed), the harness said:\n${lines.join('\n')}`)
  }, 600_000)
})
