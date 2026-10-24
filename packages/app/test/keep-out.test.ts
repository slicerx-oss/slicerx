// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer's own keep-out areas on the plate: the excluded areas of the X1 and P1 series and the corner the A1 family
// runs its nozzle wrap check in. Arrange keeps every part off them, printed by layer or by object, as the slice holds
// the print to them (heimdall's keep_out check).
import { afterEach, describe, expect, it } from 'vitest'
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
})
