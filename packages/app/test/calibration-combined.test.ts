// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { defaultValues } from '../src/calibration/actions'
import { addCombinedPlate, combinedValues, packFootprints } from '../src/calibration/combined'
import { setGeomProvider } from '../src/geom/client'
import { get, set } from '../src/state/store'

beforeEach(() => {
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', overrides: {}, objectSettings: {}, calibration: {}, slice: { status: 'idle' } })
})

const loader = {
  loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: `h-${name}`, hash: name, name, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: 12 })) }),
}
const box = (w: number, d: number, h: number) => ({ positions: [0, 0, 0, w, 0, 0, w, d, 0, 0, d, h], indices: [0, 1, 2, 0, 2, 3] })

describe('packFootprints', () => {
  it('keeps the clearance between every pair and stays on the bed', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, w: 20 + (i % 3) * 10, h: 25 }))
    const at = packFootprints(items, { widthMm: 256, depthMm: 256 }, 41)!
    expect(at).not.toBeNull()
    for (const a of items)
      for (const b of items) {
        if (a.id >= b.id) continue
        const [ax, ay] = at[a.id]!
        const [bx, by] = at[b.id]!
        const dx = Math.max(bx - (ax + a.w), ax - (bx + b.w), 0)
        const dy = Math.max(by - (ay + a.h), ay - (by + b.h), 0)
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(41)
      }
    for (const i of items) {
      expect(at[i.id]![0]).toBeGreaterThanOrEqual(5)
      expect(at[i.id]![0] + i.w).toBeLessThanOrEqual(251)
      expect(at[i.id]![1] + i.h).toBeLessThanOrEqual(251)
    }
  })
  it('says no when they do not fit', () => {
    expect(packFootprints(Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, w: 40, h: 40 })), { widthMm: 180, depthMm: 180 }, 41)).toBeNull()
  })
})

describe('combined plate', () => {
  it('builds flow pads, a pressure advance tower and a temperature tower, by object, with ranges tagged to their objects', async () => {
    const asked: Record<string, unknown>[] = []
    setGeomProvider({
      call: async (_op, req) => {
        const r = (req as { request: Record<string, unknown> }).request
        asked.push(r)
        if (r['test'] === 'flow')
          return { name: 'flow', objects: [0.95, 0.97, 0.99].map((x, i) => ({ name: `flow-${x}`, mesh: box(20, 25, 3), offsetMm: [i * 26, 0], settings: { filament_flow_ratio: x } })), ranges: [], instructions: ['Pick a pad.'] } as never
        if (r['test'] === 'pressure-advance') return { name: 'pa', objects: [{ name: 'pa', mesh: box(30, 30, 40), offsetMm: [0, 0], settings: { wall_loops: 1 } }], ranges: [{ zFromMm: 0, zToMm: 20, settings: { pressure_advance: 0.01 } }], instructions: ['Read corners.'] } as never
        return { name: 'tt', objects: [{ name: 'tt', mesh: box(40, 14, 90), offsetMm: [0, 0], settings: {} }], ranges: [{ zFromMm: 0, zToMm: 10, settings: { nozzle_temperature: [230] } }], instructions: ['Read bridges.'] } as never
      },
    })
    const id = await addCombinedPlate(loader, ['temp-tower', 'flow', 'pressure-advance'], combinedValues(defaultValues), 1)
    const s = get()
    const meta = s.plates.find((p) => p.id === id)!
    expect(meta.settings.sequence).toBe('by-object')
    // Print order: flow pads, the tower under the gantry, the tall temperature tower last.
    expect(s.plate.map((e) => e.name)).toEqual(['flow-0.95', 'flow-0.97', 'flow-0.99', 'pa', 'tt'])
    expect(asked.find((r) => r['test'] === 'pressure-advance')?.['heightMm']).toBe(40)
    const run = s.calibration[id]!
    expect(run.combined?.map((p) => p.test)).toEqual(['flow', 'pressure-advance', 'temp-tower'])
    const pa = s.plate[3]!.id
    const tt = s.plate[4]!.id
    expect(run.ranges).toEqual([
      { zFromMm: 0, zToMm: 20, settings: { pressure_advance: 0.01 }, objects: [pa] },
      { zFromMm: 0, zToMm: 10, settings: { nozzle_temperature: [230] }, objects: [tt] },
    ])
    // The flow of each pad stays on its object.
    expect(s.objectSettings[s.plate[1]!.id]).toEqual({ filament_flow_ratio: 0.97 })
  })

  it('needs two tests and says when the gantry is too low', async () => {
    await expect(addCombinedPlate(loader, ['flow'], combinedValues(defaultValues))).rejects.toThrow(/at least two/)
    set({ overrides: { extruder_clearance_height_to_rod: 12 } })
    setGeomProvider({ call: async () => ({ name: 'x', objects: [], ranges: [], instructions: [] }) as never })
    await expect(addCombinedPlate(loader, ['pressure-advance', 'temp-tower'], combinedValues(defaultValues))).rejects.toThrow(/gantry/)
  })
})
