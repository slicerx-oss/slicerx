// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer's own keep-out areas on the plate: the excluded areas of the X1 and P1 series and the corner the A1 family
// runs its nozzle wrap check in. Arrange keeps every part off them, printed by layer or by object, as the slice holds
// the print to them (heimdall's keep_out check).
import { afterEach, describe, expect, it } from 'vitest'
import { byObjectReach } from '@slicerx/settings/by-object'
import { setProfileLayer } from '../src/adapters/config'
import { arrangePlate } from '../src/plate/edit'
import { avoidAreas } from '../src/plate/arrange'
import { installPrintMargins } from '../src/plate/footprint'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { profileReady, resetProfileReady } from '../src/state/profile-sync'
import { get, set, type PlateEntry } from '../src/state/store'

afterEach(() => {
  set({ printerModel: null, plate: [], overrides: {}, selection: null, selectedIds: [] })
  setProfileLayer(null, [])
  resetProfileReady()
})

const cube = (i: number, size: number): PlateEntry => ({
  id: `c${i}`,
  name: `Cube ${i}`,
  handle: { id: `c${i}`, hash: `c${i}`, name: `Cube ${i}`, triangles: 12, bboxMm: [size, size, 10], openEdges: 0, parts: [] },
  parts: [boxMesh(size, size, 10)],
  colors: ['#bd93f9'],
  transform: compose({ position: [128, 128, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }),
})

/** Each part's box on the plate. */
function boxes(): { id: string; x0: number; y0: number; x1: number; y1: number }[] {
  return get().plate.map((e) => {
    const t = e.transform
    const xs: number[] = []
    const ys: number[] = []
    for (const p of e.parts) for (let i = 0; i + 2 < p.positions.length; i += 3) {
      xs.push(t[0]! * p.positions[i]! + t[4]! * p.positions[i + 1]! + t[12]!)
      ys.push(t[1]! * p.positions[i]! + t[5]! * p.positions[i + 1]! + t[13]!)
    }
    return { id: e.id, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  })
}

const A1_CORNER = { x: 226, y: 224, w: 30, h: 32 }
const meets = (b: { x0: number; y0: number; x1: number; y1: number }, z: { x: number; y: number; w: number; h: number }) => b.x0 < z.x + z.w && z.x < b.x1 && b.y0 < z.y + z.h && z.y < b.y1

describe('the printer keep-out areas arrange keeps off', () => {
  it.each([
    ['A1', [A1_CORNER]],
    ['A1 mini', [{ x: 156, y: 152, w: 24, h: 28 }]],
    ['P1S', [{ x: 0, y: 0, w: 18, h: 28 }]],
    ['X1 Carbon', [{ x: 0, y: 0, w: 18, h: 28 }]],
  ] as const)('reads the keep-out areas of the Bambu Lab %s from its profile', async (model, areas) => {
    set({ printerModel: { vendor: 'Bambu Lab', model } })
    await profileReady()
    expect(avoidAreas()).toEqual(areas)
  })

  it.each([
    ['by layer', 'by layer', 40, 25],
    ['by object', 'by object', 30, 9],
  ] as const)('keeps a full A1 plate off the nozzle wrap check corner, %s', async (_label, sequence, size, count) => {
    installPrintMargins(get)
    set({ printerModel: { vendor: 'Bambu Lab', model: 'A1' } })
    await profileReady()
    set({ plate: Array.from({ length: count }, (_, i) => cube(i, size)), overrides: { ...get().overrides, print_sequence: sequence, brim_type: 'no_brim', skirt_loops: 0 }, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    const placed = boxes().filter((b) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 256 && b.y1 <= 256)
    expect(placed.length).toBeGreaterThan(count / 2)
    for (const b of placed) expect(meets(b, A1_CORNER), `${b.id} at ${b.x0.toFixed(1)}, ${b.y0.toFixed(1)}`).toBe(false)
  })

  it('keeps the skirt a minimum skirt length adds round each small part off the A1 corner and on the bed, by object', async () => {
    // One loop asked for and 20 mm of filament as the minimum: sx prints 16 loops round each 3 mm cube, its skirt
    // reaching 8 mm out (byObjectReach on the cube's outline, from the slice's own loop count). Counted as one loop,
    // a full plate put a skirt into the corner, where the slice is refused.
    installPrintMargins(get)
    set({ printerModel: { vendor: 'Bambu Lab', model: 'A1' } })
    await profileReady()
    const overrides = { ...get().overrides, print_sequence: 'by object', brim_type: 'no_brim', skirt_loops: 1, skirt_distance: 2, min_skirt_length: 20 }
    set({ plate: Array.from({ length: 14 }, (_, i) => cube(i, 3)), overrides, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    // the A1's 0.42 mm line on its 0.2 mm first layer, as by-object-golden.json has it for this case
    const skirt = byObjectReach({ ...overrides, line_width: 0.42, initial_layer_print_height: 0.2, filament_diameter: [1.75] }, 0, [[0, 0], [3, 0], [3, 3], [0, 3]])
    expect(skirt).toBeCloseTo(8.033274, 5)
    const placed = boxes().filter((b) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 256 && b.y1 <= 256)
    expect(placed.length).toBeGreaterThan(6)
    for (const b of placed) {
      const out = { x0: b.x0 - skirt, y0: b.y0 - skirt, x1: b.x1 + skirt, y1: b.y1 + skirt }
      expect(meets(out, A1_CORNER), `${b.id} at ${b.x0.toFixed(1)}, ${b.y0.toFixed(1)}`).toBe(false)
      expect(out.x0 >= 0 && out.y0 >= 0 && out.x1 <= 256 && out.y1 <= 256, `${b.id} at ${b.x0.toFixed(1)}, ${b.y0.toFixed(1)}`).toBe(true)
    }
  })
})
