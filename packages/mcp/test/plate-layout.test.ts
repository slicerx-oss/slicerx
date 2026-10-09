// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's plate goes to the slicer where it is laid out: the sx CLI does not move it. So the layout sits in the
// middle of the printable area, with room for a skirt or brim on every side, not in the front left corner.
import { describe, expect, it } from 'vitest'
import { boxStl } from './helpers'

/** The printable area's corners, from a project's config. */
function bedOf(cfg: Record<string, unknown>): { x0: number; y0: number; x1: number; y1: number } {
  const pts = (cfg['printable_area'] as [number, number][]).map(([x, y]) => [Number(x), Number(y)] as const)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

async function laidOut(printer: string, size: [number, number, number], copies: number) {
  const { McpProject } = await import('../src/project')
  const { ProfileCatalog } = await import('../src/profiles')
  const { DataStore, resolveDataPaths } = await import('../src/data')
  const { createNodeSlicerHost } = await import('../src/slicerhost')
  const { createStubSlicer } = await import('../src/slicer')
  const { readStlPositions } = await import('../src/mesh')
  const store = new DataStore(resolveDataPaths())
  const host = createNodeSlicerHost(createStubSlicer(), `/tmp/slicerx-mcp-test-layout-${printer.replace(/\W/g, '')}`)
  const project = new McpProject({ name: 'Layout', profiles: [], printer }, store, new ProfileCatalog(store), host)
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
