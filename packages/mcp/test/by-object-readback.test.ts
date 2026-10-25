// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object through the integrator path: slicerx_project_show reads each plate's clearance plan back as the app
// draws it (the pairs too close with their ids, the tall objects, each object's footprint and zone), and a slice sx
// refuses with sequence_clearance names the pair by id with slicerx_arrange as the fix.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ByObjectReadback } from '@slicerx/settings/by-object'
import { boxStl, connect, data, noSx, sxBin, type Harness } from './helpers'

type Res<T> = { ok?: boolean; output: T; error?: { code: string; message: string; details?: Record<string, unknown> } }
type Shown = { plates: { index: number; placements: { id: string }[]; byObject?: ByObjectReadback }[] }

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Res<T>>(r)
  expect(r.isError, `${name}: ${JSON.stringify(d).slice(0, 400)}`).not.toBe(true)
  return d
}

/** Two 20 mm boxes side by side in the plate's rows, much closer than any clearance, on `printer` with `changes`. */
async function twoBoxes(h: Harness, printer: string, changes: Record<string, unknown>): Promise<void> {
  writeFileSync(join(h.dir, 'a.stl'), boxStl(20, 20, 10))
  writeFileSync(join(h.dir, 'b.stl'), boxStl(20, 20, 10))
  await call(h, 'slicerx_project_open', { printer, filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'a.stl') })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'b.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { skirt_loops: 0, brim_type: 'no_brim', ...changes } })
}

