// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange packs what prints around each object (brim, raft, support pad, skirt), keeps it inside the bed and
// off the printer's excluded areas and the prime tower, and says so when one object cannot fit with its brim.
// The engine's preflight blocks any toolpath point past the bed edge or inside an excluded area, so each test
// checks the grown footprint against the bed and the zones the way the preflight would.
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, SettingValue } from '@slicerx/contracts'
import { arrange, excludeBoxes, fillCount, hullHitsRect, hullOf, NO_MARGINS, printSizeOf, setAvoidAreas, setMarginSource, type ArrangeItem, type Rect } from '../src/plate/arrange'
import { arrangePlate, fillBed } from '../src/plate/edit'
import { autoBrimWidth, installPrintMargins, marginsFor } from '../src/plate/footprint'
import { objectWarnings } from '../src/plate/object-list'
import { bounds, compose, type Mat4 } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

/** A w x d x h mm block centered on the origin in XY, resting on z = 0. */
function block(w: number, d: number, h: number): { positions: Float32Array }[] {
  const p: number[] = []
  for (const x of [-w / 2, w / 2]) for (const y of [-d / 2, d / 2]) for (const z of [0, h]) p.push(x, y, z)
  return [{ positions: new Float32Array(p) }]
}

const at = (x: number, y: number): Mat4 => compose({ position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const item = (id: string, w = 30, d = 30, h = 20, x = 100, y = 100): ArrangeItem => ({ id, parts: block(w, d, h), transform: at(x, y) })

/** The brim and skirt settings the tests print with: a 6 mm brim, one skirt loop 3 mm out. */
const BRIM: Record<string, SettingValue> = { brim_type: 'outer_only', brim_width: 6, skirt_loops: 1, skirt_distance: 3, line_width: 0.42, nozzle_diameter: 0.4 }

/** The box an object's print covers, past its outline by `reach`. */
function printed(it: ArrangeItem, t: Mat4, reach: number): Rect {
  const b = bounds(it.parts, t)!
  return { x: b.min[0] - reach, y: b.min[1] - reach, w: b.max[0] - b.min[0] + 2 * reach, h: b.max[1] - b.min[1] + 2 * reach }
}

const inside = (r: Rect, bed: { widthMm: number; depthMm: number }) => r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= bed.widthMm + 1e-6 && r.y + r.h <= bed.depthMm + 1e-6
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6

beforeEach(() => {
  setAvoidAreas([])
  setMarginSource(() => NO_MARGINS)
})

describe('arrange with what prints around each object', () => {
  it('without margins the brim and skirt of an arranged object reach past a small bed (the bug)', () => {
    const bed = { widthMm: 80, depthMm: 80, heightMm: 100 }
    const items = ['a', 'b', 'c'].map((id) => item(id, 30, 30))
    const r = arrange(items, [], bed, { gapMm: 3, rotate: false, margins: NO_MARGINS })
    const reach = marginsFor(BRIM).reach(printSizeOf(bounds(items[0]!.parts, items[0]!.transform)!))
    expect(reach).toBeGreaterThan(8)
    expect(items.some((it) => !inside(printed(it, r.transforms[it.id]!, reach), bed))).toBe(true)
  })

  it('keeps every brim and skirt inside a small bed and the brims apart', () => {
    const bed = { widthMm: 110, depthMm: 110, heightMm: 100 }
    const items = ['a', 'b', 'c', 'd'].map((id) => item(id, 30, 30))
    const margins = marginsFor(BRIM)
    const r = arrange(items, [], bed, { gapMm: 3, rotate: false, margins })
    expect(r.leftOver).toEqual([])
    const size = printSizeOf(bounds(items[0]!.parts, items[0]!.transform)!)
    const boxes = items.map((it) => printed(it, r.transforms[it.id]!, margins.reach(size)))
    for (const b of boxes) expect(inside(b, bed)).toBe(true)
    const brims = items.map((it) => printed(it, r.transforms[it.id]!, margins.grow(size)))
    for (let i = 0; i < brims.length; i++) for (let j = i + 1; j < brims.length; j++) expect(hits(brims[i]!, brims[j]!)).toBe(false)
  })

  it('leaves out the objects that no longer fit once the brim is counted', () => {
    // Four 30 mm blocks fit a 110 mm bed with a 3 mm gap alone, but not with a 6 mm brim and a skirt around each.
    const bed = { widthMm: 80, depthMm: 80, heightMm: 100 }
    const items = ['a', 'b', 'c', 'd'].map((id) => item(id, 30, 30))
    const bare = arrange(items, [], bed, { gapMm: 3, rotate: false, margins: NO_MARGINS })
    expect(bare.leftOver).toEqual([])
    const r = arrange(items, [], bed, { gapMm: 3, rotate: false, margins: marginsFor(BRIM) })
    expect(r.leftOver.length).toBeGreaterThan(0)
    expect(r.tooLarge).toEqual([])
  })

  it('keeps objects and their skirt out of an excluded bed area', () => {
    const bed = { widthMm: 140, depthMm: 140, heightMm: 100 }
    const zone = excludeBoxes([[0, 0], [40, 0], [40, 30], [0, 30]])
    setAvoidAreas(zone)
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 25, 25))
    const margins = marginsFor(BRIM)
    const r = arrange(items, [], bed, { gapMm: 3, rotate: false, margins })
    expect(r.leftOver).toEqual([])
    const size = printSizeOf(bounds(items[0]!.parts, items[0]!.transform)!)
    for (const it of items) {
      const box = printed(it, r.transforms[it.id]!, margins.reach(size))
      expect(inside(box, bed)).toBe(true)
      expect(hits(box, zone[0]!)).toBe(false)
    }
  })

  it('does not let the skirt around the whole print cross an excluded area between objects', () => {
    // The zone sits in the middle of the left edge; objects above and below it would put the skirt across it.
    const bed = { widthMm: 100, depthMm: 120, heightMm: 100 }
    const zone = excludeBoxes([[0, 45], [30, 45], [30, 75], [0, 75]])
    setAvoidAreas(zone)
    const items = ['a', 'b', 'c'].map((id) => item(id, 30, 30))
    const margins = marginsFor({ ...BRIM, brim_type: 'no_brim' })
    const r = arrange(items, [], bed, { gapMm: 3, rotate: false, margins })
    // Whatever is placed, the hull of the grown boxes must not touch the zone.
    const reach = margins.reach({ w: 30, h: 30, height: 20 })
    const placed = items.filter((it) => r.transforms[it.id])
    expect(placed.length).toBeGreaterThan(1)
    const corners = placed.flatMap((it) => {
      const b = printed(it, r.transforms[it.id]!, reach)
      return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as [number, number][]
    })
    expect(hullHitsRect(hullOf(corners), zone[0]!)).toBe(false)
  })

  it('keeps off the prime tower when the plate prints in two filaments', () => {
    const bed = { widthMm: 160, depthMm: 160, heightMm: 100 }
    const cfg = { ...BRIM, enable_prime_tower: true, wipe_tower_x: 10, wipe_tower_y: 10, prime_tower_width: 35, prime_tower_brim_width: 3 }
    const items = ['a', 'b', 'c'].map((id) => item(id, 30, 30))
    const margins = marginsFor(cfg, 2)
    expect(margins.keepOut).toHaveLength(1)
    const r = arrange(items, [], bed, { gapMm: 3, rotate: false, margins })
    const tower = margins.keepOut[0]!
    for (const it of items) expect(hits(printed(it, r.transforms[it.id]!, 0), tower)).toBe(false)
    expect(marginsFor(cfg, 1).keepOut).toEqual([])
    expect(marginsFor({ ...cfg, enable_prime_tower: false }, 2).keepOut).toEqual([])
  })

  it('fills the bed with fewer copies when the brim is counted', () => {
    const bed = { widthMm: 150, depthMm: 60, heightMm: 100 }
    const one = item('a', 20, 20, 10, 30, 30)
    const bare = fillCount(one, [], bed, { gapMm: 3, rotate: false, margins: NO_MARGINS })
    const margins = marginsFor(BRIM)
    const grown = fillCount(one, [], bed, { gapMm: 3, rotate: false, margins })
    expect(grown).toBeLessThan(bare)
    expect(grown).toBeGreaterThan(0)
  })

  it('reports an object that cannot fit alone with its brim, in words that name the brim', () => {
    const bed = { widthMm: 90, depthMm: 90, heightMm: 100 }
    // 80 mm fits a 90 mm bed bare, but not with a 6 mm brim and a skirt on every side.
    const big = item('big', 80, 80)
    const r = arrange([big], [], bed, { gapMm: 3, rotate: false, margins: marginsFor(BRIM) })
    expect(r.transforms['big']).toBeUndefined()
    expect(r.tooLarge).toEqual([{ id: 'big', withoutMargin: true }])
    const huge = arrange([item('huge', 100, 100)], [], bed, { gapMm: 3, rotate: false, margins: marginsFor(BRIM) })
    expect(huge.tooLarge).toEqual([{ id: 'huge', withoutMargin: false }])
  })
})

