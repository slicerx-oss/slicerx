// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { FitGap, FitReport } from '../src/geom/cad'
import { minGapFor } from '../src/plate/fit-check'
import { crossGap, near, objectGaps } from '../src/plate/fit-run'
import { fitNotes } from '../src/plate/fit-notes'
import { measuredHoleClearance, tuneContext, tuneKey } from '../src/calibration/tuned'
import { resolveSlots } from '../src/filament/slots'
import type { UserPreset } from '../src/presets/store'
import { get } from '../src/state/store'
import { allTouches, fitLines, keepFits, setFit, setTouches, type ObjectFit, type Touch } from '../src/plate/fit-state'

const gap = (kind: FitGap['kind'], parts: [number, number], gapMm = 0.1): FitGap => ({ kind, parts, gapMm, limitMm: 0.2, from: [0, 0, 0], to: [1, 0, 0] })
const body = (item: number) => ({ bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, volumeMm3: 1, triangles: 12, item })
const report = (gaps: FitGap[], items = [0, 1, 2, 3]): FitReport => ({ parts: items.map(body), gaps, limitMm: 0.2, verticalLimitMm: 0.2, pieces: 1, warnings: [] })

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const fit = (gaps: FitGap[], names = ['Peg', 'Ring', 'Lid', 'Box']): ObjectFit => ({ gaps, names, limitMm: 0.2, verticalLimitMm: 0.2, transform: I })
const touch = (a: string, b: string, gapMm = 0): Touch => ({ ids: [a, b], transforms: [I, I], gapMm, from: [0, 0, 0], to: [1, 0, 0] })
const name = (id: string) => ({ a: 'Tower', b: 'Cube', c: 'Clip' })[id] ?? id

