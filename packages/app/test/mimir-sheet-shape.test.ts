// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sheet draws the part it is about. A sheet that names a built design draws that design's mesh as it stands on the
// plate, with the rows' places moved onto it when mimir gave them around its own origin; a sheet for a new part draws
// its own solids. Either way the part is its silhouette and its visible edges: an edge hidden behind the part never
// shows, and a row with no place whose value is an overall size gets that size's line.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeshPart, PilotDim, PilotSheet, PilotSheetSolid } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import type { PlateEntry } from '../src/state/store'
import { drawPx, drawView, fitScale, paintedEdges, rasterize, shapeBounds, shapeOfMesh, shapeOfSolids, SHEET_VIEWS, TRI_BUDGET, VIEW_PX_MAX, VIEWS, viewsFor, type Raster, type Shape, type V3, type ViewName } from '../src/workspaces/mimir/sheet-draw'
import { alignDims, hasPicture, placeMissing, sharedPicture, sheetPicture } from '../src/workspaces/mimir/sheet-shape'

/** An axis-aligned box as 12 outward triangles. */
function boxMesh(lo: V3, hi: V3): MeshPart {
  const c = (i: number): V3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]
  const positions = new Float32Array(Array.from({ length: 8 }, (_, i) => c(i)).flat())
  // each face as two triangles wound outward
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
  const indices = new Uint32Array(quads.flatMap(([a, b, cc, d]) => [a!, b!, cc!, a!, cc!, d!]))
  return { name: 'Box', slot: 1, positions, indices }
}

const entry = (id: string, parts: MeshPart[], move: V3 = [0, 0, 0]): PlateEntry => ({ id, name: 'Case', parts, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, move[0], move[1], move[2], 1], colors: [], handle: {} } as unknown as PlateEntry)

const row = (key: string, value: number, at?: PilotDim['at']): PilotDim => ({ key, label: key, value, unit: 'mm', source: 'guess', ...(at ? { at } : {}) })

/** An open box 40 x 30 x 20 with 2 mm walls: a floor and a wall ring. */
const OPEN_BOX: PilotSheetSolid[] = [
  { plane: 'xy', points: [[0, 0], [40, 0], [40, 30], [0, 30]], from: 0, to: 2 },
  { plane: 'xy', points: [[0, 0], [40, 0], [40, 30], [0, 30]], holes: [[[2, 2], [38, 2], [38, 28], [2, 28]]], from: 2, to: 20 },
]

describe('the part on the sheet', () => {
  it('draws the outline and the edges in sight, and hides the ones behind the part', () => {
    const shape = shapeOfSolids(OPEN_BOX)
    // Front at 5 px per mm, the box's front left bottom corner at (20, 120): x right, z up
    const front = rasterize(shape, 'front', 260, 140, 5, 20, 120, 1)
    const at = (r: typeof front, x: number, y: number) => r.edge[y * r.W + x]
    const covered = (r: typeof front, x: number, y: number) => r.cover[y * r.W + x]
    // the whole front face is covered, and its bottom and top are lines
    expect(covered(front, 120, 60)).toBe(1)
    expect(at(front, 120, 119) || at(front, 120, 120)).toBe(1)
    expect(at(front, 120, 20) || at(front, 120, 19)).toBe(1)
    // the floor's top inside the box (2 mm up, 10 px above the bottom) is behind the front wall: no line there
    for (let y = 108; y <= 112; y++) expect(at(front, 120, y), `row ${y}`).toBe(0)
    // from the top, the wall's inside shows as a line around the floor
    const top = rasterize(shape, 'top', 260, 200, 5, 20, 170, 1)
    // the inside of the left wall, 2 mm in from x = 0
    expect([29, 30, 31].some((x) => at(top, x, 95) === 1)).toBe(true)
    // the floor's middle has no line
    expect(at(top, 120, 95)).toBe(0)
  })

  it('draws a built design from its mesh where it stands, with the rows moved onto it', () => {
    // the design landed at x 100, y 80; mimir drew it and placed its rows around its own origin
    const plate = [entry('obj_case', [boxMesh([0, 0, 0], [96, 68, 28])], [100, 80, 0])]
    const standIn: PilotSheetSolid[] = [{ plane: 'xy', points: [[0, 0], [96, 0], [96, 68], [0, 68]], from: 0, to: 4 }]
    const sheet: PilotSheet = {
      id: 's1',
      title: 'Case main sizes',
      views: ['front', 'top', 'side', 'iso'],
      design: 'obj_case',
      part: standIn,
      dims: [row('length', 96, { a: [0, 0, 0], b: [96, 0, 0], off: [0, 0, -8] }), row('width', 68, { a: [96, 0, 0], b: [96, 68, 0], off: [8, 0, 0] }), row('height', 28, { a: [0, 0, 0], b: [0, 0, 28], off: [-8, 0, 0] })],
    }
    const pic = sheetPicture(sheet, plate)!
    expect(pic.built).toBe(true)
    // the real part, 28 mm tall, not the 4 mm slab standing in for it
    expect(shapeBounds(pic.shape)).toEqual({ lo: [100, 80, 0], hi: [196, 148, 28] })
    expect(pic.dims[0]!.at).toEqual({ a: [100, 80, 0], b: [196, 80, 0], off: [0, 0, -8] })
    // every row has its callout on the drawing
    const seen = new Set<string>()
    for (const v of SHEET_VIEWS) for (const d of drawView(pic.shape, pic.dims, v, 380, 330, { pad: 30 }).dims) seen.add(d.key)
    expect([...seen].sort()).toEqual(['height', 'length', 'width'])
    // with no design on the plate it falls back to the sheet's own solids
    expect(sheetPicture(sheet, [])!.built).toBe(false)
    expect(shapeBounds(sheetPicture(sheet, [])!.shape)!.hi[2]).toBe(4)
  })

  it('keeps rows already placed on the built part where they are', () => {
    const shape = shapeOfMesh([boxMesh([100, 80, 0], [196, 148, 28])])
    const dims = [row('length', 96, { a: [100, 80, 0], b: [196, 80, 0], off: [0, 0, -8] })]
    expect(alignDims(dims, null, shape)).toEqual(dims)
  })

  it('gives a row with no place the overall size it matches, so it still shows', () => {
    const shape = shapeOfMesh([boxMesh([0, 0, 0], [96, 68, 28])])
    const dims = placeMissing([row('outside_height', 28), row('wall', 2), row('outside_length', 96)], shape)
    expect(dims[0]!.at).toMatchObject({ a: [0, 0, 0], b: [0, 0, 28] })
    expect(dims[1]!.at).toBeUndefined()
    expect(dims[2]!.at).toMatchObject({ a: [0, 0, 0], b: [96, 0, 0] })
    expect(viewsFor(dims, []).get('outside_height')).toContain('front')
  })

  // The case's width, drawn on the base's right side and pushed out toward the lid beside it, keeps its callout off the
  // lid (the live Pi case sheet put it on the lid).
  it('keeps a callout off a second part its line points at', () => {
    const shape = shapeOfMesh([boxMesh([0, 0, 0], [92, 63, 27]), boxMesh([100, 0, 0], [192, 63, 3])])
    const width = row('width', 63, { a: [92, 0, 0], b: [92, 63, 0], off: [4, 0, 0] })
    for (const v of ['top', 'iso'] as const) {
      const drawn = drawView(shape, [width], v, 470, 320, { pad: 24 })
      const { W, cover } = drawn.part
      const [x, y] = drawn.dims[0]!.badge
      for (const [dx, dy] of [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10]] as [number, number][]) expect(cover[Math.floor(y + dy) * W + Math.floor(x + dx)], `${v} ${dx} ${dy}`).toBe(0)
    }
  })

  it('draws a mesh of a few thousand triangles in four views quickly', () => {
    // a plate with 40 x 40 posts on it: 1601 boxes, 19212 triangles
    const parts = [boxMesh([0, 0, 0], [200, 200, 2])]
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) parts.push(boxMesh([i * 5 + 1, j * 5 + 1, 2], [i * 5 + 3, j * 5 + 3, 8]))
    const shape = shapeOfMesh(parts)
    const t0 = performance.now()
    for (const v of SHEET_VIEWS) drawView(shape, [], v, 520, 330, { pad: 24, px: 2 })
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})

