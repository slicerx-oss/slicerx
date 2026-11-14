// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One design.edit_step call can carry a new value with a move, a size, a tilt or a section edit. Every field given is
// applied to the step as the call has changed it so far, so none is lost: a mast lifted 0.35 mm out of the deck and cut
// 0.35 mm shorter keeps its top where it was, and the reply says "moved by" only for a move the step now has.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  sizeMm: V3
  minMm: V3
  parts: { minMm: V3; sizeMm: V3 }[]
  steps: { state: string }[]
}

const geom = useGeomEngine('design-edit-value-with-move')

async function start() {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args)
    const out = data<{ ok?: boolean; summary: string; output: Summary }>(r)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    expect(out.ok, `${name}: ${text(r)}`).not.toBe(false)
    return out
  }
  return { ok }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const top = (o: Summary) => r2(o.parts[0]!.minMm[2] + o.parts[0]!.sizeMm[2])

describe('design.edit_step keeps every field of one edit', () => {
  // the two masts of a stage 1 ship run: built 0.41 and 0.29 mm into a 14.7 mm deck, then lifted and shortened in one
  // edit each, as the model asked for them (value 19.35 with move [0, 0, 0.35]; value 17.7 with move [0, 0, 0.3])
  for (const m of [
    { name: 'Foremast', x: 40, height: 19.7, value: 19.35, lift: 0.35 },
    { name: 'Mainmast', x: 181, height: 18, value: 17.7, lift: 0.3 },
  ]) {
    it(`lifts and shortens the ${m.name} in one edit, so its top stays and its base leaves the deck`, async () => {
      const { ok } = await start()
      const d = (await ok('slicerx_design_new', { name: 'Titanic model' })).output.design
      await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 215, heightMm: 22.4 }, placement: { center: [107.5, 0] }, distance_mm: 14.7, name: 'Hull' })
      const built = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 1.2 }, frame: { origin: [0, 0, 14.3], normal: [0, 0, 1] }, placement: { center: [m.x, 0] }, distance_mm: m.height, extent: 'oneSide', operation: 'join', part: 0, feature: m.name })
      expect(top(built.output)).toBe(r2(14.3 + m.height))
      const edited = await ok('slicerx_design_edit_step', { design: d, step: 2, value: m.value, move: [0, 0, m.lift] })
      expect(edited.summary).toContain(`moved by [0, 0, ${m.lift}] mm`)
      // the move is in the step: the base is 14.3 + lift and the top is where it was, not lower by the lift
      expect(top(edited.output)).toBe(r2(14.3 + m.lift + m.value))
      expect(edited.output.steps.every((s) => s.state === 'done')).toBe(true)
    })
  }

  it('keeps a size given with a section edit of a loft', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Pod' })).output.design
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    await ok('slicerx_geom_loft', { design: d, profiles: [section(0, 4), section(40, 12), section(80, 6)], name: 'Body' })
    const both = await ok('slicerx_design_edit_step', { design: d, step: 1, size: { axis: 'x', mm: 100 }, section: { add: 45 } })
    expect(both.summary).toContain('80 mm to 100 mm along x')
    expect(Math.round(both.output.sizeMm[0])).toBe(100)
  })

  it('keeps a lean given with a new height', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Post' })).output.design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 40 }, distance_mm: 4, name: 'Base' })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 4 }, frame: { origin: [0, 0, 4], normal: [0, 0, 1] }, distance_mm: 30, operation: 'join', part: 0, name: 'Post' })
    const leaned = await ok('slicerx_design_edit_step', { design: d, step: 2, tilt: { toward: 'x', degrees: 20 }, value: 20 })
    // a 20 mm post of radius 2 leaning 20 degrees: its top rim reaches 20 cos 20 + 2 sin 20 above the base, about 19.48;
    // upright it would reach 20, and the 30 mm it had before would reach 30
    const lean = (20 * Math.PI) / 180
    expect(top(leaned.output)).toBeCloseTo(4 + 20 * Math.cos(lean) + 2 * Math.sin(lean), 1)
  })
})
