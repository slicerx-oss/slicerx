// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A level that carries another has a thin roof a little wider than its walls (a lip). The level above stands on that
// roof, and design.check passes the pair: what stands on what is read by height, and a lip of up to two nozzle widths
// is no thin wall to fix.
import { describe, expect, it } from 'vitest'
import { createPlanRegistry } from '../src/design-check'
import { flatInput, LEVELS_HELP } from '../src/plan-detail'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('level-lip')

type Item = { name: string; want: string; got: string; pass: boolean; warning?: string }

/** A two level cabin whose lower level's roof reaches `lip` mm past its walls on every side, design.check's answer. */
async function cabin(lip: number) {
  const plans = createPlanRegistry()
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request), plans })
  const ok = async <T,>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(tool, args)
    expect(r.isError, `${tool}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const design = (await ok<{ design: string }>('slicerx_design_new', { name: 'Cabin' })).design
  const at = { center: [30, 15] }
  await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20, frontRadiusMm: 10 }, placement: at, distance_mm: 6, feature: 'Lower story' })
  // the roof, built with the level: 0.6 mm thick, sunk 0.1 mm into the walls
  await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40 + 2 * lip, heightMm: 20 + 2 * lip, frontRadiusMm: 10 + lip }, frame: { origin: [0, 0, 5.9], normal: [0, 0, 1] }, placement: at, distance_mm: 0.7, operation: 'join', feature: 'Lower story' })
  await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 16, frontRadiusMm: 8 }, frame: { origin: [0, 0, 6.5], normal: [0, 0, 1] }, placement: { center: [32, 15] }, distance_mm: 4.1, operation: 'join', feature: 'Upper story' })
  plans.put({
    planId: 'cabin-1', part: 'Cabin', units: 'mm', detail: 'display', assumptions: [], questions: [], overall: { x: 40 + 2 * lip, y: 20 + 2 * lip, z: 10.6 },
    features: [{ name: 'Lower story', kind: 'extrude', sizes: { height: 6.6 } }, { name: 'Upper story', kind: 'extrude', sizes: { height: 4 }, on: 'Lower story' }],
    flat: ['Lower story'], tiers: { 'Lower story': ['Lower story', 'Upper story'] },
  })
  return ok<{ pass: boolean; items: Item[]; notes?: string[] }>('slicerx_design_check', { planId: 'cabin-1', design })
}

describe('a level with a lip', () => {
  it('passes the stacking checks with a roof one nozzle width past its walls', async () => {
    const r = await cabin(0.4)
    expect(r.items.find((i) => i.name === 'stands on')).toMatchObject({ got: '1 stacked part on its support', pass: true })
    expect(r.items.filter((i) => !i.pass)).toEqual([])
    expect(r.pass).toBe(true)
  })

  it('passes them with a roof two nozzle widths past its walls', async () => {
    const r = await cabin(0.8)
    expect(r.items.find((i) => i.name === 'stands on')).toMatchObject({ pass: true })
    expect(r.items.filter((i) => !i.pass)).toEqual([])
  })

  it('still fails a roof as thin reaching four nozzle widths past its walls: a shelf that thin is a wall to thicken', async () => {
    const r = await cabin(1.6)
    expect(r.items.find((i) => i.name === 'stands on')).toMatchObject({ pass: true })
    expect(r.items.filter((i) => !i.pass)).toEqual([expect.objectContaining({ name: 'minimum wall', got: '0.7 mm', pass: false })])
  })
})

describe("the levels' words", () => {
  it('say each level that carries another has a thin roof just past its walls', () => {
    expect(LEVELS_HELP).toBe(
      'Its levels from the bottom up, each a planned feature; a single block lists only itself. At display and fine, each level that carries another has a thin roof reaching about one nozzle width past its walls, built with the level, so the level above stands on it and its edge shows.',
    )
    const body = (flatInput.unwrap().options[0] as unknown as { element: { shape: { levels: { description?: string } } } }).element.shape.levels
    expect(body.description).toBe(LEVELS_HELP)
  })
})