/** Where a point lands in a raster made with rasterize(shape, view, W, H, k, ox, oy, 1). */
const onScreen = (view: ViewName, p: V3, k: number, ox: number, oy: number): [number, number] => {
  const { r, u } = VIEWS[view]
  return [Math.floor((p[0] * r[0] + p[1] * r[1] + p[2] * r[2]) * k + ox), Math.floor(-(p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) * k + oy)]
}
/** True when the raster has an edge pixel within `d` px of (x, y). */
const edgeNear = (ras: Raster, [x, y]: [number, number], d: number): boolean => {
  for (let j = y - d; j <= y + d; j++) for (let i = x - d; i <= x + d; i++) if (i >= 0 && j >= 0 && i < ras.W && j < ras.H && ras.edge[j * ras.W + i]) return true
  return false
}
const coverAt = (ras: Raster, [x, y]: [number, number]): number => ras.cover[y * ras.W + x]!

/** A mesh of the given triangles, three corners each. */
const triMesh = (tris: V3[][]): MeshPart => ({ name: 'T', slot: 1, positions: new Float32Array(tris.flat(2)), indices: new Uint32Array(tris.flatMap((_, i) => [3 * i, 3 * i + 1, 3 * i + 2])) })

/** A torus of nu x nv quads, two triangles each: a dense curved part. */
function torus(R: number, r: number, nu: number, nv: number): MeshPart {
  const positions = new Float32Array(3 * nu * nv)
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = (i / nu) * 2 * Math.PI
      const b = (j / nv) * 2 * Math.PI
      positions.set([(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r + r * Math.sin(b)], 3 * (i * nv + j))
    }
  }
  const indices = new Uint32Array(6 * nu * nv)
  let o = 0
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * nv + j
      const b = ((i + 1) % nu) * nv + j
      const c = ((i + 1) % nu) * nv + ((j + 1) % nv)
      const d = i * nv + ((j + 1) % nv)
      indices.set([a, b, c, a, c, d], o)
      o += 6
    }
  }
  return { name: 'Ring', slot: 1, positions, indices }
}

