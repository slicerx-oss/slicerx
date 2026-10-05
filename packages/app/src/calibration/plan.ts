// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which calibration tests a situation needs. The table follows knowledge/workflows/calibration/plan.yaml (a
// test in it checks the two agree), so the app and mimir give the same advice. Printers that tune something
// themselves skip that test, and the list a person sees shrinks to the tests that apply.
import type { UserPreset } from '../presets/store'
import { filamentKey } from './tuned'
import type { CalibId } from './tests'
import { appName } from '../edition'

/** The plan's test names. */
export type PlanTest = 'temperature' | 'max_volumetric_speed' | 'pressure_advance' | 'flow_ratio' | 'retraction' | 'cornering' | 'input_shaping' | 'tolerance' | 'shrinkage'

/** Why someone calibrates: the situations in the plan. */
export type CalibNeed = 'new-spool' | 'new-color' | 'nozzle-change' | 'fast' | 'moved' | 'fit'

export interface NeedPlan {
  run: PlanTest[]
  optional: PlanTest[]
  note?: string
}

export const PLAN: Record<CalibNeed, NeedPlan> = {
  'new-spool': { run: ['temperature', 'pressure_advance', 'flow_ratio'], optional: ['retraction', 'max_volumetric_speed'] },
  'new-color': { run: ['pressure_advance'], optional: ['flow_ratio'], note: 'Colors of the same line usually behave alike, but not always.' },
  'nozzle-change': { run: ['pressure_advance', 'flow_ratio', 'max_volumetric_speed'], optional: [] },
  fast: { run: ['max_volumetric_speed', 'pressure_advance'], optional: [], note: 'Adaptive pressure advance helps most on fast CoreXY machines with high flow nozzles.' },
  moved: { run: ['input_shaping'], optional: [] },
  fit: { run: ['flow_ratio', 'tolerance'], optional: ['shrinkage'] },
}

export const NEED_LABEL: Record<CalibNeed, string> = {
  'new-spool': 'New spool',
  'new-color': 'New color',
  'nozzle-change': 'New nozzle',
  fast: 'Printing faster',
  moved: 'Printer moved or ringing',
  fit: 'Parts do not fit',
}

/** The order a session runs in (the plan's `order`): a result feeds the next test. */
export const PLAN_ORDER: readonly PlanTest[] = ['temperature', 'max_volumetric_speed', 'pressure_advance', 'flow_ratio', 'retraction', 'cornering', 'input_shaping', 'tolerance', 'shrinkage']

export interface CalibPrinter {
  flavor: 'klipper' | 'marlin' | 'repRapFirmware' | 'repetier' | 'bambu'
  /** The printer model id, when known ("bambu-x1-carbon"). */
  printerId?: string
}

const bambu = (p: CalibPrinter) => p.flavor === 'bambu' || /^bambu/i.test(p.printerId ?? '')
const prusa = (p: CalibPrinter) => /^prusa/i.test(p.printerId ?? '')
/** The X1 series measures flow with its lidar. */
const lidar = (p: CalibPrinter) => bambu(p) && /x1/i.test(p.printerId ?? '')

/** What the printer already tunes by itself, with a sentence for the person. Tests it names are not offered by default. */
export function selfTuned(p: CalibPrinter): { skip: PlanTest[]; notes: string[] } {
  const skip: PlanTest[] = []
  const notes: string[] = []
  if (bambu(p)) {
    skip.push('pressure_advance')
    notes.push('This printer measures pressure advance for each spool itself (flow dynamics).')
    if (lidar(p)) {
      skip.push('flow_ratio')
      notes.push('Its lidar also measures the flow ratio.')
    }
  }
  if (prusa(p)) {
    skip.push('input_shaping')
    notes.push('Input shaping is tuned at the factory and adjustable from the printer menu.')
  }
  if (p.flavor === 'klipper') notes.push(`Input shaping and cornering live in your printer.cfg, so ${appName()} does not print those towers for Klipper.`)
  return { skip, notes }
}

