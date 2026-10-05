// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// With no printer the plate, the configuration the engine slices with and its safety preflight share one bed, the
// generic one. A printer brings its own bed to all three, and dropping it brings the generic bed back.
import { afterEach, describe, expect, it } from 'vitest'
import type { Host, PrintConfig } from '@slicerx/contracts'
import { setProfileLayer } from '../src/adapters/config'
import { GENERIC_BED, bedSettings } from '../src/adapters/generic-bed'
import { loadDefaultPlate, plateSliceConfig } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { bounds, type Mat4 } from '../src/plate/transform'
import { get, set } from '../src/state/store'

afterEach(() => {
  set({ printerModel: null, plate: [] })
  setProfileLayer(null, [])
})

/** The axis box of a configuration's printable area. */
function areaBox(cfg: PrintConfig): [number, number, number, number] {
  const pts = cfg['printable_area'] as unknown as [number, number][]
  const xs = pts.map((p) => Number(p[0]))
  const ys = pts.map((p) => Number(p[1]))
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const host = { slicer: { loadParts: async (name: string) => ({ id: 'm1', hash: 'm1', name, triangles: 0, bboxMm: [0, 0, 0], openEdges: 0, parts: [] }) } } as unknown as Host

describe('the generic bed', () => {
  it('a fresh session with no printer slices for the plate it shows', async () => {
    await profileReady()
    const s = get()
    expect(s.printerModel).toBeNull()
    expect(s.bed).toEqual(GENERIC_BED)
    const cfg = plateSliceConfig(s, undefined)
    expect(cfg['printable_area']).toEqual(bedSettings(GENERIC_BED)['printable_area'])
    expect(cfg['printable_height']).toBe(GENERIC_BED.heightMm)
  })

  it('the example plate moved to X165 Y160 lies inside the printable area, and one moved past the edge does not', async () => {
    await profileReady()
    await loadDefaultPlate(host)
    const entry = get().plate[0]!
    const box = areaBox(plateSliceConfig(get(), undefined))
    const at = (x: number, y: number) => {
      const t = [...entry.transform] as Mat4
      t[12] = x
      t[13] = y
      return bounds(entry.parts, t)!
    }
    const inside = at(165, 160)
    // The skirt and brim reach a few mm past the footprint; the refusal named X200.8 for this placement.
    const reach = 5
    expect(inside.max[0] + reach).toBeGreaterThan(200)
    expect(inside.min[0] - reach).toBeGreaterThanOrEqual(box[0])
    expect(inside.max[0] + reach).toBeLessThanOrEqual(box[2])
    expect(inside.max[1] + reach).toBeLessThanOrEqual(box[3])
    expect(at(240, 160).max[0]).toBeGreaterThan(box[2])
  })

  it.each([
    ['A1 mini', 180, 180],
    ['A1', 256, 256],
    ['H2D', 350, 320],
  ])('the %s brings its own bed to the plate and the configuration alike', async (model, w, d) => {
    set({ printerModel: { vendor: 'Bambu Lab', model } })
    await profileReady()
    const s = get()
    expect([s.bed.widthMm, s.bed.depthMm]).toEqual([w, d])
    const cfg = plateSliceConfig(s, undefined)
    expect(areaBox(cfg)).toEqual([0, 0, s.bed.widthMm, s.bed.depthMm])
    expect(Number(cfg['printable_height'])).toBe(s.bed.heightMm)
  })

  it('removing the printer brings back the generic bed', async () => {
    set({ printerModel: { vendor: 'Bambu Lab', model: 'A1 mini' } })
    await profileReady()
    expect(get().bed.widthMm).toBe(180)
    set({ printerModel: null })
    await profileReady()
    expect(get().bed).toEqual(GENERIC_BED)
    expect(areaBox(plateSliceConfig(get(), undefined))).toEqual([0, 0, GENERIC_BED.widthMm, GENERIC_BED.depthMm])
  })
})
