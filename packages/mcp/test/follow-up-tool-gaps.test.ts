// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tool gaps a follow-up ran into: a step named by its number as text ("2"), and a mirror of a patterned row (pegs
// down one side of a tray's base, mirrored to the other side), which was refused as a pattern of a pattern.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  sizeMm: V3
  volumeMm3: number
  parts: { sizeMm: V3; volumeMm3: number }[]
}

const geom = useGeomEngine('follow-up-tool-gaps')

async function start() {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    const out = data<{ ok?: boolean; summary: string; output: Summary }>(r)
    expect(out.ok, `${name}: ${text(r)}`).not.toBe(false)
    return out
  }
  return { ok }
}

describe('follow-up tool gaps', () => {
  it('takes a step number given as text', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'House' })).output.design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 60, heightMm: 40 }, distance_mm: 30, name: 'Walls' })
    const out = await ok('slicerx_design_edit_step', { design: d, step: '1', value: 36 })
    expect(Math.round(out.output.sizeMm[2])).toBe(36)
  })

  it('mirrors a patterned row of pegs to the other side of the base', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Tray' })).output.design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 100, heightMm: 30 }, distance_mm: 10, name: 'Base' })
    const before = (await ok('slicerx_design_steps', { design: d })).output.volumeMm3
    const peg = await ok('slicerx_geom_extrude', { design: d, part: 0, shape: { type: 'rectangle', widthMm: 8, heightMm: 3 }, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, placement: { center: [-30, 10] }, distance_mm: 2, operation: 'join', name: 'Peg' })
    const steps = (await ok('slicerx_design_steps', { design: d })).output as unknown as { steps: { id: string }[] }
    await ok('slicerx_geom_array', { design: d, part: 0, spec: { kind: 'linear', count: 4, step: [15, 0, 0] }, steps: [steps.steps[1]!.id] })
    const row = (await ok('slicerx_design_steps', { design: d })).output as unknown as { steps: { id: string }[] }
    const both = await ok('slicerx_geom_mirror', { design: d, part: 0, plane: { axis: 'y', at: 0 }, steps: [row.steps[2]!.id] })
    void peg
    // eight pegs of 8 x 3 x 2 mm
    expect(Math.round(both.output.volumeMm3 - before)).toBe(8 * 48)
    expect(Math.round(both.output.sizeMm[1])).toBe(30)
  })
})