describe('the by-object read-back', () => {
  it('gives a by-object plate its pairs, tall objects and zones, and nothing by layer', async () => {
    const h = await connect({})
    try {
      await twoBoxes(h, 'Bambu Lab P1S', { print_sequence: 'by object' })
      const plate = (await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!
      const b = plate.byObject!
      expect(b.needMm).toBeGreaterThan(20)
      const ids = plate.placements.map((p) => p.id)
      expect(b.pairs).toHaveLength(1)
      expect([b.pairs[0]!.a.id, b.pairs[0]!.b.id]).toEqual(ids)
      expect(b.pairs[0]!.gapMm).toBeLessThan(b.needMm)
      // side by side, the head would come down on the first box
      expect(b.pairs[0]!.severity).toBe('block')
      expect(b.tall).toEqual([])
      expect(b.outlines.map((o) => o.id)).toEqual(ids)
      // each zone is the footprint grown by half the clearance
      const o = b.outlines[0]!
      const width = (r: [number, number][]) => Math.max(...r.map((p) => p[0])) - Math.min(...r.map((p) => p[0]))
      expect(width(o.footprint)).toBeCloseTo(20, 0)
      expect(width(o.zone)).toBeCloseTo(20 + b.needMm, 0)
      await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by layer' } })
      expect((await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.byObject).toBeUndefined()
    } finally {
      await h.client.close()
    }
  })

  it('counts the support round an object only when it gets support, as the app does', async () => {
    const h = await connect({})
    try {
      writeFileSync(join(h.dir, 'a.stl'), boxStl(20, 20, 10))
      writeFileSync(join(h.dir, 'ledge.stl'), ledgeStl())
      writeFileSync(join(h.dir, 'b.stl'), boxStl(20, 20, 10))
      await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
      for (const m of ['a.stl', 'ledge.stl', 'b.stl']) await call(h, 'slicerx_project_add_model', { model: join(h.dir, m) })
      await call(h, 'slicerx_project_set_overrides', { changes: { skirt_loops: 0, brim_type: 'no_brim', print_sequence: 'by object', enable_support: true, support_type: 'tree(auto)', support_threshold_angle: 25 } })
      await call(h, 'slicerx_project_move', { object: 'obj-1', x: 110, y: 60 })
      await call(h, 'slicerx_project_move', { object: 'obj-2', x: 160, y: 60 })
      await call(h, 'slicerx_project_move', { object: 'obj-3', x: 110, y: 110 })
      const reach = async () => Object.fromEntries((await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!.pairs.map((p) => [`${p.a.id} ${p.b.id}`, p.reachMm]))
      const ids = (await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.placements.map((p) => p.id)
      // The ledge's flat underside gets tree support, whose pad reaches 7.9 mm; the boxes have nothing to hold up.
      const on = await reach()
      expect(on[`${ids[0]} ${ids[1]}`]).toBeCloseTo(7.9, 1)
      expect(on[`${ids[0]} ${ids[2]}`]).toBe(0)
      await call(h, 'slicerx_project_set_overrides', { changes: { enable_support: false } })
      expect((await reach())[`${ids[0]} ${ids[1]}`]).toBe(0)
    } finally {
      await h.client.close()
    }
  })

  it('marks a pair a measured head clears as a close call and the same pair on an A1 as blocking', async () => {
    const h = await connect({})
    try {
      await twoApart(h, 'Bambu Lab P1S', { printer_model: 'Bambu Lab P1S' })
      expect((await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!.pairs.map((p) => p.severity)).toEqual(['soft'])
      await call(h, 'slicerx_project_set_overrides', { changes: { printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73 } })
      expect((await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!.pairs.map((p) => p.severity)).toEqual(['block'])
    } finally {
      await h.client.close()
    }
  })
})

/** A 20 mm box 10 mm tall with a 30 by 20 mm slab 3 mm thick on it, 5 mm out each side: a flat underside to hold up. */
function ledgeStl(): Buffer {
  const post = boxStl(20, 20, 10)
  const slab = boxStl(30, 20, 3)
  for (let t = 0; t < 12; t++) {
    for (let k = 0; k < 3; k++) {
      const o = 84 + t * 50 + 12 + k * 12
      slab.writeFloatLE(slab.readFloatLE(o) - 5, o)
      slab.writeFloatLE(slab.readFloatLE(o + 8) + 10, o + 8)
    }
  }
  const out = Buffer.concat([post.subarray(0, 84 + 12 * 50), slab.subarray(84)])
  out.writeUInt32LE(24, 80)
  return out
}

/** The two boxes 30 mm apart, by object, on `printer` with `changes`: inside any Bambu Lab radius, clear of the head. */
async function twoApart(h: Harness, printer: string, changes: Record<string, unknown>): Promise<void> {
  await twoBoxes(h, printer, { print_sequence: 'by object', ...changes })
  await call(h, 'slicerx_project_move', { object: 'obj-1', x: 110, y: 128 })
  await call(h, 'slicerx_project_move', { object: 'obj-2', x: 160, y: 128 })
}

describe.skipIf(noSx())('a by-object refusal from sx', () => {
  it('names the pair by id and offers slicerx_arrange', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      // An A1, whose head is not measured, with the printer model and max radius a Bambu Studio project carries.
      await twoBoxes(h, 'Bambu Lab A1', { print_sequence: 'by object', printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73 })
      const ids = (await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.placements.map((p) => p.id)
      const r = await h.call('slicerx_slice')
      expect(r.isError).toBe(true)
      const e = data<Res<unknown>>(r).error!
      expect(e.code).toBe('sequence_clearance')
      expect(e.details?.['fix']).toBe('slicerx_arrange')
      expect(e.details?.['needMm']).toBe(73)
      const pairs = e.details?.['pairs'] as ByObjectReadback['pairs']
      expect(pairs.map((p) => [p.a.id, p.b.id, p.severity])).toEqual([[...ids, 'block']])
      // The collision itself names the two objects by the ids slicerx_project_show gives them.
      const items = e.details?.['collisions'] as { kind: string; object_ids?: string[]; engine_objects?: string[] }[]
      expect(items[0]?.kind).toBe('clearance')
      expect([...(items[0]?.object_ids ?? [])].sort()).toEqual([...ids].sort())
      expect(items[0]?.engine_objects).toHaveLength(2)
    } finally {
      await h.client.close()
    }
  }, 240_000)

  it('names two copies of one model that enter a keep-out zone by their own ids', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      writeFileSync(join(h.dir, 'peg.stl'), boxStl(20, 20, 10))
      await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'peg.stl') })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'peg.stl') })
      await call(h, 'slicerx_project_move', { object: 'obj-1', x: 100, y: 128 })
      await call(h, 'slicerx_project_move', { object: 'obj-2', x: 160, y: 128 })
      // an A1 style nozzle wrap check zone over the whole bed
      await call(h, 'slicerx_project_set_overrides', { changes: { skirt_loops: 0, brim_type: 'no_brim', head_wrap_detect_zone: ['0x0', '256x0', '256x256', '0x256'] } })
      const ids = (await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.placements.map((p) => p.id)
      expect(ids).toHaveLength(2)
      const r = await h.call('slicerx_slice')
      expect(r.isError, JSON.stringify(data(r)).slice(0, 400)).toBe(true)
      const e = data<Res<unknown>>(r).error!
      expect(e.code).toBe('collision')
      const items = (e.details?.['collisions'] as { kind: string; object?: string; object_ids?: string[] }[]).filter((i) => i.kind === 'keep_out')
      // The words name both by the one file name; the ids tell them apart.
      expect(items).toHaveLength(2)
      expect(items[0]?.object).toBe(items[1]?.object)
      expect(items.flatMap((i) => i.object_ids ?? []).sort()).toEqual([...ids].sort())
    } finally {
      await h.client.close()
    }
  }, 240_000)

  it('slices a pair the read-back calls a close call', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      await twoApart(h, 'Bambu Lab P1S', { printer_model: 'Bambu Lab P1S' })
      expect((await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!.pairs.map((p) => p.severity)).toEqual(['soft'])
      const r = await h.call('slicerx_slice')
      expect(r.isError, JSON.stringify(data(r)).slice(0, 400)).not.toBe(true)
    } finally {
      await h.client.close()
    }
  }, 240_000)
})