describe('what the footprint includes', () => {
  const size = { w: 40, h: 40, height: 20 }
  const grow = (cfg: Record<string, SettingValue>) => marginsFor(cfg).grow(size)
  const reach = (cfg: Record<string, SettingValue>) => marginsFor(cfg).reach(size)
  const none = { brim_type: 'no_brim', skirt_loops: 0, draft_shield: 'disabled' }

  it('adds the brim width and the gap to the brim', () => {
    expect(grow({ ...none, brim_type: 'outer_only', brim_width: 8 })).toBe(8)
    expect(grow({ ...none, brim_type: 'outer_and_inner', brim_width: 8, brim_object_gap: 0.2 })).toBeCloseTo(8.2)
    expect(grow({ ...none, brim_type: 'inner_only', brim_width: 8 })).toBe(0)
    expect(grow({ ...none, brim_width: 8 })).toBe(0)
  })

  it('sizes an automatic brim by height, speed and material, the way the engine does', () => {
    const tall = { w: 8, h: 8, height: 80 }
    const cfg: Record<string, SettingValue> = { filament_type: ['PLA'], inner_wall_speed: [100], outer_wall_speed: [100] }
    expect(autoBrimWidth(cfg, { w: 40, h: 40, height: 4 })).toBe(0)
    expect(autoBrimWidth(cfg, tall)).toBeGreaterThan(5)
    expect(autoBrimWidth(cfg, tall)).toBeLessThanOrEqual(18)
    // PETG sticks harder to the plate, so the engine grows the brim.
    expect(autoBrimWidth({ ...cfg, filament_type: ['PETG'] }, tall)).toBeGreaterThan(autoBrimWidth(cfg, tall))
    expect(marginsFor({ ...cfg, brim_type: 'auto_brim', skirt_loops: 0 }).grow(tall)).toBeGreaterThan(5)
  })

  it('reaches the skirt, by distance and loops, and a draft shield counts as one loop', () => {
    const base = { ...none, skirt_distance: 4, line_width: 0.5, nozzle_diameter: 0.4 }
    expect(reach({ ...base, skirt_loops: 0 })).toBe(0)
    expect(reach({ ...base, skirt_loops: 1 })).toBeCloseTo(4.5)
    expect(reach({ ...base, skirt_loops: 3 })).toBeCloseTo(5.5)
    expect(reach({ ...base, skirt_loops: 0, draft_shield: 'enabled' })).toBeCloseTo(4.5)
    // The engine keeps the skirt a brim width out from the part.
    expect(reach({ ...base, skirt_loops: 1, brim_type: 'outer_only', brim_width: 5 })).toBeCloseTo(9.5)
  })

  it('adds the raft expansion, the support pad, and the size compensation', () => {
    expect(grow({ ...none, raft_layers: 3, raft_expansion: 1.5, raft_first_layer_expansion: 3 })).toBe(3)
    expect(reach({ ...none, enable_support: true, support_type: 'normal(auto)', raft_first_layer_expansion: 2, support_object_xy_distance: 0.35 })).toBeCloseTo(2.35)
    expect(reach({ ...none, enable_support: true, support_type: 'tree(auto)', raft_first_layer_expansion: 2, support_object_xy_distance: 0.35, tree_support_brim_width: 3 })).toBeCloseTo(5.35)
    // Support does not push neighbors apart, since only the bed edge and the excluded areas block a slice.
    expect(grow({ ...none, enable_support: true })).toBe(0)
    expect(grow({ ...none, xy_contour_compensation: 0.3 })).toBeCloseTo(0.3)
    // A negative compensation or the elephant foot shrinks the first layer, which needs no room.
    expect(grow({ ...none, xy_contour_compensation: -0.3, elefant_foot_compensation: 0.2 })).toBe(0)
  })

  it('reads a list value per filament as its first entry', () => {
    expect(grow({ ...none, brim_type: 'outer_only', brim_width: ['7', '9'] as unknown as SettingValue })).toBe(7)
  })
})

