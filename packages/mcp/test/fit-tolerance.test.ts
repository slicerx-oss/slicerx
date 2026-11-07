// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 0.02 mm a gap may read under its limit and still clear, at the edges: it is for side gaps only (round faces drawn
// as facets), so a gap above or below is held to its bare limit, which the fit rule floors to whole layers. A touch
// stays a touch. The engine's report is stubbed, so each gap is exactly the size the case names. Also the pieces item
// for pieces that are bodies of one part (after geom.mirror or geom.array), which no tool can name one by one.
import type { Design as HostDesign, DesignHost, HistoryMesh } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { fitItems, type BodyFacts, type FitFacts, type FitGap } from '../src/design-check'
import { FIT_TOLERANCE_MM, fitFacts, fitLimits, fitVerdict } from '../src/fit-facts'

type V3 = [number, number, number]
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
// one small facet per part: the report is stubbed, so the meshes only need to exist
const part = (name: string, z: number): HistoryMesh => ({ name, slot: 0, positions: [0, 0, z, 1, 0, z, 0, 1, z], indices: [0, 1, 2] })
const design = { id: 'd', name: 'Mechanism', transform: IDENTITY, parts: [part('Arm', 0), part('Pin', 5)] } as unknown as HostDesign

/** fitFacts over a stubbed engine that reports one gap between the two parts. */
async function oneGap(kind: FitGap['kind'] | 'horizontal', gapMm: number, material = 'PLA') {
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
  const fit = await fitFacts(host, design, limits)
  return { fit, gap: fit.gaps[0]!, limits }
}

const gapsItem = (fit: FitFacts) => fitItems(['Arm', 'Pin'], { fit } as BodyFacts).find((i) => i.name === 'gaps')!

describe('the fit tolerance', () => {
  it('a flat gap of 0.38 mm above and below stays tight and fails at 0.2 mm layers (PLA): one layer, which the sag closes', async () => {
    const { fit, gap, limits } = await oneGap('vertical', 0.38)
    expect(limits.verticalMm).toBe(0.4)
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
