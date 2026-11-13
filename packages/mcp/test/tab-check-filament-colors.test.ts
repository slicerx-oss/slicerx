// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.check in the mimir tab reads the open project's filament colors, as it does over the app link: a color band
// painted where and as the plan says counts as built. Without the colors the tab read every filament as a color it
// does not know, so a band painted right never counted, and the feature count failed it.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { createCardPlans, tabToolset, type FilamentList } from '../src/toolset'

type Tri = [number[], number[], number[]]
function boxTris([x0, y0, z0]: number[], [x1, y1, z1]: number[]): Tri[] {
  const v = (i: number): number[] => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!]
  const f = (a: number, b: number, c: number): Tri => [v(a), v(b), v(c)]
  return [f(0, 1, 5), f(0, 2, 3), f(0, 5, 4), f(0, 3, 1), f(2, 6, 7), f(4, 5, 7), f(2, 7, 3), f(4, 7, 6), f(0, 4, 6), f(0, 6, 2), f(1, 3, 7), f(1, 7, 5)]
}
const meshOf = (tris: readonly Tri[]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * One closed 60 x 60 x 100 mm block, d1, built by one step tagged Body and painted with filament 2 from 80 to 90 mm,
 * as the engine reads the paint back.
 */
function paintedHost(paint: Record<string, unknown> = { op: 'paint' }): DesignHost {
  const step = (id: string, op: string, feature?: string) => ({ id, params: op === 'paint' ? paint : { op }, ...(feature ? { feature } : {}) })
  const d = {
    id: 'd1',
    name: 'Block',
    history: { version: 1, base: [], steps: [step('s1', 'parts.add', 'Body'), step('s2', 'paint')] },
    transform: IDENTITY,
    parts: [{ name: 'Block', slot: 1, paint: { color: { 0: 'painted' } }, ...meshOf(boxTris([0, 0, 0], [60, 60, 100])) }],
    status: [],
    madeBy: {},
    redo: [],
  } as unknown as HostDesign
  return {
    get: (id: string) => {
      if (id !== d.id) throw new Error(`no design ${id}`)
      return d
    },
    list: () => [d],
    create: async () => Promise.reject(new Error('not here')),
    add: async () => Promise.reject(new Error('not here')),
    replay: async () => {},
    call: async (op: string) => {
      if (op === 'info') return { watertight: true }
      if (op === 'paint.regions') return { states: [{ state: 2, regions: [{ boundsMm: { min: [0, 0, 80], max: [60, 60, 90] } }] }] }
      throw new Error('not here')
    },
  } as unknown as DesignHost
}

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
/** A block with a white band from 80 to 90 mm, as an approved plan tied to d1. */
const plan = { planId: 'plan_1', part: 'Block', units: 'mm', features: [{ name: 'Body', kind: 'extrude', sizes: { length: 60, width: 60, height: 100 } }, { name: 'White band', kind: 'paint', sizes: { from: 80, to: 90 } }], colors: { Body: 'blue', 'White band': 'white' }, overall: { x: 60, y: 60, z: 100 }, assumptions: [], questions: [] } as unknown as PartPlan

/** The open project's filaments: 1 blue, 2 white. */
const project = (): FilamentList => ({ list: () => [{ slot: 1, type: 'PLA', color: '#1030a0' }, { slot: 2, type: 'PLA', color: '#ffffff' }], add: () => undefined, set: () => undefined })

async function checked(filaments?: FilamentList, paint?: Record<string, unknown>) {
  const card = createCardPlans(createPlanRegistry())
  card.plans.put(plan, 'd1', 'card')
  const tools = tabToolset(paintedHost(paint), card, { nozzleMm: () => machine.nozzle, ...(filaments ? { filaments } : {}) })
  const check = tools.find((t) => t.name === 'design.check')!
  const ctx = { context: { project: 'creative', machine, objects: [] } } as unknown as ToolContext
  const out = await check.run(check.input.parse({ planId: 'plan_1' }) as never, ctx)
  return out.output as { items: { name: string; got: string; pass: boolean }[]; body: { paintUntagged?: { id: string; step: string }[] } }
}

async function featureCount(filaments?: FilamentList) {
  return (await checked(filaments)).items.find((i) => i.name === 'feature count')!
}

describe('design.check in the tab, against the project filaments', () => {
  it('counts a band painted white where the plan puts it as built', async () => {
    const item = await featureCount(project())
    expect(item.pass).toBe(true)
    expect(item.got).toContain('White band painted white from 80 to 90 mm')
  })

  it('cannot read the band without the project filaments, so it counts as missing', async () => {
    const item = await featureCount()
    expect(item.pass).toBe(false)
    expect(item.got).toContain('White band: planned white from 80 mm to 90 mm; painted filament 2 (color not known) from 80 to 90 mm')
  })

  it('checks a design whose paint step was saved with no target, and names that step plainly', async () => {
    // as an older build or a hand-written history can hold it: the layer and filament, and no place
    const out = await checked(project(), { op: 'paint', layer: 'color', state: 2 })
    expect(out.items.find((i) => i.name === 'feature count')!.pass).toBe(true)
    expect(out.body.paintUntagged).toEqual([{ id: 's2', step: 'Paint filament 2' }])
    // and one with no layer or filament either
    expect((await checked(project())).body.paintUntagged).toEqual([{ id: 's2', step: 'Paint' }])
  })
})