describe('the plate in the store', () => {
  function entry(id: string, w: number, d: number, x: number, y: number): PlateEntry {
    const parts = block(w, d, 20).map((b) => ({ name: 'p', slot: 1, positions: b.positions, indices: new Uint32Array() }))
    const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [w, d, 20], openEdges: 0, parts: [] } as MeshHandle
    return { id, name: id, handle, parts, colors: ['#bd93f9'], transform: at(x, y) }
  }
  const small = { widthMm: 110, depthMm: 110, heightMm: 100 }

  beforeEach(() => {
    installPrintMargins(get)
    set({ bed: small, plate: [], plates: [], selection: null, selectedIds: [], overrides: { brim_type: 'outer_only', brim_width: 6, skirt_loops: 1, skirt_distance: 3 } })
  })

  it('arrange all keeps every printed edge on the bed, from the resolved configuration', async () => {
    set({ plate: ['a', 'b', 'c', 'd'].map((id) => entry(id, 30, 30, 55, 55)) })
    await arrangePlate('all', { gapMm: 3, rotate: false })
    for (const p of get().plate) {
      expect(objectWarnings(p, get())).toEqual([])
      const b = bounds(p.parts, p.transform)!
      expect(b.min[0]).toBeGreaterThanOrEqual(7)
      expect(b.max[0]).toBeLessThanOrEqual(small.widthMm - 7)
    }
  })

  it('the same layout from a brim-less configuration sits closer to the edge', async () => {
    set({ plate: [entry('a', 30, 30, 55, 55)], overrides: { brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
    await arrangePlate('all', { gapMm: 3, rotate: false })
    expect(bounds(get().plate[0]!.parts, get().plate[0]!.transform)!.min[0]).toBeCloseTo(3)
  })

  it('arrange the selected objects keeps the others where they are and the brims clear', async () => {
    set({ plate: [entry('a', 30, 30, 20, 20), entry('b', 30, 30, 55, 55)], selection: 'b', selectedIds: ['b'] })
    await arrangePlate('selection', { gapMm: 3, rotate: false })
    const [a, b] = get().plate
    expect(a!.transform[12]).toBe(20)
    const ab = bounds(a!.parts, a!.transform)!
    const bb = bounds(b!.parts, b!.transform)!
    const apart = bb.min[0] - ab.max[0] >= 12 || ab.min[0] - bb.max[0] >= 12 || bb.min[1] - ab.max[1] >= 12 || ab.min[1] - bb.max[1] >= 12
    expect(apart).toBe(true)
    expect(objectWarnings(b!, get())).toEqual([])
  })

  it('fill the bed adds fewer copies with the brim on', async () => {
    set({ plate: [entry('a', 20, 20, 30, 30)], selection: 'a', selectedIds: ['a'], bed: { widthMm: 150, depthMm: 60, heightMm: 100 } })
    const withBrim = await fillBed('a')
    set({ plate: [entry('a', 20, 20, 30, 30)], selection: 'a', selectedIds: ['a'], overrides: { brim_type: 'no_brim', skirt_loops: 0 } })
    const without = await fillBed('a')
    expect(withBrim).toBeGreaterThan(0)
    expect(withBrim).toBeLessThan(without)
    for (const p of get().plate) expect(objectWarnings(p, get())).toEqual([])
  })

  it('says in words that one object cannot fit with its brim, and leaves it where it was', async () => {
    set({ plate: [entry('Bracket', 100, 100, 55, 55)], bed: { widthMm: 110, depthMm: 110, heightMm: 100 } })
    const left = await arrangePlate('all', { gapMm: 3, rotate: false })
    expect(left).toBe(1)
    expect(get().toast?.text).toMatch(/Bracket is too large for this bed once the brim and skirt around it are counted/)
    expect(get().plate[0]!.transform[12]).toBe(55)
  })

  it('the object list flags a brim that reaches past the bed edge, and none that sits clear', () => {
    const tight = entry('t', 30, 30, 17, 55)
    expect(objectWarnings(tight, get())[0]?.text).toBe('Brim or skirt reaches past the bed edge')
    expect(objectWarnings(entry('o', 30, 30, 55, 55), get())).toEqual([])
    expect(objectWarnings(entry('off', 30, 30, 3, 55), get())[0]?.text).toBe('Off the bed')
  })

  it('flags an object whose brim reaches an excluded area', () => {
    setAvoidAreas(excludeBoxes([[0, 0], [30, 0], [30, 30], [0, 30]]))
    expect(objectWarnings(entry('z', 30, 30, 55, 55), get()).map((w) => w.text)).toEqual([])
    expect(objectWarnings(entry('z', 30, 30, 50, 40), get()).map((w) => w.text)).toEqual(['Brim or skirt reaches past the bed edge'])
  })

  it('has no effect on a printer with a large bed and no brim', async () => {
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, overrides: { brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
    appStore.setState({ plate: ['a', 'b'].map((id) => entry(id, 30, 30, 128, 128)) })
    await arrangePlate('all')
    expect(bounds(get().plate[0]!.parts, get().plate[0]!.transform)!.min[0]).toBeCloseTo(6)
  })
})
