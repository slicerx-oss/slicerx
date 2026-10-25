// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_arrange lays a project's plate out with the nest the app runs, on true outlines: clear of the printer's
// excluded areas and the prime tower's room, and with the room each part's first layer brim takes. Read back the way a
// client reads it, from slicerx_project_show. Runs the real geometry engine when it is built, else replies recorded
// from it (test/geom-engine.ts); the last test slices the arranged plate with the real sx and sx-geom.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@slicerx/contracts'
import { autoBrimRoom } from '@slicerx/settings/print-margins'
import { hullDistance } from '@slicerx/settings/by-object'
import { useGeomEngine } from './geom-engine'
import { boxStl, connect, data, noSx, noSxGeom, sxBin, type Harness } from './helpers'

const g = useGeomEngine('arrange-zones')

type Placement = { id: string; centerMm: [number, number]; sizeMm: [number, number, number] }
type Shown = { plates: { index: number; placements: Placement[] }[] }
type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  const out = { ...d, ok: d.ok ?? !r.isError } as Res<T>
  expect(out.ok, `${name}: ${out.error?.message ?? out.summary}`).toBe(true)
  return out
}

/** Each copy's box on the bed, mm. */
async function boxes(h: Harness): Promise<{ x0: number; y0: number; x1: number; y1: number }[]> {
  const shown = (await call<Shown>(h, 'slicerx_project_show')).output
  return shown.plates[0]!.placements.map((p) => ({ x0: p.centerMm[0] - p.sizeMm[0] / 2, y0: p.centerMm[1] - p.sizeMm[1] / 2, x1: p.centerMm[0] + p.sizeMm[0] / 2, y1: p.centerMm[1] + p.sizeMm[1] / 2 }))
}

type Box = Awaited<ReturnType<typeof boxes>>[number]
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
/** The gap between two boxes, mm; 0 when they touch or overlap. */
const gapOf = (a: Box, b: Box): number => Math.hypot(Math.max(0, b.x0 - a.x1, a.x0 - b.x1), Math.max(0, b.y0 - a.y1, a.y0 - b.y1))

/** A P1S project with `model` loaded and the settings `changes`. */
async function project(h: Harness, model: Buffer, changes: Record<string, SettingValue>): Promise<void> {
  writeFileSync(join(h.dir, 'part.stl'), model)
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes })
}

/** Boxes in one STL, each `[x, y, z, width, depth, height]`, mm. */
function boxesStl(list: [number, number, number, number, number, number][]): Buffer {
  const parts = list.map(([x, y, z, w, d, ht]) => {
    const b = boxStl(w, d, ht)
    for (let t = 0; t < 12; t++) for (let k = 0; k < 3; k++) [x, y, z].forEach((v, j) => b.writeFloatLE(b.readFloatLE(84 + t * 50 + 12 + k * 12 + j * 4) + v, 84 + t * 50 + 12 + k * 12 + j * 4))
    return b
  })
  const out = Buffer.concat([parts[0]!, ...parts.slice(1).map((b) => b.subarray(84))])
  out.writeUInt32LE(12 * list.length, 80)
  return out
}

/** A mushroom: a 10 mm stem under a 30 x 30 x 3 mm cap, whose overhang takes support. */
const MUSHROOM = boxesStl([[10, 10, 0, 10, 10, 10], [0, 0, 10, 30, 30, 3]])

/** Support in filament 2, so the plate prints in two filaments and gets a prime tower. */
async function twoFilaments(h: Harness): Promise<void> {
  await call(h, 'slicerx_project_add_filament', { type: 'PLA', color: '#2255FF' })
}
const SUPPORT_2 = { enable_support: true, support_filament: 2 }

/** An excluded front left corner, 100 mm square, as `bed_exclude_area` lists it. */
const CORNER = ['0x0', '100x0', '100x100', '0x100']
/** The prime tower on, at the default spot 15, 220, the project's 60 mm width and 3 mm brim. */
const TOWER = { enable_prime_tower: true }
/**
 * The tower's room: the tower, its brim and 1 mm. Its spot is pulled in from the back so the brim stays 1 mm inside the
 * 256 mm bed, y = 256 - 1 - 3 - 60 = 192. Arrange keeps the same room whether the engine places the tower (auto) or
 * it stays at its spot.
 */
