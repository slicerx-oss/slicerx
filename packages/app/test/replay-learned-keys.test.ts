// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A replay learns the keys a step found its faces or edges by, and the app saves them into the step (withStatus). The
// next replay of the same history must still hit the cache: a shell on a loft takes the engine tens of seconds, and a
// project replay used to run it again just because its saved keys were new. The saved keys still reach the engine
// when an earlier step changes, and a step given a different key runs again.
import { beforeEach, describe, expect, it } from 'vitest'
import { HISTORY_VERSION, IDENTITY, clearReplayCache, replayHistory, type History, type HistoryMesh, type Step, type StepParams } from '@slicerx/cad-history'
import { withStatus } from '../src/cad/history/ops'

beforeEach(() => clearReplayCache())

/** One triangle facing up at z 0, its face keyed 42; with `moved`, a second up-facing one at x 20 to 30 takes key 42
 * and the first one is keyed 99, as when an earlier step changed the part. */
const part = (moved = false): HistoryMesh => ({
  name: 'Body',
  slot: 1,
  positions: moved ? [0, 0, 0, 10, 0, 0, 0, 10, 0, 20, 0, 0, 30, 0, 0, 20, 10, 0] : [0, 0, 0, 10, 0, 0, 0, 10, 0],
  indices: moved ? [0, 1, 2, 3, 4, 5] : [0, 1, 2],
  faces: moved ? { ids: [0, 1], table: [{}, {}], keys: [99, 42] } : { ids: [0], table: [{}], keys: [42] },
})

const moved = { frame: { origin: [2, 2, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, outline: [], distanceMm: 1 }

/** What the engine answers each op with: the part back, with the keys the step's faces and edges were found by. */
function reply(op: string, req: unknown): unknown {
  const r = req as { mesh?: { mesh?: HistoryMesh } & HistoryMesh; options?: { targetRatio?: number } }
  const mesh = r.mesh?.mesh ?? r.mesh
  switch (op) {
    case 'simplify':
      return { mesh: part(r.options?.targetRatio === 0.6) }
    case 'face.push':
      return { mesh, moved }
    case 'shell':
      return { mesh, report: { openKeys: [42] } }
    case 'edge.fillet':
    case 'edge.chamfer':
      return { mesh, refs: [{ keys: [42, 7] }] }
    default:
      return { mesh }
  }
}

function engine() {
  const calls: { op: string; req: unknown }[] = []
  const call = async (op: string, req: unknown) => {
    calls.push({ op, req })
    return reply(op, req)
  }
  return { call, calls, count: (op: string) => calls.filter((c) => c.op === op).length }
}

const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
const edge = { a: [0, 0, 0] as [number, number, number], b: [10, 0, 0] as [number, number, number], face: [0, 0, 1] as [number, number, number] }

/** Each step type that learns keys on a replay, with no key saved yet (a version 1 file, or a pick on a keyless face). */
const learners: [string, StepParams][] = [
  ['face.push', { op: 'face.push', at: [2, 2, 0], normal: [0, 0, 1], distanceMm: 1 }],
  ['shell', { op: 'shell', open: [{ at: [2, 2, 0], normal: [0, 0, 1] }], wallMm: 2 }],
  ['edge.fillet', { op: 'edge.fillet', edges: [edge], radiusMm: 1 }],
  ['edge.chamfer', { op: 'edge.chamfer', edges: [edge], distanceMm: 1 }],
]

const history = (...steps: Step[]): History => ({ version: HISTORY_VERSION, base: [part()], steps })

/** The history as the app keeps it after a replay: each step with the keys the replay found for it. */
const saved = (h: History, r: Awaited<ReturnType<typeof replayHistory>>): History => ({ ...h, steps: withStatus(h.steps, r.status, r.found) })

describe.each(learners)('%s', (op, params) => {
  it('a second replay with the learned keys saved runs the step once', async () => {
    const e = engine()
    const h = history(step('s1', params))
    const first = await replayHistory(e.call, { history: h })
    expect(first.status[0]?.state).toBe('done')
    const after = saved(h, first)
    // the replay learned keys and the app saved them, so the params changed
    expect(after.steps[0]!.params).not.toEqual(h.steps[0]!.params)
    const second = await replayHistory(e.call, { history: after })
    expect(e.count(op)).toBe(1)
    expect(second.status).toEqual(first.status)
    expect(second.found).toEqual(first.found)
    expect(second.parts).toEqual(first.parts)
  })

  it('a step after it is not run again either', async () => {
    const e = engine()
    const h = history(step('s1', params), step('s2', { op: 'repair' }))
    const first = await replayHistory(e.call, { history: h })
    await replayHistory(e.call, { history: saved(h, first) })
    expect(e.count(op)).toBe(1)
    expect(e.count('repair')).toBe(1)
  })

  it('a changed earlier step runs it again, with the saved keys', async () => {
    const e = engine()
    const h = history(step('s0', { op: 'simplify', targetRatio: 0.5 }), step('s1', params))
    const first = await replayHistory(e.call, { history: h })
    const after = saved(h, first)
    const edited: History = { ...after, steps: [step('s0', { op: 'simplify', targetRatio: 0.6 }), after.steps[1]!] }
    const r = await replayHistory(e.call, { history: edited })
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(e.count('simplify')).toBe(2)
    if (op === 'face.push') {
      // no engine call reads the key: the step picks the face itself, and the saved key moves it to the face keyed 42
      expect(e.count(op)).toBe(2)
      const req = e.calls.filter((c) => c.op === op)[1]!.req as { triangle: number }
      expect(req.triangle).toBe(1)
    } else {
      expect(e.count(op)).toBe(2)
      const req = e.calls.filter((c) => c.op === op)[1]!.req as { open?: { key?: number }[]; edges?: { keys?: [number, number] }[] }
      if (op === 'shell') expect(req.open?.[0]?.key).toBe(42)
      else expect(req.edges?.[0]?.keys).toEqual([42, 7])
    }
  })

  it('a step given another key runs again', async () => {
    const e = engine()
    const h = history(step('s1', params))
    const first = await replayHistory(e.call, { history: h })
    const after = saved(h, first)
    const p = after.steps[0]!.params
    const other: StepParams =
      p.op === 'face.push' ? { ...p, faceKey: 77 } : p.op === 'shell' ? { ...p, open: p.open.map((o) => ({ ...o, key: 77 })) } : p.op === 'edge.fillet' || p.op === 'edge.chamfer' ? { ...p, edges: p.edges.map((x) => ({ ...x, keys: [77, 7] as [number, number] })) } : p
    const r = await replayHistory(e.call, { history: { ...after, steps: [{ ...after.steps[0]!, params: other }] } })
    if (op === 'face.push') {
      // no face has key 77: the step stops for repair rather than reusing the face keyed 42
      expect(r.status[0]?.state).toBe('broken')
    } else {
      expect(e.count(op)).toBe(2)
      const req = e.calls.at(-1)!.req as { open?: { key?: number }[]; edges?: { keys?: [number, number] }[] }
      if (op === 'shell') expect(req.open?.[0]?.key).toBe(77)
      else expect(req.edges?.[0]?.keys).toEqual([77, 7])
    }
  })

  it('the saved keys are kept by the next replay', async () => {
    const e = engine()
    const h = history(step('s1', params))
    const first = await replayHistory(e.call, { history: h })
    const after = saved(h, first)
    const second = await replayHistory(e.call, { history: after })
    expect(saved(after, second).steps).toEqual(after.steps)
  })
})
