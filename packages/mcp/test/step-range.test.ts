// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The height range a step adds solid over, from the step's own numbers (cad-history rangeOf): upright extrudes, lofts,
// revolves about an upright axis, sweeps as a loose bound, and step patterns in a row or about an upright axis. A cut,
// a revolve on a tilted axis and any other step have none.
import { IDENTITY, rangeOf, type Step, type StepParams } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

const step = (params: StepParams, id = 's1'): Step => ({ id, params, transform: [...IDENTITY] }) as unknown as Step
const deck = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }) as never
const upright = { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] } as never
const extrude = (z: number, d: number, extra: Record<string, unknown> = {}): StepParams => ({ op: 'shape.extrude', frame: deck(z), shape: { type: 'circle', diameterMm: 4 }, spec: { distanceMm: d, ...extra } }) as StepParams

describe('rangeOf', () => {
  it('reads an extrude that rises straight up from its frame to its cap, and none for a cut or a tilted one', () => {
    expect(rangeOf(step(extrude(21.15, 15)))).toEqual({ lo: 21.15, hi: 36.15 })
    expect(rangeOf(step(extrude(21.15, 15, { operation: 'cut' })))).toBeNull()
    expect(rangeOf(step({ ...extrude(0, 5), frame: { origin: [0, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] } } as StepParams))).toBeNull()
  })

  it('reads a loft over every point of its sections, each placed by its frame, ellipses included', () => {
    const loft = { op: 'sketch.loft', profiles: [{ frame: deck(21.15), loops: [{ type: 'ellipse', center: [0, 0], widthMm: 6, heightMm: 4 }] }, { frame: deck(36), loops: [{ type: 'circle', center: [1, 0], diameterMm: 3 }] }] } as StepParams
    expect(rangeOf(step(loft))).toEqual({ lo: 21.15, hi: 36 })
  })

  it('reads a revolve about an upright axis over its profile, and none on a tilted axis', () => {
    const profile = [{ points: [[0, 2], [5, 2], [5, 12], [0, 12]] }] as never
    expect(rangeOf(step({ op: 'sketch.revolve', frame: upright, loops: profile, axis: { point: [0, 0], direction: [0, 1] } } as StepParams))).toEqual({ lo: 2, hi: 12 })
    expect(rangeOf(step({ op: 'sketch.revolve', frame: upright, loops: profile, axis: { point: [0, 0], direction: [1, 0] } } as StepParams))).toBeNull()
  })

  it('bounds a sweep by its path widened by its profile\'s reach, and says the bound is loose', () => {
    const sweep = { op: 'sketch.sweep', profile: { loops: [{ type: 'circle', center: [0, 0], diameterMm: 4 }] }, path: { points: [[0, 0, 5], [10, 0, 8], [20, 0, 10]] } } as StepParams
    expect(rangeOf(step(sweep))).toEqual({ lo: 3, hi: 12, loose: true })
  })

  it('moves a row pattern\'s steps by each copy\'s rise, keeps a ring about an upright axis, and reads none it cannot place', () => {
    const source = step(extrude(0, 2), 'a')
    const byId = (id: string) => (id === 'a' ? source : undefined)
    const row = (s: Vec3) => step({ op: 'pattern', steps: ['a'], spec: { kind: 'linear', count: 3, step: s } } as StepParams, 'p')
    type Vec3 = [number, number, number]
    expect(rangeOf(row([0, 0, 5]), byId)).toEqual({ lo: 0, hi: 12 })
    expect(rangeOf(row([10, 0, 0]), byId)).toEqual({ lo: 0, hi: 2 })
    expect(rangeOf(step({ op: 'pattern', steps: ['a'], spec: { kind: 'circular', count: 4, center: [0, 0, 0] } } as StepParams, 'p'), byId)).toEqual({ lo: 0, hi: 2 })
    expect(rangeOf(step({ op: 'pattern', steps: ['a'], spec: { kind: 'circular', count: 4, center: [0, 0, 0], axis: [1, 0, 0] } } as StepParams, 'p'), byId)).toBeNull()
    expect(rangeOf(row([0, 0, 5]))).toBeNull()
    expect(rangeOf(step({ op: 'pattern', steps: ['gone'], spec: { kind: 'linear', count: 2, step: [0, 0, 1] } } as StepParams, 'p'), byId)).toBeNull()
  })

  it('reads no range for a step whose solid it cannot say from its own numbers', () => {
    expect(rangeOf(step({ op: 'array.merged', spec: { kind: 'linear', count: 4, step: [10, 0, 0] } } as StepParams))).toBeNull()
    expect(rangeOf(step({ op: 'boolean', kind: 'union', with: [1] } as StepParams))).toBeNull()    // as a hand-written history can hold it, with no frame saved
    expect(rangeOf({ id: 's1', params: { op: 'parts.add' } } as unknown as Step)).toBeNull()
  })

  describe('a merged array of a whole part', () => {
    // a step on `part`, its history read with it: the steps that ran, in order
    const on = (part: number, params: StepParams, id: string): Step => ({ ...step(params, id), part }) as Step
    const funnel = on(0, extrude(21.15, 8.35), 'f')
    const array = (spec: Record<string, unknown>, part = 0) => on(part, { op: 'array.merged', spec } as StepParams, 'a')
    const read = (history: Step[]) => rangeOf(history.at(-1)!, (id) => history.find((s) => s.id === id), history)

    it('reads the copied part from its own steps, moved by each copy\'s rise in a row and kept for a ring about an upright axis', () => {
      expect(read([funnel, array({ kind: 'linear', count: 4, step: [8, 0, 0] })])).toEqual({ lo: 21.15, hi: 29.5 })
      expect(read([funnel, array({ kind: 'linear', count: 3, step: [8, 0, 2] })])).toEqual({ lo: 21.15, hi: 33.5 })
      expect(read([funnel, array({ kind: 'circular', count: 4, center: [44, 10, 0] })])).toEqual({ lo: 21.15, hi: 29.5 })
      expect(read([funnel, array({ kind: 'circular', count: 4, center: [44, 10, 0], rotateCopies: false })])).toEqual({ lo: 21.15, hi: 29.5 })
      expect(read([funnel, array({ kind: 'circular', count: 4, center: [44, 10, 0], axis: [1, 0, 0] })])).toBeNull()
    })

    it('widens the part by a step joined to it, keeps it through a cut, and reads it again after an earlier array', () => {
      const cap = on(0, extrude(29.5, 1, { operation: 'join' }), 'c')
      const cut = on(0, extrude(29.5, 3, { operation: 'cut', flip: true }), 'x')
      const first = on(0, { op: 'array.merged', spec: { kind: 'linear', count: 2, step: [0, 0, 1] } } as StepParams, 'r')
      expect(read([funnel, cap, cut, array({ kind: 'linear', count: 2, step: [8, 0, 0] })])).toEqual({ lo: 21.15, hi: 30.5 })
      expect(read([funnel, first, array({ kind: 'linear', count: 2, step: [8, 0, 0] })])).toEqual({ lo: 21.15, hi: 30.5 })
    })

    it('follows the part it copies through a reorder and a boolean that takes another part away', () => {
      const hull = on(0, extrude(0, 14.5), 'h')
      const top = on(1, extrude(21.15, 8.35), 't')
      const spare = on(2, extrude(0, 1), 's')
      const order = on(-1, { op: 'parts.order', order: [1, 0, 2] } as StepParams, 'o')
      const cutAway = on(1, { op: 'boolean', kind: 'difference', with: [2] } as StepParams, 'b')
      // after the reorder the funnel is part 0; the difference on the hull takes part 2 away
      expect(read([hull, top, spare, order, cutAway, array({ kind: 'linear', count: 2, step: [8, 0, 0] }, 0)])).toEqual({ lo: 21.15, hi: 29.5 })
      expect(read([hull, top, spare, order, cutAway, array({ kind: 'linear', count: 2, step: [8, 0, 0] }, 1)])).toEqual({ lo: 0, hi: 14.5 })
      // every part arrayed at once: each part's range, together
      expect(read([hull, top, array({ kind: 'linear', count: 2, step: [8, 0, 0] }, -1)])).toEqual({ lo: 0, hi: 29.5 })
    })

    it('reads none when a step on the part adds solid with no range, mesh parts made it, a split came before, or no history is given', () => {
      const push = on(0, { op: 'face.push', at: [0, 0, 29.5], normal: [0, 0, 1], distanceMm: 2 } as StepParams, 'u')
      const union = on(0, { op: 'boolean', kind: 'union', with: [1] } as StepParams, 'b')
      const other = on(1, extrude(0, 1), 'o')
      const added = on(-1, { op: 'parts.add', parts: [{ name: 'Funnel', slot: 1, positions: [], indices: [] }], label: 'Built solids' } as unknown as StepParams, 'm')
      const split = on(0, { op: 'split', buildVolumeMm: [100, 100, 100] } as StepParams, 'z')
      const row = { kind: 'linear', count: 2, step: [8, 0, 0] }
      expect(read([funnel, push, array(row)])).toBeNull()
      expect(read([funnel, other, union, array(row)])).toBeNull()
      expect(read([added, array(row)])).toBeNull()
      expect(read([funnel, split, array(row)])).toBeNull()
      expect(rangeOf(array(row), (id) => (id === 'f' ? funnel : undefined))).toBeNull()
    })
  })
})
