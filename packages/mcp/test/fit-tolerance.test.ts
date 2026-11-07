// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 0.02 mm a gap may read under its limit and still clear, at the edges: it is for gaps whose ends are round faces
// drawn as facets, beside a pin or above one lying flat in its bore; a gap above or below between flat faces is held to
// its bare limit, which the fit rule floors to whole layers. A touch
// stays a touch. The engine's report is stubbed, so each gap is exactly the size the case names. Also the pieces item
// for pieces that are bodies of one part (after geom.mirror or geom.array), which no tool can name one by one.
import type { Design as HostDesign, DesignHost, HistoryMesh } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { fitItems, type BodyFacts, type FitFacts, type FitGap } from '../src/design-check'
import { FIT_TOLERANCE_MM, fitFacts, fitLimits, fitVerdict } from '../src/fit-facts'
import * as toolset from '../src/toolset'
import type { ToolContext } from '@slicerx/pilot'

type V3 = [number, number, number]
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
// one small facet per part: the report is stubbed, so the meshes only need to exist
const part = (name: string, z: number): HistoryMesh => ({ name, slot: 0, positions: [0, 0, z, 1, 0, z, 0, 1, z], indices: [0, 1, 2] })
const designOf = (parts: HistoryMesh[]) => ({ id: 'd', name: 'Mechanism', history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts, status: [], madeBy: {}, redo: [] }) as unknown as HostDesign
const design = designOf([part('Arm', 0), part('Pin', 5)])
// a gap above and below between flat faces: a top facet of Arm at z 5 under a bottom facet of Pin at 5 + the gap
const flatPair = (gapMm: number): HistoryMesh[] => [
  { name: 'Arm', slot: 0, positions: [-1, -1, 5, 1, -1, 5, 0, 1, 5], indices: [0, 1, 2] },
  { name: 'Pin', slot: 0, positions: [-1, -1, 5 + gapMm, 0, 1, 5 + gapMm, 1, -1, 5 + gapMm], indices: [0, 1, 2] },
]
// the same gap between faceted curves, a pin lying flat in its bore: the facets at the gap's ends lean, none faces up or down
const curvedPair = (gapMm: number): HistoryMesh[] => [
  { name: 'Arm', slot: 0, positions: [-1, -1, 5.6, 1, -1, 5.6, 0, 1, 5], indices: [0, 1, 2] },
  { name: 'Pin', slot: 0, positions: [-1, -1, 4.4 + gapMm, 0, 1, 5 + gapMm, 1, -1, 4.4 + gapMm], indices: [0, 1, 2] },
]

/** fitFacts over a stubbed engine that reports one gap between the two parts; a gap above and below is between flat faces unless `ends` is curved. */
async function oneGap(kind: FitGap['kind'] | 'horizontal', gapMm: number, material = 'PLA', ends: 'flat' | 'curved' = 'flat') {
  const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material })
  const from: V3 = kind === 'vertical' ? [0, 0, 5] : [0, 0, 0]
  const to: V3 = kind === 'vertical' ? [0, 0, 5 + gapMm] : [gapMm, 0, 0]
  const report = {
    parts: [
      { bounds: { min: [0, 0, 0], max: [1, 1, 0] }, item: 0 },
      { bounds: { min: [0, 0, 5], max: [1, 1, 5] }, item: 1 },
    ],
    gaps: [{ parts: [0, 1], gapMm, limitMm: kind === 'vertical' ? limits.verticalMm : limits.sideMm, kind, from, to }],
    pieces: kind === 'fused' ? 1 : 2,
  }
  const host = { call: async () => report } as unknown as DesignHost
  const fit = await fitFacts(host, kind === 'vertical' ? designOf(ends === 'flat' ? flatPair(gapMm) : curvedPair(gapMm)) : design, limits)
  return { fit, gap: fit.gaps[0]!, limits }
}

const gapsItem = (fit: FitFacts) => fitItems(['Arm', 'Pin'], { fit } as BodyFacts).find((i) => i.name === 'gaps')!

