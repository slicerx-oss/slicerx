// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint by feature on the real engine: a body built from many joined steps takes a color on the faces one plan
// feature's steps made, and every other face keeps its own. A pole joined on a tower, a row of holes cut in a box
// (the cut's walls are the cut feature's), and a boss mirrored to the other side, on exact solids and on the mesh. A
// feature the design has none of is refused with the names it has.
//
// One gap is pinned here as it is: on exact solids a join clears the key of a face the joined shape sits flat on (the
// tower's top around the pole's foot) and of faces a mirror image lands flush with, so no feature paints those. A part
// built as a mesh is refused: a body a new extrude, revolve, loft or sweep makes there keeps no face keys.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GEOM_BUILD, boxStl, built, connect, data, noKernel, text } from './helpers'
import { featureNotExactText, meshedOf } from '../src/paint-target'

const bin = process.env['SLICERX_SX_GEOM_BIN']
const mesh = built(bin, GEOM_BUILD)
const why = noKernel(bin)
afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
})

type V3 = [number, number, number]
interface Region {
  areaMm2: number
  boundsMm: { min: V3; max: V3 }
}
interface Regions {
  parts: { part: number; states: { state: number; areaMm2: number; regionCount: number; regions: Region[] }[] }[]
}

async function client() {
  const h = await connect({ geomEngine: geomEngine(bin!, 30_000) })
  const call = (name: string, args: Record<string, unknown>) => h.call(`slicerx_${name}`, args)
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  /** Paints `feature` in `state` through a preview and its apply. */
  const paint = async (design: string, feature: string, state: number) => {
    const pv = await ok<{ preview: string; areaMm2: number }>('paint_preview', { design, state, target: { kind: 'feature', feature } })
    await ok('paint_apply', { preview: pv.preview })
    return pv.areaMm2
  }
  /** The color paint of state `state` on part 0. */
  const painted = async (design: string, state: number) => (await ok<Regions>('paint_regions', { design })).parts[0]!.states.find((s) => s.state === state)
  /** A mesh design from a box model x by y by z mm, its corner at the origin. */
  const model = async (name: string, x: number, y: number, z: number) => {
    const from = join(h.dir, `${name}.stl`)
    writeFileSync(from, boxStl(x, y, z))
    return (await ok<{ design: string }>('design_new', { name, from })).design
  }
  return { call, ok, paint, painted, model }
}

type Client = Awaited<ReturnType<typeof client>>

