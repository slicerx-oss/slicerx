// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's tilt asked of an array or a pattern step: a pattern leans the steps it repeats, a merged array the
// step that made the part it copies, and separate copies lean with the part they copy, each copy about its own foot. A
// copy a merged array makes is checked against the other steps too, and a pattern of steps that cannot lean is refused
// by name. Engine replies are recorded in fixtures/design-tilt-array.json.gz.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Row {
  state: string
  leans?: { degrees: number; toward: string }
}
interface Summary {
  design: string
  sizeMm: V3
  minMm: V3
  parts: { minMm: V3; sizeMm: V3 }[]
  steps: Row[]
}

const geom = useGeomEngine('design-tilt-array')

async function start() {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args)
    return { r, out: data<{ ok?: boolean; summary: string; output: Summary }>(r) }
  }
  const ok = async (name: string, args: Record<string, unknown>) => {
    const { r, out } = await call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    expect(out.ok, `${name}: ${text(r)}`).not.toBe(false)
    return out
  }
  const design = (await ok('slicerx_design_new', { name: 'Row' })).output.design
  // a wide lower block and a narrower base raised 3 mm on it, which the posts stand on
  await ok('slicerx_geom_extrude', { design, ...block(90, 16, 4, 45, 0, 0, 'new') })
  await ok('slicerx_geom_extrude', { design, part: 0, ...block(70, 10, 3, 45, 0, 4) })
  // the x middles of what a cut across `part` at height z meets, low to high
  const middles = async (z: number, part?: number) => {
    const cut = await h.call('slicerx_geom_measure', { design, section: { ...(part === undefined ? {} : { part }), plane: { origin: [45, 0, z], normal: [0, 0, 1] } } })
    const loops = data<{ output: { section: { loops: { outer: number[][] }[] } } }>(cut).output.section.loops
    return loops.map((l) => r1((Math.min(...l.outer.map((p) => p[0]!)) + Math.max(...l.outer.map((p) => p[0]!))) / 2)).sort((a, b) => a - b)
  }
  return { h, call, ok, design, middles }
}

const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
const block = (w: number, d: number, h: number, cx: number, cy: number, z = 0, operation = 'join') => ({
  frame: top(z),
  shape: { type: 'rectangle', widthMm: w, heightMm: d },
  placement: { center: [cx, cy] },
  distance_mm: h,
  operation,
})
const post = { frame: top(7), shape: { type: 'circle', diameterMm: 5 }, placement: { center: [15, 0] }, distance_mm: 12, operation: 'join' }
const row = { kind: 'linear', count: 4, step: [20, 0, 0] }
const AT = [15, 35, 55, 75]
const r1 = (n: number) => Math.round(n * 10) / 10
const DEG = Math.PI / 180
// 6 mm up a post leaning 8 degrees toward -x, its middle sits this far toward -x
const SHIFT = 6 * Math.sin(8 * DEG)
// 6 mm up the leaning post, 7 + 6 cos 8, written out: the cut's height goes to the engine, and Math.cos may differ in
// the last bit from one platform's build to another's, which changes the recorded request. A test checks it against Math.
const UP6 = 12.941608412449423
const leaning = AT.map((x) => r1(x - SHIFT))

describe('design.edit_step tilt of an array or a pattern', () => {
  it('cuts at the written-out height, 6 mm up a post leaning 8 degrees', () => {
    expect(Math.abs(UP6 - (7 + 6 * Math.cos(8 * DEG)))).toBeLessThan(1e-12)
  })

  it('leans the post a pattern repeats, each copy about its own foot, past the lower block', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, part: 0, ...post })
    await t.ok('slicerx_geom_array', { design: t.design, part: 0, merge: true, steps: [3], spec: row })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 4, tilt: { toward: '-x', degrees: 8 } })
    expect(out.summary).toContain('step 3, Circle extrude 12 mm, which it repeats, leans 8 degrees toward -x (was 0)')
    expect(out.output.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(out.output.steps[2]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
    expect(out.output.steps[3]!.leans).toBeUndefined()
    expect(out.output.minMm[2]).toBeCloseTo(0, 1)
    expect(await t.middles(UP6)).toEqual(leaning)
  })

  it('leans the added post a merged array copies, and every copy with it', async () => {
    const t = await start()
    await t.ok('slicerx_geom_build', { design: t.design, name: 'Post', solids: [{ type: 'cylinder', origin: [15, 0, 7], axis: [0, 0, 1], diameterMm: 5, heightMm: 12 }] })
    await t.ok('slicerx_geom_array', { design: t.design, part: 1, merge: true, spec: row })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 4, tilt: { toward: '-x', degrees: 8 } })
    expect(out.summary).toContain('step 3, Add Post, which made the part it copies, leans 8 degrees toward -x (was 0)')
    expect(out.output.steps[2]).toMatchObject({ state: 'done', leans: { degrees: 8, toward: '-x' } })
    expect(out.output.steps[3]).toMatchObject({ state: 'done' })
    expect(await t.middles(UP6, 1)).toEqual(leaning)
  })

  it('leans separate copies and the part they copy together', async () => {
    const t = await start()
    await t.ok('slicerx_geom_build', { design: t.design, name: 'Post', solids: [{ type: 'cylinder', origin: [15, 0, 7], axis: [0, 0, 1], diameterMm: 5, heightMm: 12 }] })
    await t.ok('slicerx_geom_array', { design: t.design, part: 1, merge: false, spec: row })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 4, tilt: { toward: '-x', degrees: 8 } })
    expect(out.summary).toContain('it leans 8 degrees toward -x (was 0), step 3, Add Post, which made the part it copies, leans 8 degrees toward -x (was 0)')
    expect(out.output.steps[2]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
    expect(out.output.steps[3]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
    // one cut at a time, so the engine calls come in the order they were recorded
    const all: number[] = []
    for (const p of [1, 2, 3, 4]) all.push(...(await t.middles(UP6, p)))
    expect(all.sort((a, b) => a - b)).toEqual(leaning)
  })

  it('refuses a lean whose merged array copy runs into another step, naming it', async () => {
    const t = await start()
    await t.ok('slicerx_geom_build', { design: t.design, name: 'Post', solids: [{ type: 'cylinder', origin: [15, 0, 7], axis: [0, 0, 1], diameterMm: 5, heightMm: 12 }] })
    await t.ok('slicerx_geom_array', { design: t.design, part: 1, merge: true, spec: row })
    // a wall 1 mm past the fourth copy only: the post itself, at x 15, has nothing near it
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(2, 10, 12, 79, 0, 7, 'new') })
    const { r } = await t.call('slicerx_design_edit_step', { design: t.design, step: 4, tilt: { toward: 'x', degrees: 20 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/runs it into step 5, Rectangle extrude 12 mm \(copy 4\)/)
    const steps = await t.ok('slicerx_design_steps', { design: t.design })
    expect(steps.output.steps[2]!.leans).toBeUndefined()
  })

  it('refuses a pattern of steps that cannot lean, by name', async () => {
    const t = await start()
    await t.ok('slicerx_geom_subtract', { design: t.design, part: 0, label: 'Slot', solids: [{ type: 'box', min: [14, -1, 5], max: [16, 1, 8] }] })
    await t.ok('slicerx_geom_array', { design: t.design, part: 0, merge: true, steps: [3], spec: row })
    const { r } = await t.call('slicerx_design_edit_step', { design: t.design, step: 4, tilt: { toward: '-x', degrees: 8 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('tilt: none of the steps this pattern repeats can lean')
  })
})
