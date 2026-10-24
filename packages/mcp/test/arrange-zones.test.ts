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

describe('slicerx_arrange on true outlines', () => {
  it('keeps the clearance the by-object check holds an A1 to between copies', async () => {
    const h = await connect({ geomEngine: g.engine })
    await byObjectA1(h)
    const placed = await boxes(h)
    expect(placed).toHaveLength(3)
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(gapOf(placed[i]!, placed[j]!)).toBeGreaterThanOrEqual(73)
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

  it('slices a by-object plate it spaced with no sequence_clearance refusal', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await byObjectA1(h)
    expect(await boxes(h)).toHaveLength(3)
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
})
