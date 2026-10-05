// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The calibration tests: what each asks for, the request that builds its model in sx-geom, the values a
// printed result can be read as, and the filament setting the chosen value is written to.
import type { SettingValue } from '@slicerx/contracts'

/** The resolved settings a test reads its starting range from. */
export type Cfg = Record<string, SettingValue | undefined>

export type CalibId = 'temp-tower' | 'flow' | 'pressure-advance' | 'retraction' | 'max-volumetric' | 'tolerance' | 'shrinkage' | 'pa-line' | 'pa-pattern' | 'vfa' | 'input-shaping-freq' | 'input-shaping-damp' | 'cornering-jd' | 'cornering-jerk'

/** The printer and filament values some tests need in their request: the bed, nozzle and layer height, the G-code dialect and the filament. */
export interface CalibCtx {
  bedWidthMm: number
  bedDepthMm: number
  nozzleMm: number
  layerHeightMm: number
  /** As the path tests spell it: klipper, marlin, repRapFirmware, repetier or bambu. */
  flavor: 'klipper' | 'marlin' | 'repRapFirmware' | 'repetier' | 'bambu'
  filamentDiameterMm: number
  flowRatio: number
  retractionMm: number
}

export const DEFAULT_CTX: CalibCtx = { bedWidthMm: 256, bedDepthMm: 256, nozzleMm: 0.4, layerHeightMm: 0.2, flavor: 'klipper', filamentDiameterMm: 1.75, flowRatio: 1, retractionMm: 0.8 }

export interface CalibField {
  key: string
  label: string
  unit?: string
  min: number
  max: number
  step: number
}

export interface CalibTest {
  id: CalibId
  label: string
  /** One line on what it finds. */
  blurb: string
  fields: CalibField[]
  defaults(config: Cfg): Record<string, number>
  /** Request for the sx-geom `calibrate` op; the field names are the engine's. */
  request(v: Record<string, number>, ctx?: CalibCtx): Record<string, unknown>
  /** The values the model steps through, in print order (bottom or first pad first). */
  candidates(v: Record<string, number>): number[]
  /** A test read by measuring the print instead of picking a step: the measured number becomes the value. */
  /** `min` and `max` bound the resulting value. */
  measure?: { label: string; unit: string; toValue(measured: number, v: Record<string, number>): number; min: number; max: number }
  /**
   * Where the steps come from. `request` (the default): the field values give them. `response`: the engine's answer does
   * (towers and tool paths, whose values it lays out itself), so the fields only need to be in range.
   */
  steps?: 'response'
  /** Settings that hold one number, not a list per filament. `pair` writes it twice (normal and silent mode). */
  result: { label: string; unit: string; digits: number; keys: readonly string[]; scalar?: boolean; pair?: boolean; /** No profile setting: the value is a command for the printer's firmware. */ firmware?: boolean }
}

/** The engine's longest run of steps. */
export const MAX_STEPS = 64

/** Values from `from` to `to` in `step`s, either direction, rounded to kill float noise. Empty when the range is unusable. */
export function series(from: number, to: number, step: number, digits: number): number[] {
  if (![from, to, step].every(Number.isFinite) || step <= 0) return []
  const n = Math.floor(Math.abs(to - from) / step + 1e-9) + 1
  if (n > MAX_STEPS) return []
  const dir = to >= from ? 1 : -1
  return Array.from({ length: n }, (_, i) => Number((from + dir * step * i).toFixed(digits)))
}

const first = (v: SettingValue | undefined, fallback: number): number => {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'number' ? x : fallback
}

const F = (key: string, label: string, min: number, max: number, step: number, unit?: string): CalibField => ({ key, label, min, max, step, ...(unit ? { unit } : {}) })

