// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// CAD history (docs/cad-history.md): replay of steps on a base, edits that replay the later steps,
// suppress and delete, broken steps, references that follow an earlier end face, the project file
// round trip, and one undo step per history edit. Runs against the geometry engine (live wasm when
// built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { deflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import { geom } from '../src/geom/client'
import { capOf, findTriangle, followed, stepName, withNumber, type History, type HistoryMesh, type Step, type StepParams } from '../src/cad/history/model'
import { clearReplayCache, replayHistory } from '../src/cad/history/replay'
import { withStep } from '../src/cad/history/record'
import { allPlates } from '../src/plate/plates'
import { applyHistory, beginEdit, cancelEdit, deleteStep, editing, runReplay, saveEdit, setParams, setSuppressed } from '../src/cad/history/ops'
import { encodeMeshes, historyFiles } from '../src/export/history-file'
import { decodeMeshes, parseHistories } from '../src/export/history-read'
import { createHistory } from '../src/plate/history'
import { boxMesh, cylinderMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { appStore, get, set } from '../src/state/store'
import { axisSegment, fromLoops, rectangle, toLoops, type Entity } from '../src/cad/sketch-model'
import { useGeomEngine } from './geom-engine'

useGeomEngine('cad-history-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const call = (op: string, r: unknown) => geom().call(op, r)

/** A 40 by 20 by 5 mm plate, the bracket's foot. */
const base = (): HistoryMesh[] => [boxMesh(40, 20, 5)]

function volume(m: Pick<HistoryMesh, 'positions' | 'indices'>): number {
  let v = 0
  const p = m.positions
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const [a, b, c] = [3 * m.indices[k]!, 3 * m.indices[k + 1]!, 3 * m.indices[k + 2]!]
    v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
  }
  return v
}
const topZ = (m: Pick<HistoryMesh, 'positions'>) => {
  let z = -Infinity
  for (let i = 2; i < m.positions.length; i += 3) z = Math.max(z, m.positions[i]!)
  return z
}

const pull = (distanceMm: number, z = 5): StepParams => ({ op: 'face.push', at: [100, 100, z], normal: [0, 0, 1], distanceMm })
type Extrude = Extract<StepParams, { op: 'shape.extrude' }>
const boss = (z: number): Extrude => ({ op: 'shape.extrude', frame: { origin: [100, 100, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 6 }, placement: {}, spec: { distanceMm: 4, operation: 'join' } })
const hole = (z: number): Extrude => ({ op: 'shape.extrude', frame: { origin: [100, 100, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 4 }, placement: { center: [12, 0] }, spec: { distanceMm: 3, operation: 'cut' } })

/** Pull the top 5 mm, a boss on the new top, a hole beside it: each recorded the way the tools record it. */
function bracket(): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: base() as MeshPart[], transform: T }
  for (const p of [pull(5), boss(10), hole(10)]) e = { ...e, history: withStep(e, 0, p) }
  return e.history!
}

beforeEach(() => clearReplayCache())

describe('history model', () => {
  it('names steps in plain words', () => {
    expect(stepName({ params: pull(5) })).toBe('Pull 5 mm')
    expect(stepName({ params: pull(-2.5) })).toBe('Push 2.5 mm')
    expect(stepName({ params: hole(10) })).toBe('Hole 4 mm')
    expect(stepName({ params: { ...boss(10), shape: { type: 'sketch', loops: [] }, spec: { distanceMm: 12, operation: 'join' } } })).toBe('Sketch extrude 12 mm')
    expect(stepName({ params: { op: 'hollow', wallMm: 2 } })).toBe('Hollow, 2 mm walls')
    expect(stepName({ params: { op: 'edge.fillet', edges: [{ a: [0, 0, 0], b: [1, 0, 0], face: [0, 0, 1] }], radiusMm: 2 } })).toBe('Fillet 2 mm')
    expect(withNumber(pull(5), 0)).toMatch(/not 0/)
    expect(withNumber(pull(5), 8)).toMatchObject({ distanceMm: 8 })
  })

  it('finds a picked face again by point and normal, through the transform', () => {
    const m = boxMesh(40, 20, 5)
    const t = findTriangle(m, T, [110, 104, 5], [0, 0, 1])
    expect([2, 3]).toContain(t)
    expect(findTriangle(m, T, [110, 104, 6], [0, 0, 1])).toBe(-1)
    expect(findTriangle(m, T, [110, 104, 5], [0, 1, 0])).toBe(-1)
  })

  it('records that steps placed on a pulled face follow it, and moves them when the pull changes', () => {
    const h = bracket()
    expect(h.steps[1]!.follow).toEqual({ step: h.steps[0]!.id, distanceMm: 5 })
    expect(h.steps[2]!.follow).toEqual({ step: h.steps[0]!.id, distanceMm: 5 })
    expect(capOf(h.steps[0]!)!.point).toEqual([0, 0, 10])
    const steps = h.steps.map((s, i) => (i === 0 ? { ...s, params: pull(8) } : s))
    const moved = followed(steps[1]!, steps)
    expect(moved.params.op === 'shape.extrude' && moved.params.frame!.origin).toEqual([100, 100, 13])
  })

  it('a step after a broken one suppresses the steps that did not run', () => {
    const h = bracket()
    const broken: History = { ...h, steps: h.steps.map((s, i) => (i === 1 ? { ...s, broken: 'The shape no longer reaches the part.' } : s)) }
    const next = withStep({ parts: base() as MeshPart[], transform: T, history: broken }, 0, { op: 'hollow', wallMm: 1 })
    expect(next.steps.map((s) => Boolean(s.suppressed))).toEqual([false, true, true, false])
  })
})

describe('saved sketches reopen', () => {
  it('turns engine loops back into drawn entities, arcs by center and sweep included', () => {
    const drawn: Entity[] = [rectangle([0, 0], [10, 6]), { kind: 'circle', center: [20, 3], diameterMm: 4 }, { kind: 'chain', start: [0, 10], segs: [{ kind: 'line', to: [8, 10] }, { kind: 'arc', to: [0, 10], through: [4, 14] }], closed: true }]
    expect(fromLoops(toLoops(drawn))).toEqual(drawn)
    const rounded = fromLoops([{ start: [0, 0], segments: [{ type: 'line', to: [8, 0] }, { type: 'arc', center: [8, 2], sweepDeg: 90 }, { type: 'line', to: [0, 2] }, { type: 'line', to: [0, 0] }] }])!
    const arc = (rounded[0] as Extract<Entity, { kind: 'chain' }>).segs[1]!
    expect(arc.kind === 'arc' && arc.to).toEqual([10, 2])
    expect(arc.kind === 'arc' && arc.through[0]).toBeCloseTo(8 + Math.SQRT2)
    expect(fromLoops([{ start: [0, 0], segments: [{ type: 'line', lengthMm: 5, angleDeg: 0 }] }])).toBeNull()
    expect(axisSegment(drawn, { point: [0, 0], direction: [0, 1] })).toEqual({ e: 0, seg: 3 })
  })
})

describe('replay', () => {
  it('replays a bracket and starts an edit at the edited step', async () => {
    const h = bracket()
    let calls = 0
    const counted = (op: string, r: unknown) => {
      calls++
      return call(op, r)
    }
    const r = await replayHistory(counted, { history: h })
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(calls).toBe(3)
    const part = r.parts[0]!
    expect(topZ(part)).toBeCloseTo(14)
    // Plate 40 x 20 x 10, boss 6 mm across and 4 tall, hole 4 mm across and 3 deep.
    const expected = 40 * 20 * 10 + Math.PI * 9 * 4 - Math.PI * 4 * 3
    expect(Math.abs(volume(part) - expected)).toBeLessThan(expected * 0.01)
    expect(r.moved[h.steps[0]!.id]?.distanceMm).toBe(5)

    // Pull 8 instead of 5: the boss and the hole move up with the face they sat on.
    calls = 0
    const edited: History = { ...h, steps: h.steps.map((s, i) => (i === 0 ? { ...s, params: pull(8) } : s)) }
    const r2 = await replayHistory(counted, { history: edited })
    expect(calls).toBe(3)
    expect(topZ(r2.parts[0]!)).toBeCloseTo(17)

    // Only the last step changes: the two before it come from the cache.
    calls = 0
    const deeper: History = { ...edited, steps: edited.steps.map((s, i) => (i === 2 ? { ...s, params: { ...hole(10), spec: { distanceMm: 6, operation: 'cut' } } } : s)) }
    const r3 = await replayHistory(counted, { history: deeper, before: 2 })
    expect(calls).toBe(1)
    expect(topZ(r3.before![0]!)).toBeCloseTo(17)
    expect(volume(r3.parts[0]!)).toBeLessThan(volume(r2.parts[0]!))
  })

  it('replays without a suppressed step', async () => {
    const h = bracket()
    const r = await replayHistory(call, { history: { ...h, steps: h.steps.map((s, i) => (i === 1 ? { ...s, suppressed: true } : s)) } })
    expect(r.status.map((s) => s.state)).toEqual(['done', 'suppressed', 'done'])
    expect(topZ(r.parts[0]!)).toBeCloseTo(10)
  })

  it('marks a step whose face is gone as broken, skips the rest, and shows the result before it', async () => {
    const h = bracket()
    const bad: History = { ...h, steps: [h.steps[0]!, { id: 'gone', part: 0, transform: T, params: pull(3, 30) }, h.steps[1]!] }
    const r = await replayHistory(call, { history: bad })
    expect(r.status).toEqual([{ state: 'done' }, { state: 'broken', message: 'The face this step moved is gone.' }, { state: 'skipped' }])
    expect(topZ(r.parts[0]!)).toBeCloseTo(10)
  })

  it('passes the engine sentence when an op fails', async () => {
    const h = bracket()
    const bad: History = { ...h, steps: [{ ...h.steps[0]!, params: { op: 'shape.extrude', frame: { origin: [100, 100, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'sketch', loops: [{ start: [0, 0], segments: [{ type: 'line', to: [5, 0] }] }] }, spec: { distanceMm: 2, operation: 'join' } } }] }
    const r = await replayHistory(call, { history: bad })
    expect(r.status[0]!.state).toBe('broken')
    expect(r.status[0]!.message).toMatch(/Loop 1/)
    expect(r.parts[0]!.indices.length).toBe(36)
  })
})

describe('history on the plate', () => {
  beforeEach(() => {
    set({ plate: [{ id: 'a', name: 'Bracket', handle: handle('a'), parts: base() as MeshPart[], colors: ['#bd93f9'], transform: T, history: bracket() }], selection: 'a', selectedIds: ['a'], historyEdit: null })
  })

  it('lands each edit in one undo step and keeps broken marks on the steps', async () => {
    const undo = createHistory(appStore)
    try {
      await setParams(host, 'a', 0, pull(8))
      expect(undo.canUndo()).toBe(true)
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(17)
      await setSuppressed(host, 'a', 1, true)
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(13)
      undo.undo()
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(17)
      expect(get().plate[0]!.history!.steps[1]!.suppressed).toBeUndefined()
      undo.undo()
      expect(get().plate[0]!.parts[0]!.indices.length).toBe(36)
      // A push into empty space breaks; the steps after it are skipped and the mesh is the one before.
      const h = get().plate[0]!.history!
      await applyHistory(host, 'a', { ...h, steps: [h.steps[0]!, { id: 'x', part: 0, transform: T, params: pull(2, 40) }, ...h.steps.slice(1)] })
      const after = get().plate[0]!
      expect(after.history!.steps[1]!.broken).toBe('The face this step moved is gone.')
      expect(topZ(after.parts[0]!)).toBeCloseTo(10)
      await deleteStep(host, 'a', 1)
      expect(get().plate[0]!.history!.steps.some((s) => s.broken)).toBe(false)
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(14)
    } finally {
      undo.dispose()
    }
  })
})

describe('editing a step', () => {
  beforeEach(async () => {
    const h = bracket()
    const r = await runReplay({ history: h })
    set({ plate: [{ id: 'a', name: 'Bracket', handle: handle('a'), parts: r.parts as MeshPart[], colors: ['#bd93f9'], transform: T, history: h }], selection: 'a', selectedIds: ['a'], historyEdit: null, objectTool: null })
  })

  it('rolls the part back outside undo, saves in one undo step, and cancels cleanly', async () => {
    const undo = createHistory(appStore)
    try {
      const original = get().plate[0]!
      await beginEdit(host, 'a', 1)
      expect(get().historyEdit?.index).toBe(1)
      expect(get().objectTool).toBe('shape')
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(10)
      expect(undo.canUndo()).toBe(false)
      expect(editing()?.step.id).toBe(original.history!.steps[1]!.id)
      // Saves write the object as it is, not the rolled-back view.
      expect(allPlates()[0]!.objects[0]).toBe(original)
      cancelEdit()
      expect(get().plate[0]).toBe(original)
      expect(get().historyEdit).toBeNull()
      expect(undo.canUndo()).toBe(false)

      await beginEdit(host, 'a', 1)
      await saveEdit(host, { ...boss(10), spec: { distanceMm: 6, operation: 'join' } })
      expect(get().historyEdit).toBeNull()
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(16)
      undo.undo()
      expect(get().plate[0]).toBe(original)
      expect(undo.canUndo()).toBe(false)

      // Undo while a step is open puts the object back first.
      undo.redo()
      await beginEdit(host, 'a', 0)
      undo.undo()
      expect(get().historyEdit).toBeNull()
      expect(get().plate[0]).toBe(original)
    } finally {
      undo.dispose()
    }
  })
})

describe('project file', () => {
  it('writes and reads the history, base meshes as a binary part', () => {
    const h: History = { ...bracket(), steps: [...bracket().steps, { id: 'm', part: -1, transform: T, params: { op: 'parts.add', label: 'Merge with Peg', parts: [{ ...cylinderMesh(5, 10, 24), name: 'Peg', slot: 2 }] } }] }
    const files = historyFiles([{ id: 'a', history: h }, { id: 'b' }], new Map([['a', 3], ['b', 4]]))
    expect(files.map((f) => f.name)).toEqual(['Metadata/slicerx_history.json', 'Metadata/slicerx_history/3-0.bin', 'Metadata/slicerx_history/3-1.bin'])
    const map = new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    const back = parseHistories(map, new Set(['3', '4']))
    expect([...back.keys()]).toEqual(['3'])
    const got = back.get('3')!
    expect(got.steps.map((s) => s.params.op)).toEqual(['face.push', 'shape.extrude', 'shape.extrude', 'parts.add'])
    expect(got.steps[1]!.follow).toEqual(h.steps[1]!.follow)
    expect(Array.from(got.base[0]!.positions)).toEqual(Array.from(h.base[0]!.positions))
    const added = got.steps[3]!.params
    expect(added.op === 'parts.add' && added.parts[0]!.name).toBe('Peg')
    expect(added.op === 'parts.add' && added.parts[0]!.indices.length).toBe(cylinderMesh(5, 10, 24).indices.length)
  })

  it('ignores a newer version, a missing object and a damaged mesh part', () => {
    const files = historyFiles([{ id: 'a', history: bracket() }], new Map([['a', 3]]))
    const map = new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    expect(parseHistories(map, new Set(['9'])).size).toBe(0)
    const newer = new Map(map)
    newer.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify({ version: 2, objects: [] })))
    expect(parseHistories(newer, new Set(['3'])).size).toBe(0)
    const damaged = new Map(map)
    damaged.set('Metadata/slicerx_history/3-0.bin', new Uint8Array(20))
    expect(parseHistories(damaged, new Set(['3'])).size).toBe(0)
    expect(decodeMeshes(encodeMeshes(base()), [{ name: 'Box', slot: 1 }])![0]!.indices.length).toBe(36)
  })

  it('costs about as much as the mesh it stores once, deflated', () => {
    // A bracket-sized mesh of 20,000 triangles: the stored base against the same mesh as 3MF XML.
    // A scan-like surface: every coordinate a little off the grid, so floats compress as badly as they do in real models.
    const c = cylinderMesh(30, 20, 5000)
    const m = { ...c, positions: c.positions.map((v, i) => v + (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.01) }
    const bin = deflateRawSync(encodeMeshes([m])).byteLength
    let xml = ''
    for (let i = 0; i < m.positions.length; i += 3) xml += `<vertex x="${m.positions[i]}" y="${m.positions[i + 1]}" z="${m.positions[i + 2]}"/>`
    for (let i = 0; i < m.indices.length; i += 3) xml += `<triangle v1="${m.indices[i]}" v2="${m.indices[i + 1]}" v3="${m.indices[i + 2]}"/>`
    const xmlBytes = deflateRawSync(new TextEncoder().encode(xml)).byteLength
    const tris = m.indices.length / 3
    console.log(`history base: ${tris} triangles, ${bin} bytes deflated (${(bin / tris).toFixed(1)} per triangle); same mesh as model XML ${xmlBytes} bytes`)
    expect(bin).toBeLessThan(xmlBytes * 1.5)
  })
})