describe('fit check', () => {
  it('never reports parts of one object that touch: they print as one piece', () => {
    const r = report([gap('horizontal', [0, 1]), gap('fused', [0, 1], 0), gap('fused', [1, 2], 0), gap('vertical', [2, 3], 0.12), gap('apart', [1, 3], 0.76)])
    expect(objectGaps(r).map((g) => g.kind)).toEqual(['horizontal', 'vertical', 'apart'])
  })

  it('names a gap by the part each body came from, not by the order the bodies were found in', () => {
    // The check found the bodies of parts 2 and 0 first: gap [0, 1] lies between parts 2 and 1.
    const r = report([gap('horizontal', [0, 1]), gap('apart', [0, 2], 0.76)], [2, 1, 0])
    expect(objectGaps(r).map((g) => g.parts)).toEqual([[2, 1], [2, 0]])
  })

  it('finds the closest gap between the first mesh and the second', () => {
    // Two bodies from the first mesh, one from the second.
    const r = report([gap('fused', [0, 1], 0), gap('horizontal', [1, 2], 0.15), gap('fused', [0, 2], 0)], [0, 0, 1])
    expect(crossGap(r)).toMatchObject({ parts: [0, 2], gapMm: 0 })
    expect(crossGap({ ...r, gaps: [gap('fused', [0, 1], 0)] })).toBeNull()
  })

  it('measures only boxes that come within reach', () => {
    const box = (x: number) => ({ min: [x, 0, 0] as [number, number, number], max: [x + 10, 10, 10] as [number, number, number] })
    expect(near(box(0), box(10.1), 0.2)).toBe(true)
    expect(near(box(0), box(10.3), 0.2)).toBe(false)
  })

  it('says one line per kind of problem, never one per pair', () => {
    const many = Array.from({ length: 12 }, (_, i) => touch('a', `o${i}`))
    const notes = fitNotes('a', fit([gap('horizontal', [0, 1]), gap('horizontal', [2, 3], 0.05), gap('vertical', [2, 3], 0.12)]), many, name, 0.2)
    expect(notes.map((n) => n.kind)).toEqual(['touch', 'horizontal', 'vertical'])
    expect(notes[0]!.text).toBe('Touches 12 other objects, so they will print as one piece')
    expect(notes[0]!.which).toHaveLength(12)
    expect(notes[1]!.text).toBe('2 gaps are under the 0.20 mm this printer keeps open, so those parts may fuse')
    expect(notes[1]!.which).toEqual(['Peg and Ring, 0.10 mm', 'Lid and Box, 0.05 mm'])
    expect(notes[2]!.text).toBe('1 gap over a part is thinner than a 0.20 mm layer and will close')
    expect(notes[2]!.layerMm).toBe(0.12)
    expect(fitNotes('b', undefined, [touch('a', 'b', 0.1)], name, 0.2)).toEqual([{ kind: 'touch', text: 'Touches Tower, so they will print as one piece', which: ['Tower, 0.10 mm apart'], others: ['a'] }])
    expect(fitNotes('c', undefined, [touch('a', 'b')], name, 0.2)).toEqual([])
  })

  it('says when parts sit close without touching, so they print loose', () => {
    const [n] = fitNotes('a', fit([gap('apart', [0, 1], 0.76)], ['Ring', 'Foot']), [], name, 0.2)
    expect(n).toEqual({ kind: 'apart', text: 'Ring and Foot are 0.76 mm apart and do not touch, so they print as separate pieces', which: ['Ring and Foot, 0.76 mm'] })
    expect(fitNotes('a', fit([gap('apart', [0, 1], 0.5), gap('apart', [2, 3], 0.9)]), [], name, 0.2)[0]!.text).toBe('2 pairs of parts are close but do not touch, so they print as separate pieces')
  })

  it('keeps lines for the objects still on the plate, each tied to the objects it was measured on', () => {
    setFit('a', fit([gap('horizontal', [0, 1])]))
    setFit('b', fit([gap('vertical', [0, 1])]))
    setTouches([touch('a', 'b')])
    expect(fitLines()).toHaveLength(3)
    expect(fitLines()[2]!.on.map((o) => o.id)).toEqual(['a', 'b'])
    keepFits(['a'])
    expect(fitLines().map((l) => l.kind)).toEqual(['horizontal'])
    expect(fitLines()[0]!.on).toEqual([{ id: 'a', transform: I }])
    expect(allTouches()).toEqual([])
    setFit('a', null)
    expect(fitLines()).toEqual([])
  })

  it('uses the clearance the hole tolerance test measured, whatever the hole compensation setting says now', () => {
    const s = get()
    const { printerId, nozzleMm } = tuneContext(s)
    const slot = resolveSlots(s)[0]
    const preset = (results: NonNullable<UserPreset['tuned']>['results'], values: UserPreset['values'] = {}): UserPreset =>
      ({ id: 'p1', kind: 'process', name: 'Tuned', values, tuned: { key: tuneKey(slot, printerId, nozzleMm), filament: 'PLA', printerId, nozzleMm, results }, createdAt: 1, updatedAt: 1 }) as UserPreset
    expect(minGapFor({ ...s, userPresets: [] })).toBeCloseTo(Math.max(0.1, nozzleMm / 2))
    const measured = [preset({ tolerance: { label: 'Smallest clearance the peg fits', value: '0.3 mm', at: 5, raw: 0.3 } }, { xy_hole_compensation: 0 })]
    expect(measuredHoleClearance(measured, slot, printerId, nozzleMm)).toBe(0.3)
    // Per side, so half the measured extra diameter.
    expect(minGapFor({ ...s, userPresets: measured })).toBeCloseTo(0.15)
    // A result saved before the number was kept is read from its text; another nozzle's result does not count.
    expect(measuredHoleClearance([preset({ tolerance: { label: 'x', value: '0.2 mm', at: 5 } })], slot, printerId, nozzleMm)).toBe(0.2)
    expect(measuredHoleClearance(measured, slot, printerId, nozzleMm + 0.2)).toBeUndefined()
  })
})
