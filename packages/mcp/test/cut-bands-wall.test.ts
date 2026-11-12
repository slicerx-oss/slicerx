// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Color bands made as bodies: one lofted body cut flat into three bands, each its own part, leaves knife rims (a few
// hundredths of a millimeter) where the cut planes meet the round of its lower side and its rising end. Each rim lies
// on a cut the band shares with the next, so it is read as wall and design.check's wall fails under 0.1 mm; the same
// body cut once, its lower band alone, keeps its rim as a tip. The tools run as the mimir tab runs them, on a design
// host with the geometry engine (replies recorded in fixtures/cut-bands-wall.json.gz).
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { headlessDesignHost } from '../evals/creative/design-host'
import { bodyFacts } from '../src/body-facts'
import { createCardPlans, createPlanRegistry, designCheck, tabToolset, type PartPlan } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('cut-bands-wall')
const engine = (op: string, request: unknown) => g.engine(op, request)

const LOW = 3
const HIGH = 6.7
const L = 125
const r3 = (n: number) => Math.round(n * 1000) / 1000

// cos and sin of a quarter turn in four steps, written out, not computed: Math.cos and Math.sin may differ in the last
// bit from one platform's build to another's, which changes the engine requests the recording is keyed by. These are
// the values the recording was made with; a test checks them against Math.
const QUARTER: readonly (readonly [number, number])[] = [[1, 0], [0.9238795325112867, 0.3826834323650898], [0.7071067811865476, 0.7071067811865475], [0.38268343236508984, 0.9238795325112867], [6.123233995736766e-17, 1]]

/** Half a section, from the top edge down the side and round the lower curve to the bottom's middle: [y, z]. */
function halfSection(ht: number, hb: number, zb: number, zt: number): [number, number][] {
  const r = Math.max(0.05, Math.min(1.6, hb * 0.9, (zt - zb) * 0.45))
  const top = Math.min(0.7, (zt - zb - r) * 0.3)
  const pts: [number, number][] = [[ht, zt]]
  for (let k = 0; k < 3; k++) pts.push([ht + ((hb - ht) * k) / 3, zt - top + ((zb + r - (zt - top)) * k) / 3])
  for (const [c, s] of QUARTER) pts.push([hb - r + r * c, zb + r - r * s])
  pts.push([(hb - r) * 0.5, zb])
  return pts
}

/** The body's sections from one end (x 0) to the other (x 125): half width at the top and lower down, bottom, top. */
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

const plan: PartPlan = { planId: 'body', part: 'Body', units: 'mm', features: [{ name: 'Body', kind: 'loft', sizes: { length: L, width: 17 } }], overall: { x: L, y: 17, z: 9.3 }, assumptions: [], questions: [] }

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

// the hash of the sections as JSON: the numbers the recorded loft requests were made from
const PROFILES_HASH = '64a284ba4dbb6be2'

describe('color bands cut from a lofted body', () => {
  it('builds the body from the same numbers on every platform', () => {
    expect(createHash('sha256').update(JSON.stringify(profiles())).digest('hex').slice(0, 16)).toBe(PROFILES_HASH)
    QUARTER.forEach(([c, s], k) => {
      expect(Math.abs(c - Math.cos((k / 4) * (Math.PI / 2)))).toBeLessThan(1e-15)
      expect(Math.abs(s - Math.sin((k / 4) * (Math.PI / 2)))).toBeLessThan(1e-15)
    })
  })

  it('three bands that share their cuts fail the wall at the rims; one band alone keeps its rim as a tip', async () => {
    const host = headlessDesignHost(engine)
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()), { nozzleMm: () => 0.4 })
    const cut = ((await run(tools, 'design.new', { name: 'Banded body' })).output as { design: string }).design
    for (const [name, slot] of [['Body bottom', 3], ['Body side', 2], ['Body top', 1]] as const) await run(tools, 'geom.loft', { design: cut, profiles: profiles(), smooth: true, name, slot })
    await run(tools, 'geom.cut', { design: cut, part: 0, keep: 'below', plane: { axis: 'z', at: LOW } })
    await run(tools, 'geom.cut', { design: cut, part: 1, keep: 'above', plane: { axis: 'z', at: LOW } })
    await run(tools, 'geom.cut', { design: cut, part: 1, keep: 'below', plane: { axis: 'z', at: HIGH } })
    await run(tools, 'geom.cut', { design: cut, part: 2, keep: 'above', plane: { axis: 'z', at: HIGH } })
    expect(host.get(cut).parts).toHaveLength(3)
    const bands = await wall(host, cut)
    expect(bands.pass).toBe(false)
    expect(Number.parseFloat(bands.got)).toBeLessThan(0.1)

    // the bottom band alone: its rim at the cut meets no other part, so it is a tip and the band's wall is read past it
    const one = ((await run(tools, 'design.new', { name: 'Bottom band' })).output as { design: string }).design
    await run(tools, 'geom.loft', { design: one, profiles: profiles(), smooth: true, name: 'Body bottom', slot: 3 })
    await run(tools, 'geom.cut', { design: one, part: 0, keep: 'below', plane: { axis: 'z', at: LOW } })
    const facts = await bodyFacts(host, host.get(one))
    expect(facts.minWallTip?.mm).toBeLessThan(0.1)
    expect(facts.minWallMm!).toBeGreaterThan(0.1)
  }, 180_000)
})