const ROOM: Box = { x0: 15 - 3 - 1, y0: 192 - 3 - 1, x1: 15 + 60 + 3 + 1, y1: 256 }

/**
 * Three 20 mm boxes printed by object on an A1, whose head is not measured, with the printer model and max radius a
 * Bambu Studio project carries: sx then refuses objects inside the 73 mm max radius, the larger of the profile's two,
 * so arrange has to keep that much between them, not the 40 mm extruder_clearance_radius.
 */
async function byObjectA1(h: Harness): Promise<void> {
  writeFileSync(join(h.dir, 'part.stl'), boxStl(20, 20, 10))
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73, skirt_loops: 0, brim_type: 'no_brim' } })
  await call(h, 'slicerx_arrange', { count: 3 })
}

/**
 * The z27 shape on the same A1: copies of a 45 mm bracket (a 20 mm box 45 mm tall here) printed by object, the gantry
 * rod at 34 mm. Every copy is taller than the rod, so the gantry over a later copy meets an earlier one unless each has
 * a lane of its own: no other copy within the rod's reach in y.
 */
async function z27A1(h: Harness, count = 2, changes: Record<string, SettingValue> = {}): Promise<void> {
  writeFileSync(join(h.dir, 'bracket.stl'), boxStl(20, 90, 45))
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'bracket.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73, extruder_clearance_height_to_rod: 34, skirt_loops: 0, brim_type: 'no_brim', ...changes } })
  await call(h, 'slicerx_arrange', { count })
}

/** The keep-out corner each printer's own profile gives: the A1's nozzle wrap check corner, the P1S's excluded corner. */
const KEEP_OUT: Record<string, Box> = { 'Bambu Lab A1': { x0: 226, y0: 224, x1: 256, y1: 256 }, 'Bambu Lab P1S': { x0: 0, y0: 0, x1: 18, y1: 28 } }

/** The z27 brackets on another printer, which keeps its own keep-out corner: tall copies that each need a gantry lane. */
async function lanesOn(h: Harness, printer: string): Promise<void> {
  writeFileSync(join(h.dir, 'bracket.stl'), boxStl(20, 90, 45))
  await call(h, 'slicerx_project_open', { printer, filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'bracket.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', printer_model: printer, extruder_clearance_max_radius: 73, extruder_clearance_height_to_rod: 34, skirt_loops: 0, brim_type: 'no_brim' } })
  await call(h, 'slicerx_arrange', { count: 2 })
}

type ByObjectShown = { plates: { byObject?: { pairs: unknown[]; tall: unknown[]; gantry: { rodMm: number; reachMm: number } } }[] }

