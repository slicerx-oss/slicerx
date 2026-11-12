// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client takes the size an edge pick offers for the whole loop and rounds the loop at it, the way an agent would,
// and an edge listed twice (once from the chain, once from the loop) is rounded once.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface EdgeRef {
  a: V3
  b: V3
  face: V3
}
interface Pick {
  edge: EdgeRef
  supported: boolean
  maxRadiusMm: number
  chainMaxRadiusMm: number
  loopMaxRadiusMm: number
  loopMaxDistanceMm: [number, number]
  chain: EdgeRef[]
  loop: { edge: EdgeRef; supported: boolean }[]
}
interface Summary {
  design: string
  volumeMm3: number
  parts: { triangles: number }[]
}

const geom = useGeomEngine('design-edge-limits')

describe('a client sizes a round from the pick', () => {
  it('rounds a loop at the size the pick offers for the loop, and an edge listed twice once', async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Summary }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Rounded box' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20, cornerRadiusMm: 3 }, distance_mm: 6, name: 'Box' })

    const e = await h.call('slicerx_geom_edge_pick', { design: d, face: { at: [0, -9.9, 6], normal: [0, 0, 1] }, list_edges: true })
    expect(e.isError, text(e)).toBeFalsy()
    const pick = data<{ output: Pick }>(e).output
    expect(pick.supported).toBe(true)
    // the straight edge alone holds a round as tall as the wall; the corners' sides on its loop hold 3 mm
    expect(pick.maxRadiusMm).toBeCloseTo(6, 3)
    expect(pick.loopMaxRadiusMm).toBeLessThanOrEqual(3)
    expect(pick.loopMaxRadiusMm).toBeGreaterThan(2.9)
    expect(pick.chainMaxRadiusMm).toBeLessThanOrEqual(pick.maxRadiusMm)
    expect(pick.loopMaxRadiusMm).toBeLessThanOrEqual(pick.chainMaxRadiusMm)
    const loop = pick.loop.filter((l) => l.supported).map((l) => l.edge)

    // what the pick offers for the loop goes through; a little more is refused
    const over = await h.call('slicerx_geom_fillet', { design: d, edges: loop, radius_mm: pick.loopMaxRadiusMm + 0.05, all_or_nothing: true })
    expect(over.isError).toBe(true)
    expect(text(over)).toMatch(/does not fit/)
    const once = await ok('slicerx_geom_fillet', { design: d, edges: loop, radius_mm: 1 })
    await ok('slicerx_design_undo', { design: d })

    // the chain and the loop together name the picked edge twice: it is rounded once
    const twice = await ok('slicerx_geom_fillet', { design: d, edges: [...pick.chain, ...loop], radius_mm: 1 })
    expect(twice.parts[0]!.triangles).toBe(once.parts[0]!.triangles)
    expect(twice.volumeMm3).toBeCloseTo(once.volumeMm3, 6)
    await ok('slicerx_design_undo', { design: d })
    const at = await ok('slicerx_geom_fillet', { design: d, edges: loop, radius_mm: pick.loopMaxRadiusMm })
    expect(at.volumeMm3).toBeLessThan(once.volumeMm3)
    await h.client.close()
  })
})
