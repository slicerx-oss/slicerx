// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A rectangle rounded at one end or both: the outline the exact path hands the kernel (lines and real arcs), the solid
// the engine makes from it (its volume the outline's area times its height), the radii it refuses, and the words
// geom.extrude gives each radius.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache, endRadii, roundedOutline } from '@slicerx/cad-history'
import { CORNER_RADIUS_HELP, END_RADIUS_HELP } from '../src/cad'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V2 = [number, number]
type Piece = { to: V2; center?: V2; sweepDeg?: number }
type Chain = { start: V2; segments: Piece[] }
type Rect = { type: 'rectangle'; widthMm: number; heightMm: number; cornerRadiusMm?: number; frontRadiusMm?: number; backRadiusMm?: number }

const geom = useGeomEngine('rounded-ends')

/** A loop of lines and arcs as the exact path draws it. */
const chain = (shape: Rect): Chain => {
  const l = roundedOutline(shape)
  expect(l, JSON.stringify(shape)).not.toBeNull()
  return l as Chain
}

/** The area a chain of lines and arcs encloses: each piece's chord, plus the cap between each arc and its chord. */
const area = (l: Chain): number => {
  let from = l.start
  let a = 0
  for (const g of l.segments) {
    a += (from[0] * g.to[1] - g.to[0] * from[1]) / 2
    if (g.center) {
      const r = Math.hypot(from[0] - g.center[0], from[1] - g.center[1])
      const t = (g.sweepDeg! * Math.PI) / 180
      a += (r * r * (t - Math.sin(t))) / 2
    }
    from = g.to
  }
  return a
}

/** What a round of r takes from one corner. */
const corner = (r: number): number => (1 - Math.PI / 4) * r * r

const arcs = (l: Chain) => l.segments.filter((g) => g.center).map((g) => ({ center: g.center, sweepDeg: g.sweepDeg }))

describe('the outline of a rectangle with rounded ends', () => {
  it('rounds only the front end of a house, as one half circle at half the height', () => {
    const l = chain({ type: 'rectangle', widthMm: 40, heightMm: 20, frontRadiusMm: 10 })
    expect(arcs(l)).toEqual([{ center: [10, 0], sweepDeg: 180 }])
    // the loop closes where it starts, on the half circle's lower end
    expect(l.start).toEqual([10, -10])
    expect(l.segments.at(-1)!.to).toEqual(l.start)
    expect(area(l)).toBeCloseTo(800 - 2 * corner(10), 9)
    expect(endRadii({ type: 'rectangle', widthMm: 40, heightMm: 20, frontRadiusMm: 10 })).toEqual([10, 0])
  })

  it('rounds only the back end of a cabin, and both ends of a block, each to its own radius', () => {
    const back = chain({ type: 'rectangle', widthMm: 30, heightMm: 12, backRadiusMm: 6 })
    expect(arcs(back)).toEqual([{ center: [-9, 0], sweepDeg: 180 }])
    expect(area(back)).toBeCloseTo(360 - 2 * corner(6), 9)
    const both = chain({ type: 'rectangle', widthMm: 30, heightMm: 12, frontRadiusMm: 2, backRadiusMm: 6 })
    expect(arcs(both).map((a) => a.sweepDeg)).toEqual([90, 180, 90])
    expect(area(both)).toBeCloseTo(360 - 2 * corner(2) - 2 * corner(6), 9)
    // two ends of half the height on a block as long as it is wide meet: a disc
    const disc = chain({ type: 'rectangle', widthMm: 12, heightMm: 12, frontRadiusMm: 6, backRadiusMm: 6 })
    expect(disc.segments.every((g) => g.center)).toBe(true)
    expect(area(disc)).toBeCloseTo(36 * Math.PI, 9)
  })

  it('keeps the four corner rounds of cornerRadiusMm as they were, with an end radius in place of it at that end', () => {
    const four = chain({ type: 'rectangle', widthMm: 30, heightMm: 20, cornerRadiusMm: 3 })
    expect(four.start).toEqual([15, -7])
    expect(four.segments).toEqual([
      { to: [15, 7] },
      { to: [12, 10], center: [12, 7], sweepDeg: 90 },
      { to: [-12, 10] },
      { to: [-15, 7], center: [-12, 7], sweepDeg: 90 },
      { to: [-15, -7] },
      { to: [-12, -10], center: [-12, -7], sweepDeg: 90 },
      { to: [12, -10] },
      { to: [15, -7], center: [12, -7], sweepDeg: 90 },
    ])
    const front = chain({ type: 'rectangle', widthMm: 30, heightMm: 20, cornerRadiusMm: 3, frontRadiusMm: 10 })
    expect(arcs(front)).toEqual([{ center: [5, 0], sweepDeg: 180 }, { center: [-12, 7], sweepDeg: 90 }, { center: [-12, -7], sweepDeg: 90 }])
    expect(area(front)).toBeCloseTo(600 - 2 * corner(10) - 2 * corner(3), 9)
    // a corner round of half the shorter side makes the short ends half circles too, with no line of no length
    const half = chain({ type: 'rectangle', widthMm: 30, heightMm: 20, cornerRadiusMm: 10 })
    expect(arcs(half)).toEqual([{ center: [5, 0], sweepDeg: 180 }, { center: [-5, 0], sweepDeg: 180 }])
    expect(half.segments).toHaveLength(4)
  })

  it('leaves a square rectangle to the plain outline, and has no outline for radii that do not fit', () => {
    expect(roundedOutline({ type: 'rectangle', widthMm: 30, heightMm: 20 })).toBeNull()
    expect(roundedOutline({ type: 'rectangle', widthMm: 30, heightMm: 20, frontRadiusMm: 0, backRadiusMm: 0 })).toBeNull()
    expect(roundedOutline({ type: 'rectangle', widthMm: 30, heightMm: 20, frontRadiusMm: 10.5 })).toBeNull()
    expect(roundedOutline({ type: 'rectangle', widthMm: 12, heightMm: 20, frontRadiusMm: 8, backRadiusMm: 8 })).toBeNull()
  })
})

