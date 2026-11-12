// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design read-back says how each part was made and how it looks: a pod's box blocks read as plain blocks
// on its body, its lofted body does not, a house roof whose edges were rounded is no longer a plain block, and a
// design of many parts lists the first FORMS_MAX and counts the rest, so a local model's turn keeps its room.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'
import { FORMS_MAX } from '../src/part-form'

const geom = useGeomEngine('part-form')

async function start() {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ summary: string; output: { design: string; forms?: string[]; formsMore?: string } }>(r)
  }
  return { ok }
}

describe('the form line of each part', () => {
  it('reads a pod: the lofted body is shaped, the box blocks on it are plain blocks', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Pod' })).output.design
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    await ok('slicerx_geom_loft', { design: d, profiles: [section(0, 4), section(40, 12), section(80, 6)], name: 'Body' })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 12 }, frame: { origin: [0, 0, 12], normal: [0, 0, 1] }, placement: { center: [40, 0] }, distance_mm: 6, operation: 'new', name: 'Top box' })
    const out = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 8, heightMm: 6 }, frame: { origin: [0, 0, 12], normal: [0, 0, 1] }, placement: { center: [12, 0] }, distance_mm: 4, operation: 'new', name: 'Small box' })
    expect(out.output.forms).toEqual([
      'Body: loft of 3 sections, sharp edges; middle',
      'Top box: box, plain block; on Body, middle',
      'Small box: box, plain block; on Body, low x end',
    ])
  })

  it('takes the plain block mark off a house whose roof edges were rounded', async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'House' })).output.design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 60, heightMm: 40 }, distance_mm: 30, name: 'Walls' })
    const plain = await ok('slicerx_design_steps', { design: d })
    expect(plain.output.forms).toEqual(['Walls: box, plain block'])
    const pick = await ok('slicerx_geom_edge_pick', { design: d, face: { at: [0, -19.9, 30], normal: [0, 0, 1] } })
    const loop = (pick.output as unknown as { loop: { edge: unknown }[] }).loop.map((l) => l.edge)
    const round = await ok('slicerx_geom_fillet', { design: d, edges: loop, radius_mm: 2 })
    expect(round.output.forms).toEqual(['Walls: box, rounded or beveled edges'])
  })

  it(`lists the first ${FORMS_MAX} parts of a big design and counts the rest, in a few hundred tokens`, async () => {
    const { ok } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Toy car park' })).output.design
    let out = null as Awaited<ReturnType<typeof ok>> | null
    for (let k = 0; k < 40; k++) out = await ok('slicerx_geom_build', { design: d, name: `Car ${k + 1}`, solids: [{ type: 'box', min: [k * 12, 0, 0], max: [k * 12 + 10, 20, 8] }] })
    expect(out!.output.forms).toHaveLength(FORMS_MAX)
    expect(out!.output.formsMore).toBe('and 24 more parts')
    // about 4 characters a token
    const chars = JSON.stringify({ forms: out!.output.forms, formsMore: out!.output.formsMore }).length
    expect(chars / 4).toBeLessThan(260)
  })
})