export const CALIB_TESTS: readonly CalibTest[] = [
  {
    id: 'temp-tower',
    label: 'Temperature tower',
    blurb: 'Finds the nozzle temperature with the cleanest bridges, overhangs and layer bonding.',
    fields: [F('fromC', 'Start (bottom)', 170, 350, 1, '°C'), F('toC', 'End (top)', 170, 350, 1, '°C'), F('stepC', 'Step', 1, 20, 1, '°C')],
    defaults: (c) => {
      const t = first(c['nozzle_temperature'], 210)
      return { fromC: t + 20, toC: t - 20, stepC: 5 }
    },
    request: (v) => ({ test: 'temp-tower', fromC: v['fromC'], toC: v['toC'], stepC: v['stepC'] }),
    candidates: (v) => series(v['fromC']!, v['toC']!, v['stepC']!, 0),
    result: { label: 'Best temperature', unit: '°C', digits: 0, keys: ['nozzle_temperature'] },
  },
  {
    id: 'flow',
    label: 'Flow ratio',
    blurb: 'Finds the flow ratio that gives a smooth, gap-free top surface without ridges.',
    fields: [F('from', 'First ratio', 0.8, 1.2, 0.01), F('to', 'Last ratio', 0.8, 1.2, 0.01), F('step', 'Step', 0.005, 0.05, 0.005)],
    defaults: (c) => {
      const r = first(c['filament_flow_ratio'], 0.98)
      return { from: Number((r - 0.05).toFixed(3)), to: Number((r + 0.03).toFixed(3)), step: 0.02 }
    },
    request: (v) => ({ test: 'flow', from: v['from'], to: v['to'], step: v['step'] }),
    candidates: (v) => series(v['from']!, v['to']!, v['step']!, 3),
    result: { label: 'Best flow ratio', unit: '', digits: 3, keys: ['filament_flow_ratio'] },
  },
  {
    id: 'pressure-advance',
    label: 'Pressure advance',
    blurb: 'Finds the value that keeps corners sharp without gaps after them.',
    fields: [F('from', 'Bottom value', 0, 1.5, 0.001), F('to', 'Top value', 0, 1.5, 0.001), F('step', 'Step', 0.001, 0.1, 0.001)],
    defaults: () => ({ from: 0, to: 0.06, step: 0.005 }),
    request: (v) => ({ test: 'pressure-advance', from: v['from'], to: v['to'], step: v['step'] }),
    candidates: (v) => series(v['from']!, v['to']!, v['step']!, 4),
    result: { label: 'Best pressure advance', unit: '', digits: 4, keys: ['pressure_advance', 'enable_pressure_advance'] },
  },
  {
    id: 'retraction',
    label: 'Retraction',
    blurb: 'Finds the shortest retraction that leaves no strings between the towers.',
    fields: [F('fromMm', 'Bottom length', 0, 10, 0.1, 'mm'), F('toMm', 'Top length', 0, 10, 0.1, 'mm'), F('stepMm', 'Step', 0.1, 2, 0.1, 'mm')],
    defaults: (c) => {
      const r = first(c['retraction_length'], 0.8)
      return { fromMm: 0, toMm: Math.max(1, Number((r * 2).toFixed(1))), stepMm: 0.2 }
    },
    request: (v) => ({ test: 'retraction', fromMm: v['fromMm'], toMm: v['toMm'], stepMm: v['stepMm'] }),
    candidates: (v) => series(v['fromMm']!, v['toMm']!, v['stepMm']!, 2),
    result: { label: 'Best retraction length', unit: 'mm', digits: 2, keys: ['filament_retraction_length'] },
  },
  {
    id: 'max-volumetric',
    label: 'Max volumetric speed',
    blurb: 'Finds how fast the hotend can melt this filament before extrusion turns thin or clicks.',
    fields: [F('fromMm3S', 'Bottom flow', 1, 80, 0.5, 'mm³/s'), F('toMm3S', 'Top flow', 1, 80, 0.5, 'mm³/s'), F('stepMm3S', 'Step', 0.1, 5, 0.1, 'mm³/s')],
    defaults: (c) => {
      const m = first(c['filament_max_volumetric_speed'], 12)
      return { fromMm3S: Math.max(1, Math.round(m - 4)), toMm3S: Math.round(m + 12), stepMm3S: 1 }
    },
    request: (v) => ({ test: 'max-volumetric', fromMm3S: v['fromMm3S'], toMm3S: v['toMm3S'], stepMm3S: v['stepMm3S'] }),
    candidates: (v) => series(v['fromMm3S']!, v['toMm3S']!, v['stepMm3S']!, 1),
    result: { label: 'Highest clean flow', unit: 'mm³/s', digits: 1, keys: ['filament_max_volumetric_speed'] },
  },
  {
    id: 'tolerance',
    label: 'Hole tolerance',
    blurb: 'Finds how much bigger holes must be for a peg to fit, and writes it as the hole compensation.',
    fields: [F('nominalMm', 'Hole and peg diameter', 2, 30, 0.5, 'mm'), F('fromMm', 'Smallest clearance', 0, 2, 0.05, 'mm'), F('toMm', 'Largest clearance', 0, 2, 0.05, 'mm'), F('stepMm', 'Step', 0.05, 0.5, 0.05, 'mm')],
    defaults: () => ({ nominalMm: 8, fromMm: 0, toMm: 0.5, stepMm: 0.1 }),
    request: (v) => ({ test: 'tolerance', nominalMm: v['nominalMm'], clearancesMm: series(v['fromMm']!, v['toMm']!, v['stepMm']!, 2) }),
    candidates: (v) => (series(v['fromMm']!, v['toMm']!, v['stepMm']!, 2).length <= 12 ? series(v['fromMm']!, v['toMm']!, v['stepMm']!, 2) : []),
    result: { label: 'Smallest clearance the peg fits', unit: 'mm', digits: 2, keys: ['xy_hole_compensation'], scalar: true },
  },
  {
    id: 'shrinkage',
    label: 'Shrinkage',
    blurb: 'Measures how much the filament shrinks as it cools and writes the percentage. Measure the long arm after it cools.',
    fields: [F('armMm', 'Arm length', 20, 250, 1, 'mm')],
    defaults: () => ({ armMm: 100 }),
    request: (v) => ({ test: 'shrinkage', armMm: v['armMm'] }),
    candidates: () => [],
    measure: { label: 'Measured arm length', unit: 'mm', min: 50, max: 150, toValue: (measured, v) => (measured / v['armMm']!) * 100 },
    result: { label: 'Shrinkage', unit: '%', digits: 2, keys: ['filament_shrink'] },
  },
  {
    id: 'pa-line',
    label: 'Pressure advance lines',
    blurb: 'Prints one line per value, each slow, fast and slow again. The line with an even width and sharp ends has the right value. A toolpath, no model.',
    fields: [F('start', 'First value', 0, 2, 0.001), F('step', 'Step', 0.0005, 0.05, 0.0005), F('count', 'Lines', 3, 100, 1), F('slowSpeedMmS', 'Slow speed', 5, 100, 1, 'mm/s'), F('fastSpeedMmS', 'Fast speed', 20, 400, 1, 'mm/s')],
    defaults: () => ({ start: 0, step: 0.002, count: 30, slowSpeedMmS: 20, fastSpeedMmS: 100 }),
    request: (v, ctx = DEFAULT_CTX) => ({ test: 'pa-line', start: v['start'], step: v['step'], count: v['count'], slowSpeedMmS: v['slowSpeedMmS'], fastSpeedMmS: v['fastSpeedMmS'], ...pathCommon(ctx) }),
    candidates: (v) => series(v['start']!, v['start']! + v['step']! * (v['count']! - 1), v['step']!, 4),
    steps: 'response',
    result: { label: 'Best pressure advance', unit: '', digits: 4, keys: ['pressure_advance', 'enable_pressure_advance'] },
  },
  {
    id: 'pa-pattern',
    label: 'Pressure advance pattern',
    blurb: 'Prints a row of chevrons, each at its own value. The sharpest point with no gaps or bulges has the right value. A toolpath, no model.',
    fields: [F('start', 'First value', 0, 2, 0.001), F('end', 'Last value', 0, 2, 0.001), F('step', 'Step', 0.0005, 0.05, 0.0005), F('wallCount', 'Walls', 1, 6, 1)],
    defaults: () => ({ start: 0, end: 0.08, step: 0.005, wallCount: 3 }),
    request: (v, ctx = DEFAULT_CTX) => ({ test: 'pa-pattern', start: v['start'], end: v['end'], step: v['step'], wallCount: v['wallCount'], ...pathCommon(ctx) }),
    candidates: (v) => series(v['start']!, v['end']!, v['step']!, 4),
    steps: 'response',
    result: { label: 'Best pressure advance', unit: '', digits: 4, keys: ['pressure_advance', 'enable_pressure_advance'] },
  },
  {
    id: 'vfa',
    label: 'Vertical fine artifacts (speed)',
    blurb: 'A tower whose outer wall speed steps up every band. The speeds with the least ribbing on the wall are the ones to print at.',
    fields: [F('startMmS', 'Start speed', 20, 400, 1, 'mm/s'), F('endMmS', 'End speed', 20, 400, 1, 'mm/s'), F('stepMmS', 'Step', 1, 50, 1, 'mm/s'), F('bandMm', 'Band height', 2, 20, 0.5, 'mm')],
    defaults: () => ({ startMmS: 40, endMmS: 200, stepMmS: 10, bandMm: 5 }),
    request: (v) => ({ test: 'vfa', startMmS: v['startMmS'], endMmS: v['endMmS'], stepMmS: v['stepMmS'], bandMm: v['bandMm'] }),
    candidates: (v) => series(v['startMmS']!, v['endMmS']!, v['stepMmS']!, 0),
    steps: 'response',
    result: { label: 'Outer wall speed', unit: 'mm/s', digits: 0, keys: ['outer_wall_speed'] },
  },
  {
    id: 'input-shaping-freq',
    label: 'Input shaping frequency',
    blurb: 'A tower with a shaper frequency per band. The height with the weakest ripples after corners has the right frequency. The value is set in the printer, not the profile.',
    fields: [F('startHz', 'Start frequency', 5, 300, 1, 'Hz'), F('endHz', 'End frequency', 5, 300, 1, 'Hz'), F('dampingRatio', 'Damping ratio', 0, 1, 0.01)],
    defaults: () => ({ startHz: 15, endHz: 110, dampingRatio: 0.15 }),
    request: (v) => ({ test: 'input-shaping-freq', startHz: v['startHz'], endHz: v['endHz'], dampingRatio: v['dampingRatio'] }),
    candidates: () => [],
    steps: 'response',
    result: { label: 'Best frequency', unit: 'Hz', digits: 0, keys: [], firmware: true },
  },
  {
    id: 'input-shaping-damp',
    label: 'Input shaping damping',
    blurb: 'A tower with a damping ratio per band at a fixed frequency. The value is set in the printer, not the profile.',
    fields: [F('freqHz', 'Frequency', 5, 300, 1, 'Hz'), F('startDamping', 'Start damping', 0, 1, 0.01), F('endDamping', 'End damping', 0, 1, 0.01)],
    defaults: () => ({ freqHz: 30, startDamping: 0, endDamping: 0.4 }),
    request: (v) => ({ test: 'input-shaping-damp', freqHz: v['freqHz'], startDamping: v['startDamping'], endDamping: v['endDamping'] }),
    candidates: () => [],
    steps: 'response',
    result: { label: 'Best damping ratio', unit: '', digits: 2, keys: [], firmware: true },
  },
  {
    id: 'cornering-jd',
    label: 'Cornering (junction deviation)',
    blurb: 'A tower with a junction deviation per band. Pick the height with sharp corners and acceptable ringing. Stay well under a value that shifts layers.',
    fields: [F('start', 'Start', 0, 1, 0.005, 'mm'), F('end', 'End', 0, 1, 0.005, 'mm')],
    defaults: () => ({ start: 0, end: 0.25 }),
    request: (v) => ({ test: 'cornering', mode: 'junctionDeviation', start: v['start'], end: v['end'] }),
    candidates: () => [],
    steps: 'response',
    result: { label: 'Junction deviation', unit: 'mm', digits: 3, keys: ['machine_max_junction_deviation'] },
  },
  {
    id: 'cornering-jerk',
    label: 'Cornering (jerk)',
    blurb: 'A tower with a jerk value per band. Pick the height with sharp corners and acceptable ringing. Stay well under a value that shifts layers.',
    fields: [F('start', 'Start', 0.5, 30, 0.5, 'mm/s'), F('end', 'End', 0.5, 30, 0.5, 'mm/s')],
    defaults: () => ({ start: 1, end: 15 }),
    request: (v) => ({ test: 'cornering', mode: 'jerk', start: v['start'], end: v['end'] }),
    candidates: () => [],
    steps: 'response',
    result: { label: 'Jerk', unit: 'mm/s', digits: 1, keys: ['machine_max_jerk_x', 'machine_max_jerk_y'], pair: true },
  },
]

