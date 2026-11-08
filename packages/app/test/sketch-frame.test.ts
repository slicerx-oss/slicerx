// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A timeline sketch's frame is stored once, in plate coordinates, and read where it stands now: moved with the design
// it was drawn for, else with the body of the first feature drawn on it (cad-history design-frame.ts). A step drawn on
// it is recorded where the sketch is stored, so folding the step into the timeline writes the frame the sketch has, and
// nothing a feature's undo, redo, deletion or a change of owner does rewrites it. Plain timelines, no engine.
import { frameNow, historyOf, parseTimeline, recordedOn, sketchMove, syncTimeline, timelineFiles, withoutBody, withSketch, type DrawnFor, type FaceFrame, type History, type HistoryMesh, type Mat4, type StepParams, type Timeline } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

const at = (x: number, y: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]
const TOP: FaceFrame = { origin: [128, 128, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const RING = [{ type: 'circle' as const, center: [0, 0] as [number, number], diameterMm: 6 }]
const BOX: HistoryMesh = { name: 'Box', slot: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3] }

/** A cut on sketch `k`, given on `frame`. */
const cut = (frame: FaceFrame): StepParams => ({ op: 'shape.extrude', frame, shape: { type: 'sketch', loops: RING }, placement: {}, spec: { distanceMm: 2, operation: 'cut' } })
const history = (...steps: History['steps']): History => ({ version: 1, base: [BOX], steps })
const sketchOf = (t: Timeline, id = 'k') => t.items.find((i) => i.kind === 'sketch' && i.id === id)
const frameOf = (t: Timeline, id = 'k') => {
  const k = sketchOf(t, id)
  return k?.kind === 'sketch' ? k.frame : undefined
}
const EMPTY: Timeline = { bodies: [], items: [], marker: 0 }
const plate = (o: Record<string, Mat4>) => (b: string) => o[b]
/** An object on the plate with its history, standing at `transform`. */
const on = (id: string, h: History, transform: Mat4) => ({ id, history: h, transform })

describe('a sketch frame stored once', () => {
  it('stays stored as drawn when its only feature is undone and redone after its body moved, and the feature replays where it was made', () => {
    const t0 = withSketch(EMPTY, { id: 'k', frame: TOP, loops: RING })
    const s1 = { id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: 'k' }
    const t1 = syncTimeline(t0, [on('D', history(s1), at(128, 128))])
    // the person drags D 30 mm, then its cut is undone and redone
    const t2 = syncTimeline(t1, [on('D', history(), at(158, 128))])
    expect(frameOf(t2)).toEqual(TOP)
    const t3 = syncTimeline(t2, [on('D', history(s1), at(158, 128))])
    expect(frameOf(t3)).toEqual(TOP)
    expect(historyOf(t3, 'D')!.steps[0]).toMatchObject({ transform: at(128, 128), params: { frame: TOP } })
    // carried by the cut, it stands 30 mm over; with the cut undone, where it was drawn
    expect(sketchMove(t3, 'k', plate({ D: at(158, 128) }))).toEqual(at(30, 0))
    expect(sketchMove(t2, 'k', plate({ D: at(158, 128) }))).toEqual(at(0, 0))
  })

  it('records a step on a sketch drawn for a design that moved where the sketch is stored, and reads it the same through undo and redo', () => {
    const drawnFor: DrawnFor[] = [{ design: 'D', transform: at(128, 128) }]
    const t0 = withSketch(EMPTY, { id: 'k', frame: TOP, loops: RING, drawnFor })
    const where = plate({ D: at(158, 128) })
    const now = frameNow(t0, sketchOf(t0) as never, where)!
    expect(now.origin).toEqual([158, 128, 10])
    // the step as given on the plane where the sketch stands now, on D standing where it was dragged
    const r = recordedOn(t0, 'k', at(158, 128), cut(now), where)
    expect(r.transform).toEqual(at(128, 128))
    expect(r.params).toEqual(cut(TOP))
    const s1 = { id: 's1', part: 0, transform: r.transform, params: r.params, sketch: 'k' }
    const t1 = syncTimeline(t0, [on('D', history(s1), at(158, 128))])
    const t2 = syncTimeline(t1, [on('D', history(), at(158, 128))])
    const t3 = syncTimeline(t2, [on('D', history(s1), at(158, 128))])
    for (const t of [t1, t2, t3]) {
      expect(frameOf(t)).toEqual(TOP)
      expect(sketchMove(t, 'k', where)).toEqual(at(30, 0))
    }
  })

  it('keeps another body\'s feature and the sketch as stored when the first feature on a shared sketch goes', () => {
    const t0 = withSketch(EMPTY, { id: 'k', frame: TOP, loops: RING })
    const sD = { id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: 'k' }
    const t1 = syncTimeline(t0, [on('D', history(sD), at(128, 128))])
    // D dragged 10 mm; then E's cut on the same sketch, given where the sketch stands now, recorded through the rule
    const where = plate({ D: at(138, 128), E: at(50, 128) })
    const now = frameNow(t1, sketchOf(t1) as never, where)!
    const r = recordedOn(t1, 'k', at(50, 128), cut(now), where)
    const sE = { id: 's2', part: 0, transform: r.transform, params: r.params, sketch: 'k' }
    const t2 = syncTimeline(t1, [on('D', history(sD), at(138, 128)), on('E', history(sE), at(50, 128))])
    const e = historyOf(t2, 'E')
    // D's cut undone, then D deleted: E's step and the sketch never change, and the sketch reads where it stood
    const t3 = syncTimeline(t2, [on('D', history(), at(138, 128)), on('E', history(sE), at(50, 128))])
    const t4 = syncTimeline(t3, [on('E', history(sE), at(50, 128))])
    for (const t of [t3, t4]) {
      expect(frameOf(t)).toEqual(TOP)
      expect(historyOf(t, 'E')).toEqual(e)
      expect(frameNow(t, sketchOf(t) as never, where)).toEqual(now)
    }
  })
})

describe('a sketch drawn for a design that waits for its body', () => {
  // D's only step drew on k; the step is undone, so D waits with no body while `waits` says so
  const drawnFor = (...ds: string[]): DrawnFor[] => ds.map((design) => ({ design, transform: at(128, 128) }))
  const made = (k: Parameters<typeof withSketch>[1]) => {
    const t0 = withSketch(EMPTY, k)
    return syncTimeline(t0, [on('D', history({ id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: k.id }), at(128, 128))])
  }
  const ids = (t: Timeline) => t.items.map((i) => i.id)

  it('stays under its id when the body leaves while the design waits, and goes with it when nothing waits', () => {
    const t = made({ id: 'k', frame: TOP, loops: RING, drawnFor: drawnFor('D') })
    expect(ids(withoutBody(t, 'D', (d) => d === 'D'))).toEqual(['k'])
    expect(ids(syncTimeline(t, [], undefined, (d) => d === 'D'))).toEqual(['k'])
    expect(ids(withoutBody(t, 'D', () => false))).toEqual([])
    expect(ids(withoutBody(t, 'D'))).toEqual([])
  })

  it('stays while either of two designs it was drawn for waits', () => {
    const t = made({ id: 'k', frame: TOP, loops: RING, drawnFor: drawnFor('D', 'W') })
    expect(ids(withoutBody(t, 'D', (d) => d === 'W'))).toEqual(['k'])
    expect(ids(withoutBody(t, 'D', (d) => d === 'D'))).toEqual(['k'])
    expect(ids(withoutBody(t, 'D', (d) => d === 'X'))).toEqual([])
  })

  it('goes with the body when it was drawn for no design, whatever waits', () => {
    const t = made({ id: 'k', frame: TOP, loops: RING })
    expect(ids(withoutBody(t, 'D', () => true))).toEqual([])
  })

  it('stays, once, while another body still uses it', () => {
    const t0 = made({ id: 'k', frame: TOP, loops: RING, drawnFor: drawnFor('D') })
    const sE = { id: 's2', part: 0, transform: at(50, 128), params: cut(TOP), sketch: 'k' }
    const both = syncTimeline(t0, [on('D', history({ id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: 'k' }), at(128, 128)), on('E', history(sE), at(50, 128))])
    const left = withoutBody(both, 'D', () => false)
    expect(ids(left)).toEqual(['k', 's2'])
    // the step comes back: still one sketch k, now under both features
    const back = syncTimeline(left, [on('D', history({ id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: 'k' }), at(128, 128)), on('E', history(sE), at(50, 128))])
    expect(back.items.filter((i) => i.kind === 'sketch').map((i) => i.id)).toEqual(['k'])
    expect(back.items.flatMap((i) => (i.kind === 'feature' ? [i.sketch] : []))).toEqual(['k', 'k'])
  })
})

describe('a project file with a malformed landing or drawn for', () => {
  /** A design file of D (object 1) with a landing and a sketch drawn for it, its JSON changed by `edit`, read back. */
  function readBack(edit: (j: { bodies: Record<string, unknown>[]; items: Record<string, unknown>[] }) => void) {
    const k = { id: 'k', frame: TOP, loops: RING, drawnFor: [{ design: 'D', transform: at(128, 128) }] }
    const t0 = withSketch(EMPTY, k)
    const h: History = { ...history({ id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: 'k' }), placed: [128, 128] }
    const t = syncTimeline(t0, [on('D', h, at(128, 128))])
    const files = new Map(timelineFiles(t, new Map([['D', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    const name = 'Metadata/slicerx_history.json'
    const j = JSON.parse(new TextDecoder().decode(files.get(name)!)) as { bodies: Record<string, unknown>[]; items: Record<string, unknown>[] }
    edit(j)
    files.set(name, new TextEncoder().encode(JSON.stringify(j)))
    return parseTimeline(files, new Set(['1']), () => at(128, 128))
  }
  const sketch = (t: Timeline | null) => t?.items.find((i) => i.kind === 'sketch')
  const intact = (t: Timeline | null) => {
    expect(t?.bodies.map((b) => b.id)).toEqual(['1'])
    expect(t?.items.map((i) => i.id)).toEqual(['k', 's1'])
    expect(sketch(t)).toMatchObject({ frame: TOP, loops: RING })
    expect(historyOf(t!, '1')?.steps.map((st) => st.id)).toEqual(['s1'])
  }

  it('reads both as written', () => {
    const t = readBack(() => undefined)
    intact(t)
    expect(t?.bodies[0]?.placed).toEqual([128, 128])
    expect(sketch(t)).toMatchObject({ drawnFor: [{ design: '1', transform: at(128, 128) }] })
  })

  it.each([
    ['one number', [128]],
    ['three numbers', [128, 128, 0]],
    ['a string', ['128', 128]],
    ['not a number', [null, 128]],
    ['past a bed\'s reach', [1e9, 0]],
    ['not a list', { x: 128, y: 128 }],
  ])('drops a landing of %s and keeps the rest', (_what, placed) => {
    const t = readBack((j) => {
      j.bodies[0]!['placed'] = placed
    })
    intact(t)
    expect(t?.bodies[0]?.placed).toBeUndefined()
    expect(historyOf(t!, '1')?.placed).toBeUndefined()
  })

  it.each<[string, (f: Record<string, unknown>) => Record<string, unknown>]>([
    ['a transform of 15 numbers', (f: Record<string, unknown>) => ({ ...f, transform: (f['transform'] as number[]).slice(1) })],
    ['a transform of 17 numbers', (f: Record<string, unknown>) => ({ ...f, transform: [...(f['transform'] as number[]), 0] })],
    ['a transform with a string', (f: Record<string, unknown>) => ({ ...f, transform: (f['transform'] as unknown[]).map((v, i) => (i === 12 ? '128' : v)) })],
    ['a transform with a null', (f: Record<string, unknown>) => ({ ...f, transform: (f['transform'] as unknown[]).map((v, i) => (i === 13 ? null : v)) })],
    ['a design that is no string', (f: Record<string, unknown>) => ({ ...f, design: 1 })],
    ['no transform', (f: Record<string, unknown>) => ({ design: f['design'] })],
  ])('drops a drawn for with %s and keeps the sketch', (_what, change) => {
    const t = readBack((j) => {
      const k = j.items.find((i) => i['kind'] === 'sketch')!
      k['drawnFor'] = (k['drawnFor'] as Record<string, unknown>[]).map(change)
    })
    intact(t)
    expect(sketch(t)).not.toHaveProperty('drawnFor')
  })

  it('drops a drawn for that names two designs, or none', () => {
    for (const drawnFor of [[{ design: '1', transform: at(0, 0) }, { design: '1', transform: at(0, 0) }], [], 'D']) {
      const t = readBack((j) => {
        j.items.find((i) => i['kind'] === 'sketch')!['drawnFor'] = drawnFor
      })
      intact(t)
      expect(sketch(t)).not.toHaveProperty('drawnFor')
    }
  })
})