describe('geom.extrude with rounded ends', () => {
  const tool = async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'House' })).output.design
    return { h, design }
  }

  it('makes a house with a round front as a closed solid of the outline times its height', async () => {
    const { h, design } = await tool()
    const r = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20, frontRadiusMm: 10 }, distance_mm: 6, name: 'House' })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ output: { sizeMm: number[]; volumeMm3: number; parts: { watertight?: boolean }[] } }>(r).output
    expect(out.sizeMm).toEqual([40, 20, 6])
    // the round is drawn as flat facets within 0.005 mm of it, so the solid is a hair under the true area
    const want = 6 * (800 - 2 * corner(10))
    expect(out.volumeMm3).toBeLessThan(want)
    expect(out.volumeMm3).toBeGreaterThan(want * 0.999)
  })

  it('refuses a radius past half the height, and two ends that need more than the width, by name', async () => {
    const { h, design } = await tool()
    const tall = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20, frontRadiusMm: 10.5 }, distance_mm: 6 })
    expect(tall.isError).toBe(true)
    expect(text(tall)).toContain('frontRadiusMm: between 0 and half the height')
    const long = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 12, heightMm: 20, frontRadiusMm: 8, backRadiusMm: 8 }, distance_mm: 6 })
    expect(long.isError).toBe(true)
    expect(text(long)).toContain("frontRadiusMm: together with the other end's radius, at most the width")
  })

  it('gives each radius its words, in the schema the tool lists', async () => {
    expect(CORNER_RADIUS_HELP).toBe('Rounds all four corners by this radius, in mm. Up to half the shorter side; at half, the short ends are full half circles.')
    expect(END_RADIUS_HELP).toBe("Rounds only the two corners at the rectangle's front (+x) or back (-x) end by this radius, in mm; up to half the height. A house with a round front and square back takes frontRadiusMm alone.")
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const listed = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_geom_extrude')!
    const shapes = ((listed.inputSchema.properties as Record<string, { anyOf?: unknown[]; oneOf?: unknown[] }>)['shape']!)
    const rect = ((shapes.anyOf ?? shapes.oneOf) as { properties: Record<string, { const?: string; description?: string }> }[]).find((s) => s.properties['type']?.const === 'rectangle')!
    expect(rect.properties['cornerRadiusMm']!.description).toBe(CORNER_RADIUS_HELP)
    expect(rect.properties['frontRadiusMm']!.description).toBe(END_RADIUS_HELP)
    expect(rect.properties['backRadiusMm']!.description).toBe(END_RADIUS_HELP)
  })
})

describe('a rounded end on an exact design', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    clearReplayCache()
  })

  it('reaches the kernel as real arcs, a half circle for an end of half the height', async () => {
    vi.stubEnv('SX_BREP_DEV', '1')
    const sent: { op: string; request: Record<string, unknown> }[] = []
    const cube = { positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
    const engine = async (op: string, request: unknown) => {
      sent.push({ op, request: request as Record<string, unknown> })
      if (op === 'brep.count') return { bodies: 0 }
      if (op === 'brep.tessellate') return { ...cube, faceIds: [0, 0, 0, 0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
      if (op.startsWith('brep.')) return { bodySmb: `${op.slice(5)}-new`, touches: true }
      return { mesh: cube }
    }
    const h = await connect({ geomEngine: engine })
    const made = await h.call('slicerx_design_new', { name: 'Cabin', exact: true })
    expect(made.isError, text(made)).toBeFalsy()
    const design = data<{ output: { design: string } }>(made).output.design
    const r = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 12, frontRadiusMm: 6, backRadiusMm: 2 }, placement: { center: [50, 20] }, distance_mm: 5 })
    expect(r.isError, text(r)).toBeFalsy()
    const extrude = sent.find((s) => s.op === 'brep.extrude')!
    const outer = (extrude.request['polygons'] as { outer: Chain }[])[0]!.outer
    expect(outer.segments.filter((g) => g.center)).toEqual([
      { to: [59, 26], center: [59, 20], sweepDeg: 180 },
      { to: [35, 24], center: [37, 24], sweepDeg: 90 },
      { to: [37, 14], center: [37, 16], sweepDeg: 90 },
    ])
    expect(outer.start).toEqual([59, 14])
  })
})