describe('the fit tolerance', () => {
  it('a flat gap of 0.38 mm above and below stays tight and fails at 0.2 mm layers (PLA): one layer, which the sag closes', async () => {
    const { fit, gap, limits } = await oneGap('vertical', 0.38)
    expect(limits.verticalMm).toBe(0.4)
    expect(gap.flat).toBe(true)
    expect(gap.kind).toBe('vertical')
    expect(gap.direction).toBe('z')
    expect(fitVerdict(gap, limits)).toBe('fuses')
    expect(gapsItem(fit).pass).toBe(false)
  })

  it('PETG 0.585 mm above and below stays tight against 0.6 mm and binds', async () => {
    const { fit, gap, limits } = await oneGap('vertical', 0.585, 'PETG')
    expect(limits.verticalMm).toBe(0.6)
    expect(gap.kind).toBe('vertical')
    expect(fitVerdict(gap, limits)).toBe('binds')
    expect(gapsItem(fit).pass).toBe(false)
  })

  it('a gap above and below at its limit, to float error, clears; a thousandth under does not', async () => {
    const at = await oneGap('vertical', 0.4 - 1e-9)
    expect(at.gap.kind).toBe('apart')
    expect(fitVerdict(at.gap, at.limits)).toBe('slides')
    const under = await oneGap('vertical', 0.399)
    expect(under.gap.kind).toBe('vertical')
  })

  it('a gap above a pin lying flat in its bore, modeled at the limit, clears: its ends are faceted curves', async () => {
    // a 0.4 mm gap over a round pin reads up to a facet's sagitta short at its top
    for (const read of [0.385, 0.4 - FIT_TOLERANCE_MM + 1e-9]) {
      const { fit, gap, limits } = await oneGap('vertical', read, 'PLA', 'curved')
      expect(gap.flat, `${read} mm`).toBeUndefined()
      expect(gap.direction).toBe('z')
      expect(gap.kind, `${read} mm`).toBe('apart')
      expect(fitVerdict(gap, limits), `${read} mm`).toBe('slides')
      expect(gapsItem(fit).pass, `${read} mm`).toBe(true)
    }
    // more than the tolerance under still fails
    const { fit, gap } = await oneGap('vertical', 0.4 - 0.0201, 'PLA', 'curved')
    expect(gap.kind).toBe('vertical')
    expect(gapsItem(fit).pass).toBe(false)
  })

  it('a flat gap above and below and its verdict agree at float error under the limit', async () => {
    for (const under of [5e-7, 7e-7]) {
      const { gap, limits } = await oneGap('vertical', 0.4 - under)
      expect(gap.flat).toBe(true)
      expect(gap.kind, `${under} under`).toBe('apart')
      expect(fitVerdict(gap, limits), `${under} under`).toBe('slides')
    }
  })

  it('a side gap within the tolerance of its limit clears', async () => {
    const { fit, gap, limits } = await oneGap('horizontal', 0.28)
    expect(gap.kind).toBe('apart')
    expect(gap.direction).toBe('xy')
    expect(fitVerdict(gap, limits)).toBe('slides')
    expect(gapsItem(fit).pass).toBe(true)
  })

  it('never passes a side gap more than 0.02 mm under its limit', async () => {
    expect(FIT_TOLERANCE_MM).toBeLessThanOrEqual(0.02)
    for (const under of [0.0201, 0.021, 0.025, 0.03, 0.05, 0.1]) {
      const { fit, gap } = await oneGap('horizontal', 0.3 - under)
      expect(gap.kind, `${0.3 - under} mm`).toBe('horizontal')
      expect(gapsItem(fit).pass, `${0.3 - under} mm`).toBe(false)
    }
  })

  it('a touch stays a touch, at 0 and at a hair over', async () => {
    for (const g of [0, 1e-12]) {
      const { fit, gap, limits } = await oneGap('fused', g)
      expect(gap.kind).toBe('fused')
      expect(fitVerdict(gap, limits)).toBe('fuses')
      expect(gapsItem(fit).pass).toBe(false)
    }
  })
})

describe('the pieces item for bodies of one part', () => {
  const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2 })
  const apart = (a: number, b: number): FitGap => ({ bodies: [a, b], kind: 'apart', gapMm: 0.4, limitMm: 0.3, from: [0, 0, 0], to: [0.4, 0, 0], direction: 'xy' })
  const pieces = (fit: FitFacts, plan: string[]) => fitItems(plan, { fit } as BodyFacts).find((i) => i.name === 'pieces')!

  it('passes a mirrored leaf: two pieces that are bodies of one part, as many as the plan names', () => {
    const fit: FitFacts = { limits, pieces: 2, bodies: [{ part: 0, name: 'Leaf 1', partName: 'Leaf' }, { part: 0, name: 'Leaf 2', partName: 'Leaf' }], gaps: [apart(0, 1)] }
    const got = pieces(fit, ['Left leaf', 'Right leaf'])
    expect(got.pass).toBe(true)
    expect(got.got).toBe('2 pieces (Left leaf and Right leaf are Leaf 1 and Leaf 2, bodies of one part)')
  })

  it('passes the names that match and reads the rest as bodies of one part', () => {
    const fit: FitFacts = { limits, pieces: 3, bodies: [{ part: 0, name: 'Leaf 1', partName: 'Leaf' }, { part: 0, name: 'Leaf 2', partName: 'Leaf' }, { part: 1, name: 'Pin', partName: 'Pin' }], gaps: [apart(0, 2), apart(1, 2)] }
    const got = pieces(fit, ['Pin', 'Left leaf', 'Right leaf'])
    expect(got.pass).toBe(true)
    expect(got.got).toBe('3 pieces (Left leaf and Right leaf are Leaf 1 and Leaf 2, bodies of one part)')
  })

  it('still fails names no body has when each body is a part of its own, which can be renamed', () => {
    const fit: FitFacts = { limits, pieces: 2, bodies: [{ part: 0, name: 'Arm', partName: 'Arm' }, { part: 1, name: 'Pin', partName: 'Pin' }], gaps: [apart(0, 1)] }
    const got = pieces(fit, ['Lid', 'Tray'])
    expect(got.pass).toBe(false)
    expect(got.got).toContain('name each piece as the plan does')
  })

  it('fails when one of the unnamed bodies is a part of its own', () => {
    const fit: FitFacts = { limits, pieces: 3, bodies: [{ part: 0, name: 'Leaf 1', partName: 'Leaf' }, { part: 0, name: 'Leaf 2', partName: 'Leaf' }, { part: 1, name: 'Arm', partName: 'Arm' }], gaps: [apart(0, 2), apart(1, 2)] }
    expect(pieces(fit, ['Left leaf', 'Right leaf', 'Pin']).pass).toBe(false)
  })
})

