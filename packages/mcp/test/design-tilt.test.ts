// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's tilt leans what an extrude or a loft made about its foot, in place: the timeline keeps one step,
// a pattern made of it leans with it, a later size edit keeps the lean, steps after it (a cut) still go through, and
// a saved project reads the lean back. A lean into another step's shape, by the step or by a copy a pattern made of
// it, is refused with that step by name. Engine
// replies are recorded in fixtures/design-tilt.json.gz.
import { describe, expect, it } from 'vitest'
import { historyFiles, parseHistories, type History } from '@slicerx/cad-history'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Row {
  state: string
  name: string
  leans?: { degrees: number; toward: string }
}
interface Summary {
  design: string
  sizeMm: V3
  minMm: V3
  parts: { minMm: V3; sizeMm: V3 }[]
  steps: Row[]
}

const geom = useGeomEngine('design-tilt')

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
  const design = (await ok('slicerx_design_new', { name: 'Stand' })).output.design
  return { h, call, ok, design }
}

const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
const block = (w: number, d: number, h: number, cx: number, cy: number, z = 0, operation = 'join') => ({
  frame: top(z),
  shape: { type: 'rectangle', widthMm: w, heightMm: d },
  placement: { center: [cx, cy] },
  distance_mm: h,
  operation,
})
const post = (dia: number, h: number, cx: number, cy: number, z: number) => ({ frame: top(z), shape: { type: 'circle', diameterMm: dia }, placement: { center: [cx, cy] }, distance_mm: h, operation: 'join' })
const r1 = (n: number) => Math.round(n * 10) / 10
// a twelve-sided section about (cx, 0), r across its corners
const gon = (cx: number, r: number) => Array.from({ length: 12 }, (_, k) => [cx + r * Math.cos((k * Math.PI) / 6), r * Math.sin((k * Math.PI) / 6)])
const DEG = Math.PI / 180

