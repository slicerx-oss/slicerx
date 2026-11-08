// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 0.02 mm a gap may read under its limit and still clear, at the edges: it is for gaps whose ends are round faces
// drawn as facets, beside a pin or above one lying flat in its bore; a gap above or below between flat faces is held to
// its bare limit, which the fit rule floors to whole layers. A touch
// stays a touch. The engine's report is stubbed, so each gap is exactly the size the case names. Also the pieces item
// for pieces that are bodies of one part (after geom.mirror or geom.array), which no tool can name one by one.
import type { Design as HostDesign, DesignHost, HistoryMesh } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { fitItems, isNamingMiss, type BodyFacts, type FitFacts, type FitGap } from '../src/design-check'
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

// A cylinder as the engine draws one (build::cylinder through Frame::from_normal): n sides, vertex i at 2 pi i / n from
// the frame's u axis, which is z for a cylinder along x and -z along y. Its side faces outward, or inward for a bore.
function cylinder(axis: 'x' | 'y', r: number, n: number, center: V3, lengthMm: number, inner = false): { mesh: HistoryMesh; ring: [number, number][] } {
  const w: V3 = axis === 'x' ? [1, 0, 0] : [0, 1, 0]
  const u: V3 = axis === 'x' ? [0, 0, 1] : [0, 0, -1]
  const v: V3 = axis === 'x' ? [0, -1, 0] : [-1, 0, 0]
  const ring = Array.from({ length: n }, (_, i): [number, number] => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)])
  const at = ([a, b]: [number, number], h: number): number[] => [0, 1, 2].map((k) => center[k]! + u[k]! * a + v[k]! * b + w[k]! * h)
  const positions = [...ring.flatMap((p) => at(p, 0)), ...ring.flatMap((p) => at(p, lengthMm))]
  const indices: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const quad = [i, j, n + j, i, n + j, n + i]
    // wind each pair outward (inward for a bore): the normal against the way from the axis to the side
    const p = (k: number): V3 => [positions[k * 3]!, positions[k * 3 + 1]!, positions[k * 3 + 2]!]
    const [a, b, c] = [p(quad[0]!), p(quad[1]!), p(quad[2]!)]
    const nrm = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]
    const out = [0, 1, 2].reduce((t, k) => t + nrm[k]! * ((a[k]! + b[k]!) / 2 - center[k]! - w[k]! * ((a[k]! + b[k]!) / 2 - center[k]!)), 0)
    indices.push(...((out > 0) !== inner ? quad : [quad[0]!, quad[2]!, quad[1]!, quad[3]!, quad[5]!, quad[4]!]))
  }
  return { mesh: { name: inner ? 'Knuckle' : 'Pin', slot: 0, positions, indices }, ring }
}

/**
 * fitFacts over a pin lying in its bore, the engine's reply built from the two outlines: the closest gap between them
 * across the axis (the pin's corners against the bore's sides and the other way), above the pin, as fit.check reports
 * a gap under the limit there.
 */
