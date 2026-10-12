// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's plate goes to the slicer where it is laid out: the sx CLI does not move it. So the layout sits in the
// middle of the printable area, with room for a skirt or brim on every side, not in the front left corner.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxStl, connect, data } from './helpers'

/** The printable area's corners, from a project's config. */
function bedOf(cfg: Record<string, unknown>): { x0: number; y0: number; x1: number; y1: number } {
  const pts = (cfg['printable_area'] as [number, number][]).map(([x, y]) => [Number(x), Number(y)] as const)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

async function laidOut(printer: string, size: [number, number, number], copies: number, profiles: string[] = []) {
  const { McpProject } = await import('../src/project')
  const { ProfileCatalog } = await import('../src/profiles')
  const { DataStore, resolveDataPaths } = await import('../src/data')
  const { createNodeSlicerHost } = await import('../src/slicerhost')
  const { createStubSlicer } = await import('../src/slicer')
  const { readStlPositions } = await import('../src/mesh')
  const store = new DataStore(resolveDataPaths())
  const host = createNodeSlicerHost(createStubSlicer(), `/tmp/slicerx-mcp-test-layout-${(printer + profiles.join('')).replace(/\W/g, '')}`)
  const catalog = new ProfileCatalog(store)
  await catalog.prepare(profiles)
  const project = new McpProject({ name: 'Layout', profiles, ...(printer ? { printer } : {}) }, store, catalog, host)
  const positions = readStlPositions(boxStl(...size))
  const handle = await host.loadParts('box', [{ name: 'box', slot: 1, positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) }])
  project.addMesh(handle.id, 'box', handle.bboxMm, handle.triangles, copies)
  const plate = await project.plate(1)
  const bed = bedOf(project.config(1) as Record<string, unknown>)
  // Each box's footprint on the bed: the box spans 0..size, moved by the transform's translation.
  const feet = plate.objects.map((o) => ({ x0: o.transform[12]!, y0: o.transform[13]!, x1: o.transform[12]! + size[0], y1: o.transform[13]! + size[1] }))
  const all = { x0: Math.min(...feet.map((f) => f.x0)), y0: Math.min(...feet.map((f) => f.y0)), x1: Math.max(...feet.map((f) => f.x1)), y1: Math.max(...feet.map((f) => f.y1)) }
  return { plate, bed, all }
}

/** Room a skirt or brim needs past the parts on every side, mm. */
const MARGIN_MM = 10

describe('a plate laid out for the sx CLI', () => {
  for (const [printer, side] of [
    ['bambu_p1s', 256],
    ['bambu_a1_mini', 180],
  ] as const) {
    it(`centers four copies on the ${printer} with room for a skirt or brim`, async () => {
      const { plate, bed, all } = await laidOut(printer, [40, 30, 20], 4)
      expect(plate.objects).toHaveLength(4)
      expect(bed.x1 - bed.x0).toBe(side)
      expect((all.x0 + all.x1) / 2).toBeCloseTo((bed.x0 + bed.x1) / 2, 6)
      expect((all.y0 + all.y1) / 2).toBeCloseTo((bed.y0 + bed.y1) / 2, 6)
      expect(all.x0 - MARGIN_MM).toBeGreaterThanOrEqual(bed.x0)
      expect(all.y0 - MARGIN_MM).toBeGreaterThanOrEqual(bed.y0)
      expect(all.x1 + MARGIN_MM).toBeLessThanOrEqual(bed.x1)
      expect(all.y1 + MARGIN_MM).toBeLessThanOrEqual(bed.y1)
    })
  }

  it('centers a single part, so its own brim stays on the bed', async () => {
    const { bed, all } = await laidOut('bambu_p1s', [100, 100, 10], 1)
    expect(all.x0 - bed.x0).toBeCloseTo(bed.x1 - all.x1, 6)
    expect(all.y0 - bed.y0).toBeCloseTo(bed.y1 - all.y1, 6)
  })
})

/** The FLSUN V400, a delta: its printable area is a ring of 72 points around a 300 mm circle centered on 0, 0. */
const V400 = 'machine:flsun-v400'

