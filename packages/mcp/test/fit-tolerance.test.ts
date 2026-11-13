// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 0.02 mm a gap may read under its limit and still clear, at the edges: it is for gaps whose ends are round faces
// drawn as facets, beside a pin or above one lying flat in its bore; a gap above or below between flat faces is held to
// its bare limit, which the fit rule floors to whole layers. A touch
// stays a touch. The engine's report is stubbed, so each gap is exactly the size the case names. Also the pieces item
// for pieces that are bodies of one part (after geom.mirror or geom.array), which no tool can name one by one.
import type { Design as HostDesign, DesignHost, HistoryMesh } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { fitItems, isNamingMiss, lonePieces, type BodyFacts, type FitFacts, type FitGap } from '../src/design-check'
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
function cylinder(axis: 'x' | 'y', r: number, n: number, center: V3, lengthMm: number, inner = false, phase = 0): { mesh: HistoryMesh; ring: [number, number][] } {
  const w: V3 = axis === 'x' ? [1, 0, 0] : [0, 1, 0]
  const u: V3 = axis === 'x' ? [0, 0, 1] : [0, 0, -1]
  const v: V3 = axis === 'x' ? [0, -1, 0] : [-1, 0, 0]
  // phase turns the corners round by that many facets: a half puts a side where a corner was
  const ring = Array.from({ length: n }, (_, i): [number, number] => [r * Math.cos((2 * Math.PI * (i + phase)) / n), r * Math.sin((2 * Math.PI * (i + phase)) / n)])
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
 * across the axis (the pin's corners against the bore's sides and the other way), above the pin, or below it with
 * `side`, as fit.check reports a gap under the limit there. `phase` turns both outlines round by that many facets.
 */
async function pinInBore(axis: 'x' | 'y', pinR: number, pinSides: number, boreR: number, boreSides: number, turnDeg = 0, side: 'above' | 'below' = 'above', phase = 0) {
  const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })
  const center: V3 = [0, 0, 5]
  const pin = cylinder(axis, pinR, pinSides, center, 10, false, phase)
  const bore = cylinder(axis, boreR, boreSides, center, 10, true, phase)
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
        // of pairs that tie, the one nearest the top (the bottom for a gap below); from one corner, the one that runs
        // most up and down, as from a corner of 8 sides to the level side rather than the 45 degree one beside it
        const toward = (z: number): number => (side === 'above' ? z : -z)
        const higher = toward(height(p)) - toward(height(best.p))
        if (d < best.d - 1e-9 || (d <= best.d + 1e-9 && (higher > 1e-9 || (higher >= -1e-9 && toward(height(q)) > toward(height(best.q)) + 1e-9)))) best = { d, p, q }
      }
    return best
  }
  // the gap over the top of the pin, from the corners within 10 degrees of it: the engine reports the closest pair
  // running up and down, which is there when it is the closest of all, as with the same number of sides on pin and
  // bore, where every side ties
  // (or within half a facet and a degree, for an outline of so few sides that no corner is within 10 degrees)
  const within = Math.max(10, 180 / Math.min(pinSides, boreSides) + 1)
  const up = (p: [number, number]): boolean => (side === 'above' ? height(p) : -height(p)) > Math.cos((within * Math.PI) / 180) * Math.hypot(p[0], p[1])
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
  // the gap runs more up and down than across, as the engine's fit check sorts a gap above or below
  expect(Math.abs(to[2] - from[2])).toBeGreaterThan(Math.hypot(to[0] - from[0], to[1] - from[1]))
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

  it('a 5 mm pin in a 5.4 mm bore, both drawn in 25 sides along y, clears its 0.4 mm gap: the bore\'s 1.35 mm top strip is no flat face', async () => {
    // the bore's level strip is wider than the pin's 0.63 mm one, wide enough for a 1 mm disc, but the facets on both
    // sides of it lean 14.4 degrees: it is the top of a round face. Turned about z too.
    for (const [boreSides, turnDeg] of [[25, 0], [25, 30], [27, 0]] as const) {
      const { fit, gap, limits, readMm } = await pinInBore('y', 5, 25, 5.4, boreSides, turnDeg)
      const what = `bore in ${boreSides} sides turned ${turnDeg} degrees, read ${readMm.toFixed(4)} mm`
      expect(readMm, what).toBeGreaterThan(0.38)
      expect(readMm, what).toBeLessThan(0.4)
      expect(gap.flat, what).toBeUndefined()
      expect(gap.kind, what).toBe('apart')
      expect(fitVerdict(gap, limits), what).toBe('slides')
      expect(gapsItem(fit).pass, what).toBe(true)
    }
  })

  it('a pin lying in its bore gets the same answer for the gap above it and the gap below it, in 12, 25 and 27 sides', async () => {
    // a level side at the end the gap is read from: 12 sides turned half a facet have one at the top and the bottom, and
    // 25 and 27 one at the top, or at the bottom turned half a facet. Below the pin the facets beside its bottom side
    // rise from it, and above the bore's floor too; the gap is between two round faces whichever end it is read from.
    for (const [pinSides, boreSides] of [[12, 12], [25, 25], [25, 27], [27, 27]] as const)
      for (const side of ['above', 'below'] as const) {
        const phase = pinSides % 2 === 0 ? 0.5 : side === 'above' ? 0 : 0.5
        const { fit, gap, limits, readMm } = await pinInBore('y', 2.5, pinSides, 2.9, boreSides, 0, side, phase)
        const what = `${pinSides} and ${boreSides} sides turned ${phase} facets, the gap ${side} the pin, read ${readMm.toFixed(4)} mm`
        expect(readMm, what).toBeGreaterThan(0.38)
        expect(readMm, what).toBeLessThan(0.4)
        expect(gap.flat, what).toBeUndefined()
        expect(gap.kind, what).toBe('apart')
        expect(fitVerdict(gap, limits), what).toBe('slides')
        expect(gapsItem(fit).pass, what).toBe(true)
      }
  })

  it('a pin lying in its bore in 8, 12, 16, 25 or 27 sides is a round face above and below, and a 5 mm pin in 25 or 27', async () => {
    // a level side at the end the gap is read from, with the facets beside it turning further facet by facet: 45 degrees
    // then a wall in 8 sides, 30 then 60 in 12, down to 13.3 then 26.7 in 27. Each gets the facet allowance, so a gap
    // within it of the limit clears; 8 sides read 0.37 mm, more than the allowance under, and stays tight.
    const cases = [...([8, 12, 16, 25, 27] as const).map((n) => [2.5, 2.9, n] as const), [5, 5.4, 25], [5, 5.4, 27]] as const
    for (const [pinR, boreR, n] of cases)
      for (const side of ['above', 'below'] as const)
        for (const turnDeg of [0, 45]) {
          const phase = n % 2 === 0 ? 0.5 : side === 'above' ? 0 : 0.5
          const { gap, limits, readMm } = await pinInBore('y', pinR, n, boreR, n, turnDeg, side, phase)
          const what = `${pinR} mm pin in a ${boreR} mm bore, ${n} sides, the gap ${side} it, turned ${turnDeg}, read ${readMm.toFixed(4)} mm`
          expect(gap.flat, what).toBeUndefined()
          expect(gap.direction, what).toBe('z')
          const clears = readMm + FIT_TOLERANCE_MM >= limits.verticalMm
          expect(clears, what).toBe(n !== 8)
          expect(gap.kind, what).toBe(clears ? 'apart' : 'vertical')
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

  // flat faces meshed in small facets, as the engine draws large faces: each rectangle (x0, y0, x1, y1) a grid of
  // `step` mm squares, two facets each, facing up for the lower body's top and down for the upper body's bottom
  const face = (name: string, rects: [number, number, number, number][], z: number, step: number, up: boolean, turnDeg = 0): HistoryMesh => {
    const [cos, sin] = [Math.cos((turnDeg * Math.PI) / 180), Math.sin((turnDeg * Math.PI) / 180)]
    const positions: number[] = []
    const indices: number[] = []
    for (const [x0, y0, x1, y1] of rects) {
      const [nx, ny] = [Math.round((x1 - x0) / step), Math.round((y1 - y0) / step)]
      const base = positions.length / 3
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          const [x, y] = [x0 + ((x1 - x0) * i) / nx, y0 + ((y1 - y0) * j) / ny]
          positions.push(x * cos - y * sin, x * sin + y * cos, z)
        }
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const [a, b, c, d] = [base + j * (nx + 1) + i, base + j * (nx + 1) + i + 1, base + (j + 1) * (nx + 1) + i + 1, base + (j + 1) * (nx + 1) + i]
          indices.push(...(up ? [a, b, c, a, c, d] : [a, c, b, a, d, c]))
        }
    }
    return { name, slot: 0, positions, indices }
  }
  /** fitFacts over a top face at z 5 under a bottom face `gapMm` higher, the engine's gap from a corner of the lower face (`at`) straight up, as it picks a facet corner of parallel faces. */
  const stacked = async (lower: [number, number, number, number][], upper: [number, number, number, number][], gapMm: number, at: [number, number], o: { step?: number; turnDeg?: number } = {}) => {
    const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })
    const [cos, sin] = [Math.cos(((o.turnDeg ?? 0) * Math.PI) / 180), Math.sin(((o.turnDeg ?? 0) * Math.PI) / 180)]
    const p: [number, number] = [at[0] * cos - at[1] * sin, at[0] * sin + at[1] * cos]
    const report = {
      parts: [
        { bounds: { min: [0, 0, 0], max: [1, 1, 5] }, item: 0 },
        { bounds: { min: [0, 0, 5 + gapMm], max: [1, 1, 6] }, item: 1 },
      ],
      gaps: [{ parts: [0, 1], gapMm, limitMm: limits.verticalMm, kind: 'vertical', from: [...p, 5], to: [...p, 5 + gapMm] }],
      pieces: 2,
    }
    const step = o.step ?? 0.5
    const fit = await fitFacts({ call: async () => report } as unknown as DesignHost, designOf([face('Arm', lower, 5, step, true, o.turnDeg), face('Pin', upper, 5 + gapMm, step, false, o.turnDeg)]), limits)
    return { fit, gap: fit.gaps[0]!, limits }
  }
  const expectFlat = async (what: string, run: (gapMm: number) => ReturnType<typeof stacked>) => {
    const tight = await run(0.38)
    expect(tight.gap.flat, what).toBe(true)
    expect(tight.gap.kind, what).toBe('vertical')
    expect(fitVerdict(tight.gap, tight.limits), what).toBe('fuses')
    expect(gapsItem(tight.fit).pass, what).toBe(false)
    const clear = await run(0.4)
    expect(clear.gap.flat, what).toBe(true)
    expect(clear.gap.kind, what).toBe('apart')
    expect(fitVerdict(clear.gap, clear.limits), what).toBe('slides')
  }

  it('stacked 20 mm plates meshed in 0.5 mm facets are flat faces, from a corner, at any turn: 0.38 mm fuses and 0.4 mm slides', async () => {
    const plate: [number, number, number, number][] = [[0, 0, 20, 20]]
    for (const turnDeg of [0, 30, 45]) {
      await expectFlat(`plates turned ${turnDeg} degrees, from a corner`, (g) => stacked(plate, plate, g, [0, 0], { turnDeg }))
      await expectFlat(`plates turned ${turnDeg} degrees, from an edge`, (g) => stacked(plate, plate, g, [10, 0], { turnDeg }))
    }
    // 20,000 facets on each plate
    await expectFlat('plates in 0.2 mm facets', (g) => stacked(plate, plate, g, [7, 7], { step: 0.2 }))
  })

  it('a lid over a box rim of 1.2 mm walls is a flat gap, from a corner of the rim', async () => {
    // a 30 by 20 mm box, its rim four strips 1.2 mm wide, under a lid that covers it
    const rim: [number, number, number, number][] = [[0, 0, 30, 1.2], [0, 18.8, 30, 20], [0, 1.2, 1.2, 18.8], [28.8, 1.2, 30, 18.8]]
    await expectFlat('lid on a rim, outer corner', (g) => stacked(rim, [[0, 0, 30, 20]], g, [0, 0], { step: 0.4 }))
    await expectFlat('lid on a rim, inner corner', (g) => stacked(rim, [[0, 0, 30, 20]], g, [1.2, 1.2], { step: 0.4 }))
  })

  it('a wide flat bottom over a narrow rail is a flat gap: the bridged face above decides, not the 0.8 mm rail', async () => {
    const rail: [number, number, number, number][] = [[0, 0, 20, 0.8]]
    for (const turnDeg of [0, 30]) await expectFlat(`rail turned ${turnDeg} degrees`, (g) => stacked(rail, [[-5, -10, 25, 10]], g, [0, 0], { step: 0.4, turnDeg }))
    // the same rail hung over a plate, or over another rail, is the face printed over the gap; under 1 mm across it
    // cannot be told from a pin's level strip, so it gets the facet allowance
    for (const lower of [[[-5, -10, 25, 10]], rail] as [number, number, number, number][][]) {
      const hung = await stacked(lower, rail, 0.38, [0, 0], { step: 0.4 })
      expect(hung.gap.flat).toBeUndefined()
      expect(hung.gap.kind).toBe('apart')
    }
  })

  it('a bottom strip 1.2 mm wide is a flat face and one 0.9 mm wide is not, from its end', async () => {
    const plate: [number, number, number, number][] = [[-5, -10, 25, 10]]
    await expectFlat('a 1.2 mm strip over a plate', (g) => stacked(plate, [[0, 0, 20, 1.2]], g, [0, 0], { step: 0.3 }))
    await expectFlat('a 1.2 mm strip over a plate, from the middle of its end', (g) => stacked(plate, [[0, 0, 20, 1.2]], g, [0, 0.6], { step: 0.3 }))
    const narrow = await stacked(plate, [[0, 0, 20, 0.9]], 0.38, [0, 0], { step: 0.3 })
    expect(narrow.gap.flat).toBeUndefined()
    expect(narrow.gap.kind).toBe('apart')
  })

  it('a narrow bottom strip beside a wide one across a thin groove is no flat face: the groove parts them', async () => {
    const plate: [number, number, number, number][] = [[-5, -10, 25, 10]]
    for (const groove of [0.1, 0.15, 0.2]) {
      // a 0.8 mm rail, the groove, then a wide plate, all bottom faces of the upper body at one height
      const upper: [number, number, number, number][] = [[0, 0, 20, 0.8], [0, 0.8 + groove, 20, 10]]
      for (const at of [[0, 0], [10, 0.4], [10, 0.8]] as [number, number][]) {
        const hung = await stacked(plate, upper, 0.38, at, { step: 0.2 })
        expect(hung.gap.flat, `${groove} mm groove, from ${at.join(', ')}`).toBeUndefined()
        expect(hung.gap.kind, `${groove} mm groove, from ${at.join(', ')}`).toBe('apart')
      }
      // the wide side of the groove is a flat face, though the groove runs past it
      await expectFlat(`the plate beside a ${groove} mm groove`, (g) => stacked(plate, upper, g, [10, 0.8 + groove], { step: 0.2 }))
    }
  })

  it('a wide bottom face with a 0.2 mm slot through it stays a flat face on either side of the slot', async () => {
    const plate: [number, number, number, number][] = [[-5, -10, 25, 10]]
    const slotted: [number, number, number, number][] = [[0, 0, 20, 4.9], [0, 5.1, 20, 10]]
    for (const at of [[10, 4.9], [10, 5.1], [10, 4.5]] as [number, number][]) await expectFlat(`slotted plate, from ${at.join(', ')}`, (g) => stacked(plate, slotted, g, at, { step: 0.2 }))
  })

  /**
   * fitFacts over a plate's top at z 5 under a bottom face of the upper body that is a level strip `stripMm` wide (along x,
   * 20 mm long) with a chamfer 3 mm wide on each side, rising away from it by `left` and `right` degrees (none: the strip
   * ends at a wall). The gap runs from the plate straight up to the middle of the strip.
   */
  const chamfered = async (stripMm: number, left: number | null, right: number | null, gapMm: number, turnDeg = 0) => {
    const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })
    const z = 5 + gapMm
    const h = stripMm / 2
    // x breaks across the bottom face, each with its height
    const cols: [number, number][] = [[-h, z], [h, z]]
    if (left !== null) cols.unshift([-h - 3, z + 3 * Math.tan((left * Math.PI) / 180)])
    if (right !== null) cols.push([h + 3, z + 3 * Math.tan((right * Math.PI) / 180)])
    const [cos, sin] = [Math.cos((turnDeg * Math.PI) / 180), Math.sin((turnDeg * Math.PI) / 180)]
    const positions: number[] = []
    for (const [x, zz] of cols) for (const y of [0, 20]) positions.push(x * cos - y * sin, x * sin + y * cos, zz)
    const indices: number[] = []
    for (let i = 0; i + 1 < cols.length; i++) {
      const [a, b, c, d] = [i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2]
      // wound to face down
      indices.push(a, b, c, a, c, d)
    }
    const upper: HistoryMesh = { name: 'Pin', slot: 0, positions, indices }
    const lower = face('Arm', [[-10, -5, 10, 25]], 5, 0.5, true, turnDeg)
    const p: [number, number] = [-10 * 0 + 0 * cos - 10 * sin, 0 * sin + 10 * cos]
    const report = {
      parts: [
        { bounds: { min: [0, 0, 0], max: [1, 1, 5] }, item: 0 },
        { bounds: { min: [0, 0, z], max: [1, 1, 6] }, item: 1 },
      ],
      gaps: [{ parts: [0, 1], gapMm, limitMm: limits.verticalMm, kind: 'vertical', from: [...p, 5], to: [...p, z] }],
      pieces: 2,
    }
    const fit = await fitFacts({ call: async () => report } as unknown as DesignHost, designOf([lower, upper]), limits)
    return { gap: fit.gaps[0]!, limits }
  }

  it('a level strip 1.5 and 2.5 mm wide with a 10 or 20 degree chamfer on both sides stays a flat face', async () => {
    // a drafted rib or a lead-in this shallow is a real flat face, not the top of a round one
    for (const strip of [1.5, 2.5])
      for (const deg of [10, 20])
        for (const turnDeg of [0, 30]) {
          const { gap, limits } = await chamfered(strip, deg, deg, 0.38, turnDeg)
          const what = `${strip} mm strip, ${deg} degrees both sides, turned ${turnDeg}`
          expect(gap.flat, what).toBe(true)
          expect(gap.kind, what).toBe('vertical')
          expect(fitVerdict(gap, limits), what).toBe('fuses')
        }
  })

  it('a level strip with a chamfer of 29 or exactly 30 degrees on both sides stays a flat face: one plane each side is no round face', async () => {
    for (const strip of [1.5, 2.5])
      for (const deg of [29, 30])
        for (const turnDeg of [0, 30, 45]) {
          const { gap, limits } = await chamfered(strip, deg, deg, 0.38, turnDeg)
          const what = `${strip} mm strip, ${deg} degrees both sides, turned ${turnDeg}`
          expect(gap.flat, what).toBe(true)
          expect(gap.kind, what).toBe('vertical')
          expect(fitVerdict(gap, limits), what).toBe('fuses')
        }
  })

  it('a level strip with a chamfer on one side only, or on both sides steeper than 30 degrees, stays a flat face', async () => {
    for (const strip of [1.5, 2.5]) {
      for (const [left, right] of [[10, null], [null, 20], [29, null], [31, 31], [40, 40], [10, 40]] as const) {
        const { gap, limits } = await chamfered(strip, left, right, 0.38)
        const what = `${strip} mm strip, chamfers ${left} and ${right}`
        expect(gap.flat, what).toBe(true)
        expect(gap.kind, what).toBe('vertical')
        expect(fitVerdict(gap, limits), what).toBe('fuses')
      }
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

describe('the gaps item for pieces that join no other', () => {
  const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2 })
  const cube = (k: number, x: number) => ({ part: k, name: `Cube ${k + 1}`, partName: `Cube ${k + 1}`, box: { min: [x, 0, 0], max: [x + 20, 20, 20] } })
  const gaps = (fit: FitFacts) => fitItems(fit.bodies.map((b) => b.name), { fit } as BodyFacts).find((i) => i.name === 'gaps')!
  const knuckle = (a: number, b: number): FitGap => ({ bodies: [a, b], kind: 'apart', gapMm: 0.4, limitMm: 0.3, from: [0, 0, 0], to: [0.4, 0, 0], direction: 'xy' })

  it('says each form word for word: one piece, two, and three or more', () => {
    expect(lonePieces(['Cube 2'], 10)).toBe('Cube 2 joins no other piece: it is 10 mm or more from the nearest. Pieces that print in place print at their joints, each its planned gap from the piece it joins, so move it there before checking again.')
    expect(lonePieces(['Cube 2', 'Cube 3'], 10)).toBe('Cube 2 and Cube 3 join no other piece: each is 10 mm or more from the nearest. Pieces that print in place print at their joints, each its planned gap from the piece it joins, so move each one there before checking again.')
    expect(lonePieces(['Cube 2', 'Cube 3', 'Cube 4', 'Cube 5', 'Cube 6', 'Cube 7', 'Cube 8'], 10)).toBe('Cube 2, Cube 3 and 5 more join no other piece: each is 10 mm or more from the nearest. Pieces that print in place print at their joints, each its planned gap from the piece it joins, so move each one there before checking again.')
  })

  it('fails eight cubes laid 10 mm apart with no joint, naming them and the closest distance in whole mm', () => {
    const fit: FitFacts = { limits, pieces: 8, bodies: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => cube(k, k * 30.4)), gaps: [] }
    const g = gaps(fit)
    expect(g.pass).toBe(false)
    expect(g.got).toBe('Cube 1, Cube 2 and 6 more join no other piece: each is 10 mm or more from the nearest. Pieces that print in place print at their joints, each its planned gap from the piece it joins, so move each one there before checking again.')
  })

  it('fails one cube left apart from a joined pair, and says at least the 2 mm the check looked within when the boxes say less', () => {
    const fit: FitFacts = { limits, pieces: 3, bodies: [cube(0, 0), cube(1, 20.4), { ...cube(2, 60), box: { min: [0, 0, 30], max: [40, 20, 50] } }], gaps: [knuckle(0, 1)] }
    expect(gaps(fit).got).toBe('Cube 3 joins no other piece: it is 10 mm or more from the nearest. Pieces that print in place print at their joints, each its planned gap from the piece it joins, so move it there before checking again.')
    // boxes that overlap while the bodies stay 2 mm or more apart (the engine looked within 2 mm and found nothing)
    const tucked: FitFacts = { ...fit, bodies: [cube(0, 0), cube(1, 20.4), { ...cube(2, 0), box: { min: [5, 5, 5], max: [15, 15, 15] } }] }
    expect(gaps(tucked).got).toContain('Cube 3 joins no other piece: it is 2 mm or more from the nearest.')
  })

  it('passes pieces that each meet another', () => {
    const fit: FitFacts = { limits, pieces: 2, bodies: [cube(0, 0), cube(1, 20.4)], gaps: [knuckle(0, 1)] }
    expect(gaps(fit).pass).toBe(true)
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
    expect(got.got).toBe("2 pieces, but Lid and Tray are not among them: the pieces left over are Arm and Pin. Each is a piece of its own, so only the names are off: give each part one of the plan's names and check again, without changing its shape")
  })

  it('names the part left over beside the plan name it misses when the count is right and each piece is a part of its own: a naming miss', () => {
    // the live run: Segment 1 and Segment 2 planned, built as Segment 1 head and Segment 2 body
    const fit: FitFacts = { limits, pieces: 2, bodies: [{ part: 0, name: 'Segment 1 head', partName: 'Segment 1 head' }, { part: 1, name: 'Segment 2 body', partName: 'Segment 2 body' }], gaps: [apart(0, 1)] }
    const got = pieces(fit, ['Segment 1', 'Segment 2'])
    expect(got).toEqual({
      name: 'pieces',
      want: '2 separate pieces (Segment 1, Segment 2)',
      got: '2 pieces, but Segment 1 and Segment 2 are not among them: Segment 1 head is not named Segment 1; Segment 2 body is not named Segment 2. Each is a piece of its own, so only the names are off: give each part its plan name and check again, without changing its shape',
      pass: false,
    })
    expect(isNamingMiss(got)).toBe(true)
    // one name off: its part is named beside it, whatever the name
    const one = pieces({ ...fit, bodies: [{ part: 0, name: 'Hinge leaf', partName: 'Hinge leaf' }, { part: 1, name: 'Pin', partName: 'Pin' }] }, ['Leaf', 'Pin'])
    expect(one.got).toBe('2 pieces, but Leaf is not among them: Hinge leaf is not named Leaf. It is a piece of its own, so only the name is off: give the part its plan name and check again, without changing its shape')
    expect(isNamingMiss(one)).toBe(true)
    // matching stays exact: Segment 1 does not answer Segment 10, and a wrong count is no naming miss
    const ten = pieces({ ...fit, bodies: [{ part: 0, name: 'Segment 10', partName: 'Segment 10' }, { part: 1, name: 'Segment 2', partName: 'Segment 2' }] }, ['Segment 1', 'Segment 2'])
    expect(ten.pass).toBe(false)
    expect(ten.got).toContain('Segment 10 is not named Segment 1')
    expect(isNamingMiss(pieces({ ...fit, pieces: 1 }, ['Segment 1', 'Segment 2']))).toBe(false)
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
    const tools = toolset.designToolset(host, {}, { plans, cardSide: true })
    const tool = tools.find((x) => x.name === 'design.check')!
    // the gaps are looked at first, as design.check asks of a print-in-place plan
    const fit = tools.find((x) => x.name === 'geom.fit_check')!
    await fit.run(fit.input.parse({ design: 'd' }), {} as ToolContext)
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

  it('design.check lets a part built under another name than the plan gives pass once without using the fix round', async () => {
    const report = {
      parts: [
        { bounds: { min: [0, 0, 0], max: [5, 5, 5] }, item: 0 },
        { bounds: { min: [10, 0, 0], max: [15, 5, 5] }, item: 1 },
      ],
      gaps: [{ parts: [0, 1], gapMm: 0.5, limitMm: 0.3, kind: 'apart', from: [5, 0, 0], to: [5.5, 0, 0] }],
      pieces: 2,
    }
    const cube = (name: string, x: number): HistoryMesh => ({ name, slot: 0, positions: [0, 0, 0, 5, 0, 0, 5, 5, 0, 0, 5, 0, 0, 0, 5, 5, 0, 5, 5, 5, 5, 0, 5, 5].map((v, k) => (k % 3 === 0 ? v + x : v)), indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] })
    const lizard = designOf([cube('Segment 1 head', 0), cube('Segment 2', 10)])
    const host = { get: () => lizard, list: () => [lizard], call: async (op: string) => (op === 'fit.check' ? report : op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))) } as unknown as DesignHost
    const plans = toolset.createPlanRegistry()
    plans.put({ planId: 'lizard', part: 'Mechanism', units: 'mm', features: [], assumptions: [], questions: [], printInPlace: ['Segment 1', 'Segment 2'] }, 'd', 'card')
    const tools = toolset.designToolset(host, {}, { plans, cardSide: true })
    const tool = tools.find((x) => x.name === 'design.check')!
    // the gaps are looked at first, as design.check asks of a print-in-place plan
    const fit = tools.find((x) => x.name === 'geom.fit_check')!
    await fit.run(fit.input.parse({ design: 'd' }), {} as ToolContext)
    const r = await tool.run(tool.input.parse({ planId: 'lizard' }), {} as ToolContext)
    const out = r.output as { items: { name: string; pass: boolean; got: string }[] }
    expect(out.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['pieces'])
    expect(out.items.find((i) => i.name === 'pieces')!.got).toContain('Segment 1 head is not named Segment 1')
    expect(r.summary).toContain('This miss does not use the fix round.')
    expect(plans.get('lizard')?.failedChecks).toBeUndefined()
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
