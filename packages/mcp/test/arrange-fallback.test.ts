// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_arrange when the geometry engine cannot nest: none is installed (no sx-geom), or it fails. It then packs the
// copies' boxes the way the app's arrange does without the engine (@slicerx/settings/box-pack), with the same room:
// the by-object clearance, the gantry lanes of tall copies and the printer's keep-out areas. More copies than that
// fits are refused with how many fit; it never answers with the rows it started from.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@slicerx/contracts'
import type { SlicerxMcpOptions } from '../src/index'
import { boxStl, connect, data, noSx, sxBin, type Harness } from './helpers'

type Placement = { centerMm: [number, number]; sizeMm: [number, number, number] }
type Shown = { plates: { index: number; placements: Placement[]; byObject?: { pairs: unknown[]; tall: unknown[]; gantry: { reachMm: number } } }[] }
type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }
type Box = { x0: number; y0: number; x1: number; y1: number }

async function send<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  return { ...d, ok: d.ok ?? !r.isError } as Res<T>
}

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const out = await send<T>(h, name, args)
  expect(out.ok, `${name}: ${out.error?.message ?? out.summary}`).toBe(true)
  return out
}

async function shown(h: Harness): Promise<{ boxes: Box[]; plate: Shown['plates'][number] }> {
  const plate = (await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!
  return { plate, boxes: plate.placements.map((p) => ({ x0: p.centerMm[0] - p.sizeMm[0] / 2, y0: p.centerMm[1] - p.sizeMm[1] / 2, x1: p.centerMm[0] + p.sizeMm[0] / 2, y1: p.centerMm[1] + p.sizeMm[1] / 2 })) }
}

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
const gapOf = (a: Box, b: Box): number => Math.hypot(Math.max(0, b.x0 - a.x1, a.x0 - b.x1), Math.max(0, b.y0 - a.y1, a.y0 - b.y1))
const pairs = (list: Box[]): [Box, Box][] => list.flatMap((a, i) => list.slice(i + 1).map((b): [Box, Box] => [a, b]))

/** The A1's own nozzle wrap check corner, and a 100 mm excluded corner a project can add. */
const WRAP: Box = { x0: 226, y0: 224, x1: 256, y1: 256 }
const CORNER: Box = { x0: 0, y0: 0, x1: 100, y1: 100 }

/** An A1 project with one model and the settings `changes`. */
async function a1(h: Harness, model: Buffer, changes: Record<string, SettingValue>): Promise<void> {
  writeFileSync(join(h.dir, 'part.stl'), model)
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { printer_model: 'Bambu Lab A1', skirt_loops: 0, brim_type: 'no_brim', ...changes } })
}

const BY_OBJECT = { print_sequence: 'by object', extruder_clearance_max_radius: 73 }

/** No sx-geom at all, or one that fails every call. */
const ENGINES: [string, SlicerxMcpOptions][] = [
  ['with no geometry engine', { sxGeomBin: join('/nonexistent', 'sx-geom') }],
  ['when the geometry engine fails', { geomEngine: () => Promise.reject(new Error('sx-geom stopped')) }],
]

describe.each(ENGINES)('slicerx_arrange %s', (_name, engine) => {
  it('spaces by-object copies by the clearance radius and keeps them off the A1 wrap check corner', async () => {
    const h = await connect(engine)
    await a1(h, boxStl(20, 20, 10), BY_OBJECT)
    await call(h, 'slicerx_arrange', { count: 3 })
    const { boxes, plate } = await shown(h)
    expect(boxes).toHaveLength(3)
    for (const [a, b] of pairs(boxes)) expect(gapOf(a, b), JSON.stringify([a, b])).toBeGreaterThanOrEqual(73)
    for (const b of boxes) expect(overlaps(b, WRAP), JSON.stringify(b)).toBe(false)
    expect(plate.byObject?.pairs).toEqual([])
  })

  it('adds the skirt sx prints round each copy by object to the clearance, a combined skirt too', async () => {
    const h = await connect(engine)
    await a1(h, boxStl(20, 20, 10), { ...BY_OBJECT, skirt_loops: 1, skirt_distance: 2, skirt_type: 'combined' })
    await call(h, 'slicerx_arrange', { count: 3 })
    const { boxes, plate } = await shown(h)
    expect(boxes).toHaveLength(3)
    // the skirt's distance and its one loop past each box
    for (const [a, b] of pairs(boxes)) expect(gapOf(a, b), JSON.stringify([a, b])).toBeGreaterThanOrEqual(75.3)
    expect(plate.byObject?.pairs).toEqual([])
  })

  it('gives each copy taller than the gantry rod a lane of its own', async () => {
    const h = await connect(engine)
    await a1(h, boxStl(20, 90, 45), { ...BY_OBJECT, extruder_clearance_height_to_rod: 34 })
    await call(h, 'slicerx_arrange', { count: 2 })
    const { boxes, plate } = await shown(h)
    expect(boxes).toHaveLength(2)
    expect(plate.byObject?.tall).toEqual([])
    expect(plate.byObject?.pairs).toEqual([])
    const [p, q] = [boxes[0]!, boxes[1]!]
    expect(Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1)).toBeGreaterThanOrEqual(2 * plate.byObject!.gantry.reachMm)
  })

  it('keeps copies printed by layer apart and out of an excluded corner', async () => {
    const h = await connect(engine)
    await a1(h, boxStl(30, 30, 10), { bed_exclude_area: ['0x0', '100x0', '100x100', '0x100'] })
    await call(h, 'slicerx_arrange', { count: 16 })
    const { boxes } = await shown(h)
    expect(boxes).toHaveLength(16)
    for (const b of boxes) expect(overlaps(b, CORNER) || overlaps(b, WRAP), JSON.stringify(b)).toBe(false)
    for (const [a, b] of pairs(boxes)) expect(overlaps(a, b), JSON.stringify([a, b])).toBe(false)
  })

  it('refuses more by-object copies than fit, says how many fit, and leaves the plate as it was', async () => {
    const h = await connect(engine)
    await a1(h, boxStl(20, 20, 10), BY_OBJECT)
    const r = await send(h, 'slicerx_arrange', { count: 10 })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/^Only \d of 10 fit on 1 plates\. Add plates or printers\.$/)
    expect((await shown(h)).boxes).toHaveLength(1)
  })
})

describe.skipIf(noSx())('slicerx_arrange without the geometry engine, sliced with sx', () => {
  const none = { engine: 'sx' as const, sxBin, sxGeomBin: join('/nonexistent', 'sx-geom') }

  it('slices the copies it spaced by object with no clearance refusal', async () => {
    const h = await connect(none)
    await a1(h, boxStl(20, 20, 10), BY_OBJECT)
    await call(h, 'slicerx_arrange', { count: 3 })
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it('slices the copies it spaced by object with a combined skirt, which goes round each copy', async () => {
    const h = await connect(none)
    await a1(h, boxStl(20, 20, 10), { ...BY_OBJECT, skirt_loops: 1, skirt_distance: 2, skirt_type: 'combined' })
    await call(h, 'slicerx_arrange', { count: 3 })
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)

  it('slices the copies it laid out by layer with no collision', async () => {
    const h = await connect(none)
    await a1(h, boxStl(30, 30, 10), {})
    await call(h, 'slicerx_arrange', { count: 16 })
    const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
    expect(sliced.output.total.grams).toBeGreaterThan(0)
  }, 240_000)
})
