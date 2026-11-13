// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A rail as a client adds one: round posts spread along a line and a flat top bar on them, in one call. All round the
// top of a tray as a part of its own, along one side joined to it, and refused in words when it would not print or
// the line is not one. Checked by the reply's rail facts, the steps it adds, and the parts' sizes.
import { describe, expect, it } from 'vitest'
import { RAIL_UNDO_NOTE } from '../src/modeling-tools'
import { insetOutline, railLayout } from '../src/rail'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Rail {
  part: number
  posts: number
  cornerPosts: number
  spacingMm: number
  lengthMm: number
  closed: boolean
  heightMm: number
  postMm: number
  barMm: number
  barHeightMm: number
}
interface Summary {
  design: string
  steps: number
  sizeMm: V3
  minMm: V3
  volumeMm3: number
  parts: { name: string; sizeMm: V3; minMm: V3; volumeMm3: number }[]
  rail?: Rail
}

const geom = useGeomEngine('rail-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

async function tray() {
  const h = await connect({ geomEngine: engine })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  const d = (await ok('slicerx_design_new', { name: 'Tray' })).design
  // a tray 40 x 20 mm and 5 mm tall, its top at z 5
  await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 5 })
  const steps = async () => data<{ output: { steps: { name: string; op: string; state: string }[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
  return { h, ok, d, steps }
}

describe('laying out a rail', () => {
  it('spreads posts evenly along an open line, one at each end, and centers the bar on it', () => {
    const lay = railLayout([[0, 0], [10, 0]], false, { spacingMm: 3, barMm: 0.8 })
    if (typeof lay === 'string') throw new Error(lay)
    expect(lay.posts).toEqual([[0, 0], [2.5, 0], [5, 0], [7.5, 0], [10, 0]])
    expect(lay.spacingMm).toBe(2.5)
    expect(lay.cornerPosts).toBe(2)
    expect(lay.bar).toEqual([{ points: [[0, 0.4], [10, 0.4], [10, -0.4], [0, -0.4]] }])
    // with a cap the bar reaches past the end posts
    const capped = railLayout([[0, 0], [10, 0]], false, { spacingMm: 3, barMm: 0.8, capMm: 0.4 })
    if (typeof capped === 'string') throw new Error(capped)
    expect(capped.bar).toEqual([{ points: [[-0.4, 0.4], [10.4, 0.4], [10.4, -0.4], [-0.4, -0.4]] }])
  })

  it('goes all round a closed outline, with the bar as a ring, and moves an outline in by an inset', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const lay = railLayout(square, true, { spacingMm: 3, barMm: 1 })
    if (typeof lay === 'string') throw new Error(lay)
    expect(lay.lengthMm).toBe(40)
    // a post on each corner, and 3 more along each 10 mm side, 2.5 mm apart
    expect(lay.cornerPosts).toBe(4)
    expect(lay.posts).toHaveLength(16)
    expect(lay.spacingMm).toBe(2.5)
    for (const c of square) expect(lay.posts).toContainEqual(c)
    expect(lay.bar).toHaveLength(2)
    expect(insetOutline(square, 1)).toEqual([[1, 1], [9, 1], [9, 9], [1, 9]])
    // the same inward, whichever way the outline runs
    expect(insetOutline([...square].reverse(), 1)).toEqual([[1, 9], [9, 9], [9, 1], [1, 1]])
  })

  it('puts a post on every sharp corner of an open line and spreads the rest between, but not on a gentle turn', () => {
    // a V: 5 mm up to a corner, 5 mm down; then a line bent only 10 degrees, which is no corner
    const v = railLayout([[0, 0], [3, 4], [6, 0]], false, { spacingMm: 2, barMm: 0.8 })
    if (typeof v === 'string') throw new Error(v)
    expect(v.cornerPosts).toBe(3)
    expect(v.posts).toContainEqual([3, 4])
    expect(v.posts).toHaveLength(7)
    const bent = railLayout([[0, 0], [10, 0], [19.8481, 1.7365]], false, { spacingMm: 25, barMm: 0.8 })
    if (typeof bent === 'string') throw new Error(bent)
    expect(bent.cornerPosts).toBe(2)
    expect(bent.posts).toHaveLength(2)
  })

  it('says why a line is no line', () => {
    expect(railLayout([[0, 0], [0, 0]], false, { spacingMm: 3, barMm: 0.8 })).toBe('A path needs 2 or more different points.')
    expect(railLayout([[0, 0], [1, 0]], true, { spacingMm: 3, barMm: 0.8 })).toBe('A closed path needs 3 or more different points.')
  })
})

describe('a rail on a design', () => {
  it('runs all round the top of a tray as a part of its own, posts and bar at a printable size', async () => {
    const { ok, d, steps } = await tray()
    const r = await ok('slicerx_geom_rail', { design: d, face: { point: [0, 0, 5] }, height_mm: 3, name: 'Railing', slot: 2 })
    const rail = r.rail!
    // posts twice the 0.4 mm nozzle, the bar 0.2 mm wider to cap them; its outside on the tray's edge, so its middle
    // runs 0.5 mm in, all round a 39 x 19 outline
    expect(rail).toMatchObject({ part: 1, closed: true, heightMm: 3, postMm: 0.8, barMm: 1, barHeightMm: 0.8 })
    expect(rail.lengthMm).toBeCloseTo(2 * (39 + 19), 3)
    // a post on each of the 4 corners, 12 more along each 39 mm side and 6 along each 19 mm end
    expect(rail).toMatchObject({ posts: 40, cornerPosts: 4, spacingMm: 3 })
    expect(r.parts.map((p) => p.name)).toEqual(['Body', 'Railing'])
    const railing = r.parts[1]!
    // as wide as the tray, standing on its top (sunk 0.05 mm) and 3 mm tall
    expect(railing.sizeMm[0]).toBeCloseTo(40, 1)
    expect(railing.sizeMm[1]).toBeCloseTo(20, 1)
    expect(railing.minMm[2]).toBeCloseTo(4.95, 3)
    expect(railing.sizeMm[2]).toBeCloseTo(3.05, 3)
    // an open rail, not a wall: much less than a ring 0.8 mm thick and 3 mm tall would be
    expect(railing.volumeMm3).toBeLessThan(1 * 3 * rail.lengthMm * 0.5)
    expect((await steps()).slice(1).map((s) => [s.name, s.state])).toEqual([[`Rail posts, ${rail.posts}`, 'done'], ['Rail bar', 'done']])
  }, 60_000)

  it('runs along one side joined to the tray', async () => {
    const { h, d } = await tray()
    const res = await h.call('slicerx_geom_rail', { design: d, path: { frame: { origin: [0, 0, 5], normal: [0, 0, 1] }, points: [[-18, -9], [18, -9]] }, height_mm: 2, part: 0, join: true })
    expect(res.isError, text(res)).toBeFalsy()
    const r = data<{ output: Summary }>(res).output
    // the reply says one undo takes both steps, and how to change one
    expect(text(res)).toContain(`Railed: steps 2 and 3, 13 posts (2 on corners) at most 3 mm apart along 36 mm, 2 mm tall, joined to Body; ${RAIL_UNDO_NOTE}`)
    expect(r.rail).toMatchObject({ part: 0, closed: false, posts: 13, cornerPosts: 2, spacingMm: 3, lengthMm: 36 })
    expect(r.parts).toHaveLength(1)
    expect(r.sizeMm[2]).toBeCloseTo(7, 3)
    expect(r.volumeMm3).toBeGreaterThan(40 * 20 * 5)
  }, 60_000)

  it('refuses in words a rail too thin to print, or with no line', async () => {
    const { h, d, steps } = await tray()
    const thin = await h.call('slicerx_geom_rail', { design: d, face: { point: [0, 0, 5] }, height_mm: 3, post_mm: 0.3 })
    expect(thin.isError).toBe(true)
    expect(text(thin)).toMatch(/post_mm: 0.3 mm is thinner than a 0.4 mm nozzle prints; give at least 0.8 mm/)
    const both = await h.call('slicerx_geom_rail', { design: d, face: { point: [0, 0, 5] }, path: { points: [[0, 0], [5, 0]] }, height_mm: 3 })
    expect(text(both)).toMatch(/give path or face, not both/)
    const flush = await h.call('slicerx_geom_rail', { design: d, face: { point: [0, 0, 5] }, height_mm: 3, bar_mm: 0.8 })
    expect(text(flush)).toMatch(/bar_mm: the bar caps the posts, so it is at least 0.1 mm wider than they are; give at least 0.9 mm/)
    const low = await h.call('slicerx_geom_rail', { design: d, face: { point: [0, 0, 5] }, height_mm: 0.5 })
    expect(text(low)).toMatch(/give a height above the bar's thickness/)
    expect(await steps()).toHaveLength(1)
  }, 60_000)
})