async function pinInBore(axis: 'x' | 'y', pinR: number, pinSides: number, boreR: number, boreSides: number, turnDeg = 0) {
  const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })
  const center: V3 = [0, 0, 5]
  const pin = cylinder(axis, pinR, pinSides, center, 10)
  const bore = cylinder(axis, boreR, boreSides, center, 10, true)
  // closest points of two outlines in the frame's (u, v) plane; z is the first coordinate along u, up along x and down along y
  const height = (p: [number, number]): number => (axis === 'x' ? p[0] : -p[0])
  const closest = (pts: [number, number][], ring: [number, number][]) => {
    let best = { d: Infinity, p: [0, 0] as [number, number], q: [0, 0] as [number, number] }
    for (const p of pts)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!
        const b = ring[(i + 1) % ring.length]!
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)))
        const q: [number, number] = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
        const d = Math.hypot(p[0] - q[0], p[1] - q[1])
        // of pairs that tie, the one nearest the top
        if (d < best.d - 1e-9 || (d <= best.d + 1e-9 && height(p) > height(best.p))) best = { d, p, q }
      }
    return best
  }
  // the gap over the top of the pin, from the corners within 10 degrees of it: the engine reports the closest pair
  // running up and down, which is there when it is the closest of all, as with the same number of sides on pin and
  // bore, where every side ties
  const up = (p: [number, number]): boolean => height(p) > Math.cos((10 * Math.PI) / 180) * Math.hypot(p[0], p[1])
  const one = closest(pin.ring.filter(up), bore.ring)
  const other = closest(bore.ring.filter(up), pin.ring)
  const g = one.d <= other.d ? one : { d: other.d, p: other.q, q: other.p }
  const u: V3 = axis === 'x' ? [0, 0, 1] : [0, 0, -1]
  const v: V3 = axis === 'x' ? [0, -1, 0] : [-1, 0, 0]
  const w: V3 = axis === 'x' ? [1, 0, 0] : [0, 1, 0]
  // the whole design turned about z through the axis, as a hinge built on a diagonal is
  const [cos, sin] = [Math.cos((turnDeg * Math.PI) / 180), Math.sin((turnDeg * Math.PI) / 180)]
  const turn = (p: V3): V3 => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos, p[2]]
  const turned = (m: HistoryMesh): HistoryMesh => ({ ...m, positions: Array.from({ length: m.positions.length / 3 }, (_, i) => turn([m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!])).flat() })
  const at = ([a, b]: [number, number]): V3 => turn([0, 1, 2].map((k) => center[k]! + u[k]! * a + v[k]! * b + w[k]! * 5) as V3)
  const from = at(g.p)
  const to = at(g.q)
  // the gap runs more up than across, as the engine's fit check sorts a gap above or below
  expect(to[2] - from[2]).toBeGreaterThan(Math.hypot(to[0] - from[0], to[1] - from[1]))
  const report = {
    parts: [
      { bounds: { min: [-boreR, -boreR, 5 - boreR], max: [boreR, boreR, 5 + boreR] }, item: 0 },
      { bounds: { min: [-pinR, -pinR, 5 - pinR], max: [pinR, pinR, 5 + pinR] }, item: 1 },
    ],
    gaps: [{ parts: [1, 0], gapMm: g.d, limitMm: limits.verticalMm, kind: 'vertical', from, to }],
    pieces: 2,
  }
  const host = { call: async () => report } as unknown as DesignHost
  const fit = await fitFacts(host, designOf([turned(bore.mesh), turned(pin.mesh)]), limits)
  return { fit, gap: fit.gaps[0]!, limits, readMm: g.d }
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

  it('a pin of 2.5 mm radius lying in a 2.9 mm bore clears its 0.4 mm gap, drawn in the sides the engine draws it in', async () => {
    // geom.build draws a cylinder in circle_segments(r, 0.02) sides, 48 at most: 25 for the pin and 27 for the bore.
    // Along x a corner of each sits at the top, and the facets beside it lean 7.2 and 6.7 degrees; along y a facet sits
    // level at the top, one 0.63 mm strip; with 25 sides on both, the gap runs from one level strip to the other. The
    // engine's own test cylinder has 96 sides. None is a flat face.
    for (const [axis, pinSides, boreSides] of [['x', 25, 27], ['y', 25, 27], ['y', 25, 25], ['x', 96, 96], ['y', 97, 97]] as const) {
      const { fit, gap, limits, readMm } = await pinInBore(axis, 2.5, pinSides, 2.9, boreSides)
      const what = `${pinSides} sides along ${axis}, read ${readMm.toFixed(4)} mm`
      expect(readMm, what).toBeGreaterThan(0.38)
      expect(readMm, what).toBeLessThan(0.4)
      expect(gap.flat, what).toBeUndefined()
      expect(gap.direction, what).toBe('z')
      expect(gap.kind, what).toBe('apart')
      expect(fitVerdict(gap, limits), what).toBe('slides')
      expect(gapsItem(fit).pass, what).toBe(true)
    }
  })

  it('a pin lying in its bore clears its 0.4 mm gap with the design turned about z: a level strip along it is no flat face at any angle', async () => {
    // along y, 25 sides on both: the gap runs from the pin's level strip to the bore's. Turned 30 or 45 degrees, each
    // strip's facets reach several mm both ways seen from above, though the strip is 0.63 mm wide
    for (const turnDeg of [30, 45])
      for (const [pinSides, boreSides] of [[25, 25], [25, 27]] as const) {
        const { fit, gap, limits, readMm } = await pinInBore('y', 2.5, pinSides, 2.9, boreSides, turnDeg)
        const what = `${pinSides} and ${boreSides} sides turned ${turnDeg} degrees, read ${readMm.toFixed(4)} mm`
        expect(readMm, what).toBeLessThan(0.4)
        expect(gap.flat, what).toBeUndefined()
        expect(gap.kind, what).toBe('apart')
        expect(fitVerdict(gap, limits), what).toBe('slides')
        expect(gapsItem(fit).pass, what).toBe(true)
      }
  })

  it('a gap with one end on a flat face and the other on a round one gets the facet allowance, either way up', async () => {
    const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })
    const flatTop: HistoryMesh = { name: 'Arm', slot: 0, positions: [-1, -1, 5, 1, -1, 5, 0, 1, 5], indices: [0, 1, 2] }
    const flatUnder = (z: number): HistoryMesh => ({ name: 'Pin', slot: 0, positions: [-1, -1, z, 0, 1, z, 1, -1, z], indices: [0, 1, 2] })
    const leaningTop: HistoryMesh = curvedPair(0.385)[0]!
    const leaningUnder = curvedPair(0.385)[1]!
    for (const [parts, what] of [
      [[flatTop, leaningUnder], 'a flat top under a round bottom'],
      [[leaningTop, flatUnder(5.385)], 'a round top under a flat bottom'],
    ] as const) {
      const report = {
        parts: [
          { bounds: { min: [0, 0, 0], max: [1, 1, 5] }, item: 0 },
          { bounds: { min: [0, 0, 5.385], max: [1, 1, 6] }, item: 1 },
        ],
        gaps: [{ parts: [0, 1], gapMm: 0.385, limitMm: limits.verticalMm, kind: 'vertical', from: [0, 0, 5], to: [0, 0, 5.385] }],
        pieces: 2,
      }
      const fit = await fitFacts({ call: async () => report } as unknown as DesignHost, designOf([...parts]), limits)
      const gap = fit.gaps[0]!
      expect(gap.flat, what).toBeUndefined()
      expect(gap.kind, what).toBe('apart')
      expect(fitVerdict(gap, limits), what).toBe('slides')
    }
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

  it('fails a piece merged into another while a third is mirrored: the mirrored part already answers its own name', () => {
    // Pin joined into Arm, Base mirrored into two bodies: the count matches, but Base 2 is not the Pin
    const fit: FitFacts = { limits, pieces: 3, bodies: [{ part: 0, name: 'Base 1', partName: 'Base' }, { part: 0, name: 'Base 2', partName: 'Base' }, { part: 1, name: 'Arm', partName: 'Arm' }], gaps: [apart(0, 2), apart(1, 2)] }
    const got = pieces(fit, ['Base', 'Arm', 'Pin'])
    expect(got.pass).toBe(false)
    expect(got.got).toContain('Pin is not among them')
  })

  it('fails two parts of several bodies when one part answers a name and its other body would stand in for another', () => {
    // a fused leaf counts as one piece, so the count matches only with the second pin read as a leaf
    const fit: FitFacts = { limits, pieces: 3, bodies: [{ part: 0, name: 'Leaf 1', partName: 'Leaf' }, { part: 0, name: 'Leaf 2', partName: 'Leaf' }, { part: 1, name: 'Pin 1', partName: 'Pin' }, { part: 1, name: 'Pin 2', partName: 'Pin' }], gaps: [apart(0, 2), apart(1, 3)] }
    expect(pieces(fit, ['Left leaf', 'Right leaf', 'Pin']).pass).toBe(false)
  })

  it('passes two parts of several bodies, each body one of the names left over', () => {
    const fit: FitFacts = { limits, pieces: 4, bodies: [{ part: 0, name: 'Leaf 1', partName: 'Leaf' }, { part: 0, name: 'Leaf 2', partName: 'Leaf' }, { part: 1, name: 'Pin 1', partName: 'Pin' }, { part: 1, name: 'Pin 2', partName: 'Pin' }], gaps: [apart(0, 2), apart(1, 3)] }
    const got = pieces(fit, ['Left leaf', 'Right leaf', 'Front pin', 'Back pin'])
    expect(got.pass).toBe(true)
    expect(got.got).toBe('4 pieces (Left leaf, Right leaf, Front pin and Back pin are Leaf 1, Leaf 2, Pin 1 and Pin 2, bodies of parts that hold several)')
  })

  it('fails a mirrored leaf whose part is named for one leaf, saying how to name it, and the miss is only about names', () => {
    const fit: FitFacts = { limits, pieces: 3, bodies: [{ part: 0, name: 'Left leaf 1', partName: 'Left leaf' }, { part: 0, name: 'Left leaf 2', partName: 'Left leaf' }, { part: 1, name: 'Pin', partName: 'Pin' }], gaps: [apart(0, 2), apart(1, 2)] }
    const got = pieces(fit, ['Left leaf', 'Right leaf', 'Pin'])
    expect(got.pass).toBe(false)
    expect(got.got).toBe(
      "3 pieces, but Right leaf is not among them: Left leaf 2 is another body of Left leaf (Left leaf), which already answers a piece's name. Bodies of one part take the plan's names only when the part's own name is none of them: build that part under a name that is no piece's and check again, or make each piece a part of its own",
    )
    expect(isNamingMiss(got)).toBe(true)
    // the same part under a name that is no piece's passes
    const leaves: FitFacts = { ...fit, bodies: [{ part: 0, name: 'Leaf 1', partName: 'Leaf' }, { part: 0, name: 'Leaf 2', partName: 'Leaf' }, { part: 1, name: 'Pin', partName: 'Pin' }] }
    expect(pieces(leaves, ['Left leaf', 'Right leaf', 'Pin']).pass).toBe(true)
    // a name no body has, with each body a part of its own, is not a naming miss of this kind
    const own: FitFacts = { limits, pieces: 2, bodies: [{ part: 0, name: 'Arm', partName: 'Arm' }, { part: 1, name: 'Pin', partName: 'Pin' }], gaps: [apart(0, 1)] }
    expect(isNamingMiss(pieces(own, ['Lid', 'Tray']))).toBe(false)
  })

  it("design.check lets a miss only on a part's name pass once without using the fix round", async () => {
    const report = {
      parts: [
        { bounds: { min: [0, 0, 0], max: [1, 1, 0] }, item: 0 },
        { bounds: { min: [3, 0, 0], max: [4, 1, 0] }, item: 0 },
        { bounds: { min: [0, 0, 5], max: [1, 1, 5] }, item: 1 },
      ],
      gaps: [
        { parts: [0, 2], gapMm: 0.5, limitMm: 0.3, kind: 'apart', from: [0, 0, 0], to: [0.5, 0, 0] },
        { parts: [1, 2], gapMm: 0.5, limitMm: 0.3, kind: 'apart', from: [3, 0, 0], to: [3.5, 0, 0] },
      ],
      pieces: 3,
    }
    // closed 5 mm cubes, so only the pieces item can fail
    const cube = (name: string, x: number): HistoryMesh => ({ name, slot: 0, positions: [0, 0, 0, 5, 0, 0, 5, 5, 0, 0, 5, 0, 0, 0, 5, 5, 0, 5, 5, 5, 5, 0, 5, 5].map((v, k) => (k % 3 === 0 ? v + x : v)), indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] })
    const leaf = designOf([cube('Left leaf', 0), cube('Pin', 10)])
    const host = { get: () => leaf, list: () => [leaf], call: async (op: string) => (op === 'fit.check' ? report : op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))) } as unknown as DesignHost
    const plans = toolset.createPlanRegistry()
    plans.put({ planId: 'hinge', part: 'Mechanism', units: 'mm', features: [], assumptions: [], questions: [], printInPlace: ['Left leaf', 'Right leaf', 'Pin'] }, 'd', 'card')
    const tool = toolset.designToolset(host, {}, { plans, cardSide: true }).find((x) => x.name === 'design.check')!
    const check = async () => {
      const r = await tool.run(tool.input.parse({ planId: 'hinge' }), {} as ToolContext)
      return { summary: r.summary, out: r.output as { pass: boolean; stop?: string; items: { name: string; pass: boolean }[] } }
    }
    const first = await check()
    expect(first.out.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['pieces'])
    expect(first.summary).toContain('This miss does not use the fix round.')
    expect(plans.get('hinge')).toMatchObject({ namingWaived: true, replaceable: true })
    expect(plans.get('hinge')?.failedChecks).toBeUndefined()
    // the second such miss counts, and the one after it uses up the fix round
    expect((await check()).out.stop).toBeUndefined()
    expect(plans.get('hinge')?.failedChecks).toBe(1)
    expect((await check()).out.stop).toContain('The fix round is used')
  })

  it('fails more bodies of one part left over than names left: two leaves planned, three leaf bodies', () => {
    // two of the three leaf bodies touch, so the count matches; the part answers no name, so only the count of
    // leftover bodies against leftover names rejects it
    const fit: FitFacts = { limits, pieces: 3, bodies: [{ part: 0, name: 'Leaf 1', partName: 'Leaf' }, { part: 0, name: 'Leaf 2', partName: 'Leaf' }, { part: 0, name: 'Leaf 3', partName: 'Leaf' }, { part: 1, name: 'Pin', partName: 'Pin' }], gaps: [apart(0, 3), apart(1, 3), { ...apart(1, 2), kind: 'fused', gapMm: 0 }] }
    const got = pieces(fit, ['Left leaf', 'Right leaf', 'Pin'])
    expect(got.pass).toBe(false)
    expect(got.got).toContain('Left leaf and Right leaf are not among them')
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