describe('design.edit_step tilt', () => {
  it('leans an extrude about its foot as the same step, and stands it up again at 0', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(40, 40, 5, 20, 20, 0, 'new') })
    await t.ok('slicerx_geom_extrude', { design: t.design, part: 0, ...post(4, 20, 36, 20, 5) })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 20 } })
    expect(out.summary).toContain('it leans 20 degrees toward x (was 0)')
    expect(out.output.steps).toHaveLength(2)
    expect(out.output.steps[1]).toMatchObject({ state: 'done', leans: { degrees: 20, toward: 'x' } })
    // the top of the post reaches past the block's edge at x 40: its foot at x 36, 20 mm up at 20 degrees
    const reach = 36 + 20 * Math.sin(20 * DEG) + 2 * Math.cos(20 * DEG)
    expect(r1(out.output.minMm[0] + out.output.sizeMm[0])).toBeCloseTo(r1(reach), 0)
    const back = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 0 } })
    expect(back.output.steps[1]!.leans).toBeUndefined()
    expect(back.output.sizeMm[0]).toBeCloseTo(40, 1)
  })

  it('leans a lofted body and the copies a pattern made of it', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(100, 12, 4, 50, 0, 0, 'new') })
    const ring = (z: number, r: number) => ({ frame: top(z), loops: [{ points: gon(15, r) }] })
    await t.ok('slicerx_geom_loft', { design: t.design, part: 0, operation: 'join', profiles: [ring(4, 3), ring(10, 2.8), ring(16, 2.6)] })
    await t.ok('slicerx_geom_array', { design: t.design, part: 0, merge: true, steps: [2], spec: { kind: 'linear', count: 3, step: [30, 0, 0] } })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'y', degrees: 20 } })
    expect(out.output.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    // cut across at 10 mm up, 6 mm above the foot: each of the three rings sits 6 tan 20 toward y
    const cut = await t.h.call('slicerx_geom_measure', { design: t.design, part: 0, section: { plane: { origin: [50, 0, 10], normal: [0, 0, 1] } } })
    const loops = data<{ output: { section: { loops: { outer: number[][] }[] } } }>(cut).output.section.loops
    const middles = loops.map((l) => (Math.min(...l.outer.map((p) => p[1]!)) + Math.max(...l.outer.map((p) => p[1]!))) / 2)
    expect(middles).toHaveLength(3)
    for (const y of middles) expect(y).toBeCloseTo(6 * Math.tan(20 * DEG), 0)
  })

  it('keeps the lean through a later size edit of the same step', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(40, 40, 5, 20, 20, 0, 'new') })
    await t.ok('slicerx_geom_extrude', { design: t.design, part: 0, ...post(4, 20, 36, 20, 5) })
    await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 20 } })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, size: { axis: 'z', mm: 30 } })
    expect(out.output.steps[1]).toMatchObject({ state: 'done', leans: { degrees: 20, toward: 'x' } })
    const reach = 36 + 30 * Math.sin(20 * DEG) + 2 * Math.cos(20 * DEG)
    expect(r1(out.output.minMm[0] + out.output.sizeMm[0])).toBeCloseTo(r1(reach), 0)
  })

  it('leans a step that a later cut works on, and the cut still goes through', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(40, 40, 5, 20, 20, 0, 'new') })
    await t.ok('slicerx_geom_extrude', { design: t.design, part: 0, ...post(6, 20, 20, 20, 5) })
    await t.ok('slicerx_geom_cut', { design: t.design, part: 0, plane: { axis: 'z', at: 15 }, keep: 'both' })
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: '-y', degrees: 10 } })
    expect(out.output.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(out.output.parts).toHaveLength(2)
    expect(out.output.steps[1]).toMatchObject({ leans: { degrees: 10, toward: '-y' } })
  })

  it('refuses a lean that runs into another step, naming it, and keeps the step as it was', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(40, 40, 5, 20, 20, 0, 'new') })
    await t.ok('slicerx_geom_extrude', { design: t.design, part: 0, ...post(3, 20, 26, 20, 5) })
    await t.ok('slicerx_geom_extrude', { design: t.design, part: 0, ...block(2, 30, 20, 31, 20, 5) })
    const { r } = await t.call('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 30 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/runs it into step 3, Rectangle extrude 20 mm/)
    const steps = await t.ok('slicerx_design_steps', { design: t.design })
    expect(steps.output.steps[1]!.leans).toBeUndefined()
  })

  it('refuses a lean whose pattern copy runs into another step, naming it', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(100, 12, 4, 50, 0, 0, 'new') })
    const ring = (z: number, r: number) => ({ frame: top(z), loops: [{ points: gon(10, r) }] })
    await t.ok('slicerx_geom_loft', { design: t.design, part: 0, operation: 'join', profiles: [ring(4, 3), ring(10, 2.8), ring(16, 2.6)] })
    await t.ok('slicerx_geom_array', { design: t.design, part: 0, merge: true, steps: [2], spec: { kind: 'linear', count: 3, step: [30, 0, 0] } })
    // a wall 1 mm past the third copy only: the step itself, at x 10, has nothing near it
    await t.ok('slicerx_geom_extrude', { design: t.design, part: 0, ...block(2, 12, 16, 75, 0, 4) })
    const { r } = await t.call('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 25 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/runs it into step 4, Rectangle extrude 16 mm/)
    // the other way the copies lean away from the wall, and the lean is kept
    const out = await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: '-x', degrees: 25 } })
    expect(out.output.steps[1]).toMatchObject({ leans: { degrees: 25, toward: '-x' } })
  })

  it('leans only what an extrude or a loft made', async () => {
    const t = await start()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...block(20, 20, 10, 10, 10, 0, 'new') })
    await t.ok('slicerx_geom_cut', { design: t.design, part: 0, plane: { axis: 'z', at: 5 }, keep: 'both' })
    const { r } = await t.call('slicerx_design_edit_step', { design: t.design, step: 2, tilt: { toward: 'x', degrees: 10 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('only what an extrude or a loft made leans')
  })
})

describe('a saved lean', () => {
  it('reads back from a saved project, and a damaged one reads as none', () => {
    const tilt = { degrees: 12, up: [0, 0, 1], toward: [1, 0, 0] }
    const step = { id: 's1', part: 0, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], params: { op: 'shape.extrude', shape: { type: 'circle', diameterMm: 4 }, spec: { distanceMm: 20, operation: 'new' } } }
    const h = { version: 1, base: [], steps: [{ ...step, tilt }, { ...step, id: 's2', tilt: { degrees: 'far', up: [0, 0, 1], toward: [1, 0, 0] } }] } as unknown as History
    const files = historyFiles([{ id: 'a', history: h }], new Map([['a', 3]]))
    const map = new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    const back = parseHistories(map, new Set(['3'])).get('3')
    expect(back?.steps[0]?.tilt).toEqual(tilt)
    expect(back?.steps[1]?.tilt).toBeUndefined()
  })
})