describe('the rasterizer on faces that are not square to the view', () => {
  it('hides the open box\'s far and inside edges in iso, and draws its outline', () => {
    const shape = shapeOfSolids(OPEN_BOX)
    const [k, ox, oy] = [5, 60, 260]
    const iso = rasterize(shape, 'iso', 420, 420, k, ox, oy, 1)
    // the bottom left edge runs behind the floor, and the inside foot of the front wall behind the front wall
    for (const p of [[0, 15, 0], [20, 2, 2]] as V3[]) {
      const at = onScreen('iso', p, k, ox, oy)
      expect(coverAt(iso, at), String(p)).toBe(1)
      expect(edgeNear(iso, at, 2), String(p)).toBe(false)
    }
    // the front right corner and the far wall's inside foot are in sight
    for (const p of [[40, 0, 10], [20, 28, 2]] as V3[]) expect(edgeNear(iso, onScreen('iso', p, k, ox, oy), 1), String(p)).toBe(true)
  })

  it('keeps the nearer of two crossing faces by depth, where one slopes away in Front', () => {
    // a face sloping back (y = x) and an upright one at y = 10: left of x = 10 the slope is nearer, right of it the upright
    const slope: V3[][] = [[[0, 0, 0], [40, 40, 0], [40, 40, 30]], [[0, 0, 0], [40, 40, 30], [0, 0, 30]]]
    const upright: V3[][] = [[[0, 10, 0], [40, 10, 0], [40, 10, 30]], [[0, 10, 0], [40, 10, 30], [0, 10, 30]]]
    const shape = shapeOfMesh([triMesh([...slope, ...upright])])
    const [k, ox, oy] = [5, 20, 180]
    const front = rasterize(shape, 'front', 260, 200, k, ox, oy, 1)
    // where they cross (x = 10) is a line; on either side the face is one plane, no line
    expect(edgeNear(front, onScreen('front', [10, 0, 15], k, ox, oy), 1)).toBe(true)
    for (const x of [4, 18, 30]) expect(edgeNear(front, onScreen('front', [x, 0, 15], k, ox, oy), 2), `x ${x}`).toBe(false)
  })

  it('draws a 32 sided cylinder with no line on its facets, only its outline and the rim of its top', () => {
    const ring = Array.from({ length: 32 }, (_, i) => [20 * Math.cos((i * Math.PI) / 16), 20 * Math.sin((i * Math.PI) / 16)] as [number, number])
    const shape = shapeOfSolids([{ plane: 'xy', points: ring, from: 0, to: 30 }])
    const [k, ox, oy] = [5, 130, 170]
    const front = rasterize(shape, 'front', 260, 200, k, ox, oy, 1)
    // across the middle: a line at each side and none between
    const y = onScreen('front', [0, 0, 15], k, ox, oy)[1]
    const lines = Array.from({ length: front.W }, (_, x) => front.edge[y * front.W + x]).flatMap((e, x) => (e ? [x] : []))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((x) => x < 35 || x > 225), `lines at ${lines.join(', ')}`).toBe(true)
    // in iso the top's rim is a line all round its near side, and the top's middle has none
    const iso = rasterize(shape, 'iso', 300, 300, k, 150, 200, 1)
    expect(edgeNear(iso, onScreen('iso', [0, 0, 30], k, 150, 200), 3)).toBe(false)
    for (const a of [-90, -45, 0, 180]) expect(edgeNear(iso, onScreen('iso', [20 * Math.cos((a * Math.PI) / 180), 20 * Math.sin((a * Math.PI) / 180), 30], k, 150, 200), 1), `rim at ${a}`).toBe(true)
  })

  it('leaves a hole through a cap open', () => {
    const shape = shapeOfSolids([{ plane: 'xy', points: [[0, 0], [40, 0], [40, 40], [0, 40]], holes: [[[15, 15], [25, 15], [25, 25], [15, 25]]], from: 0, to: 5 }])
    const top = rasterize(shape, 'top', 240, 240, 5, 20, 220, 1)
    expect(coverAt(top, onScreen('top', [20, 20, 5], 5, 20, 220))).toBe(0)
    expect(coverAt(top, onScreen('top', [8, 8, 5], 5, 20, 220))).toBe(1)
    // the hole's rim is a line
    expect(edgeNear(top, onScreen('top', [15, 20, 5], 5, 20, 220), 1)).toBe(true)
  })
})

