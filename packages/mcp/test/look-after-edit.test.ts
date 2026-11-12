// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up that edits a step the design was built with (raised lettering made taller, a block made longer) is
// measured like any other change: a look, the edit, then a look with compare gives the share of the view that changed.
// Neutral samples: a name plate with raised letters, and a block on a base.
import { describe, expect, it } from 'vitest'
import { headlessDesignHost } from '../evals/creative/design-host'
import { createCardPlans, createPlanRegistry, tabToolset } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('look-after-edit')

function tools() {
  const host = headlessDesignHost((op, request) => g.engine(op, request))
  const all = tabToolset(host, createCardPlans(createPlanRegistry()))
  const tool = (n: string) => all.find((t) => t.name === n)!
  return async (n: string, a: unknown) => {
    const r = await tool(n).run(tool(n).input.parse(a) as never, { sessionId: 's1' } as never)
    return r
  }
}

describe('a look after a step was edited', () => {
  it('measures raised letters made taller by editing their step', async () => {
    const run = tools()
    const d = ((await run('design.new', { name: 'Name plate' })).output as { design: string }).design
    await run('geom.extrude', { design: d, operation: 'new', name: 'Plate', slot: 1, shape: { type: 'rectangle', widthMm: 80, heightMm: 30, cornerRadiusMm: 3 }, distance_mm: 3 })
    const letters = await run('geom.emboss', { design: d, text: 'HI', point: [0, 0, 3], normal: [0, 0, 1], size_mm: 16, depth_mm: 1.5, mode: 'emboss', slot: 2, name: 'Letters' })
    expect(letters.ok, letters.summary).not.toBe(false)
    expect((await run('design.look', { design: d })).ok).not.toBe(false)
    const edit = await run('design.edit_step', { design: d, step: 2, value: 3 })
    expect(edit.ok, edit.summary).not.toBe(false)
    const after = await run('design.look', { design: d, compare: true })
    expect(after.ok, after.summary).not.toBe(false)
    expect((after.output as { visiblePct: number }).visiblePct).toBeGreaterThan(0)
  }, 60_000)

  it('measures a block made longer by editing its step', async () => {
    const run = tools()
    const d = ((await run('design.new', { name: 'Block' })).output as { design: string }).design
    await run('geom.extrude', { design: d, operation: 'new', name: 'Base', slot: 1, shape: { type: 'rectangle', widthMm: 60, heightMm: 40 }, distance_mm: 4 })
    await run('geom.extrude', { design: d, operation: 'new', name: 'Block', slot: 2, frame: { origin: [0, 0, 4], normal: [0, 0, 1] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 6 })
    expect((await run('design.look', { design: d })).ok).not.toBe(false)
    const edit = await run('design.edit_step', { design: d, step: 2, size: { axis: 'z', mm: 18 } })
    expect(edit.ok, edit.summary).not.toBe(false)
    const after = await run('design.look', { design: d, compare: true })
    expect(after.ok, after.summary).not.toBe(false)
    expect((after.output as { visiblePct: number }).visiblePct).toBeGreaterThan(2)
  }, 60_000)
})
