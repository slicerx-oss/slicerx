// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's tool changer for Preview reads the printer catalog's kinematics: an IDEX printer parks a carriage, it never
// plays the H2D's chute switch. A print the start G-code puts in a copy mode (duplication or mirror) plays no change.
import { describe, expect, it } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type Host, type PreviewBuffers } from '@slicerx/contracts'
import { buildTimeline } from '../src/lib/preview-timeline'
import { toolChangerFor } from '../src/lib/toolchanger'
import { copyModeOf, loadCopyMode } from '../src/workspaces/preview/copy-mode'
import { get, set, type ProfileInfo } from '../src/state/store'

const profile = (printerId: string) => ({ printerId, nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'printer', tier: 'standard', source: 'slicerx' }) as unknown as ProfileInfo

describe('toolChangerFor', () => {
  it('gives the Snapmaker J1, an IDEX printer in the catalog, the carriage park', () => {
    set({ profile: profile('snapmaker-j1'), overrides: { nozzle_diameter: ['0.4', '0.4'], printable_area: ['0x0', '324x0', '324x200', '0x200'] }, bed: { widthMm: 324, depthMm: 200, heightMm: 200 } })
    const spec = toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })
    expect(spec?.kind).toBe('idex-park')
    expect(spec?.idex?.park).toEqual([-50, 374])
    expect(spec?.chute).toBeUndefined()
  })

  it('plays nothing on the Snapmaker Artisan and keeps the H2D on its chute switch', () => {
    set({ profile: profile('snapmaker-artisan'), overrides: { nozzle_diameter: ['0.4', '0.4'] }, bed: { widthMm: 400, depthMm: 400, heightMm: 400 } })
    expect(toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })).toBeNull()
    set({ profile: profile('bambu-h2d'), overrides: { nozzle_diameter: ['0.4', '0.4'] }, bed: { widthMm: 350, depthMm: 320, heightMm: 325 } })
    expect(toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })?.kind).toBe('dual-nozzle')
  })
})

/** Two layers of moves along y 0, the first in tool 0 and the second in tool 1: one tool change. */
function twoTools(): PreviewBuffers {
  const layers: [number, number, number][][] = [[[10, 60, 0], [60, 10, 0]], [[200, 250, 1], [250, 200, 1]]]
  const N = layers.length
  const S = layers.reduce((a, l) => a + l.length, 0)
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + S * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, N, true)
  dv.setUint32(20, 2, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  dv.setUint32(o, 0, true)
  dv.setUint32(o + 4, 2, true)
  dv.setUint32(o + 8, S, true)
  o += (N + 1) * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, 0.2 * (k + 1), true))
  o += N * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, 10, true))
  o += N * 4
  layers.forEach((l, k) => {
    for (const [x0, x1, tool] of l) {
      dv.setFloat32(o, x0, true)
      dv.setFloat32(o + 8, x1, true)
      dv.setFloat32(o + 16, 0.2 * (k + 1), true)
      dv.setUint16(o + 20, 400, true)
      dv.setUint16(o + 22, 200, true)
      dv.setUint8(o + 25, tool)
      dv.setUint16(o + 26, 1000, true)
      o += SXPV_SEGMENT_BYTES
    }
  })
  return readPreview(raw)
}

const NL = '\n'

/** The J1's start G-code as the engine renders it for a plate whose name picks a mode (the profile's own lines). */
const j1Start = (modeLine: string) => ['; Model: Snapmaker J1 (0.4/0.4)', '; Plate   : IDEX', '', 'T0', '', 'M205 V8 ;Junction Deviation (mm)', '', modeLine, '', 'M140 S60', 'G28', 'G0 Z100.0', 'G1 X10 Y0 E5 F1200'].join(NL)

describe('IDEX copy modes', () => {
  it('reads the mode from the last M605 of the start G-code, outside comments', () => {
    expect(copyModeOf(j1Start('  M605 S2 X162 R0 ;IDEX Duplication').split(NL))).toBe('duplicate')
    expect(copyModeOf(j1Start('  M605 S3 ;IDEX Mirror').split(NL))).toBe('mirror')
    // Backup mode prints with one carriage at a time: changes play as usual.
    expect(copyModeOf(j1Start('  M605 S4 ;IDEX Backup').split(NL))).toBeNull()
    expect(copyModeOf(j1Start('').split(NL))).toBeNull()
    expect(copyModeOf(['; M605 S2 X162', 'G28'])).toBeNull()
    expect(copyModeOf(['M605 S2 X150', 'M605 S1'])).toBeNull()
    expect(copyModeOf(['m605 s3'])).toBe('mirror')
  })

  it('plays no tool change for a J1 print in duplication mode, and the same print in normal mode still plays it', async () => {
    const p = twoTools()
    const j1 = { profile: profile('snapmaker-j1'), overrides: { nozzle_diameter: ['0.4', '0.4'], printable_area: ['0x0', '324x0', '324x200', '0x200'] }, bed: { widthMm: 324, depthMm: 200, heightMm: 200 } }
    set({ ...j1, preview: p, copyMode: null })
    const normal = toolChangerFor(get())
    expect(normal?.kind).toBe('idex-park')
    expect(buildTimeline(p, normal).changes).toHaveLength(1)

    // The start G-code read from the slice's text, as Preview reads it once the slice is done.
    const text = j1Start('  M605 S2 X162 R0 ;IDEX Duplication')
    const host = { slicer: { exportGcode: async () => ({ blob: new Blob([text]) }) } } as unknown as Host
    set({ slice: { status: 'done', stale: false, result: { id: 'copy-j1', gcodeFormat: 'gcode' } } as never })
    const mode = await loadCopyMode(host, p)
    expect(mode).toBe('duplicate')
    set({ copyMode: { preview: p, mode: mode! } })
    const copy = toolChangerFor(get())
    expect(copy).toBeNull()
    expect(buildTimeline(p, copy).changes).toHaveLength(0)

    // A mode read for another preview counts for none: the next slice plays its changes until its own start is read.
    set({ preview: twoTools() })
    expect(toolChangerFor(get())?.kind).toBe('idex-park')
    set({ slice: { status: 'idle' } as never, preview: null, copyMode: null })
  })
})
