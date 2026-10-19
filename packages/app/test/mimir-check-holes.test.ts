// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.check on a part built in the mimir tab: a 608 pillow block from a real session, replayed from its real steps
// through the tab's design toolset (the approved card plan, then design.new, the geom.build that made the part and
// design.check). The body a boolean leaves has its rim corners bunched along some arcs, and the bore has a narrower
// shoulder on its axis; the check still finds the bore and both screw holes at their planned sizes. Runs against the
// geometry engine and only where it is built: its replies carry the 140,000 facet body, 14 MB recorded, so CI runs the
// same rims in packages/mcp/test/body-facts-holes.test.ts instead.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { PartPlan } from '@slicerx/mcp/toolset'
import { designToolset } from '@slicerx/mcp/toolset'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { set } from '../src/state/store'
import { mimirPlans } from '../src/workspaces/mimir/plans'
import { liveEngine, useGeomEngine } from './geom-engine'

// no recorded replies to fall back on: without the engine the test is skipped
if (liveEngine) useGeomEngine('mimir-check-holes-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

interface Case {
  planId: string
  plan: Omit<PartPlan, 'planId'>
  steps: { tool: string; input: Record<string, unknown>; summary: string }[]
  /** The part as it was exported at the end of the session. */
  stl: { triangles: number; min: number[]; max: number[] }
}
type Item = { name: string; want: string; got: string; pass: boolean }
type Checked = { design: string; pass: boolean; items: Item[]; body: { size: { x: number; y: number; z: number }; holes: { diameterMm: number }[]; watertight: boolean } }

const block = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mimir-check-608-block.json'), 'utf8')) as Case

afterEach(() => mimirPlans.clear())

describe('design.check on a part built in the tab', () => {
  it.skipIf(!liveEngine)('finds the 608 block\'s bore and both M4 holes at their planned sizes', { timeout: 60_000 }, async () => {
    set({ plate: [], selection: null, selectedIds: [], historyEdit: null })
    const host = appDesignHost(loader)
    const tools = new Map(designToolset(host, {}, { plans: mimirPlans, cardSide: true }).map((t) => [t.name, t]))
    mimirPlans.put({ planId: block.planId, ...block.plan }, undefined, 'card')
    // the design ids of the run, as this replay names them
    const ids = new Map<string, string>()
    const named = (v: unknown): unknown => (typeof v === 'string' ? (ids.get(v) ?? v) : v)
    let checked: Checked | undefined
    for (const step of block.steps) {
      const tool = tools.get(step.tool)!
      const input = Object.fromEntries(Object.entries(step.input).map(([k, v]) => [k, named(v)]))
      const out = await tool.run(tool.input.parse(input) as never, {} as never)
      expect(out.ok, `${step.tool}: ${out.summary}`).not.toBe(false)
      if (step.tool === 'design.new') ids.set(/\((obj_\w+)\)/.exec(step.summary)![1]!, (out.output as { design: string }).design)
      if (step.tool === 'design.check') checked = out.output as Checked
    }
    // the body checked is the part exported at the end: the same size and as many facets
    const d = host.get(checked!.design)
    expect(d.parts.reduce((n, p) => n + p.indices.length / 3, 0)).toBe(block.stl.triangles)
    expect(checked!.body.size).toEqual({ x: block.stl.max[0]! - block.stl.min[0]!, y: block.stl.max[1]! - block.stl.min[1]!, z: block.stl.max[2]! - block.stl.min[2]! })
    expect(checked!.body.watertight).toBe(true)
    // the bore, its 18 mm shoulder (a hole of its own on the same axis) and the two M4 holes
    expect(checked!.body.holes.map((h) => Math.round(h.diameterMm * 100) / 100).sort((a, b) => a - b)).toEqual([4.5, 4.5, 18, 21.9])
    const item = (name: string) => checked!.items.find((i) => i.name === name)
    for (const name of ['Bearing bore', 'M4 mounting hole 1', 'M4 mounting hole 2']) expect(item(name), name).toMatchObject({ pass: true })
    expect(item('Bearing bore')?.got).toBe('21.9 mm diameter')
    // what still fails is so: the shoulder came after the plan, and the part was made in one step, not four
    expect(checked!.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['extra hole, 18 mm', 'feature count'])
  })
})
