// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint steps in the CAD history (@slicerx/cad-history): a step stores its target, replay paints it again through
// the engine's `paint.select`, a later step that changes the part's triangles drops the paint with a note, and paint
// on stored meshes and paint steps come back from the project file. The engine here is a stand-in that answers
// `paint.select` and `repair` the way sx-geom does; the real op's results are tested in sx-geom.
import { describe, expect, it } from 'vitest'
import { PAINT_DROPPED, HISTORY_VERSION, clearReplayCache, historyFiles, mainNumber, parseHistories, replayHistory, stepName, withNumber, type History, type HistoryMesh, type PaintTarget, type StepParams } from '@slicerx/cad-history'
import { stepIcon } from '../src/cad/history/step-icon'
import { boxMesh } from '../src/plate/mesh-ops'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** What the engine was asked, and its answers: the bottom of a box is triangles 0 and 1 (boxMesh). */
function engine() {
  const asked: { op: string; request: Record<string, unknown> }[] = []
  const call = async (op: string, request: unknown): Promise<unknown> => {
    const r = request as Record<string, unknown>
    asked.push({ op, request: r })
    if (op === 'paint.select') {
      const target = r['target'] as PaintTarget
      const state = r['state'] as number
      const text = state === 0 ? '' : state < 3 ? (state << 2).toString(16).toUpperCase() : `${(state - 3).toString(16).toUpperCase()}C`
      if (target.kind === 'direction' && target.direction === 'bottom') return { changed: { '0': text, '1': text } }
      if (target.kind === 'seed') return { changed: { '2': text } }
      throw new Error('target: not one this stand-in knows')
    }
    if (op === 'repair') {
      const mesh = r['mesh'] as { positions: number[]; indices: number[] }
      return { mesh: { positions: mesh.positions, indices: mesh.indices } }
    }
    if (op === 'cut') {
      const mesh = r['mesh'] as { positions: number[]; indices: number[] }
      return { below: { positions: mesh.positions, indices: mesh.indices }, above: { positions: mesh.positions, indices: mesh.indices } }
    }
    throw new Error(`no ${op} here`)
  }
  return { call, asked }
}

const step = (id: string, params: StepParams) => ({ id, part: 0, transform: T, params })
const paint = (target: PaintTarget, state = 2, layer: 'color' | 'seam' = 'color'): StepParams => ({ op: 'paint', layer, state, target })

