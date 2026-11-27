// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's tilt leans what a revolve or a sweep made about its foot, in place, as it does an extrude: a
// lamp's upright post turned or swept up from its base leans as the same step, and stands up again at 0. A revolve
// about an axis lying over has no foot and is refused. Engine replies are recorded in fixtures/design-tilt-revolve.json.gz.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  sizeMm: V3
  minMm: V3
  steps: { state: string; leans?: { degrees: number; toward: string } }[]
}

const geom = useGeomEngine('design-tilt-revolve')

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
  const design = (await ok('slicerx_design_new', { name: 'Lamp' })).output.design
  // the lamp's base, 40 by 40 and 5 tall
  await ok('slicerx_geom_extrude', { design, frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 40, heightMm: 40 }, placement: { center: [20, 20] }, distance_mm: 5, operation: 'new' })
  return { h, call, ok, design }
}

// an upright plane through (36, 20), its v straight up from the base's top
const upright = { origin: [36, 20, 5], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }
// a post 4 mm across and 20 mm tall, as the half outline a revolve turns about its axis
const half = [{ points: [[0, 0], [2, 0], [2, 20], [0, 20]] }]
const r1 = (n: number) => Math.round(n * 10) / 10
const DEG = Math.PI / 180
// the post's far side at 20 degrees toward x: its foot at x 36, 20 mm up, 2 mm out
const REACH = 36 + 20 * Math.sin(20 * DEG) + 2 * Math.cos(20 * DEG)

describe('design.edit_step tilt on a revolve or a sweep', () => {
  it('leans a revolved post about its foot as the same step, and stands it up again at 0', async () => {
    const t = await start()
    await t.ok('slicerx_geom_revolve', { design: t.design, part: 0, frame: upright, loops: half, axis: { point: [0, 0], direction: [0, 1] }, angle_deg: 360, operation: 'join' })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 20 } })
    expect(out.summary).toContain('it leans 20 degrees toward x (was 0)')
    expect(out.output.steps).toHaveLength(2)
    expect(out.output.steps[1]).toMatchObject({ state: 'done', leans: { degrees: 20, toward: 'x' } })
    expect(r1(out.output.minMm[0] + out.output.sizeMm[0])).toBeCloseTo(r1(REACH), 0)
    const back = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 0 } })
    expect(back.output.steps[1]!.leans).toBeUndefined()
    expect(back.output.sizeMm[0]).toBeCloseTo(40, 1)
  })

  it('leans a swept post about the low end of its path', async () => {
    const t = await start()
    const profile = { frame: { origin: [36, 20, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [{ type: 'circle', center: [0, 0], diameterMm: 4 }] }
    await t.ok('slicerx_geom_sweep', { design: t.design, part: 0, profile, path: { points: [[36, 20, 5], [36, 20, 25]] }, operation: 'join' })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 20 } })
    expect(out.output.steps[1]).toMatchObject({ state: 'done', leans: { degrees: 20, toward: 'x' } })
    expect(r1(out.output.minMm[0] + out.output.sizeMm[0])).toBeCloseTo(r1(REACH), 0)
    // its foot stays on the base: nothing dips under the bed
    expect(out.output.minMm[2]).toBeCloseTo(0, 1)
  })

  it('refuses a revolve whose axis lies over, and keeps the step as it was', async () => {
    const t = await start()
    // a ring lying on the base, turned about an axis along x
    await t.ok('slicerx_geom_revolve', { design: t.design, part: 0, frame: upright, loops: [{ points: [[-6, 1], [6, 1], [6, 3], [-6, 3]] }], axis: { point: [0, 0], direction: [1, 0] }, angle_deg: 180, operation: 'join' })
    const { r } = await t.call('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'y', degrees: 10 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/this revolve turns about an axis lying over, so it has no foot to lean about/)
    const steps = await t.ok('slicerx_design_steps', { design: t.design })
    expect(steps.output.steps[1]!.leans).toBeUndefined()
  })
})