/** The tests a need calls for on this printer: the ones to run, the optional ones, and what the printer covers. */
export function plannedTests(need: CalibNeed, printer: CalibPrinter): { run: PlanTest[]; optional: PlanTest[]; note?: string; notes: string[] } {
  const { skip, notes } = selfTuned(printer)
  const plan = PLAN[need]
  const keep = (list: PlanTest[]) => list.filter((t) => !skip.includes(t)).sort((a, b) => PLAN_ORDER.indexOf(a) - PLAN_ORDER.indexOf(b))
  return { run: keep(plan.run), optional: keep(plan.optional), ...(plan.note ? { note: plan.note } : {}), notes }
}

/** The test the person sees for a plan test: pressure advance has three ways to print, and the printer picks one. */
export function calibIdFor(test: PlanTest, printer: CalibPrinter): CalibId {
  switch (test) {
    case 'temperature':
      return 'temp-tower'
    case 'max_volumetric_speed':
      return 'max-volumetric'
    // Klipper's own guide uses a tower; the other firmwares do well with the chevron pattern, which uses the least filament.
    case 'pressure_advance':
      return printer.flavor === 'klipper' ? 'pressure-advance' : 'pa-pattern'
    case 'flow_ratio':
      return 'flow'
    case 'retraction':
      return 'retraction'
    case 'cornering':
      return printer.flavor === 'repRapFirmware' ? 'cornering-jerk' : 'cornering-jd'
    case 'input_shaping':
      return 'input-shaping-freq'
    case 'tolerance':
      return 'tolerance'
    case 'shrinkage':
      return 'shrinkage'
  }
}

/**
 * The tests shown in the list. Pressure advance is one entry (its method follows the printer), the vertical fine
 * artifact tower is for Expert, and the input shaping and cornering towers appear only where firmware lacks its own tuning.
 */
export function visibleTests(printer: CalibPrinter, expert: boolean): CalibId[] {
  const base: PlanTest[] = ['temperature', 'pressure_advance', 'flow_ratio', 'retraction', 'max_volumetric_speed', 'tolerance', 'shrinkage']
  const manual = printer.flavor === 'marlin' || printer.flavor === 'repRapFirmware' || printer.flavor === 'repetier'
  const { skip } = selfTuned(printer)
  const ids = base.filter((t) => expert || !skip.includes(t)).map((t) => calibIdFor(t, printer))
  if (manual && !skip.includes('input_shaping')) ids.push('input-shaping-freq', 'input-shaping-damp')
  if (manual) ids.push(calibIdFor('cornering', printer))
  if (expert) ids.push('vfa', 'pressure-advance', 'pa-line', 'pa-pattern', 'cornering-jd', 'cornering-jerk', 'input-shaping-freq', 'input-shaping-damp')
  return [...new Set(ids)]
}

type Slot = Parameters<typeof filamentKey>[0]

/** Why this spool wants calibration now, or null when it has results for this printer and nozzle. */
export function needFor(presets: readonly UserPreset[], slot: Slot, printerId: string, nozzleMm: number): CalibNeed | null {
  const tuned = presets.filter((p) => p.tuned && p.tuned.key.includes(`@${printerId}@`))
  const key = filamentKey(slot)
  if (tuned.some((p) => p.tuned!.key.startsWith(`${key}@${printerId}@`) && p.tuned!.nozzleMm === nozzleMm)) return null
  if (tuned.some((p) => p.tuned!.key.startsWith(`${key}@${printerId}@`))) return 'nozzle-change'
  // Same product and material in another color: only pressure advance, mostly.
  const [line, type] = key.split('|')
  if (tuned.some((p) => p.tuned!.key.startsWith(`${line}|${type}|`) && p.tuned!.nozzleMm === nozzleMm)) return 'new-color'
  return 'new-spool'
}
