// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up changes what is built by editing the step that made it: design.edit_step's size sets a step's length along
// one axis, from its low end, and move shifts what it made, so a patterned detail changes at its source and every copy
// follows (shorter pen cups are one edit, not one push per cup). A step that raises a body under parts standing on it
// names those parts, so they are lifted rather than left sunk inside it.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Part {
  name: string
  minMm: V3
  sizeMm: V3
}
interface Summary {
  design: string
  sizeMm: V3
  parts: Part[]
  steps: { state: string; message?: string }[]
}

const geom = useGeomEngine('design-edit-move-size')

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
  return { call, ok }
}

const r1 = (n: number) => Math.round(n * 10) / 10

describe('design.edit_step size and move', () => {
  it('shortens three arrayed pen cups by editing the cup step once, from its base', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Desk organizer' })).output.design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 80, heightMm: 50 }, distance_mm: 12, name: 'Tray' })
    // a pen cup turned from its outline, standing on the tray, then arrayed along x
    await ok('slicerx_geom_revolve', { design: d, loops: [{ points: [[0, 0], [10, 0], [10, 34], [0, 34]] }], frame: { origin: [-25, 0, 12], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, axis: { point: [0, 0], direction: [0, 1] }, angle_deg: 360, operation: 'new', name: 'Pen cup' })
    const arrayed = await ok('slicerx_geom_array', { design: d, part: 1, spec: { kind: 'linear', count: 3, step: [25, 0, 0] } })
    expect(r1(arrayed.output.parts[1]!.sizeMm[2])).toBe(34)
    const short = await ok('slicerx_design_edit_step', { design: d, step: 2, size: { axis: 'z', mm: 26 } })
    expect(short.summary).toMatch(/^Edited step 2, .*: 34 mm to 26 mm along z$/)
    const cups = short.output.parts[1]!
    expect(r1(cups.sizeMm[2])).toBe(26)
    expect(r1(cups.minMm[2])).toBe(12)
    // all three cups follow: the row is still 70 mm long (25 + 25 + 20)
    expect(r1(cups.sizeMm[0])).toBe(70)
    expect(short.output.steps.every((s) => s.state === 'done')).toBe(true)
    const lifted = await ok('slicerx_design_edit_step', { design: d, step: 2, move: [0, 0, 4] })
    expect(r1(lifted.output.parts[1]!.minMm[2])).toBe(16)
    expect(r1(lifted.output.parts[1]!.sizeMm[2])).toBe(26)
  })

  it('makes a toy boat hull longer by editing its loft along its length', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Toy boat' })).output.design
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    await ok('slicerx_geom_loft', { design: d, profiles: [section(0, 4), section(40, 12), section(80, 6)], name: 'Hull' })
    const longer = await ok('slicerx_design_edit_step', { design: d, step: 1, size: { axis: 'x', mm: 100 } })
    expect(r1(longer.output.sizeMm[0])).toBe(100)
    expect(r1(longer.output.parts[0]!.minMm[0])).toBe(0)
    expect(r1(longer.output.sizeMm[2])).toBe(12)
  })

  it('refuses a size on a step it cannot stretch, and a move on a step with no place of its own', async () => {
    const { ok, call } = await start()
    const d = (await ok('slicerx_design_new', { name: 'House' })).output.design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 60, heightMm: 40 }, distance_mm: 30, name: 'Walls' })
    await ok('slicerx_geom_hollow', { design: d, wall_mm: 2 })
    const sized = await call('slicerx_design_edit_step', { design: d, step: 2, size: { axis: 'z', mm: 20 } })
    expect(text(sized.r)).toMatch(/size: .*extrude, revolve or loft/)
    const moved = await call('slicerx_design_edit_step', { design: d, step: 2, move: [0, 0, 3] })
    expect(text(moved.r)).toMatch(/move: .*no place of its own/)
  })

  it('names a chimney a new upper story sinks into, and lifting its step clears it', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'House' })).output.design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 60, heightMm: 40 }, distance_mm: 30, name: 'Walls' })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 8, heightMm: 8 }, frame: { origin: [0, 0, 30], normal: [0, 0, 1] }, placement: { center: [15, 8] }, distance_mm: 12, operation: 'new', name: 'Chimney' })
    const story = await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'rectangle', widthMm: 50, heightMm: 30 }, frame: { origin: [0, 0, 30], normal: [0, 0, 1] }, distance_mm: 6, operation: 'join', name: 'Upper story' })
    expect(story.summary).toContain('Chimney stood on Walls and is now 6 mm inside it: lift it with design.edit_step move [0, 0, 6] on step 2, the step that made it')
    const lifted = await ok('slicerx_design_edit_step', { design: d, step: 2, move: [0, 0, 6] })
    expect(r1(lifted.output.parts[1]!.minMm[2])).toBe(36)
  })
})