describe('a built part of many triangles', () => {
  // a torus of 200,000 triangles, such as a part with fillets all round
  const dense = torus(40, 15, 500, 200)
  const plate = [entry('obj_ring', [dense])]
  const sheet: PilotSheet = { id: 'sd', title: 'Ring sizes', views: ['front', 'top', 'side', 'iso'], design: 'obj_ring', dims: [row('outside', 110, { a: [-55, -55, 0], b: [55, -55, 0], off: [0, -8, 0] }), row('height', 30, { a: [55, 0, 0], b: [55, 0, 30], off: [8, 0, 0] })] }

  it('is simplified to the drawing\'s budget, keeping its size and its hole', () => {
    const pic = sheetPicture(sheet, plate)!
    expect(dense.indices.length / 3).toBe(200_000)
    expect(pic.shape.simplified).toBe(true)
    expect(pic.shape.tris.length / 9).toBeLessThanOrEqual(TRI_BUDGET)
    expect(pic.shape.tris.length / 9).toBeGreaterThan(TRI_BUDGET / 4)
    // bounds come from the mesh as built, not the simplified one
    const b = shapeBounds(pic.shape)!
    expect(b.lo[0]).toBeCloseTo(-55, 1)
    expect(b.hi[2]).toBeCloseTo(30, 1)
    const k = 3
    const top = rasterize(pic.shape, 'top', 400, 400, k, 200, 200, 1)
    expect(coverAt(top, [200, 200])).toBe(0)
    expect(coverAt(top, onScreen('top', [40, 0, 30], k, 200, 200))).toBe(1)
  })

  it('is shaped once for every part of the tab that asks, and the caption asks without shaping it', () => {
    const a = sharedPicture(sheet, plate[0]!)
    expect(sharedPicture(sheet, plate[0]!)).toBe(a)
    // the design moved on the plate: a new entry, a new picture
    const moved = { ...plate[0]!, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] } as PlateEntry
    expect(sharedPicture(sheet, moved)).not.toBe(a)
    expect(hasPicture(sheet, plate)).toBe(true)
    expect(hasPicture(sheet, [])).toBe(false)
    expect(hasPicture({ id: 'sb', title: 'Box', views: ['iso'], dims: [], part: OPEN_BOX }, [])).toBe(true)
  })

  it('keeps every view\'s canvas under the pixel budget, at the screen\'s ratio when it fits', () => {
    expect(drawPx(400, 300, 2)).toBe(2)
    expect(drawPx(400, 300, 1)).toBe(1)
    expect(drawPx(400, 300, 3)).toBe(2)
    // a big desktop cell draws coarser instead of at twice its size
    const px = drawPx(1500, 1000, 2)
    expect(Math.round(1500 * px) * Math.round(1000 * px)).toBeLessThanOrEqual(VIEW_PX_MAX * 1.01)
  })

  it('draws in four views in well under a second', () => {
    const t0 = performance.now()
    const pic = sheetPicture(sheet, plate)!
    const cell = { w: 700, h: 440 }
    const px = drawPx(cell.w, cell.h, 2)
    const flat = Math.min(...(['front', 'side', 'top'] as const).map((v) => fitScale(pic.shape, pic.dims, v, cell.w, cell.h, 24)))
    for (const v of SHEET_VIEWS) drawView(pic.shape, pic.dims, v, cell.w, cell.h, { pad: 24, px, ...(v === 'iso' ? {} : { scale: flat }) })
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})

describe('rows placed around mimir\'s own origin', () => {
  // the built part stands at x 100..150, y 100..140, z 0..30
  const shape = shapeOfMesh([boxMesh([100, 100, 0], [150, 140, 30])])

  it('moves only the rows that miss the part, and leaves a row already on it where it is', () => {
    const a = row('length', 50, { a: [100, 100, 0], b: [150, 100, 0], off: [0, 0, -8] })
    const b = row('width', 40, { a: [0, 0, 0], b: [0, 40, 0], off: [-8, 0, 0] })
    const c = row('height', 30, { a: [0, 0, 0], b: [0, 0, 30], off: [-8, 0, 0] })
    const out = alignDims([a, b, c], null, shape)
    expect(out[0]).toEqual(a)
    expect(out[1]!.at).toEqual({ a: [100, 100, 0], b: [100, 140, 0], off: [-8, 0, 0] })
    expect(out[2]!.at).toEqual({ a: [100, 100, 0], b: [100, 100, 30], off: [-8, 0, 0] })
  })

  // A plate 200 x 200 x 20 standing at x, y 28..228 on a 256 mm bed, its rows around mimir's own corner: the hole's
  // place falls inside the part's bounds unmoved by chance, so moving row by row split the sheet into two frames.
  it('moves every row of a sheet in its own frame together, a hole that lands inside the part by chance too', () => {
    const plate = shapeOfMesh([boxMesh([28, 28, 0], [228, 228, 20])])
    const length = row('length', 200, { a: [0, 0, 0], b: [200, 0, 0], off: [0, -8, 0] })
    const width = row('width', 200, { a: [0, 0, 0], b: [0, 200, 0], off: [-8, 0, 0] })
    const hole = row('hole', 10, { a: [95, 100, 20], b: [105, 100, 20], off: [0, 6, 0] })
    const out = alignDims([length, width, hole], null, plate)
    expect(out[0]!.at).toEqual({ a: [28, 28, 0], b: [228, 28, 0], off: [0, -8, 0] })
    expect(out[1]!.at).toEqual({ a: [28, 28, 0], b: [28, 228, 0], off: [-8, 0, 0] })
    expect(out[2]!.at).toEqual({ a: [123, 128, 20], b: [133, 128, 20], off: [0, 6, 0] })
    // the sheet's own solids giving its corner move it the same way
    const own = shapeOfSolids([{ plane: 'xy', points: [[0, 0], [200, 0], [200, 200], [0, 200]], from: 0, to: 20 }])
    expect(alignDims([length, width, hole], own, plate)).toEqual(out)
  })

  it('leaves rows inside the part (a hole and its spacing) alone, not snapped to its corner', () => {
    const hole = row('hole', 3, { a: [10, 10, 30], b: [13, 10, 30], off: [0, 6, 0] })
    const pitch = row('pitch', 30, { a: [10, 10, 30], b: [40, 10, 30], off: [0, -6, 0] })
    expect(alignDims([hole, pitch], null, shape)).toEqual([hole, pitch])
  })
})

/**
 * The headphone stand's sheet as mimir sent it in a live run: a round base, a tapered stem and the hook arm, with eight
 * rows. Its callouts 5, 6 and 7 bunched at the stem's top in Iso, and 5 and 6 sat on the base in Top.
 */
const STAND: PilotSheet = {
  id: 'stand',
  title: 'Headphone stand sizes',
  views: ['front', 'top', 'side', 'iso'],
  part: [
    { plane: 'xy', points: Array.from({ length: 32 }, (_, i) => [50 * Math.cos((i * Math.PI) / 16), 50 * Math.sin((i * Math.PI) / 16)] as [number, number]), from: 0, to: 6 },
    { plane: 'xz', points: [[-15, 6], [15, 6], [10, 186], [-10, 186]], from: -15, to: 15 },
    { plane: 'xz', points: [[10, 176], [70, 176], [70, 186], [10, 186]], from: -5, to: 5 },
  ],
  dims: [
    { ...row('base_diameter', 100, { a: [-50, -50, 0], b: [50, -50, 0], off: [0, -8, 0] }), source: 'asked' },
    { ...row('base_thickness', 6, { a: [50, 0, 0], b: [50, 0, 6], off: [8, 0, 0] }), source: 'asked' },
    { ...row('stem_height', 180, { a: [-15, 0, 6], b: [-15, 0, 186], off: [-10, 0, 0] }), source: 'asked' },
    { ...row('stem_base', 30, { a: [-15, 0, 6], b: [15, 0, 6], off: [0, -20, 0] }), source: 'asked' },
    { ...row('stem_top', 20, { a: [-10, 0, 186], b: [10, 0, 186], off: [0, 20, 0] }), source: 'asked' },
    { ...row('stem_wall', 2, { a: [8, 0, 186], b: [10, 0, 186], off: [0, 14, 0] }), source: 'asked' },
    { ...row('hook_reach', 60, { a: [10, 0, 186], b: [70, 0, 186], off: [0, 0, 10] }), source: 'asked' },
    row('hook_tube', 10, { a: [70, 0, 176], b: [70, 0, 186], off: [12, 0, 0] }),
  ],
}

/** The pipe elbow's sheet as the sweep it is built as: a 32 mm tube with a 2.5 mm wall bent on 50 mm, 20 mm ends. */
const ELBOW: PilotSheet = {
  id: 'elbow',
  title: '90 degree pipe elbow',
  views: ['front', 'top', 'side', 'iso'],
  part: [{ kind: 'sweep', profile: { d: 32, hole: 27 }, path: [[0, 0, 0], [0, 0, 70], [70, 0, 70]], round: 50 }],
  dims: [
    { ...row('outside_diameter', 32, { a: [-16, 0, 0], b: [16, 0, 0], off: [0, 0, -8] }), source: 'asked' },
    { ...row('wall_thickness', 2.5, { a: [13.5, 0, 0], b: [16, 0, 0], off: [0, 0, -16] }), source: 'asked' },
    { ...row('bend_radius', 50, { a: [50, 0, 20], b: [0, 0, 20], off: [0, 0, 0] }), source: 'asked' },
    { ...row('end_length', 20, { a: [-16, 0, 0], b: [-16, 0, 20], off: [-10, 0, 0] }), source: 'asked' },
    { ...row('bend_angle', 90), unit: 'deg', source: 'asked', at: { c: [50, 0, 20], from: [-1, 0, 0], to: [0, 0, 1], r: 20 } },
  ],
}

/** True when the segment runs over the part after it has been off it: a leader that crosses the part to its callout. */
function overPart(part: Raster, [p, q]: [[number, number], [number, number]]): boolean {
  const on = (x: number, y: number): boolean => {
    const i = Math.floor(x * part.px)
    const j = Math.floor(y * part.px)
    return i >= 0 && j >= 0 && i < part.W && j < part.H && part.cover[j * part.W + i] === 1
  }
  const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 2)
  let off = false
  for (let s = 0; s <= n; s++) {
    const t = s / Math.max(1, n)
    const here = on(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
    if (!here) off = true
    else if (off) return true
  }
  return false
}

describe('callouts on a crowded sheet', () => {
  it('keeps every callout off the part and apart from the others, each on a leader that crosses no other', () => {
    const pic = sheetPicture(STAND, [])!
    // the drawing's cells at 1440 px wide, with the flat views at one scale as the sheet draws them
    const [w, h, pad] = [475, 320, 24]
    const flat = Math.min(...(['front', 'side', 'top'] as const).map((v) => fitScale(pic.shape, pic.dims, v, w, h, pad, STAND.views)))
    for (const v of SHEET_VIEWS) {
      const drawn = drawView(pic.shape, pic.dims, v, w, h, { pad, order: STAND.views, px: 2, ...(v === 'iso' ? {} : { scale: flat }) })
      const { W, H, px, cover } = drawn.part
      for (const d of drawn.dims) {
        const [bx, by] = d.badge
        // no pixel of the part under the callout's disk
        for (let y = Math.floor((by - 10) * px); y <= Math.ceil((by + 10) * px); y++) {
          for (let x = Math.floor((bx - 10) * px); x <= Math.ceil((bx + 10) * px); x++) {
            if (x < 0 || y < 0 || x >= W || y >= H || Math.hypot(x / px - bx, y / px - by) > 10) continue
            expect(cover[y * W + x], `${v}: callout ${d.n} sits on the part`).toBe(0)
          }
        }
        // apart from every other callout, with room between them
        for (const o of drawn.dims) if (o !== d) expect(Math.hypot(o.badge[0] - bx, o.badge[1] - by), `${v}: callouts ${d.n} and ${o.n}`).toBeGreaterThanOrEqual(26)
      }
      // leaders never cross, and none runs under another callout
      const side = (p: number[], q: number[], r: number[]) => (q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!)
      const leaders = drawn.dims.filter((d) => d.leader)
      for (const a of leaders) {
        for (const b of leaders) {
          if (a === b) continue
          const [p, q] = a.leader!
          const [r, t] = b.leader!
          expect(side(r, t, p) * side(r, t, q) < 0 && side(p, q, r) * side(p, q, t) < 0, `${v}: leaders ${a.n} and ${b.n} cross`).toBe(false)
        }
      }
      for (const d of drawn.dims) {
        // a callout away from its size is on a leader to it
        const m = d.leader?.[0]
        if (!d.leader) continue
        for (const o of drawn.dims) {
          if (o === d) continue
          const [p, q] = d.leader
          const vx = q[0] - p[0]
          const vy = q[1] - p[1]
          const tt = Math.max(0, Math.min(1, ((o.badge[0] - p[0]) * vx + (o.badge[1] - p[1]) * vy) / (vx * vx + vy * vy || 1)))
          expect(Math.hypot(o.badge[0] - p[0] - tt * vx, o.badge[1] - p[1] - tt * vy), `${v}: leader ${d.n} runs under callout ${o.n}${m ? '' : ''}`).toBeGreaterThanOrEqual(10)
        }
      }
    }
  })

  it('keeps a callout off a thin rod that passes between the points of its rim', () => {
    // a block, and a rod 1 mm thick (4 px) just above the length's line, where its callout would go
    const shape = shapeOfSolids([
      { plane: 'xz', points: [[0, 0], [40, 0], [40, 20], [0, 20]], from: -5, to: 5 },
      { plane: 'xz', points: [[-10, 25.5], [50, 25.5], [50, 26.5], [-10, 26.5]], from: -1, to: 1 },
    ])
    const length = row('length', 40, { a: [0, 0, 20], b: [40, 0, 20], off: [0, 0, 4] })
    const drawn = drawView(shape, [length], 'front', 300, 220, { scale: 4 })
    const { W, cover } = drawn.part
    const [bx, by] = drawn.dims[0]!.badge
    for (let y = Math.floor(by - 10); y <= by + 10; y++) for (let x = Math.floor(bx - 10); x <= bx + 10; x++) if (Math.hypot(x - bx, y - by) <= 10) expect(cover[y * W + x], `${x}, ${y}`).toBe(0)
  })

  it('puts a leader on every callout that left its line, in every view of the stand', () => {
    const pic = sheetPicture(STAND, [])!
    for (const v of SHEET_VIEWS) {
      for (const d of drawView(pic.shape, pic.dims, v, 475, 320, { pad: 24, order: STAND.views }).dims) {
        const line = d.lines.at(-1)
        const mid: [number, number] = d.leader ? d.leader[0] : line ? [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2] : d.badge
        if (Math.hypot(d.badge[0] - mid[0], d.badge[1] - mid[1]) > 15) expect(d.leader, `${v}: callout ${d.n}`).not.toBeNull()
      }
    }
  })
})

// The elbow's Iso had callout 4 on a leader drawn across the tube to the far side of it.
describe('leaders to callouts', () => {
  for (const sheet of [ELBOW, STAND]) {
    it(`never cross the part on their way to the callout: ${sheet.title}`, () => {
      const pic = sheetPicture(sheet, [])!
      for (const [w, h] of [[475, 320], [420, 300], [360, 260]] as [number, number][]) {
        const flat = Math.min(...(['front', 'side', 'top'] as const).map((v) => fitScale(pic.shape, pic.dims, v, w, h, 24, sheet.views)))
        for (const v of SHEET_VIEWS) {
          const drawn = drawView(pic.shape, pic.dims, v, w, h, { pad: 24, order: sheet.views, ...(v === 'iso' ? {} : { scale: flat }) })
          for (const d of drawn.dims) if (d.leader) expect(overPart(drawn.part, d.leader), `${w} x ${h} ${v}: leader ${d.n} crosses the part`).toBe(false)
        }
      }
    })
  }

  // The elbow's end length is placed in the tube's middle plane, which the tube hides in Iso: its lines start where
  // they come out from behind the tube, not over its near side.
  it('start a line from a place the part hides where it comes out from behind the part', () => {
    const pic = sheetPicture(ELBOW, [])!
    const drawn = drawView(pic.shape, pic.dims, 'iso', 475, 320, { pad: 24, order: ELBOW.views })
    const end = drawn.dims.find((d) => d.key === 'end_length')!
    const { W, cover } = drawn.part
    for (const [p] of end.lines.slice(0, 2)) expect(cover[Math.floor(p[1]) * W + Math.floor(p[0])], `starts at ${p}`).toBe(0)
    // in Front the same place is on the outline in sight, and its lines start on it
    const front = drawView(pic.shape, pic.dims, 'front', 475, 320, { pad: 24, order: ELBOW.views })
    const [fx, fy] = front.dims.find((d) => d.key === 'end_length')!.lines[0]![0]
    const touches = [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => front.part.cover[(Math.floor(fy) + dy) * front.part.W + Math.floor(fx) + dx] === 1))
    expect(touches, 'Front: the line starts on the outline').toBe(true)
  })
})

