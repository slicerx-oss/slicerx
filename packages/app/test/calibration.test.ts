// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { addCalibrationPlate, applyCalibrationResult, defaultValues } from '../src/calibration/actions'
import { CALIB_TESTS, calibTest, checkValues, resultSettings, series } from '../src/calibration/tests'
import { setGeomProvider } from '../src/geom/client'
import { get, set } from '../src/state/store'

beforeEach(() => {
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', overrides: {}, objectSettings: {}, calibration: {}, slice: { status: 'idle' } })
})

describe('calibration tests', () => {
  it('steps a range in either direction without float noise', () => {
    expect(series(230, 190, 5, 0)).toEqual([230, 225, 220, 215, 210, 205, 200, 195, 190])
    expect(series(0.93, 1.01, 0.02, 3)).toEqual([0.93, 0.95, 0.97, 0.99, 1.01])
    expect(series(0, 1, 0.1, 2)).toHaveLength(11)
    expect(series(0, 100, 0.1, 1)).toEqual([])
    expect(series(1, 2, 0, 1)).toEqual([])
  })

  it('defaults every test to a usable range', () => {
    for (const t of CALIB_TESTS) expect(checkValues(t, t.defaults({})), t.id).toBeNull()
  })

  it('centers the temperature range on the current nozzle temperature', () => {
    expect(calibTest('temp-tower').defaults({ nozzle_temperature: [220] })).toEqual({ fromC: 240, toC: 200, stepC: 5 })
  })

  it('rejects values outside a field range and single-step ranges', () => {
    const t = calibTest('flow')
    expect(checkValues(t, { from: 0.5, to: 1, step: 0.02 })).toMatch(/First ratio/)
    expect(checkValues(t, { from: 1, to: 1, step: 0.02 })).toMatch(/at least 2/)
    expect(checkValues(t, { from: NaN, to: 1, step: 0.02 })).toMatch(/needs a number/)
  })

  it('names the engine fields in the request', () => {
    expect(calibTest('temp-tower').request({ fromC: 230, toC: 190, stepC: 5 })).toEqual({ test: 'temp-tower', fromC: 230, toC: 190, stepC: 5 })
    expect(calibTest('max-volumetric').request({ fromMm3S: 5, toMm3S: 20, stepMm3S: 1 })).toMatchObject({ test: 'max-volumetric', fromMm3S: 5 })
  })

  it('tolerance steps the clearances and writes a single number, not a list', () => {
    const t = calibTest('tolerance')
    expect(t.request({ nominalMm: 8, fromMm: 0, toMm: 0.5, stepMm: 0.1 })).toEqual({ test: 'tolerance', nominalMm: 8, clearancesMm: [0, 0.1, 0.2, 0.3, 0.4, 0.5] })
    expect(t.candidates({ nominalMm: 8, fromMm: 0, toMm: 0.5, stepMm: 0.1 })).toHaveLength(6)
    expect(checkValues(t, t.defaults({}))).toBeNull()
    // The engine takes at most 12 holes.
    expect(checkValues(t, { nominalMm: 8, fromMm: 0, toMm: 2, stepMm: 0.05 })).toMatch(/steps/)
    expect(resultSettings(t, 0.2)).toEqual({ xy_hole_compensation: 0.2 })
  })

  it('shrinkage turns a measured length into a percentage', () => {
    const t = calibTest('shrinkage')
    expect(t.measure!.toValue(99.4, { armMm: 100 })).toBeCloseTo(99.4)
    expect(t.measure!.toValue(47.5, { armMm: 50 })).toBeCloseTo(95)
    expect(checkValues(t, t.defaults({}))).toBeNull()
    expect(t.request({ armMm: 120 })).toEqual({ test: 'shrinkage', armMm: 120 })
    expect(resultSettings(t, 99.4)).toEqual({ filament_shrink: [99.4] })
  })

  it('writes filament settings as one-element lists', () => {
    expect(resultSettings(calibTest('temp-tower'), 204.6)).toEqual({ nozzle_temperature: [205] })
    expect(resultSettings(calibTest('pressure-advance'), 0.03)).toEqual({ pressure_advance: [0.03], enable_pressure_advance: [true] })
    expect(resultSettings(calibTest('pressure-advance'), 0)).toEqual({ pressure_advance: [0], enable_pressure_advance: [false] })
    expect(resultSettings(calibTest('flow'), 0.97)).toEqual({ filament_flow_ratio: [0.97] })
  })
})

