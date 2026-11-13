// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One call, one undo, as a client sees it: the steps a rail adds together (its posts and bar) share a group, undo takes
// them off together, and redo puts them back together. Steps made one call each, a hole and its counterbore (so the
// head alone can be undone and made again), and steps from a file saved before groups undo one at a time as before.
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readZip, writeZip } from '../src/zip'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  steps: number
  sizeMm: V3
  volumeMm3: number
  parts: { name: string }[]
}
interface Row {
  name: string
  state: string
  group?: string
}

const geom = useGeomEngine('undo-group-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

async function block() {
  const h = await connect({ geomEngine: engine })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  const said = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ summary: string }>(r).summary
  }
  const d = (await ok('slicerx_design_new', { name: 'Block' })).design
  // a block 40 x 20 mm and 5 mm tall, its top at z 5
  const first = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 5 })
  const steps = async (id = d) => data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: id })).output.steps
  // the design as it stands: its step count, volume, size and parts
  const now = async (id = d) => {
    const o = data<{ output: Omit<Summary, 'steps'> & { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: id })).output
    return { steps: o.steps.length, volumeMm3: o.volumeMm3, sizeMm: o.sizeMm, parts: o.parts.map((p) => p.name) }
  }
  return { h, ok, said, d, first, steps, now }
}

describe('the steps one call adds undo as one', () => {
  it('takes a rail off in one undo, leaving the design as it was, and puts both its steps back in one redo', async () => {
    const { ok, said, d, first, steps, now } = await block()
    const railed = await ok('slicerx_geom_rail', { design: d, face: { point: [0, 0, 5] }, height_mm: 3 })
    expect(railed.steps).toBe(3)
    const rows = await steps()
    // the two steps of the call share one group; the block's own step has none
    expect(rows[0]!.group).toBeUndefined()
    expect(rows[1]!.group).toBeTruthy()
    expect(rows[2]!.group).toBe(rows[1]!.group)
    expect(await said('slicerx_design_undo', { design: d })).toMatch(/^Removed Rail posts, \d+ and Rail bar$/)
    expect(await now()).toEqual({ steps: 1, volumeMm3: first.volumeMm3, sizeMm: first.sizeMm, parts: ['Body'] })
    expect(await said('slicerx_design_redo', { design: d })).toMatch(/^Put back Rail posts, \d+ and Rail bar$/)
    const back = await steps()
    expect(back.map((s) => [s.name, s.state, s.group])).toEqual(rows.map((s) => [s.name, s.state, s.group]))
    expect((await now()).volumeMm3).toBeCloseTo(railed.volumeMm3, 6)
  }, 60_000)

  it('undoes a hole and its counterbore one step at a time, so the head alone comes off', async () => {
    const { ok, said, d, steps, now } = await block()
    await ok('slicerx_geom_hole', { design: d, center: [0, 0, 5], diameter_mm: 3.4, counterbore: { diameter_mm: 6.5, depth_mm: 2 } })
    const rows = await steps()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.group)).toEqual([undefined, undefined, undefined])
    expect(await said('slicerx_design_undo', { design: d })).not.toMatch(/ and /)
    expect((await now()).steps).toBe(2)
  }, 60_000)

  it('undoes steps made one call each one at a time, as before', async () => {
    const { ok, said, d, now } = await block()
    await ok('slicerx_geom_hole', { design: d, center: [-10, 0, 5], diameter_mm: 3 })
    await ok('slicerx_geom_hole', { design: d, center: [10, 0, 5], diameter_mm: 3 })
    expect(await said('slicerx_design_undo', { design: d })).toBe('Removed Hole 3 mm')
    expect((await now()).steps).toBe(2)
    expect(await said('slicerx_design_redo', { design: d })).toBe('Put back Hole 3 mm')
    expect((await now()).steps).toBe(3)
  }, 60_000)

  it('saves the group and opens it again, and a file saved before groups undoes one step at a time', async () => {
    const { h, ok, said, d, now } = await block()
    await ok('slicerx_geom_rail', { design: d, face: { point: [0, 0, 5] }, height_mm: 3 })
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const open = async (path: string) => data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path })).output.designs[0]!
    // saved and opened again, the rail still undoes in one
    const again = await open(saved.path)
    expect(again.steps).toBe(3)
    expect(await said('slicerx_design_undo', { design: again.design })).toMatch(/ and Rail bar$/)
    expect((await now(again.design)).steps).toBe(1)
    // the same file with no group in it, as one saved before groups: each step undoes alone
    const zip = readZip(readFileSync(saved.path))
    const entries = zip.names().map((name) => {
      const bytes = zip.read(name)!
      if (name !== 'Metadata/slicerx_history.json') return { name, data: bytes }
      return { name, data: new TextDecoder().decode(bytes).replace(/,"group":"[^"]*"/g, '') }
    })
    expect(entries.some((e) => typeof e.data === 'string' && !e.data.includes('"group"'))).toBe(true)
    const old = saved.path.replace(/\.3mf$/, '-old.3mf')
    writeFileSync(old, writeZip(entries))
    const before = await open(old)
    expect(before.steps).toBe(3)
    expect(await said('slicerx_design_undo', { design: before.design })).toBe('Removed Rail bar')
    expect((await now(before.design)).steps).toBe(2)
  }, 60_000)
})