describe('the part\'s edges as painted', () => {
  const shape = shapeOfSolids([{ plane: 'xy', points: [[0, 0], [40, 0], [40, 30], [0, 30]], from: 0, to: 20 }])
  it('are two device px wide on a 1x screen and three at 2x, grown into the part only', () => {
    for (const [px, width] of [[1, 2], [2, 3]] as const) {
      const ras = rasterize(shape, 'front', 260 * px, 140 * px, 5, 20, 120, px)
      const ink = paintedEdges(ras)
      for (let i = 0; i < ink.length; i++) {
        if (ras.edge[i]) expect(ink[i]).toBe(1)
        if (ink[i] && !ras.edge[i]) expect(ras.cover[i], `pixel ${i} off the part`).toBe(1)
      }
      // across the box's left outline, in the middle of its height
      const y = Math.floor(60 * px)
      const run = Array.from({ length: 8 * px }, (_, x) => ink[y * ras.W + Math.floor(18 * px) + x]).join('')
      expect(run.match(/1+/)![0].length, `at ${px}x`).toBe(width)
    }
  })

  it('take the theme\'s outline ink, with no color of their own', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/workspaces/mimir/mimir.css'), 'utf8')
    const rule = css.match(/\.mimir-ink-edge \{[^}]*\}/)![0]
    expect(rule).toMatch(/color: var\(--ti-ol\)/)
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})

