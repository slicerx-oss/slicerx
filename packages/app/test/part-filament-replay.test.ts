// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step that sets a part's filament (parts.slot) changes that part's slot and nothing else: no engine call, the same on
// a mesh part and on an exact solid, which stays exact, so a design that must stay exact takes it. A part that is gone
// breaks the step as any step on a missing part does. A stand-in exact engine.
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache, IDENTITY, replayHistory, stepName, type History, type Step, type StepParams } from '@slicerx/cad-history'

const tri = (mark: number) => ({ positions: [mark, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] })

function engine() {
  const sent: string[] = []
  const call = async (op: string) => {
    sent.push(op)
    if (op === 'brep.tessellate') return { ...tri(1), faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op.startsWith('brep.')) return { bodySmb: 'box' }
    return { mesh: tri(2) }
  }
  return { call, sent }
}

const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const step = (id: string, part: number, params: StepParams): Step => ({ id, part, transform: [...IDENTITY], params })
const box = (id: string) => step(id, 0, { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams)
const slot = (id: string, part: number, n: number, name: string) => step(id, part, { op: 'parts.slot', slot: n, name })

beforeEach(() => clearReplayCache())

describe("a step that sets a part's filament", () => {
  it('sets that part\'s slot on a mesh design, calling no engine', async () => {
    const e = engine()
    const base: History['base'] = [{ name: 'Hull', slot: 1, ...tri(3) }, { name: 'Funnel', slot: 1, ...tri(4) }]
    const r = await replayHistory(e.call, { history: { version: 1, base, steps: [slot('f', 1, 3, 'Funnel')] } })
    expect(r.status).toEqual([{ state: 'done' }])
    expect(r.parts.map((p) => [p.name, p.slot])).toEqual([['Hull', 1], ['Funnel', 3]])
    expect(r.parts[1]!.positions).toEqual(base[1]!.positions)
    expect(e.sent).toEqual([])
  })

  it('keeps an exact part exact on a design that must stay exact', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: { version: 1, base: [], steps: [box('a'), slot('f', 0, 2, 'Body')], exact: true }, exact: true })
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect(r.parts[0]!.slot).toBe(2)
    expect(r.exactFellBack).toBeUndefined()
    // the box made once on the kernel and meshed once at the end: the slot step called nothing
    expect(e.sent.filter((o) => !o.startsWith('brep.') && o !== 'exact.ops')).toEqual([])
  })

  it('breaks on a part that is gone, as any step on a missing part does', async () => {
    const r = await replayHistory(engine().call, { history: { version: 1, base: [{ name: 'Hull', slot: 1, ...tri(3) }], steps: [slot('f', 2, 3, 'Funnel')] } })
    expect(r.status).toEqual([{ state: 'broken', message: 'The part this step works on is gone.' }])
  })

  it('is named by the filament and the part', () => {
    expect(stepName(slot('f', 1, 3, 'Funnel'))).toBe('Filament 3 for Funnel')
  })
})
