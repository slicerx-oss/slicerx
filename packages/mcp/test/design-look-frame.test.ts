// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.look's compare draws the look before a change and the model after it in one frame, so the two pictures are
// the same size and every pixel can be set against its twin. The edges are drawn as thin prisms that reach a little
// past the model, so a change that moves the model's extent (a step raised, a step lowered, a part added beside it)
// must not change the frame, or the pictures differ by a pixel and the change cannot be measured.
import { describe, expect, it } from 'vitest'
import { headlessDesignHost } from '../evals/creative/design-host'
import { createCardPlans, createPlanRegistry, tabToolset } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('design-look-frame')

/** The tab's tools over the engine, with the size of every picture the engine drew. */
function setup() {
  const sizes: [number, number][] = []
  const host = headlessDesignHost(async (op, request) => {
    const r = await g.engine(op, request)
    if (op === 'render') {
      const s = r as { widthPx: number; heightPx: number }
      sizes.push([s.widthPx, s.heightPx])
    }
    return r
  })
  const tools = tabToolset(host, createCardPlans(createPlanRegistry()))
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const run = (n: string, a: unknown) => tool(n).run(tool(n).input.parse(a) as never, { sessionId: 's1' } as never)
  return { sizes, run }
}

const top = (x: number, y: number, z: number) => ({ origin: [x, y, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })

/** A 70 by 30 by 3 mm plate with a 20 by 10 mm block 1.2 mm tall on it (step 2), looked at once. */
async function plate(run: ReturnType<typeof setup>['run']): Promise<string> {
  const d = ((await run('design.new', { name: 'Name plate' })).output as { design: string }).design
  await run('geom.extrude', { design: d, shape: { type: 'rectangle', widthMm: 70, heightMm: 30 }, distance_mm: 3 })
  await run('geom.extrude', { design: d, part: 0, operation: 'join', frame: top(0, 0, 3), shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 1.2 })
  await run('design.look', { design: d })
  return d
}

/** The compare's measured share, after checking both of its pictures came out the same size. */
async function compared(t: ReturnType<typeof setup>, d: string): Promise<number> {
  const before = t.sizes.length
  const r = await t.run('design.look', { design: d, compare: true })
  expect(r.ok, r.summary).not.toBe(false)
  const [a, b] = t.sizes.slice(before)
  expect(t.sizes.length - before).toBe(2)
  expect(b).toEqual(a)
  return (r.output as { visiblePct: number }).visiblePct
}

describe('design.look compare keeps one frame', () => {
  it('measures a step raised past the top of the model', async () => {
    const t = setup()
    const d = await plate(t.run)
    // the block from 1.2 mm to 3 mm: the model's top moves up
    await t.run('design.edit_step', { design: d, step: 2, value: 3 })
    expect(await compared(t, d)).toBeGreaterThan(0)
  })

  it('measures a step lowered under the top of the model', async () => {
    const t = setup()
    const d = await plate(t.run)
    // the block from 1.2 mm to 0.4 mm: the model's top moves down
    await t.run('design.edit_step', { design: d, step: 2, value: 0.4 })
    expect(await compared(t, d)).toBeGreaterThan(0)
  })

  it('measures a part added outside the box the model had', async () => {
    const t = setup()
    const d = await plate(t.run)
    // a 10 mm cube 20 mm past the plate's right end
    await t.run('geom.extrude', { design: d, operation: 'new', frame: top(65, 0, 0), shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 10 })
    expect(await compared(t, d)).toBeGreaterThan(0)
  })
})