// A pipe bend, a round stem and a vase are drawn as they will be built, and their rows get their callouts on them.
describe('revolved, swept and lofted parts on the sheet', () => {
  const near = (b: { lo: V3; hi: V3 } | null, lo: V3, hi: V3) => {
    for (let k = 0; k < 3; k++) {
      expect(b!.lo[k]).toBeCloseTo(lo[k]!, 0)
      expect(b!.hi[k]).toBeCloseTo(hi[k]!, 0)
    }
  }
  const calloutsIn = (shape: Shape, dims: PilotDim[]) => {
    const seen = new Set<string>()
    for (const v of SHEET_VIEWS) for (const d of drawView(shape, dims, v, 420, 320, { pad: 24 }).dims) seen.add(d.key)
    return [...seen].sort()
  }

  it('draws the pipe elbow as a tube swept round its bend, with every row on it', () => {
    const shape = shapeOfSolids([{ kind: 'sweep', profile: { d: 32, hole: 27 }, path: [[0, 0, 0], [0, 0, 70], [70, 0, 70]], round: 50 }])
    near(shapeBounds(shape), [-16, -16, 0], [70, 16, 86])
    // the bore is open at the end, and the wall around it is part
    const [k, ox] = [4, 120]
    const side = rasterize(shape, 'top', 400, 240, k, ox, 120, 1)
    expect(coverAt(side, onScreen('top', [0, 0, 0], k, ox, 120))).toBe(1)
    const front = rasterize(shape, 'front', 420, 400, k, 100, 380, 1)
    // the bend's middle on the centerline (50 out from its center at (50, 20)) is covered, its center is not
    expect(coverAt(front, onScreen('front', [50 - 50 * Math.SQRT1_2, 0, 20 + 50 * Math.SQRT1_2], k, 100, 380))).toBe(1)
    expect(coverAt(front, onScreen('front', [50, 0, 20], k, 100, 380))).toBe(0)
    const dims = [row('outside_diameter', 32, { a: [-16, 0, 0], b: [16, 0, 0], off: [0, 0, -8] }), row('end_length', 20, { a: [-16, 0, 0], b: [-16, 0, 20], off: [-10, 0, 0] }), { ...row('bend_angle', 90), unit: 'deg' as const, at: { c: [50, 0, 20] as V3, from: [-1, 0, 0] as V3, to: [0, 0, 1] as V3, r: 20 } }]
    expect(calloutsIn(shape, dims)).toEqual(['bend_angle', 'end_length', 'outside_diameter'])
  })

  // looking down a straight tube shows its bore open and its wall round it; a rod of the same size is covered through
  it('draws a swept tube with its bore open, apart from a solid rod', () => {
    const path: V3[] = [[0, 0, 0], [0, 0, 40]]
    const tube = shapeOfSolids([{ kind: 'sweep', profile: { d: 32, hole: 27 }, path }])
    // each end cap is the outside ring and the bore's
    expect(tube.polys.map((p) => p.length)).toEqual([2, 2])
    const top = rasterize(tube, 'top', 200, 200, 4, 100, 100, 1)
    expect(coverAt(top, onScreen('top', [0, 0, 40], 4, 100, 100))).toBe(0)
    expect(coverAt(top, onScreen('top', [0, 6, 40], 4, 100, 100))).toBe(0)
    for (const p of [[14.75, 0, 40], [-14.75, 0, 40], [0, 14.75, 40], [0, -14.75, 40]] as V3[]) expect(coverAt(top, onScreen('top', p, 4, 100, 100)), `wall at ${p}`).toBe(1)
    const rod = shapeOfSolids([{ kind: 'sweep', profile: { d: 32 }, path }])
    expect(rod.polys.map((p) => p.length)).toEqual([1, 1])
    expect(coverAt(rasterize(rod, 'top', 200, 200, 4, 100, 100, 1), onScreen('top', [0, 0, 40], 4, 100, 100))).toBe(1)
  })

  it('draws a revolved stem round, and a part of a turn with its ends closed', () => {
    const full = shapeOfSolids([{ kind: 'revolve', plane: 'xz', points: [[0, 0], [15, 0], [10, 60], [0, 60]], axis: { point: [0, 0], direction: [0, 1] } }])
    near(shapeBounds(full), [-15, -15, 0], [15, 15, 60])
    const top = rasterize(full, 'top', 200, 200, 4, 100, 100, 1)
    expect(coverAt(top, [100, 100])).toBe(1)
    // a quarter turn of a ring: its two ends are capped faces
    const quarter = shapeOfSolids([{ kind: 'revolve', plane: 'xz', points: [[40, 0], [50, 0], [50, 10], [40, 10]], axis: { point: [0, 0], direction: [0, 1] }, angle: 90 }])
    expect(quarter.polys.length).toBe(2)
    near(shapeBounds(quarter), [0, 0, 0], [50, 50, 10])
    expect(calloutsIn(full, [row('base', 30, { a: [-15, 0, 0], b: [15, 0, 0], off: [0, 0, -8] }), row('height', 60, { a: [15, 0, 0], b: [15, 0, 60], off: [8, 0, 0] })])).toEqual(['base', 'height'])
  })

  // what the schema lets through draws as finite geometry, or nothing: never NaN, never a part across the whole sheet
  it('draws odd paths, turns and sections finite and in bounds', () => {
    const ring = { plane: 'xz' as const, points: [[10, 0], [20, 0], [20, 10], [10, 10]] as [number, number][], axis: { point: [0, 0] as [number, number], direction: [0, 1] as [number, number] } }
    const cases: [string, PilotSheetSolid, number][] = [
      ['a round far larger than the shorter leg', { kind: 'sweep', profile: { d: 10 }, path: [[0, 0, 0], [0, 0, 20], [200, 0, 20]], round: 500 }, 220],
      ['two corners close together with a large round', { kind: 'sweep', profile: { d: 10 }, path: [[0, 0, 0], [0, 0, 50], [10, 0, 50], [10, 0, 0]], round: 40 }, 70],
      ['a path that doubles back', { kind: 'sweep', profile: { d: 10 }, path: [[0, 0, 0], [0, 0, 50], [0, 0, 10]], round: 5 }, 70],
      ['three points in a line', { kind: 'sweep', profile: { d: 10, hole: 6 }, path: [[0, 0, 0], [0, 0, 25], [0, 0, 50]], round: 10 }, 70],
      ['a bore as wide as the tube', { kind: 'sweep', profile: { d: 10, hole: 12 }, path: [[0, 0, 0], [0, 0, 50]] }, 70],
      ['a turn of 0 degrees', { kind: 'revolve', ...ring, angle: 0 }, 50],
      ['a turn of -90 degrees', { kind: 'revolve', ...ring, angle: -90 }, 50],
      ['sections out of order', { kind: 'loft', plane: 'xy', sections: [{ at: 80, d: 20 }, { at: 0, d: 60 }, { at: 40, points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] }] }, 100],
    ]
    for (const [what, solid, reach] of cases) {
      const shape = shapeOfSolids([solid])
      const all = [...shape.tris, ...shape.polys.flat(2).flat()]
      expect(all.every(Number.isFinite), what).toBe(true)
      expect(all.length, what).toBeGreaterThan(0)
      const b = shapeBounds(shape)!
      for (let k = 0; k < 3; k++) expect(Math.max(Math.abs(b.lo[k]!), Math.abs(b.hi[k]!)), what).toBeLessThanOrEqual(reach)
      for (const v of SHEET_VIEWS) for (const d of drawView(shape, [], v, 300, 200).dims) expect(d.badge.every(Number.isFinite), what).toBe(true)
    }
    // a -90 turn goes the other way round from a 90 one
    const plus = shapeBounds(shapeOfSolids([{ kind: 'revolve', ...ring, angle: 90 }]))!
    const minus = shapeBounds(shapeOfSolids([{ kind: 'revolve', ...ring, angle: -90 }]))!
    expect(Math.sign(plus.hi[1]! + plus.lo[1]!)).toBe(-Math.sign(minus.hi[1]! + minus.lo[1]!))
  })

  // the sheet's schema takes a revolve as one outline and drops holes, so the drawing never shows a bore it did not get
  it('draws a revolve from its outline alone, as the sheet takes it', () => {
    const ring = { kind: 'revolve' as const, plane: 'xz' as const, points: [[10, 0], [20, 0], [20, 10], [10, 10]] as [number, number][], axis: { point: [0, 0] as [number, number], direction: [0, 1] as [number, number] } }
    const holed = { ...ring, holes: [[[12, 2], [18, 2], [18, 8], [12, 8]]] } as unknown as PilotSheetSolid
    expect(Array.from(shapeOfSolids([holed]).tris)).toEqual(Array.from(shapeOfSolids([ring]).tris))
  })

  it('draws a loft from round to square, its top square in Top', () => {
    const shape = shapeOfSolids([{ kind: 'loft', plane: 'xy', sections: [{ at: 0, d: 60 }, { at: 80, points: [[-20, -20], [20, -20], [20, 20], [-20, 20]] }] }])
    near(shapeBounds(shape), [-30, -30, 0], [30, 30, 80])
    expect(shape.polys.length).toBe(2)
    const top = rasterize(shape, 'top', 300, 300, 4, 150, 150, 1)
    // the top's corner is a corner of the drawing
    expect(edgeNear(top, onScreen('top', [20, 20, 80], 4, 150, 150), 1)).toBe(true)
    expect(calloutsIn(shape, [row('top', 40, { a: [-20, -20, 80], b: [20, -20, 80], off: [0, 0, 8] }), row('height', 80, { a: [30, 0, 0], b: [30, 0, 80], off: [8, 0, 0] })])).toEqual(['height', 'top'])
  })
})
