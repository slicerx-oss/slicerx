// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sheet draws the part it is about. A sheet that names a built design draws that design's mesh as it stands on the
// plate, with the rows' places moved onto it when mimir gave them around its own origin; a sheet for a new part draws
// its own solids. Either way the part is its silhouette and its visible edges: an edge hidden behind the part never
// shows, and a row with no place whose value is an overall size gets that size's line.
import type { MeshPart, PilotDim, PilotSheet, PilotSheetSolid } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import type { PlateEntry } from '../src/state/store'
import { drawView, rasterize, shapeBounds, shapeOfMesh, shapeOfSolids, SHEET_VIEWS, viewsFor, type V3 } from '../src/workspaces/mimir/sheet-draw'
import { alignDims, placeMissing, sheetPicture } from '../src/workspaces/mimir/sheet-shape'

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