describe('a paint step on replay', () => {
  it('does not paint a neighboring face when the stored seed key is missing', async () => {
    clearReplayCache()
    const e = engine()
    const history: History = { version: HISTORY_VERSION, base: [boxMesh(20, 20, 10)], steps: [step('missing', paint({ kind: 'seed', point: [10, 10, 10], faceKey: 123 }))] }
    const r = await replayHistory(e.call, { history })
    expect(r.status[0]).toMatchObject({ state: 'broken', message: expect.stringMatching(/missing.*repair/i) })
    expect(r.parts[0]?.paint).toBeUndefined()
    expect(e.asked.some((a) => a.op === 'paint.select')).toBe(false)
  })

  it('paints its target again through the engine and keeps the paint on the part', async () => {
    clearReplayCache()
    const e = engine()
    const history: History = { version: 1, base: [boxMesh(20, 20, 10)], steps: [step('p1', paint({ kind: 'direction', direction: 'bottom' }))] }
    const r = await replayHistory(e.call, { history })
    expect(r.status[0]).toEqual({ state: 'done' })
    expect(r.parts[0]?.paint).toEqual({ color: { 0: '8', 1: '8' } })
    // The engine got the part, the step's frame, the layer's texts so far and the target as stored.
    const asked = e.asked.find((a) => a.op === 'paint.select')!.request
    expect(asked['transform']).toEqual(T)
    expect(asked['paint']).toEqual({})
    expect(asked['state']).toBe(2)
  })

  it('builds on earlier paint, clears with state 0, and keeps layers apart', async () => {
    clearReplayCache()
    const e = engine()
    const history: History = {
      version: 1,
      base: [boxMesh(20, 20, 10)],
      steps: [
        step('p1', paint({ kind: 'direction', direction: 'bottom' })),
        step('p2', paint({ kind: 'seed', point: [10, 10, 10] }, 4)),
        step('p3', paint({ kind: 'direction', direction: 'bottom' }, 1, 'seam')),
        step('p4', paint({ kind: 'direction', direction: 'bottom' }, 0)),
      ],
    }
    const r = await replayHistory(e.call, { history })
    expect(r.status.every((s) => s.state === 'done')).toBe(true)
    // Color: the bottom cleared again, the seeded triangle slot 4; seam: the bottom.
    expect(r.parts[0]?.paint).toEqual({ color: { 2: '1C' }, seam: { 0: '4', 1: '4' } })
    // The second color step saw the first one's texts.
    expect(e.asked.filter((a) => a.op === 'paint.select')[1]!.request['paint']).toEqual({ 0: '8', 1: '8' })
  })

  it('is dropped with a note by a later step that changes the part', async () => {
    clearReplayCache()
    const e = engine()
    const history: History = { version: 1, base: [boxMesh(20, 20, 10)], steps: [step('p1', paint({ kind: 'direction', direction: 'bottom' })), step('r1', { op: 'repair' })] }
    const r = await replayHistory(e.call, { history })
    expect(r.parts[0]?.paint).toBeUndefined()
    expect(r.status[1]).toEqual({ state: 'done', note: PAINT_DROPPED })
  })

  it('is dropped with a note by a cut that keeps both pieces', async () => {
    clearReplayCache()
    const e = engine()
    const cut: StepParams = { op: 'plane.cut', plane: { point: [0, 0, 5], normal: [0, 0, 1] }, keep: 'both' }
    const history: History = { version: 1, base: [boxMesh(20, 20, 10)], steps: [step('p1', paint({ kind: 'direction', direction: 'bottom' })), step('c1', cut)] }
    const r = await replayHistory(e.call, { history })
    expect(r.parts).toHaveLength(2)
    expect(r.parts.every((p) => p.paint === undefined)).toBe(true)
    expect(r.status[1]).toEqual({ state: 'done', note: PAINT_DROPPED })
  })

  it('breaks, in the engine words, when the target is not found', async () => {
    clearReplayCache()
    const history: History = { version: 1, base: [boxMesh(20, 20, 10)], steps: [step('p1', paint({ kind: 'height', below: 5 }))] }
    const r = await replayHistory(engine().call, { history })
    expect(r.status[0]?.state).toBe('broken')
    expect(r.status[0]?.message).toMatch(/Not one this stand-in knows/)
  })

  it('counts base paint in the replay key, so other paint is another result', async () => {
    clearReplayCache()
    const e = engine()
    const painted: HistoryMesh = { ...boxMesh(20, 20, 10), paint: { color: { 5: '8' } } }
    const steps = [step('r1', { op: 'repair' } as StepParams)]
    const a = await replayHistory(e.call, { history: { version: 1, base: [boxMesh(20, 20, 10)], steps } })
    const b = await replayHistory(e.call, { history: { version: 1, base: [painted], steps } })
    expect(a.status[0]).toEqual({ state: 'done' })
    expect(b.status[0]).toEqual({ state: 'done', note: PAINT_DROPPED })
  })
})