describe('slicerx_arrange on true outlines', () => {
  it('keeps copies off the corner an A1 runs its nozzle wrap check in, from its own profile', async () => {
    const h = await connect({ geomEngine: g.engine })
    writeFileSync(join(h.dir, 'part.stl'), boxStl(20, 20, 10))
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
    await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', skirt_loops: 0, brim_type: 'no_brim' } })
    await call(h, 'slicerx_arrange', { count: 8 })
    const placed = await boxes(h)
    expect(placed).toHaveLength(8)
    const corner: Box = { x0: 226, y0: 224, x1: 256, y1: 256 }
    for (const b of placed) expect(overlaps(b, corner), JSON.stringify(b)).toBe(false)
  })

  // Support on: copies of a box have nothing to hold up, so they keep the clearance alone; copies of a mushroom keep
  // its tree support pad (7.9 mm) too, as the check counts them.
  for (const [model, padded] of [['box', false], ['mushroom', true]] as const) {
    it(`spaces copies of a ${model} by the clearance${padded ? ' and its support pad' : ' alone'}, with support on`, async () => {
      const h = await connect({ geomEngine: g.engine })
      await project(h, padded ? MUSHROOM : boxStl(20, 20, 10), { print_sequence: 'by object', skirt_loops: 0, brim_type: 'no_brim', enable_support: true, support_type: 'tree(auto)', support_threshold_angle: 25 })
      await call(h, 'slicerx_arrange', { count: 3 })
      type Outline = { id: string; footprint: [number, number][] }
      const shown = (await call<{ plates: { byObject: { needMm: number; pairs: unknown[]; outlines: Outline[] } }[] }>(h, 'slicerx_project_show')).output.plates[0]!.byObject
      expect(shown.pairs).toEqual([])
      expect(shown.outlines).toHaveLength(3)
      const d: number[] = []
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) d.push(hullDistance(shown.outlines[i]!.footprint, shown.outlines[j]!.footprint))
      for (const v of d) expect(v).toBeGreaterThanOrEqual(shown.needMm - 0.1 + (padded ? 7.9 : 0))
      if (!padded) expect(Math.min(...d)).toBeLessThan(shown.needMm + 7.9)
    })
  }


  it('keeps the clearance the by-object check holds an A1 to between copies', async () => {
    const h = await connect({ geomEngine: g.engine })
    await byObjectA1(h)
    const placed = await boxes(h)
    expect(placed).toHaveLength(3)
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(gapOf(placed[i]!, placed[j]!)).toBeGreaterThanOrEqual(73)
  })

  it('gives each copy taller than the gantry rod a lane of its own, so the by-object check passes', async () => {
    const h = await connect({ geomEngine: g.engine })
    await z27A1(h)
    const placed = await boxes(h)
    expect(placed).toHaveLength(2)
    const b = (await call<ByObjectShown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!
    expect(b.gantry.rodMm).toBe(34)
    expect(b.tall).toEqual([])
    expect(b.pairs).toEqual([])
    // the lanes: each pair of copies further apart in y than the rod reaches (twice the read-back's reach)
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const [p, q] = [placed[i]!, placed[j]!]
      expect(Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1)).toBeGreaterThanOrEqual(2 * b.gantry.reachMm)
    }
  })

  it.each(Object.keys(KEEP_OUT))('keeps tall copies in gantry lanes of their own and off the keep-out corner of the %s', async (printer) => {
    const h = await connect({ geomEngine: g.engine })
    await lanesOn(h, printer)
    const placed = await boxes(h)
    expect(placed).toHaveLength(2)
    for (const b of placed) expect(overlaps(b, KEEP_OUT[printer]!), JSON.stringify(b)).toBe(false)
    const b = (await call<ByObjectShown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!
    expect(b.tall).toEqual([])
    expect(b.pairs).toEqual([])
    const [p, q] = [placed[0]!, placed[1]!]
    expect(Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1)).toBeGreaterThanOrEqual(2 * b.gantry.reachMm)
  })

  it('moves the lanes layout to the middle of the bed as a whole, and the by-object check still passes', async () => {
    const h = await connect({ geomEngine: g.engine })
    await z27A1(h)
    const placed = await boxes(h)
    expect(placed).toHaveLength(2)
    const b = (await call<ByObjectShown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!
    expect(b.tall).toEqual([])
    expect(b.pairs).toEqual([])
    // within a cell of the middle of the A1's 256 mm bed, since it moves in whole cells
    const mid = (lo: number, hi: number) => (lo + hi) / 2
    expect(Math.abs(mid(Math.min(...placed.map((p) => p.x0)), Math.max(...placed.map((p) => p.x1))) - 128)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(mid(Math.min(...placed.map((p) => p.y0)), Math.max(...placed.map((p) => p.y1))) - 128)).toBeLessThanOrEqual(0.5)
  })

  it('keeps every copy out of an excluded corner', async () => {
    const h = await connect({ geomEngine: g.engine })
    await project(h, boxStl(30, 30, 10), { bed_exclude_area: CORNER, skirt_loops: 0 })
    await call(h, 'slicerx_arrange', { count: 20 })
    const placed = await boxes(h)
    expect(placed).toHaveLength(20)
    const corner: Box = { x0: 0, y0: 0, x1: 100, y1: 100 }
    for (const b of placed) expect(overlaps(b, corner), JSON.stringify(b)).toBe(false)
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i]!, placed[j]!)).toBe(false)
  })

  it.each([true, false])('keeps the prime tower room clear when the plate prints in two filaments (auto position %s)', async (auto) => {
    const h = await connect({ geomEngine: g.engine })
    await project(h, MUSHROOM, { ...TOWER, ...SUPPORT_2, prime_tower_auto_position: auto, skirt_loops: 0 })
    await twoFilaments(h)
    await call(h, 'slicerx_arrange', { count: 20 })
    const placed = await boxes(h)
    expect(placed).toHaveLength(20)
    for (const b of placed) expect(overlaps(b, ROOM), JSON.stringify(b)).toBe(false)
  })

  it('keeps thin standing parts apart by the brims their first layers print', async () => {
    // A slow, tall, thin wall: the bounds estimate gives it no brim, the engine a few loops from its first layer.
    const slow = 30
    const cfg: Record<string, SettingValue> = {
      brim_type: 'auto_brim',
      brim_width: 0,
      brim_object_gap: 0,
      skirt_loops: 0,
      line_width: 0.42,
      initial_layer_line_width: 0.5,
      initial_layer_print_height: 0.2,
      ...Object.fromEntries(['inner_wall_speed', 'outer_wall_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'support_speed'].map((k) => [k, slow])),
    }
    const h = await connect({ geomEngine: g.engine })
    await project(h, boxStl(60, 1.6, 40), cfg)
    await call(h, 'slicerx_arrange', { count: 6 })
    const placed = await boxes(h)
    expect(placed).toHaveLength(6)
    const base = [{ outer: [[0, 0], [60, 0], [60, 1.6], [0, 1.6]] as [number, number][], holes: [] }]
    const room = autoBrimRoom({ ...cfg, nozzle_diameter: 0.4, filament_type: 'PLA' }, base, 40)
    expect(room).toBeGreaterThan(4)
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(gapOf(placed[i]!, placed[j]!)).toBeGreaterThanOrEqual(2 * room + 1 - 0.05)
  })
})