/** The bed and printer values the tool path tests put in their request, with the G-code to print them. */
function pathCommon(c: CalibCtx): Record<string, unknown> {
  return {
    nozzleDiameterMm: c.nozzleMm,
    layerHeightMm: c.layerHeightMm,
    bedWidthMm: c.bedWidthMm,
    bedDepthMm: c.bedDepthMm,
    gcode: { flavor: c.flavor, filamentDiameterMm: c.filamentDiameterMm, flowRatio: c.flowRatio, retractionMm: c.retractionMm },
  }
}

export function calibTest(id: CalibId): CalibTest {
  return CALIB_TESTS.find((t) => t.id === id)!
}

/** What a chosen value writes: the filament settings, as one-element lists like the schema stores them. */
export function resultSettings(test: CalibTest, value: number): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const key of test.result.keys) {
    if (key === 'enable_pressure_advance') out[key] = [value > 0]
    else if (key === 'nozzle_temperature') out[key] = [Math.round(value)]
    else out[key] = test.result.scalar ? value : test.result.pair ? [value, value] : [value]
  }
  return out
}

/** Problems with the entered values, or none. */
export function checkValues(test: CalibTest, v: Record<string, number>): string | null {
  for (const f of test.fields) {
    const x = v[f.key]
    if (x === undefined || !Number.isFinite(x)) return `${f.label} needs a number.`
    if (x < f.min || x > f.max) return `${f.label} must be between ${f.min} and ${f.max}${f.unit ? ` ${f.unit}` : ''}.`
  }
  // A measured test has no steps to pick from, and the engine lays out the steps of a tower or tool path.
  if (test.measure || test.steps === 'response') return null
  return test.candidates(v).length < 2 ? `The range must give at least 2 and at most ${MAX_STEPS} steps.` : null
}