describe('paint in the project file', () => {
  function roundTrip(history: History): History | undefined {
    const files = new Map(historyFiles([{ id: 'o1', history }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    return parseHistories(files, new Set(['1'])).get('1')
  }
  const targets: PaintTarget[] = [
    { kind: 'part' },
    { kind: 'direction', direction: 'bottom', angleDeg: 20, pick: 'largest' },
    { kind: 'direction', direction: [0, 0.6, -0.8], pick: { nearest: [1, 2, 3] } },
    { kind: 'height', below: 10 },
    { kind: 'height', from: 2, to: 4 },
    { kind: 'seed', point: [1, 2, 3], faceKey: 77, mode: 'bucket' },
    { kind: 'replace', from: 2 },
  ]

  for (const t of targets) {
    it(`keeps a paint step with a ${t.kind} target`, () => {
      const p = paint(t, 3)
      expect(roundTrip({ version: 1, base: [boxMesh(10, 10, 5)], steps: [step('s1', p)] })?.steps[0]?.params).toEqual(p)
    })
  }

  it('keeps paint on stored meshes, and reads a file without paint as before', () => {
    const base: HistoryMesh = { ...boxMesh(10, 10, 5), paint: { color: { 0: '8', 3: '0C' }, seam: { 1: '4' } } }
    const back = roundTrip({ version: 1, base: [base], steps: [] })
    expect(back?.base[0]?.paint).toEqual(base.paint)
    expect(roundTrip({ version: 1, base: [boxMesh(10, 10, 5)], steps: [] })?.base[0]?.paint).toBeUndefined()
  })

  it('drops a history whose paint does not check', () => {
    const bad = (params: unknown) => roundTrip({ version: 1, base: [boxMesh(10, 10, 5)], steps: [step('s1', params as StepParams)] })
    expect(bad({ op: 'paint', layer: 'glitter', state: 2, target: { kind: 'part' } })).toBeUndefined()
    expect(bad({ op: 'paint', layer: 'color', state: 300, target: { kind: 'part' } })).toBeUndefined()
    expect(bad({ op: 'paint', layer: 'color', state: 2, target: { kind: 'height' } })).toBeUndefined()
    expect(bad({ op: 'paint', layer: 'color', state: 2, target: { kind: 'height', below: 1, above: 2 } })).toBeUndefined()
    expect(bad({ op: 'paint', layer: 'color', state: 2, target: { kind: 'direction', direction: 'up' } })).toBeUndefined()
    expect(bad({ op: 'paint', layer: 'color', state: 2, target: { kind: 'seed', point: [1, 2] } })).toBeUndefined()
    // Paint on a triangle the mesh does not have, or a text that is not hex.
    expect(roundTrip({ version: 1, base: [{ ...boxMesh(10, 10, 5), paint: { color: { 999: '8' } } }], steps: [] })).toBeUndefined()
    expect(roundTrip({ version: 1, base: [{ ...boxMesh(10, 10, 5), paint: { color: { 0: 'zz' } } }], steps: [] })).toBeUndefined()
  })
})

describe('a paint step in the list', () => {
  it('is named by what and where it paints, with its icon by layer', () => {
    expect(stepName({ params: paint({ kind: 'direction', direction: 'bottom' }) })).toBe('Paint the bottom filament 2')
    expect(stepName({ params: paint({ kind: 'height', below: 10 }, 0) })).toBe('Clear paint, below 10 mm')
    expect(stepName({ params: paint({ kind: 'seed', point: [0, 0, 0] }, 1, 'seam') })).toBe('Seam, from a point')
    expect(stepName({ params: { op: 'paint', layer: 'support', state: 2, target: { kind: 'part' } } })).toBe('Support blocker, the part')
    expect(stepIcon(paint({ kind: 'part' }))).toBe('color-painting')
    expect(stepIcon(paint({ kind: 'part' }, 1, 'seam'))).toBe('seam-painting')
  })

  it('has a one-sided band height as its number', () => {
    const p = paint({ kind: 'height', below: 10 })
    expect(mainNumber(p)).toMatchObject({ label: 'Below', value: 10, unit: 'mm' })
    expect(withNumber(p, 12)).toMatchObject({ target: { kind: 'height', below: 12 } })
    expect(mainNumber(paint({ kind: 'part' }))).toBeNull()
    expect(withNumber(paint({ kind: 'part' }), 3)).toMatch(/no number/)
  })
})