describe('a plate on a round bed', () => {
  it('keeps every copy inside the circle, with the edge room, where the square box would reach past it', async () => {
    // 40 x 30 parts: rows across the full 280 mm of the box put the outer copies of the front and back rows off
    // the circle.
    const size: [number, number, number] = [40, 30, 20]
    const { plate, bed } = await laidOut('', size, 30, [V400])
    expect(bed.x1 - bed.x0).toBeCloseTo(300, 0)
    expect(plate.bed?.round).toBe(true)
    expect(plate.objects).toHaveLength(30)
    const cx = (bed.x0 + bed.x1) / 2
    const cy = (bed.y0 + bed.y1) / 2
    for (const o of plate.objects) {
      const [x, y] = [o.transform[12]!, o.transform[13]!]
      const far = Math.max(...[[x, y], [x + size[0], y], [x, y + size[1]], [x + size[0], y + size[1]]].map(([px, py]) => Math.hypot(px! - cx, py! - cy)))
      expect(far).toBeLessThanOrEqual(150 - MARGIN_MM + 1e-6)
    }
    // And the copies keep apart.
    const feet = plate.objects.map((o) => ({ x0: o.transform[12]!, y0: o.transform[13]!, x1: o.transform[12]! + size[0], y1: o.transform[13]! + size[1] }))
    for (let i = 0; i < feet.length; i++) for (let j = i + 1; j < feet.length; j++) {
      const a = feet[i]!
      const b = feet[j]!
      expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0).toBe(true)
    }
  })

  it('centers a single part on the circle', async () => {
    const { plate, bed } = await laidOut('', [100, 60, 10], 1, [V400])
    const o = plate.objects[0]!
    expect(o.transform[12]! + 50).toBeCloseTo((bed.x0 + bed.x1) / 2, 6)
    expect(o.transform[13]! + 30).toBeCloseTo((bed.y0 + bed.y1) / 2, 6)
  })
})

describe('reading the bed back from a project', () => {
  type Shown = { output: { bed: Record<string, unknown> } }

  it('a client opening a project on the FLSUN V400 reads a round bed by its diameter', async () => {
    const h = await connect()
    const opened = data<Shown>(await h.call('slicerx_project_open', { name: 'Delta', profiles: [V400] }))
    expect(opened.output.bed).toEqual({ shape: 'round', diameterMm: 300, heightMm: 410, centerMm: [0, 0] })
    const shown = data<Shown>(await h.call('slicerx_project_show'))
    expect(shown.output.bed).toEqual(opened.output.bed)
  })

  it('a rectangular bed reads back by its width and depth', async () => {
    const h = await connect()
    const shown = data<Shown>(await h.call('slicerx_project_open', { name: 'Box', printer: 'bambu_a1_mini' }))
    expect(shown.output.bed).toEqual({ shape: 'rectangle', widthMm: 180, depthMm: 180, heightMm: 180, originMm: [0, 0] })
  })
})

describe('a hand placement on a round bed', () => {
  type Placement = { id: string; centerMm: [number, number]; manual: boolean; offBed?: boolean }
  type Shown = { output: { project: { plates: { placements: Placement[] }[] } } }

  /** Moves the 20 mm cube onto the front right diagonal of the V400 so its far corner is `reach` mm from the middle. */
  async function placedAt(reach: number): Promise<{ given: [number, number]; placement: Placement }> {
    const h = await connect()
    await h.call('slicerx_project_open', { name: 'Delta', profiles: [V400] })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    const c = reach / Math.SQRT2 - 10
    const given: [number, number] = [c, -c]
    const moved = data<Shown>(await h.call('slicerx_project_move', { object: 'obj-1', x: given[0], y: given[1] }))
    return { given, placement: moved.output.project.plates[0]!.placements[0]! }
  }

  it('stays where the client put it and is flagged off the bed 1 mm past the rim', async () => {
    const { given, placement } = await placedAt(151)
    expect(placement.manual).toBe(true)
    expect(placement.centerMm[0]).toBeCloseTo(given[0], 2)
    expect(placement.centerMm[1]).toBeCloseTo(given[1], 2)
    expect(placement.offBed).toBe(true)
  })

  it('is clear 1 mm inside the rim', async () => {
    const { given, placement } = await placedAt(149)
    expect(placement.centerMm[0]).toBeCloseTo(given[0], 2)
    expect(placement.offBed).toBeUndefined()
  })
})
