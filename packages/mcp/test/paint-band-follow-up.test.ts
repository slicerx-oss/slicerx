// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A color asked for on a part already painted in bands (a toy boat's hull, red below its waterline) goes on the band the
// person most likely means, not over the whole part: a whole-part repaint of a banded part is refused with its bands
// listed for a client with no way to ask; in the tab the person picks the band on a one-tap question, unless the
// words already said the whole part.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'
import type { ToolContext } from '@slicerx/pilot'
import { headlessDesignHost } from '../evals/creative/design-host'
import { createCardPlans, createPlanRegistry, tabToolset } from '../src/toolset'

const geom = useGeomEngine('paint-band-follow-up')

describe('a color on a part painted in bands', () => {
  it('refuses painting the whole banded hull, lists its bands, and takes a height band', async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ summary: string; output: Record<string, unknown> }>(r)
    }
    const d = (await ok('slicerx_design_new', { name: 'Toy boat' })).output['design'] as string
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    await ok('slicerx_geom_loft', { design: d, profiles: [section(0, 4), section(40, 12), section(80, 6)], name: 'Hull' })
    // red below the waterline at 4 mm; the rest is the hull's own filament
    const below = await ok('slicerx_paint_preview', { design: d, layer: 'color', state: 3, target: { kind: 'height', below: 4 }, part: 0 })
    await ok('slicerx_paint_apply', { preview: (below.output as { preview: string }).preview })
    const whole = await h.call('slicerx_paint_preview', { design: d, layer: 'color', state: 4, target: { kind: 'part' }, part: 0 })
    expect(text(whole)).toMatch(/target: Hull is painted in bands: filament 3 over \d+ mm2, and the rest in its own filament/)
    expect(text(whole)).toMatch(/paint the band the person most likely means with a height target/)
    expect(text(whole)).toMatch(/say which band you took; if two bands fit equally, ask with two choices/)
    // the hull painted red below the waterline, asked red again: still only the band, never the whole part
    const same = await h.call('slicerx_paint_preview', { design: d, layer: 'color', state: 3, target: { kind: 'part' }, part: 0 })
    expect(text(same)).toMatch(/Hull is painted in bands: filament 3 over \d+ mm2/)
    const band = await ok('slicerx_paint_preview', { design: d, layer: 'color', state: 4, target: { kind: 'height', below: 4 }, part: 0 })
    expect(band.summary).toMatch(/Preview/)
  })

  it('still paints a whole part that has no bands', async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const d = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'House' })).output.design
    await h.call('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 60, heightMm: 40 }, distance_mm: 30, name: 'Walls' })
    const r = await h.call('slicerx_paint_preview', { design: d, layer: 'color', state: 2, target: { kind: 'part' }, part: 0 })
    expect(r.isError, text(r)).toBeFalsy()
  })

  it('in the tab, asks which band with one tap, and takes the answer or the whole part when the words say so', async () => {
    const host = headlessDesignHost((op, request) => geom.engine(op, request))
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()))
    const asked: { question: string; labels: string[] }[] = []
    let answer = 0
    const ctx = {
      ask: async (q: { question: string; choices: { id: string; label: string }[] }) => {
        asked.push({ question: q.question, labels: q.choices.map((c) => c.label) })
        return { id: q.choices[answer]!.id }
      },
    } as unknown as ToolContext
    const tool = (n: string) => tools.find((t) => t.name === n)!
    const run = (n: string, a: unknown) => tool(n).run(tool(n).input.parse(a) as never, ctx)
    const d = ((await run('design.new', { name: 'Toy boat' })).output as { design: string }).design
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    await run('geom.loft', { design: d, profiles: [section(0, 4), section(40, 12), section(80, 6)], name: 'Hull' })
    const pv = await run('paint.preview', { design: d, layer: 'color', state: 3, target: { kind: 'height', below: 4 }, part: 0 })
    await run('paint.apply', { preview: (pv.output as { preview: string }).preview })
    const below = await run('paint.preview', { design: d, layer: 'color', state: 4, target: { kind: 'part' }, part: 0 })
    expect(asked.at(-1)).toEqual({ question: 'Paint which part of Hull in filament 4?', labels: ['Below 4 mm', 'Above 4 mm', 'All of it'] })
    expect(below.summary).toMatch(/^The person picked below 4 mm\. Preview p\d+: Paint below 4 mm filament 4/)
    answer = 2
    const all = await run('paint.preview', { design: d, layer: 'color', state: 4, target: { kind: 'part' }, part: 0 })
    expect(all.summary).toMatch(/^The person picked all of it\. Preview p\d+: Paint the part filament 4/)
    const n = asked.length
    const whole = await run('paint.preview', { design: d, layer: 'color', state: 4, target: { kind: 'part' }, part: 0, whole: true })
    expect(asked).toHaveLength(n)
    expect(whole.summary).toMatch(/^Preview p\d+: Paint the part filament 4/)
  })
})