describe('one gap rule for every caller', () => {
  it('the toolset exports the limits by direction, the way a gap runs and whether it clears', () => {
    const l = toolset.fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })
    expect([toolset.fitLimitFor(l, 'xy'), toolset.fitLimitFor(l, 'z')]).toEqual([0.3, 0.4])
    expect(toolset.FIT_TOLERANCE_MM).toBe(FIT_TOLERANCE_MM)
    expect(toolset.clearsFitLimit(0.28, 'xy', l)).toBe(true)
    expect(toolset.clearsFitLimit(0.279, 'xy', l)).toBe(false)
    // between flat faces only at the limit; between faceted curves within the tolerance, as a side gap
    expect(toolset.clearsFitLimit(0.38, 'z', l, true)).toBe(false)
    expect(toolset.clearsFitLimit(0.4 - 1e-9, 'z', l, true)).toBe(true)
    expect(toolset.clearsFitLimit(0.38, 'z', l)).toBe(true)
    expect(toolset.clearsFitLimit(0.379, 'z', l)).toBe(false)
    expect(toolset.fitDirection('vertical', [0, 0, 0], [5, 0, 0])).toBe('z')
    expect(toolset.fitDirection('horizontal', [0, 0, 0], [0, 0, 5])).toBe('xy')
    expect(toolset.fitDirection('apart', [0, 0, 0], [0.1, 0, 0.5])).toBe('z')
    expect(toolset.fitDirection('fused', [0, 0, 0], [0.5, 0, 0.1])).toBe('xy')
    expect(toolset.fitDirection('fused', [0, 0, 0], [0.5, 0, 0.1], true)).toBe('z')
    expect(toolset.fitVerdict({ kind: 'vertical', gapMm: 0.38, direction: 'z', flat: true }, l)).toBe('fuses')
    expect(toolset.fitVerdict({ kind: 'vertical', gapMm: 0.385, direction: 'z' }, l)).toBe('slides')
  })

  it("designToolset hands the run's layer height and filament to geom.fit_check and design.check", async () => {
    const asked: Record<string, unknown>[] = []
    const report = { parts: [{ bounds: { min: [0, 0, 0], max: [1, 1, 0] }, item: 0 }, { bounds: { min: [0, 0, 5], max: [1, 1, 5] }, item: 1 }], gaps: [], pieces: 2 }
    const host = {
      get: () => design,
      list: () => [design],
      call: async (op: string, req: Record<string, unknown>) => {
        if (op === 'fit.check') asked.push(req)
        if (op === 'fit.check') return report
        return op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))
      },
    } as unknown as DesignHost
    const plans = toolset.createPlanRegistry()
    plans.put({ planId: 'pip', part: 'Mechanism', units: 'mm', features: [], assumptions: [], questions: [], printInPlace: ['Arm', 'Pin'] }, 'd', 'card')
    const tools = toolset.designToolset(host, {}, { plans, cardSide: true, fitProfile: () => ({ material: 'PETG', layerHeightMm: 0.28 }) })
    const run = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name)!
      return (await t.run(t.input.parse(args), {} as ToolContext)).output as { limits?: Record<string, unknown>; body?: { fit?: { limits: Record<string, unknown> } } }
    }
    const fit = await run('geom.fit_check', { design: 'd' })
    expect(fit.limits).toMatchObject({ side_mm: 0.4, vertical_mm: 0.84, material: 'PETG', layer_height_mm: 0.28 })
    const check = await run('design.check', { planId: 'pip' })
    expect(check.body?.fit?.limits).toMatchObject({ sideMm: 0.4, verticalMm: 0.84, material: 'PETG', layerHeightMm: 0.28 })
    expect(asked.map((r) => [r['minGapMm'], r['minVerticalGapMm'], r['layerHeightMm']])).toEqual([
      [0.4, 0.84, 0.28],
      [0.4, 0.84, 0.28],
    ])
  })
})
