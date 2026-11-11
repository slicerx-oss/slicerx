// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Color bands on a curved hull: painted on one lofted body, the hull keeps the wall design.check holds it to; the same
// bands made as bodies cut from the loft at the waterline and under the deck leave knife edges (a few hundredths of a
// millimeter) where the cut planes meet the round of the bilge and the rising stern, and design.check's wall fails.
// The tools run as the mimir tab runs them, on a design host with the geometry engine (replies recorded).
import { describe, expect, it } from 'vitest'
import { headlessDesignHost } from '../evals/creative/design-host'
import { bodyFacts } from '../src/body-facts'
import { createCardPlans, createPlanRegistry, designCheck, tabToolset, type PartPlan } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('tab-paint-wall')
const engine = (op: string, request: unknown) => g.engine(op, request)

const WATERLINE = 3
const BAND = 6.7
const L = 125
const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Half a hull section, from the deck edge down the side and round the bilge to the keel's middle: [y, z]. */
function halfSection(ht: number, hb: number, zb: number, zt: number): [number, number][] {
  const r = Math.max(0.05, Math.min(1.6, hb * 0.9, (zt - zb) * 0.45))
  const top = Math.min(0.7, (zt - zb - r) * 0.3)
  const pts: [number, number][] = [[ht, zt]]
  for (let k = 0; k < 3; k++) pts.push([ht + ((hb - ht) * k) / 3, zt - top + ((zb + r - (zt - top)) * k) / 3])
  for (let k = 0; k <= 4; k++) {
    const a = (k / 4) * (Math.PI / 2)
    pts.push([hb - r + r * Math.cos(a), zb + r - r * Math.sin(a)])
  }
  pts.push([(hb - r) * 0.5, zb])
  return pts
}

/** The hull's sections from the stern (x 0) to the bow (x 125): half beam at the deck and at the bilge, bottom, deck. */
const SECTIONS: [number, number, number, number, number][] = [
  [0, 2.4, 1.6, 5.4, 8.8],
  [5.5, 6.9, 5.8, 1.9, 8.6],
  [16, 8.5, 8.15, 0.08, 8.38],
  [60, 8.5, 8.2, 0, 8.3],
  [96, 8.5, 8.15, 0, 8.38],
  [114, 6.6, 4.0, 0.1, 8.78],
  [123, 2.4, 0.9, 0.5, 9.2],
  [125, 1.0, 0.75, 1.0, 9.3],
]
const profiles = () =>
  SECTIONS.map(([x, ht, hb, zb, zt]) => {
    const right = halfSection(ht, hb, zb, zt)
    const left = [...right].reverse().map(([y, z]) => [-y, z] as [number, number])
    return { frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [...right, [0, zb] as [number, number], ...left].map(([y, z]) => [r3(y), r3(z)]) }] }
  })

const plan: PartPlan = { planId: 'hull', part: 'Hull', units: 'mm', features: [{ name: 'Hull', kind: 'loft', sizes: { length: L, beam: 17 } }], overall: { x: L, y: 17, z: 9.3 }, assumptions: [], questions: [] }

const run = async (tools: ReturnType<typeof tabToolset>, name: string, args: Record<string, unknown>) => {
  const t = tools.find((x) => x.name === name)!
  const out = await t.run(t.input.parse(args) as never, {} as never)
  expect(out.ok, out.summary).not.toBe(false)
  return out
}

/** design.check's minimum wall item on the design as it is. */
async function wall(host: ReturnType<typeof headlessDesignHost>, design: string) {
  const r = designCheck(plan, await bodyFacts(host, host.get(design)), 0.4)
  return r.items.find((i) => i.name === 'minimum wall')!
}

describe('color bands on a lofted hull', () => {
  it('painted on one body pass the wall check; cut into bodies they fail it', async () => {
    // one hull, painted red below the waterline and white from under the deck up; black is the hull's own filament
    const host = headlessDesignHost(engine)
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()), { nozzleMm: () => 0.4 })
    const one = ((await run(tools, 'design.new', { name: 'Painted hull' })).output as { design: string }).design
    await run(tools, 'geom.loft', { design: one, profiles: profiles(), smooth: true, name: 'Hull', slot: 2 })
    for (const [state, target] of [[3, { kind: 'height', below: WATERLINE }], [1, { kind: 'height', above: BAND }]] as const) {
      const pv = (await run(tools, 'paint.preview', { design: one, state, target })).output as { preview: string }
      await run(tools, 'paint.apply', { preview: pv.preview })
    }
    expect(host.get(one).parts).toHaveLength(1)
    const totals = ((await run(tools, 'paint.regions', { design: one })).output as { totalsMm2: Record<string, number> }).totalsMm2
    expect(Object.keys(totals).sort()).toEqual(['1', '3'])
    const painted = await wall(host, one)
    expect(painted.pass, painted.got).toBe(true)

    // the same three colors as three lofts cut at the waterline and under the deck
    const cut = ((await run(tools, 'design.new', { name: 'Cut hull' })).output as { design: string }).design
    for (const [name, slot] of [['Hull bottom', 3], ['Hull side', 2], ['Hull band and deck', 1]] as const) await run(tools, 'geom.loft', { design: cut, profiles: profiles(), smooth: true, name, slot })
    await run(tools, 'geom.cut', { design: cut, part: 0, keep: 'below', plane: { axis: 'z', at: WATERLINE } })
    await run(tools, 'geom.cut', { design: cut, part: 1, keep: 'above', plane: { axis: 'z', at: WATERLINE } })
    await run(tools, 'geom.cut', { design: cut, part: 1, keep: 'below', plane: { axis: 'z', at: BAND } })
    await run(tools, 'geom.cut', { design: cut, part: 2, keep: 'above', plane: { axis: 'z', at: BAND } })
    expect(host.get(cut).parts).toHaveLength(3)
    const bands = await wall(host, cut)
    expect(bands.pass).toBe(false)
    expect(Number.parseFloat(bands.got)).toBeLessThan(0.1)
  }, 180_000)
})
