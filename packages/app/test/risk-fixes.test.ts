// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { runPlateCheck } from '../src/plate/checks'
import { boxMesh } from '../src/plate/mesh-ops'
import { applyRiskFix, fixInPlace, fixPatch, riskFixes } from '../src/plate/risk-fixes'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const post = (id: string, x = 0): PlateEntry => ({ id, name: id, handle: handle(id), parts: [boxMesh(8, 8, 60)], colors: ['#bd93f9'], transform: x ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] : ident })

beforeEach(() => {
  set({ plate: [post('post'), post('other', 100)], slice: { status: 'idle' }, easy: { ...get().easy, supports: 'off' }, objectSettings: {}, overrides: { brim_type: 'no_brim', brim_width: 0, z_hop_types: ['Slope Lift'] } })
})

describe('risk fixes', () => {
  it('turns the risk report into buttons on the object it found', async () => {
    const c = await runPlateCheck('risks', get())
    const f = c.fixes.find((x) => x.risk === 'tall_thin' && x.objectId === 'post')
    expect(f?.label).toBe('Add a brim 5 mm wide and Normal Lift z hop')
    expect(f?.objectSettings).toEqual({ brim_type: 'outer_only', brim_width: 5 })
    expect(f?.plateSettings).toEqual({ z_hop_types: 'Normal Lift' })
  })

  it('applies a brim to that object only, and z hop to every extruder of the plate', async () => {
    const [f] = riskFixes({ risks: [{ id: 'tall_thin', object: 'post', objectId: 'post', settings: { brim_type: 'outer_only', brim_width: 5, z_hop_types: 'Normal Lift' } }] }, get())
    expect(fixInPlace(f!)).toBe(false)
    await applyRiskFix(f!, async () => undefined)
    expect(get().objectSettings).toEqual({ post: { brim_type: 'outer_only', brim_width: 5 } })
    expect(get().overrides.z_hop_types).toEqual(['Normal Lift'])
    expect(fixInPlace(f!)).toBe(true)
  })

  it('never makes a brim narrower or changes its type', () => {
    set({ objectSettings: { post: { brim_type: 'auto_brim', brim_width: 8 } } })
    const [f] = riskFixes({ risks: [{ id: 'first_layer', object: 'post', objectId: 'post', settings: { brim_type: 'outer_only', brim_width: 6 } }] }, get())
    expect(fixPatch(f!).object).toEqual({})
    expect(fixInPlace(f!)).toBe(true)
  })

  it('offers supports for the object and a repair for open edges, and skips objects that left the plate', async () => {
    const fixes = riskFixes(
      {
        risks: [
          { id: 'overhang', object: 'post', objectId: 'post', settings: { enable_support: true } },
          { id: 'open_edges', object: 'other', objectId: 'other' },
          { id: 'warp', object: 'gone', objectId: 'gone', settings: { brim_width: 8 } },
        ],
      },
      get(),
    )
    expect(fixes.map((f) => f.label)).toEqual(['Turn on supports for this object', 'Repair the mesh'])
    let repaired = ''
    await applyRiskFix(fixes[1]!, async () => (repaired = get().selection ?? ''))
    expect(repaired).toBe('other')
  })

  it("reads thin walls, floating islands and long bridges from the slice on screen, and fixes them where they are", async () => {
    const { bounds } = await import('../src/plate/transform')
    const b = bounds(get().plate[1]!.parts, get().plate[1]!.transform)!
    const ox = (b.min[0]! + b.max[0]!) / 2
    const oy = (b.min[1]! + b.max[1]!) / 2
    const warnings = [
      { code: 'thin_wall', message: `A feature thinner than 0.42 mm on layer 4 near X ${ox.toFixed(1)} Y ${oy.toFixed(1)} mm is too thin for the walls and will not print. Switch the wall generator to Arachne, which prints features down to a quarter of the nozzle, or scale the part up.`, layer: 3 },
      { code: 'long_bridge', message: 'A bridge on layer 26 near X 300.0 Y 300.0 mm spans 40.0 mm, longer than the 10 mm max bridge length, and can sag. Turn on supports, or slow bridges down and give them more fan.', layer: 25 },
    ]
    set({ slice: { status: 'done', stale: false, result: { warnings } } as never })
    const c = await runPlateCheck('risks', get())
    expect(JSON.stringify(c.display)).not.toMatch(/found when the plate is sliced/)
    const thin = c.fixes.find((f) => f.risk === 'thin_wall')
    expect(thin).toMatchObject({ objectId: 'other', label: 'Use Arachne walls for this object', objectSettings: { wall_generator: 'arachne' } })
    const bridge = c.fixes.find((f) => f.risk === 'long_bridge')
    expect(bridge).toMatchObject({ objectId: '', object: 'the plate', label: 'Turn on supports', plateSettings: { enable_support: true } })
    await applyRiskFix(bridge!, async () => undefined)
    expect(get().easy.supports).toBe('auto')
    expect(get().overrides.enable_support).toBeUndefined()
  })

  it('says to slice when the slice on screen is out of date', async () => {
    set({ slice: { status: 'done', stale: true, result: { warnings: [] } } as never })
    const c = await runPlateCheck('risks', get())
    expect(JSON.stringify(c.display)).toMatch(/found when the plate is sliced/)
  })
})