describe('calibration plate', () => {
  const loader = {
    loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: `h-${name}`, hash: name, name, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: 12 })) }),
  }

  it('builds the model onto a new plate with its height bands, and saves a result to the filament', async () => {
    const calls: unknown[] = []
    setGeomProvider({
      call: async (op, request) => {
        calls.push([op, request])
        return {
          name: 'temp-tower',
          objects: [{ name: 'Tower', mesh: { positions: [0, 0, 0, 40, 0, 0, 0, 14, 0, 0, 0, 30], indices: [0, 1, 2, 0, 2, 3, 0, 1, 3, 1, 2, 3] }, offsetMm: [0, 0], settings: {} }],
          ranges: [{ zFromMm: 0, zToMm: 10, settings: { nozzle_temperature: [230] } }],
          instructions: ['Print it.'],
        } as never
      },
    })
    const id = await addCalibrationPlate(loader, 'temp-tower', { fromC: 230, toC: 190, stepC: 10 })
    expect(calls[0]).toEqual(['calibrate', { request: { test: 'temp-tower', fromC: 230, toC: 190, stepC: 10 }, meshOutput: 'flat' }])
    const s = get()
    expect(s.activePlate).toBe(id)
    expect(s.plates.find((p) => p.id === id)?.name).toBe('Calibration: Temperature tower')
    expect(s.plate).toHaveLength(1)
    // Centered on the 256 mm bed: a 40 x 14 layout starts at 108, 121.
    expect(s.plate[0]!.transform[12]).toBeCloseTo(108)
    expect(s.plate[0]!.transform[13]).toBeCloseTo(121)
    expect(s.calibration[id]).toMatchObject({ test: 'temp-tower', values: [230, 220, 210, 200, 190] })
    applyCalibrationResult('temp-tower', 210)
    // A filament result belongs to its spool and is read per slot at slice time, not written to the shared settings.
    expect(get().overrides['nozzle_temperature']).toBeUndefined()
  })

  it('refuses a bad range before calling the engine', async () => {
    await expect(addCalibrationPlate(loader, 'flow', { from: 1, to: 1, step: 0.02 })).rejects.toThrow(/at least 2/)
    expect(defaultValues('flow')).toHaveProperty('step')
  })
})

