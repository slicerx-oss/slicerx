// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Lab A1 and A1 mini as the Print sheet sees them: the stock profiles' beds, excluded areas and start
// G-code, the print options each offers, and the model the printer reports winning over the one it was added as.
import { describe, expect, it } from 'vitest'
import { printerConfig } from '@slicerx/settings'
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { sliceMachine } from '../src/export/threemf'
import { preflight } from '../src/plate/preflight'
import { supportedOptions } from '../src/send/options'

const cfg = (id: string) => printerConfig(id) as unknown as Record<string, unknown>

describe('the stock A1 and A1 mini profiles', () => {
  it('have the beds Orca 2.4.2 gives them and no excluded areas', () => {
    const a1 = cfg('bambu-a1')
    expect(a1['printable_area']).toEqual([[0, 0], [256, 0], [256, 256], [0, 256]])
    expect(a1['printable_height']).toBe(256)
    expect(a1['printer_model']).toBe('Bambu Lab A1')
    const mini = cfg('bambu-a1-mini')
    expect(mini['printable_area']).toEqual([[0, 0], [180, 0], [180, 180], [0, 180]])
    expect(mini['printable_height']).toBe(180)
    expect(mini['printer_model']).toBe('Bambu Lab A1 mini')
    for (const c of [a1, mini]) expect((c['bed_exclude_area'] as unknown[] | undefined) ?? []).toEqual([])
  })

  it('wipe and purge past the bed edge in the start G-code, which the plate check leaves alone', () => {
    // The A1 purges at X -48.2 beside the bed and wipes along Y -0.5; the A1 mini purges past its own edge too.
    const a1 = String(cfg('bambu-a1')['machine_start_gcode'])
    expect(a1).toMatch(/G1 X-48\.2/)
    expect(a1).toMatch(/G1 Y-0\.5/)
    expect(String(cfg('bambu-a1-mini')['machine_start_gcode'])).toMatch(/X-\d/)
    const printer = { id: 'a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1 } as PrinterInfo
    const inside = preflight({ printer, status: null, config: cfg('bambu-a1') as never, plateBounds: { min: [0, 0, 0], max: [256, 256, 20] }, plateBed: { widthMm: 256, depthMm: 256, heightMm: 256 }, file: { name: 'a.gcode.3mf', sha256: 'f'.repeat(64), layers: 10, timeS: 60, grams: 1 } })
    expect(inside.errors).toEqual([])
  })

  it('name the printer in slice_info by its model id', () => {
    expect(sliceMachine(cfg('bambu-a1')).printerModelId).toBe('N2S')
    expect(sliceMachine(cfg('bambu-a1-mini')).printerModelId).toBe('N1')
    expect(sliceMachine(cfg('bambu-a1')).printableArea).toEqual([[0, 0], [256, 0], [256, 256], [0, 256]])
  })
})

describe('the A1 series on the Print sheet', () => {
  const a1 = { vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan' }

  it('offers leveling, flow calibration, vibration compensation and timelapse, but no first layer inspection', () => {
    expect(supportedOptions(a1, { cameraAvailable: true }).map((s) => s.id)).toEqual(['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse'])
    expect(supportedOptions({ ...a1, model: 'A1 mini' }, { cameraAvailable: true }).map((s) => s.id)).not.toContain('firstLayerInspection')
  })

  it('goes by the model the printer reports over the one it was added as', () => {
    expect(supportedOptions({ ...a1, model: 'Bambu printer' }, { cameraAvailable: true, model: 'A1 mini' }).map((s) => s.id)).not.toContain('firstLayerInspection')
    const printer = { id: 'm', name: 'Mini', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1 } as PrinterInfo
    const status = { printerId: 'm', state: 'idle', nozzles: [], slots: [], cameraAvailable: true, updatedAt: '', model: 'A1 mini' } as PrinterStatus
    const wide = preflight({ printer, status, config: cfg('bambu-a1') as never, plateBounds: { min: [0, 0, 0], max: [200, 100, 20] }, plateBed: { widthMm: 256, depthMm: 256, heightMm: 256 }, file: { name: 'a.gcode.3mf', sha256: 'f'.repeat(64), layers: 10, timeS: 60, grams: 1 } })
    expect(wide.errors.join(' ')).toMatch(/180 x 180 mm bed of the A1 mini/)
  })
})
