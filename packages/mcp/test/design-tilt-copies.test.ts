// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's tilt asked of the step that made a part a later array of separate copies copies: the copies lean
// with it in the same edit, each about its own foot, and the edit is refused whole when a copy would run into another
// step. A merged array of the part still leans by its own rule. Engine replies are recorded in
// fixtures/design-tilt-copies.json.gz.
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
  minMm: V3
  parts: { minMm: V3; sizeMm: V3 }[]
  steps: Row[]
}

const geom = useGeomEngine('design-tilt-copies')

const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
const block = (w: number, d: number, h: number, cx: number, cy: number, z = 0, operation = 'join') => ({
  frame: top(z),
  shape: { type: 'rectangle', widthMm: w, heightMm: d },
  placement: { center: [cx, cy] },
  distance_mm: h,
  operation,
})
const row = { kind: 'linear', count: 4, step: [20, 0, 0] }
const AT = [15, 35, 55, 75]
const r1 = (n: number) => Math.round(n * 10) / 10
const DEG = Math.PI / 180
// 6 mm up a post leaning 8 degrees toward -x, its middle sits this far toward -x
const SHIFT = 6 * Math.sin(8 * DEG)
// 6 mm up the leaning post standing at 4 mm (the plate) and at 7 mm (the raised base), written out: the cut's height
// goes to the engine, and Math.cos may differ in the last bit between builds. A test checks them against Math.
const UP6_PLATE = 9.941608412449423
const UP6_BASE = 12.941608412449423
const leaning = AT.map((x) => r1(x - SHIFT))

/** A design with a plate, with `raised` a narrower base 3 mm high on it, and a post added standing on top. */
async function start(raised: boolean) {
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
  await ok('slicerx_geom_extrude', { design, ...block(90, 16, 4, 45, 0, 0, 'new') })
  if (raised) await ok('slicerx_geom_extrude', { design, part: 0, ...block(70, 10, 3, 45, 0, 4) })
  const foot = raised ? 7 : 4
  await ok('slicerx_geom_build', { design, name: 'Post', solids: [{ type: 'cylinder', origin: [15, 0, foot], axis: [0, 0, 1], diameterMm: 5, heightMm: 12 }] })
  // the x middles of what a cut across `part` at height z meets, low to high
  const middles = async (z: number, part: number) => {
    const cut = await h.call('slicerx_geom_measure', { design, section: { part, plane: { origin: [45, 0, z], normal: [0, 0, 1] } } })
    const loops = data<{ output: { section: { loops: { outer: number[][] }[] } } }>(cut).output.section.loops
    return loops.map((l) => r1((Math.min(...l.outer.map((p) => p[0]!)) + Math.max(...l.outer.map((p) => p[0]!))) / 2)).sort((a, b) => a - b)
  }
  // the middles of the post and its three copies, one cut at a time so engine calls come in the order recorded
  const row4 = async (z: number) => {
    const all: number[] = []
    for (const p of [1, 2, 3, 4]) all.push(...(await middles(z, p)))
    return all.sort((a, b) => a - b)
  }
  return { h, call, ok, design, middles, row4 }
}

describe('design.edit_step tilt of a part with separate copies', () => {
  it('cuts at the written-out heights, 6 mm up a post leaning 8 degrees', () => {
    expect(Math.abs(UP6_PLATE - (4 + 6 * Math.cos(8 * DEG)))).toBeLessThan(1e-12)
    expect(Math.abs(UP6_BASE - (7 + 6 * Math.cos(8 * DEG)))).toBeLessThan(1e-12)
  })

  it('leans the post and all four copies of a separate row on a plate', async () => {
    const t = await start(false)
    await t.ok('slicerx_geom_array', { design: t.design, part: 1, merge: false, spec: row })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: '-x', degrees: 8 } })
    expect(out.summary).toContain('it leans 8 degrees toward -x (was 0)')
    expect(out.summary).not.toContain('which made the part it copies')
    expect(out.output.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(out.output.steps[1]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
    expect(out.output.steps[2]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
    expect(await t.row4(UP6_PLATE)).toEqual(leaning)
    const steps = await t.ok('slicerx_design_steps', { design: t.design })
    expect(steps.output.steps[2]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
  })

  it('leans a separate row on a raised base, each copy about its own foot', async () => {
    const t = await start(true)
    await t.ok('slicerx_geom_array', { design: t.design, part: 1, merge: false, spec: row })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 3, tilt: { toward: '-x', degrees: 8 } })
    expect(out.output.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(out.output.steps[2]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
    expect(out.output.steps[3]).toMatchObject({ leans: { degrees: 8, toward: '-x' } })
    expect(out.output.minMm[2]).toBeCloseTo(0, 1)
    expect(await t.row4(UP6_BASE)).toEqual(leaning)
  })

  it('refuses the whole lean when one copy would run into a neighbor, changing nothing', async () => {
    const t = await start(true)
    await t.ok('slicerx_geom_array', { design: t.design, part: 1, merge: false, spec: row })
    // a wall 1 mm past the fourth copy only: the post itself, at x 15, has nothing near it
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(2, 10, 12, 79, 0, 7, 'new') })
    const { r } = await t.call('slicerx_design_edit_step', { design: t.design, step: 3, tilt: { toward: 'x', degrees: 20 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/runs it into step 5, Rectangle extrude 12 mm \(copy 4\)/)
    const steps = await t.ok('slicerx_design_steps', { design: t.design })
    expect(steps.output.steps.map((s) => s.leans)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it('leans a merged array of the post by its own rule, the array step unchanged', async () => {
    const t = await start(true)
    await t.ok('slicerx_geom_array', { design: t.design, part: 1, merge: true, spec: row })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 3, tilt: { toward: '-x', degrees: 8 } })
    expect(out.summary).toContain('it leans 8 degrees toward -x (was 0)')
    expect(out.output.steps[2]).toMatchObject({ state: 'done', leans: { degrees: 8, toward: '-x' } })
    expect(out.output.steps[3]!.leans).toBeUndefined()
    expect(await t.middles(UP6_BASE, 1)).toEqual(leaning)
  })
})
