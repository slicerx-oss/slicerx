// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull on a face beside a fillet or chamfer (docs/cad-history.md, "Push beside a round"): the
// push goes into the history before the round, which is made again on the moved edge, so nothing of
// the old round stands. Undo, redo and a fresh replay give the same bytes. Against the geometry engine
// (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { pickEdge } from '../src/cad/edge-api'
import { applyEdges, edgeParams, type Kind } from '../src/cad/edges'
import { findTriangle, followsOf, stepName, type History, type HistoryMesh, type Step } from '../src/cad/history/model'
import { runReplay, setParams } from '../src/cad/history/ops'
import { clearReplayCache } from '../src/cad/history/replay'
import { applyPush, pickPushFace } from '../src/cad/push'
import { historyFiles } from '../src/export/history-file'
import { parseHistories } from '../src/export/history-read'
import type { Vec3 } from '../src/geom/cad'
import { toGeom } from '../src/geom/client'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { appStore, get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('cad-push-fillet-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
// The block is 30 x 20 x 10 mm, centered on (100, 100) on the bed: x 85 to 115, y 90 to 110.
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const UP: Vec3 = [0, 0, 1]
const FRONT: Vec3 = [0, -1, 0]
const DOWN: Vec3 = [0, 0, -1]
const LEFT: Vec3 = [-1, 0, 0]
const entry = () => get().plate.find((p) => p.id === 'a')!
const part = () => entry().parts[0]!

function place(parts: MeshPart[], history?: History): void {
  set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts, colors: ['#bd93f9'], transform: T, ...(history ? { history } : {}) }], selection: 'a', selectedIds: ['a'], historyEdit: null, objectTool: null, plateLoading: false })
}

beforeEach(() => {
  clearReplayCache()
  place([boxMesh(30, 20, 10)])
})

/** The extent of a part along an axis, world. */
function extent(m: Pick<HistoryMesh, 'positions'>, axis: number): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = axis; i < m.positions.length; i += 3) {
    const v = m.positions[i]! + (axis === 0 ? 100 : axis === 1 ? 100 : 0)
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  return [lo, hi]
}

function volume(m: Pick<HistoryMesh, 'positions' | 'indices'>): number {
  const p = m.positions
  const ix = m.indices
  let v = 0
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const [a, b, c] = [3 * ix[t]!, 3 * ix[t + 1]!, 3 * ix[t + 2]!]
    v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return v / 6
}

/** Every edge between exactly two triangles, once each way. */
function watertight(m: Pick<HistoryMesh, 'positions' | 'indices'>): boolean {
  const key = (i: number) => `${m.positions[3 * i]},${m.positions[3 * i + 1]},${m.positions[3 * i + 2]}`
  const seen = new Map<string, number>()
  for (let t = 0; t + 2 < m.indices.length; t += 3) {
    for (let j = 0; j < 3; j++) {
      const a = key(m.indices[t + j]!)
      const b = key(m.indices[t + ((j + 1) % 3)]!)
      seen.set(`${a}|${b}`, (seen.get(`${a}|${b}`) ?? 0) + 1)
    }
  }
  for (const [k, n] of seen) {
    const [a, b] = k.split('|')
    if (n !== 1 || seen.get(`${b}|${a}`) !== 1) return false
  }
  return true
}

const tri = (at: Vec3, normal: Vec3) => findTriangle(part(), T, at, normal)

async function round(kind: Kind, at: Vec3, normal: Vec3, size = 2): Promise<void> {
  const p = await pickEdge({ mesh: toGeom(part()), transform: T }, { triangle: tri(at, normal), at })
  expect(p.supported).toBe(true)
  await applyEdges(host, 'a', 0, edgeParams(kind, [p.edge], size, null))
}

async function push(at: Vec3, normal: Vec3, d: number) {
  return applyPush(host, await pickPushFace('a', 0, { triangle: tri(at, normal), at }), d)
}

/** A fresh replay of the history gives the part, byte for byte. */
async function replaysTheSame(): Promise<void> {
  clearReplayCache()
  const r = await runReplay({ history: entry().history! })
  expect(r.status.every((s) => s.state === 'done')).toBe(true)
  const now = part()
  expect(new Float32Array(r.parts[0]!.positions)).toEqual(now.positions)
  expect(new Uint32Array(r.parts[0]!.indices)).toEqual(now.indices)
}