describe.skipIf(noSx() || noSxGeom())('an arranged plate sliced with sx', () => {
  // With support in filament 2 the plate has a prime tower. The skirt is off here, since these cases check the tower
  // and the excluded corner. The margins count the first layer of normal support as the engine prints it, one grid
  // cell and the pad past the overhang (about 5.05 mm on these settings), so a skirt round it would stay on the bed.
  it('slices with no collision: excluded corner, prime tower at its spot, brims', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    // The tower at its spot: with auto position the engine picks one next to the parts itself.
    await project(h, MUSHROOM, { ...TOWER, ...SUPPORT_2, prime_tower_auto_position: false, bed_exclude_area: CORNER, skirt_loops: 0 })
    await twoFilaments(h)
    await call(h, 'slicerx_arrange', { count: 16 })
    expect(await boxes(h)).toHaveLength(16)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  for (const sequence of ['by layer', 'by object'] as const) {
    it(`slices an A1 plate it arranged ${sequence} clear of the nozzle wrap check corner`, async () => {
      const h = await connect({ engine: 'sx', sxBin })
      writeFileSync(join(h.dir, 'part.stl'), boxStl(20, 20, 10))
      await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
      await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: sequence, skirt_loops: 0, brim_type: 'no_brim' } })
      await call(h, 'slicerx_arrange', { count: sequence === 'by object' ? 8 : 36 })
      const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
      expect(sliced.output.total.grams).toBeGreaterThan(0)
    }, 280_000)
  }

  // Copies spaced by their own reach as the check counts it (a box by the clearance alone, a mushroom by its support pad
  // too), on a printer whose head is estimated (A1, refused inside the radius) and one whose head is measured (P1S).
  for (const [printer, changes] of [
    ['Bambu Lab A1', { printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73 }],
    ['Bambu Lab P1S', {}],
  ] as const) {
    for (const model of ['box', 'mushroom'] as const) {
      it(`slices by-object copies of a ${model} it spaced with support on, on the ${printer}`, async () => {
        const h = await connect({ engine: 'sx', sxBin })
        writeFileSync(join(h.dir, 'part.stl'), model === 'box' ? boxStl(20, 20, 10) : MUSHROOM)
        await call(h, 'slicerx_project_open', { printer, filament: 'Bambu PLA Basic' })
        await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
        await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', skirt_loops: 0, brim_type: 'no_brim', enable_support: true, support_type: 'tree(auto)', support_threshold_angle: 25, ...changes } })
        await call(h, 'slicerx_arrange', { count: 3 })
        expect(await boxes(h)).toHaveLength(3)
        const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
        expect(sliced.output.total.grams).toBeGreaterThan(0)
      }, 240_000)
    }
  }

  it('slices a by-object plate it spaced with no sequence_clearance refusal', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await byObjectA1(h)
    expect(await boxes(h)).toHaveLength(3)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it('slices a by-object plate of copies taller than the gantry rod with no sequence_clearance refusal', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await z27A1(h)
    expect(await boxes(h)).toHaveLength(2)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it.each(Object.keys(KEEP_OUT))('slices gantry lane copies on the %s clear of its keep-out corner', async (printer) => {
    const h = await connect({ engine: 'sx', sxBin })
    await lanesOn(h, printer)
    expect(await boxes(h)).toHaveLength(2)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it('slices the tall copies it laid out in the middle of a P1S, with no sequence_clearance refusal', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    writeFileSync(join(h.dir, 'bracket.stl'), boxStl(20, 90, 45))
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'bracket.stl') })
    await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', printer_model: 'Bambu Lab P1S', extruder_clearance_max_radius: 68, extruder_clearance_height_to_rod: 34, extruder_clearance_dist_to_rod: 33, skirt_loops: 0, brim_type: 'no_brim' } })
    await call(h, 'slicerx_arrange', { count: 2 })
    const placed = await boxes(h)
    expect(placed).toHaveLength(2)
    expect(Math.abs((Math.min(...placed.map((p) => p.y0)) + Math.max(...placed.map((p) => p.y1))) / 2 - 128)).toBeLessThanOrEqual(0.5)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it.each([
    ['a 5 mm brim', { brim_type: 'outer_only', brim_width: 5 }],
    ['a skirt round each copy', { skirt_loops: 2, skirt_distance: 3, skirt_type: 'perobject' }],
  ] as const)('slices the tall copies it spaced with %s, with no sequence_clearance refusal', async (_what, changes) => {
    const h = await connect({ engine: 'sx', sxBin })
    await z27A1(h, 2, changes)
    expect(await boxes(h)).toHaveLength(2)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it('slices with no collision: excluded corner, skirt and brims', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await project(h, boxStl(30, 30, 10), { bed_exclude_area: CORNER, skirt_loops: 2, skirt_distance: 3 })
    await call(h, 'slicerx_arrange', { count: 24 })
    expect(await boxes(h)).toHaveLength(24)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it('slices a plate of 12 mm cubes on an A1 by object whose skirt has a minimum length, which adds loops round each', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    writeFileSync(join(h.dir, 'part.stl'), boxStl(12, 12, 5))
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
    // one loop asked for; 20 mm of filament takes seven round a 12 mm cube
    await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', brim_type: 'no_brim', skirt_loops: 1, min_skirt_length: 20 } })
    await call(h, 'slicerx_arrange', { count: 9 })
    expect(await boxes(h)).toHaveLength(9)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it('slices both plates when it puts ten 20 mm cubes five to a plate on an A1 by object, with the skirt round each', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    writeFileSync(join(h.dir, 'part.stl'), boxStl(20, 20, 20))
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
    // the profile's own skirt, combined: printing by object each cube still gets one round it
    await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', skirt_loops: 1, skirt_type: 'combined' } })
    expect((await call(h, 'slicerx_arrange', { count: 10, plates: 2 })).summary).toBe('5 per plate on 2 plates')
    for (const plate of [1, 2]) {
      const sliced = await call<{ plates: { plate: number }[] }>(h, 'slicerx_slice', { plates: [plate] })
      expect(sliced.output.plates.map((p) => p.plate)).toEqual([plate])
    }
  }, 240_000)
})

/**
 * Half the by-object spacing each printer's profile gives, mm: (its clearance radius + 1 mm) / 2, 73 mm on the A1 and
 * 68 mm on the P1S. A gantry lane or any zone other than the printer's own keep-out areas keeps this much.
 */
const HALF: Record<string, number> = { 'Bambu Lab A1': 37, 'Bambu Lab P1S': 34.5 }

/** By-object set-ups, and how many 20 mm boxes then fill each printer's plate. */
const SETUPS: [string, Record<string, SettingValue>, Record<string, number>][] = [
  ['no brim or skirt', { brim_type: 'no_brim', skirt_loops: 0 }, { 'Bambu Lab A1': 8, 'Bambu Lab P1S': 9 }],
  ['a 5 mm brim', { brim_type: 'outer_only', brim_width: 5, skirt_loops: 0 }, { 'Bambu Lab A1': 8, 'Bambu Lab P1S': 8 }],
  ['a 2 loop skirt', { brim_type: 'no_brim', skirt_loops: 2, skirt_distance: 3 }, { 'Bambu Lab A1': 8, 'Bambu Lab P1S': 8 }],
]
const FULL = Object.keys(KEEP_OUT).flatMap((printer) => SETUPS.map(([name, changes, count]) => [printer, name, changes, count[printer]!] as const))

/** A full by-object plate of 20 mm boxes on `printer`. */
async function fullByObject(h: Harness, printer: string, changes: Record<string, SettingValue>, count: number): Promise<void> {
  writeFileSync(join(h.dir, 'part.stl'), boxStl(20, 20, 10))
  await call(h, 'slicerx_project_open', { printer, filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', ...changes } })
  await call(h, 'slicerx_arrange', { count })
}

/** Two tall 230 x 58 mm brackets by object on an A1, each needing a gantry lane of its own. */
async function wideLanesA1(h: Harness): Promise<void> {
  writeFileSync(join(h.dir, 'bracket.stl'), boxStl(230, 58, 45))
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'bracket.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73, extruder_clearance_height_to_rod: 34, skirt_loops: 0, brim_type: 'no_brim' } })
  await call(h, 'slicerx_arrange', { count: 2 })
}

describe('slicerx_arrange next to the printer keep-out corner, printing by object', () => {
  // Nothing prints in the corner, so a copy keeps its edge spacing from it (at least the 6 mm gap), not half the
  // extruder clearance that keeps two printed copies apart.
  it.each(FULL)('a full %s plate with %s uses the room by the corner and stays out of it', async (printer, _name, changes, count) => {
    const h = await connect({ geomEngine: g.engine })
    await fullByObject(h, printer, changes, count)
    const placed = await boxes(h)
    expect(placed).toHaveLength(count)
    const corner = KEEP_OUT[printer]!
    for (const b of placed) expect(overlaps(b, corner), JSON.stringify(b)).toBe(false)
    const near = Math.min(...placed.map((b) => gapOf(b, corner)))
    expect(near).toBeGreaterThanOrEqual(6 - 1e-3)
    expect(near).toBeLessThan(HALF[printer]!)
  })

  it('fits two tall 230 x 58 mm brackets on an A1, each in its own gantry lane', async () => {
    const h = await connect({ geomEngine: g.engine })
    await wideLanesA1(h)
    const placed = await boxes(h)
    expect(placed).toHaveLength(2)
    for (const b of placed) expect(overlaps(b, KEEP_OUT['Bambu Lab A1']!), JSON.stringify(b)).toBe(false)
    const b = (await call<ByObjectShown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!
    expect(b.tall).toEqual([])
    expect(b.pairs).toEqual([])
    const [p, q] = [placed[0]!, placed[1]!]
    expect(Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1)).toBeGreaterThanOrEqual(2 * b.gantry.reachMm)
  })

  it('fits two more 25 mm boxes on a P1S than spacing its corner like a gantry lane', async () => {
    // spaced like a lane (half the 68 mm clearance) seven fit; a skirt round the whole print would also go round each
    // box by object, and the nest tries the half spacing too if the edge spacing ever left copies over
    const h = await connect({ geomEngine: g.engine })
    writeFileSync(join(h.dir, 'part.stl'), boxStl(25, 25, 10))
    await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
    await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', brim_type: 'no_brim', skirt_loops: 0 } })
    await call(h, 'slicerx_arrange', { count: 9 })
    const placed = await boxes(h)
    expect(placed).toHaveLength(9)
    expect(placed.some((b) => overlaps(b, KEEP_OUT['Bambu Lab P1S']!))).toBe(false)
  })
})

describe.skipIf(noSx() || noSxGeom())('a plate arranged next to the printer keep-out corner, sliced with sx', () => {
  it.each(FULL)('slices a full %s plate with %s by object', async (printer, _name, changes, count) => {
    const h = await connect({ engine: 'sx', sxBin })
    await fullByObject(h, printer, changes, count)
    expect(await boxes(h)).toHaveLength(count)
    let refused = ''
    try {
      await call(h, 'slicerx_slice')
    } catch (e) {
      refused = String(e)
    }
    expect(refused).toBe('')
  }, 240_000)

  it('slices the two tall 230 x 58 mm brackets on an A1', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await wideLanesA1(h)
    expect(await boxes(h)).toHaveLength(2)
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)
})