describe('towers and tool paths', () => {
  const loader = {
    loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: `h-${name}`, hash: name, name, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: 12 })) }),
  }
  const box = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 1, 2, 0, 2, 3, 0, 1, 3, 1, 2, 3] }

  it('maps a height to the layer that starts there', async () => {
    const { layerIndexAt, spliceBody } = await import('../src/calibration/gcode')
    expect(layerIndexAt(0, 0.2, 0.2)).toBe(0)
    expect(layerIndexAt(0.2, 0.2, 0.2)).toBe(1)
    expect(layerIndexAt(5, 0.2, 0.2)).toBe(25)
    expect(layerIndexAt(5, 0.2, 0.3)).toBe(Math.round(4.7 / 0.2) + 1)
    const file = 'G28\n;LAYER_CHANGE\nG1 X1\n;LAYER_CHANGE\nG1 X2\n\n; end\nM84\n'
    expect(spliceBody(file, 'G1 X9\n')).toBe('G28\n; calibration test: G-code from the test, not from slicing\nG1 X9\n; end\nM84\n')
    expect(spliceBody('G28\nM84\n', 'G1 X9')).toBeNull()
    // a bambu lab file marks its layers with orca's bambu tag
    expect(spliceBody(file.replaceAll(';LAYER_CHANGE', '; CHANGE_LAYER'), 'G1 X9\n')).toBe('G28\n; calibration test: G-code from the test, not from slicing\nG1 X9\n; end\nM84\n')
  })

  it('a tower puts its band commands at the band layers and keeps them by value for the result', async () => {
    const calls: unknown[] = []
    setGeomProvider({
      call: async (_op, request) => {
        calls.push(request)
        return {
          name: 'input-shaping-freq',
          objects: [{ name: 'Tower', mesh: box, offsetMm: [0, 0], settings: {} }],
          ranges: [],
          instructions: ['Read the band.'],
          expected: {
            setupGcode: { gcode: { klipper: 'SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=0', marlin: 'M593 T0' } },
            layerCommands: [
              { zFromMm: 0, zToMm: 5, freqHz: 30, gcode: { klipper: 'SET_INPUT_SHAPER SHAPER_FREQ_X=30', marlin: 'M593 X F30' } },
              { zFromMm: 5, zToMm: 10, freqHz: 40, gcode: { klipper: 'SET_INPUT_SHAPER SHAPER_FREQ_X=40', marlin: 'M593 X F40' } },
            ],
          },
        } as never
      },
    })
    set({ overrides: { layer_height: 0.2, initial_layer_print_height: 0.2 } })
    const id = await addCalibrationPlate(loader, 'input-shaping-freq', calibTest('input-shaping-freq').defaults({}))
    const run = get().calibration[id]!
    // The default printer flavor is marlin, so the marlin text is used.
    expect(run.layerGcode).toEqual([
      { layer: 0, kind: 'custom', gcode: 'M593 T0\nM593 X F30' },
      { layer: 25, kind: 'custom', gcode: 'M593 X F40' },
    ])
    expect(run.values).toEqual([30, 40])
    expect(run.bandGcode).toEqual({ '30': 'M593 X F30', '40': 'M593 X F40' })
    expect((calls[0] as { request: { test: string } }).request.test).toBe('input-shaping-freq')
  })

  it('a pressure advance line keeps its G-code body and slices a placeholder', async () => {
    setGeomProvider({
      call: async () =>
        ({ name: 'pa-line', objects: [], ranges: [], instructions: ['Print it.'], expected: { gcode: 'M900 K0.0000\nG1 X10 E1\n', values: [0, 0.002, 0.004] } }) as never,
    })
    const id = await addCalibrationPlate(loader, 'pa-line', calibTest('pa-line').defaults({}))
    const run = get().calibration[id]!
    expect(run.body).toContain('M900 K0.0000')
    expect(run.values).toEqual([0, 0.002, 0.004])
    expect(get().plate).toHaveLength(1)
    expect(get().plate[0]!.name).toBe('Placeholder')
  })

  it('the path and tower requests carry what the engine needs', () => {
    const ctx = { bedWidthMm: 220, bedDepthMm: 220, nozzleMm: 0.6, layerHeightMm: 0.3, flavor: 'klipper' as const, filamentDiameterMm: 1.75, flowRatio: 0.98, retractionMm: 0.5 }
    const pa = calibTest('pa-line').request(calibTest('pa-line').defaults({}), ctx) as Record<string, unknown>
    expect(pa).toMatchObject({ test: 'pa-line', nozzleDiameterMm: 0.6, layerHeightMm: 0.3, bedWidthMm: 220, gcode: { flavor: 'klipper', flowRatio: 0.98 } })
    expect(calibTest('cornering-jerk').request({ start: 1, end: 15 })).toEqual({ test: 'cornering', mode: 'jerk', start: 1, end: 15 })
    expect(calibTest('cornering-jd').request({ start: 0, end: 0.25 })).toEqual({ test: 'cornering', mode: 'junctionDeviation', start: 0, end: 0.25 })
    expect(calibTest('vfa').request({ startMmS: 40, endMmS: 200, stepMmS: 10, bandMm: 5 })).toEqual({ test: 'vfa', startMmS: 40, endMmS: 200, stepMmS: 10, bandMm: 5 })
  })

  it('every test has a usable default, and results land in the right setting', () => {
    for (const t of CALIB_TESTS) expect(checkValues(t, t.defaults({})), t.id).toBeNull()
    expect(resultSettings(calibTest('cornering-jerk'), 7)).toEqual({ machine_max_jerk_x: [7, 7], machine_max_jerk_y: [7, 7] })
    expect(resultSettings(calibTest('cornering-jd'), 0.05)).toEqual({ machine_max_junction_deviation: [0.05] })
    expect(resultSettings(calibTest('vfa'), 120)).toEqual({ outer_wall_speed: [120] })
    expect(calibTest('input-shaping-freq').result.firmware).toBe(true)
    expect(resultSettings(calibTest('input-shaping-freq'), 40)).toEqual({})
  })
})
