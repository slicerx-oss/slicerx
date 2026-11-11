// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's tool changer for Preview on the Bambu Lab H3C: the shipped profile gives the PrintTool rack, each filament
// takes the hotend the slice's filament map gave it, and a real two filament slice plays all of its changes, each a
// 4 s hotend swap after the first visit to a hotend loads it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { printerConfig } from '@slicerx/settings'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type PreviewBuffers } from '@slicerx/contracts'
import type { SettingValue } from '@slicerx/contracts/settings'
import { buildTimeline } from '../src/lib/preview-timeline'
import { toolChangerFor } from '../src/lib/toolchanger'
import { get, set, type ProfileInfo } from '../src/state/store'

const profile = (printerId: string) => ({ printerId, nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'printer', tier: 'standard', source: 'slicerx' }) as unknown as ProfileInfo
const shipped = (id: string) => printerConfig(id) as unknown as Record<string, SettingValue>
/** The stock Standard process's travel speed for the H3C, which the app's tier gives the print (resolved/bambu-lab.json). */
const h3cModel = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'profiles', 'resolved', 'bambu-lab.json'), 'utf8')) as { models: Record<string, { base: string; process: Record<string, Record<string, SettingValue>> }> }).models['bambu-h3c']!
const travel = { travel_speed: h3cModel.process[h3cModel.base]!['travel_speed']! }
const BED = { widthMm: 330, depthMm: 320, heightMm: 325 }

/**
 * A real H3C slice of two cubes, PETG in filament 1 and ABS in filament 3: 165 layers, each printing both filaments and
 * starting with the one the layer before ended on, so 165 changes. The slice's map: filament 1 on hotend 0, filament 3
 * on hotend 1, filament 2 unprinted on hotend 0.
 */
function realSlice(): PreviewBuffers {
  const N = 165
  const S = 2 * N
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + S * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, N, true)
  dv.setUint32(20, 3, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  for (let k = 0; k <= N; k++) dv.setUint32(o + k * 4, Math.min(2 * k, S), true)
  o += (N + 1) * 4
  for (let k = 0; k < N; k++) dv.setFloat32(o + k * 4, 0.2 * (k + 1), true)
  o += N * 4
  for (let k = 0; k < N; k++) dv.setFloat32(o + k * 4, 20, true)
  o += N * 4
  let tool = 0
  for (let k = 0; k < N; k++) {
    for (const x of [150, 230]) {
      dv.setFloat32(o, x, true)
      dv.setFloat32(o + 4, 160, true)
      dv.setFloat32(o + 8, x + 30, true)
      dv.setFloat32(o + 12, 160, true)
      dv.setFloat32(o + 16, 0.2 * (k + 1), true)
      dv.setUint16(o + 20, 420, true)
      dv.setUint16(o + 22, 200, true)
      dv.setUint8(o + 24, 0)
      dv.setUint8(o + 25, tool)
      dv.setUint16(o + 26, 1000, true)
      o += SXPV_SEGMENT_BYTES
      if (x === 150) tool = tool === 0 ? 2 : 0
    }
  }
  return readPreview(raw)
}

const sliced = (nozzles: number[]) => ({ status: 'done', result: { filamentMap: { extruders: nozzles.map(() => 1), nozzles, auto: true } } }) as never

describe('toolChangerFor on the H3C', () => {
  it('gives the shipped H3C profile the PrintTool rack, nine docks, and each filament the hotend the slice gave it', () => {
    set({ profile: profile('bambu-h3c'), overrides: shipped('bambu-h3c'), bed: BED })
    const spec = toolChangerFor({ ...get(), preview: { toolCount: 3 } as never, slice: sliced([0, 0, 1, 0, 0, 0, 0, 0]) })
    expect(spec?.kind).toBe('printtool-rack')
    expect(spec?.printTool?.x).toHaveLength(9)
    expect(spec?.extruderOf).toEqual([0, 0, 1])
    expect(spec?.seconds.switch).toBe(4)
    expect(spec?.chute?.exitY).toEqual([295, 265])
    expect(spec?.rack).toBeUndefined()
  })

  it('plays every change of a real two filament slice: a 4 s swap, the first visit to hotend 1 loading it as well', () => {
    set({ profile: profile('bambu-h3c'), overrides: { ...shipped('bambu-h3c'), ...travel }, bed: BED })
    const p = realSlice()
    const spec = toolChangerFor({ ...get(), preview: p, slice: sliced([0, 0, 1, 0, 0, 0, 0, 0]) })!
    const tl = buildTimeline(p, spec)
    expect(tl.changes).toHaveLength(165)
    expect(tl.changes.map((c) => c.to)).toEqual(Array.from({ length: 165 }, (_, i) => (i % 2 === 0 ? 2 : 0)))
    expect(tl.changes.map((c) => spec.extruderOf[c.to])).toEqual(Array.from({ length: 165 }, (_, i) => (i % 2 === 0 ? 1 : 0)))
    expect(tl.changes[0]!.fixed).toBe(19)
    expect(new Set(tl.changes.slice(1).map((c) => c.fixed))).toEqual(new Set([4]))
    // A swap plays in a few seconds: the firmware's 4 s plus the lift, the exit moves and the return.
    for (const c of tl.changes.slice(1)) {
      expect(c.duration).toBeGreaterThan(4)
      expect(c.duration).toBeLessThan(7)
    }
  })
})