const names = () => entry().history!.steps.map((s) => stepName(s))
const follows = (s: Step) => followsOf(s).map((f) => f.step)

/** The block of the given size, its top front edge rounded, as a fresh object: what the push should give. */
async function reference(kind: Kind, h: number, front = 90): Promise<HistoryMesh> {
  const back = entry()
  const base = boxMesh(30, 110 - front, h)
  const shift = (front - 90) / 2
  const positions = new Float32Array(base.positions)
  for (let i = 1; i < positions.length; i += 3) positions[i] = positions[i]! + shift
  place([{ ...base, positions }])
  await round(kind, [100, front + 0.5, h], UP)
  const m = part()
  set({ plate: [back] })
  return m
}

describe('push beside a round', () => {
  it('pushing the top into the part rounds the moved edge and leaves no lip', async () => {
    const ref = await reference('fillet', 7)
    await round('fillet', [100, 90.5, 10], UP)
    const undo = createHistory(appStore)
    try {
      const before = part()
      const r = await push([100, 100, 10], UP, -3)
      expect(r.message).toMatch(/^Cut [\d.]+ cm³ out of Block\. The fillet along that face was made again on the moved edge\.$/)
      expect(r.warn).toBe(false)
      expect(names()).toEqual(['Push 3 mm', 'Fillet 2 mm'])
      const [p0, f0] = entry().history!.steps
      expect(follows(f0!)).toEqual([p0!.id])
      // Nothing stands above the new top: the old round is gone, the new one sits on the moved edge.
      expect(extent(part(), 2)).toEqual([0, 7])
      expect(watertight(part())).toBe(true)
      expect(volume(part())).toBeCloseTo(volume(ref), 3)
      await replaysTheSame()
      const after = part()
      undo.undo()
      expect(part().positions).toEqual(before.positions)
      expect(part().indices).toEqual(before.indices)
      expect(names()).toEqual(['Fillet 2 mm'])
      undo.redo()
      expect(part().positions).toEqual(after.positions)
      expect(part().indices).toEqual(after.indices)
      expect(entry().history!.steps).toHaveLength(2)
    } finally {
      undo.dispose()
    }
  })

  it('pulling the top out does the same the other way', async () => {
    await round('fillet', [100, 90.5, 10], UP)
    await push([100, 100, 10], UP, 4)
    expect(names()).toEqual(['Pull 4 mm', 'Fillet 2 mm'])
    expect(extent(part(), 2)).toEqual([0, 14])
    expect(watertight(part())).toBe(true)
    expect(volume(part())).toBeCloseTo(volume(await reference('fillet', 14)), 3)
    await replaysTheSame()
  })

  it('a chamfer follows like a fillet', async () => {
    await round('chamfer', [100, 90.5, 10], UP)
    await push([100, 100, 10], UP, -3)
    expect(names()).toEqual(['Push 3 mm', 'Chamfer 2 mm'])
    expect(extent(part(), 2)).toEqual([0, 7])
    expect(volume(part())).toBeCloseTo(30 * 20 * 7 - 30 * 2, 3)
    await replaysTheSame()
  })

  it('faces on both sides of the edge move, and an edit of either push moves the round', async () => {
    await round('fillet', [100, 90.5, 10], UP)
    await push([100, 100, 10], UP, -3)
    await push([100, 90, 3], FRONT, -2)
    expect(names()).toEqual(['Push 3 mm', 'Push 2 mm', 'Fillet 2 mm'])
    const [top, front, fillet] = entry().history!.steps
    expect(follows(fillet!).sort()).toEqual([top!.id, front!.id].sort())
    expect(extent(part(), 1)).toEqual([92, 110])
    expect(extent(part(), 2)).toEqual([0, 7])
    expect(volume(part())).toBeCloseTo(volume(await reference('fillet', 7, 92)), 3)
    await replaysTheSame()
    // The top goes back up 2 mm: the round goes with it.
    await setParams(host, 'a', 0, { op: 'face.push', at: [100, 100, 10], normal: UP, distanceMm: -1 })
    expect(entry().history!.steps.every((s) => s.broken === undefined)).toBe(true)
    expect(extent(part(), 2)).toEqual([0, 9])
    expect(volume(part())).toBeCloseTo(volume(await reference('fillet', 9, 92)), 3)
    await replaysTheSame()
  })

  it('a round on another edge stays where it is and the push goes at the end', async () => {
    // The bottom front edge: the top does not touch it.
    await round('fillet', [100, 90.5, 0], DOWN)
    await push([100, 100, 10], UP, -3)
    expect(names()).toEqual(['Fillet 2 mm', 'Push 3 mm'])
    expect(extent(part(), 2)).toEqual([0, 7])
    // A rounded corner of the top only ends on it: the top's outline carries the round down.
    place([boxMesh(30, 20, 10)])
    await round('fillet', [85, 91, 5], LEFT)
    await push([100, 100, 10], UP, -3)
    expect(names()).toEqual(['Fillet 2 mm', 'Push 3 mm'])
    expect(extent(part(), 2)).toEqual([0, 7])
    expect(watertight(part())).toBe(true)
    await replaysTheSame()
  })

  it('a pocket floor pushed through takes its round with it and leaves no ledge', async () => {
    const pocket: History = { version: 1, base: [boxMesh(40, 30, 6)], steps: [{ id: 'pocket', part: 0, transform: T, params: { op: 'subtract', solids: [{ type: 'box', min: [90, 95, 2], max: [110, 105, 7] }], label: 'Pocket' } }] }
    const r = await runReplay({ history: pocket })
    place(r.parts as MeshPart[], pocket)
    // The concave edges around the floor, rounded.
    const p = await pickEdge({ mesh: toGeom(part()), transform: T }, { triangle: tri([100, 100, 2], UP), at: [100, 95.2, 2] })
    expect(p.supported && !p.convex).toBe(true)
    await applyEdges(host, 'a', 0, edgeParams('fillet', p.loop.map((l) => l.edge), 1, null))
    await push([100, 100, 2], UP, -2.5)
    expect(names()).toEqual(['Pocket', 'Push 2.5 mm', 'Fillet 1 mm, 4 edges'])
    expect(entry().history!.steps.every((s) => s.broken === undefined)).toBe(true)
    expect(volume(part())).toBeCloseTo(40 * 30 * 6 - 20 * 10 * 6, 3)
    expect(watertight(part())).toBe(true)
    await replaysTheSame()
  })

  it('a project keeps the faces a round follows', () => {
    const steps: Step[] = [
      { id: 'p', part: 0, transform: T, params: { op: 'face.push', at: [100, 100, 10], normal: UP, distanceMm: -3 } },
      { id: 'q', part: 0, transform: T, params: { op: 'face.push', at: [100, 90, 3], normal: FRONT, distanceMm: -2 } },
      {
        id: 'f',
        part: 0,
        transform: T,
        params: { op: 'edge.fillet', edges: [{ a: [85, 90, 10], b: [115, 90, 10], face: UP }, { a: [85, 90, 0], b: [85, 90, 10], face: FRONT }], radiusMm: 2 },
        follow: [{ step: 'p', distanceMm: 0, points: [0, 1, 3] }, { step: 'q', distanceMm: 0 }],
      },
    ]
    const history: History = { version: 1, base: [boxMesh(30, 20, 10)], steps }
    const files = historyFiles([{ id: 'a', history }], new Map([['a', 1]]))
    const back = parseHistories(new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data])), new Set(['1'])).get('1')
    expect(back?.steps.map((s) => s.follow)).toEqual([undefined, undefined, steps[2]!.follow])
  })

  it('a top rounded all round is still a face to push, and its rim comes down with it', async () => {
    const p = await pickEdge({ mesh: toGeom(part()), transform: T }, { triangle: tri([100, 100, 10], UP), at: [100, 90.5, 10] })
    await applyEdges(host, 'a', 0, edgeParams('fillet', p.loop.map((l) => l.edge), 2, null))
    // The top meets only the round's strips now.
    const face = await pickPushFace('a', 0, { triangle: tri([100, 100, 10], UP), at: [100, 100, 10] })
    expect(face.frame.normal[2]).toBeCloseTo(1)
    // Pushed, the whole rounded rim comes down with it.
    await applyPush(host, face, -3)
    expect(names()).toEqual(['Push 3 mm', 'Fillet 2 mm, 4 edges'])
    expect(extent(part(), 2)).toEqual([0, 7])
    expect(watertight(part())).toBe(true)
    await replaysTheSame()
  })
})