// a 20 x 20 x 30 tower with a 6 mm pole 15 mm tall joined on its top, centered at (cx, cy)
const pole = (d: string, cx: number, cy: number) => ({ design: d, part: 0, shape: { type: 'circle', diameterMm: 6 }, frame: { origin: [cx, cy, 30], normal: [0, 0, 1] }, distance_mm: 15, operation: 'join', feature: 'Pole' })
// the pole's side and top, as facets a little under pi * 6 * 15 + 9 pi
const POLE_MAX = Math.PI * 6 * 15 + 9 * Math.PI
// a 2 x 2 hole 3 mm deep in the side at y y0 starting at x x0, then a row of four 8 mm apart of step `at`
const hole = (d: string, x0: number, y0: number) => ({ design: d, part: 0, shape: { type: 'rectangle', widthMm: 2, heightMm: 2 }, frame: { origin: [x0, y0, 5], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, distance_mm: 3, operation: 'cut', feature: 'Holes' })
const holeRow = (d: string, at: number) => ({ design: d, steps: [at], spec: { kind: 'linear', count: 4, step: [8, 0, 0] }, feature: 'Hole row' })
// each hole's four walls and its floor
const HOLE_MM2 = 4 * 2 * 3 + 2 * 2
// a 4 x 4 boss 2 mm tall on the top of a 10 mm block, at x bx
const boss = (d: string, bx: number, by: number) => ({ design: d, part: 0, shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, frame: { origin: [bx, by, 10], normal: [0, 0, 1] }, distance_mm: 2, operation: 'join', feature: 'Boss' })

async function poleOnly(c: Client, d: string) {
  const area = await c.paint(d, 'pole', 2)
  expect(area).toBeGreaterThan(POLE_MAX * 0.97)
  expect(area).toBeLessThan(POLE_MAX)
  const two = (await c.painted(d, 2))!
  expect(two.regionCount).toBe(1)
  expect(two.regions[0]!.boundsMm.min[2]).toBeGreaterThan(29.99)
  return area
}

async function holeWalls(c: Client, d: string, y0: number) {
  expect(await c.paint(d, 'Holes', 2)).toBeCloseTo(4 * HOLE_MM2, 1)
  const two = (await c.painted(d, 2))!
  expect(two.regionCount).toBe(4)
  for (const r of two.regions) {
    expect(r.boundsMm.min[1]).toBeGreaterThan(y0 - 0.01)
    expect(r.boundsMm.max[1]).toBeLessThan(y0 + 3.01)
  }
  // the row's own name paints the same faces: its first copy is the hole it repeats
  const row = await c.ok<{ areaMm2: number }>('paint_preview', { design: d, state: 3, target: { kind: 'feature', feature: 'Hole row' } })
  expect(row.areaMm2).toBeCloseTo(4 * HOLE_MM2, 1)
}

describe('paint by feature on exact solids', () => {
  const skip = why !== null
  const because = skip ? ` (skipped: ${why})` : ''
  const start = async (c: Client, name: string) => {
    vi.stubEnv('SX_BREP_DEV', '1')
    const d = await c.ok<{ design: string; exact: boolean }>('design_new', { name, exact: true })
    expect(d.exact).toBe(true)
    return d.design
  }
  const tower = async (c: Client) => {
    const d = await start(c, 'Tower')
    await c.ok('geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, distance_mm: 30, feature: 'Tower' })
    await c.ok('geom_extrude', pole(d, 0, 0))
    return d
  }

  it.skipIf(skip)(`a joined pole takes its own color by feature, and the tower under it keeps its own${because}`, async () => {
    const c = await client()
    const d = await tower(c)
    const area = await poleOnly(c, d)
    // the tower: its four sides and its bottom. Its top around the pole's foot lost its key to the join, so it stays bare
    expect(await c.paint(d, 'Tower', 3)).toBeCloseTo(4 * 600 + 400, 1)
    expect((await c.painted(d, 3))!.regions.every((r) => r.boundsMm.max[2] < 30.01)).toBe(true)
    expect((await c.painted(d, 2))!.areaMm2).toBeCloseTo(area, 1)
  })

  it.skipIf(skip)(`the walls of a row of cut holes paint by the cut feature, the box around them its own${because}`, async () => {
    const c = await client()
    const d = await start(c, 'Box')
    await c.ok('geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 10, feature: 'Box' })
    await c.ok('geom_extrude', hole(d, -12, -10))
    await c.ok('geom_array', holeRow(d, 2))
    await holeWalls(c, d, -10)
    // the box keeps its faces, the side the holes go through included: all of it but the holes
    expect(await c.paint(d, 'Box', 4)).toBeCloseTo(2 * (40 * 20 + 40 * 10 + 20 * 10) - 4 * 4, 1)
    expect((await c.painted(d, 2))!.areaMm2).toBeCloseTo(4 * HOLE_MM2, 1)
  })

  it.skipIf(skip)(`a mirrored feature is painted on both sides, but for the faces the mirror image lands flush with${because}`, async () => {
    const c = await client()
    const d = await start(c, 'Block')
    await c.ok('geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 10, feature: 'Block' })
    await c.ok('geom_extrude', boss(d, -10, 0))
    await c.ok('geom_mirror', { design: d, plane: { axis: 'x', at: 0 }, steps: [2] })
    // the two bosses' tops and their sides toward y lie flush with the image's, and the join clears their keys: the
    // sides toward x and away from it, 4 x 2 mm each, are what is left on each boss
    expect(await c.paint(d, 'Boss', 2)).toBeCloseTo(2 * 2 * 8, 1)
    const two = (await c.painted(d, 2))!
    expect(new Set(two.regions.map((r) => Math.sign(r.boundsMm.min[0])))).toEqual(new Set([-1, 1]))
  })

  it.skipIf(skip)(`refuses a feature the design has none of, with the names it has${because}`, async () => {
    const c = await client()
    const d = await tower(c)
    const r = await c.call('paint_preview', { design: d, state: 2, target: { kind: 'feature', feature: 'Chimney' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('target: Chimney is not a planned feature; name one the plan has (Tower, Pole)')
  })
})

describe('paint by feature on the mesh', () => {
  const skip = !mesh
  const because = skip ? ` (skipped: ${GEOM_BUILD})` : ''
  // a part built as a mesh keeps no record of which step made each face across a new body, so a feature target is
  // refused there with the ways that still work, and paints nothing

  it.skipIf(skip)(`refuses a feature on a design built from a model, a mesh, and paints nothing${because}`, async () => {
    const c = await client()
    const d = await c.model('Tower', 20, 20, 30)
    await c.ok('geom_extrude', pole(d, 10, 10))
    const r = await c.call('paint_preview', { design: d, state: 2, target: { kind: 'feature', feature: 'Pole' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(featureNotExactText(0))
    expect((await c.ok<Regions>('paint_regions', { design: d })).parts[0]?.states ?? []).toEqual([])
  })

  it.skipIf(skip)(`refuses a feature on a design that is not exact, where a new extrude starts the body${because}`, async () => {
    const c = await client()
    const d = (await c.ok<{ design: string }>('design_new', { name: 'Tower' })).design
    await c.ok('geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, distance_mm: 30, feature: 'Tower' })
    await c.ok('geom_extrude', pole(d, 0, 0))
    for (const feature of ['Pole', 'Tower']) {
      const r = await c.call('paint_preview', { design: d, state: 2, target: { kind: 'feature', feature } })
      expect(text(r)).toContain(featureNotExactText(0))
    }
    // the other targets still paint it
    expect(await c.ok<{ areaMm2: number }>('paint_preview', { design: d, state: 2, target: { kind: 'height', above: 30 } })).toMatchObject({ areaMm2: expect.any(Number) })
  })
})

describe('the refusal of a feature on a part built as a mesh', () => {
  it('says it word for word, and finds the first targeted part built as a mesh', () => {
    expect(featureNotExactText(2)).toBe('target: painting by feature needs a part built as an exact solid, and part 2 is not one; paint it by height, by direction or from a seed point instead')
    expect(meshedOf([0, 1, 2], [2, 1])).toBe(1)
    expect(meshedOf([0], [1])).toBeUndefined()
    expect(meshedOf([0, 1], [])).toBeUndefined()
  })
})
