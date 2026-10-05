// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's deterministic checks run as plain functions (no model, no key) and shown as plain UI: the
// plate risk report and the printer match behind two commands, and the electricity estimate in the
// Estimate block. Everything here reads the plate; nothing changes it or starts anything. A risk's
// fix is returned for the dialog to offer as a button (risk-fixes.ts).
import type { FunctionResult } from '@slicerx/pilot/functions'
import type { MeshPart, PrinterHost, SettingValue, SliceWarning, ToolDisplay } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { resolveSlots } from '../filament/slots'
import type { AppState } from '../state/store'
import { bake } from './mesh-ops'
import { riskFixes, type RiskFix } from './risk-fixes'
import { bounds } from './transform'

export type PlateCheckKind = 'risks' | 'printers'

export interface PlateCheck {
  title: string
  ok: boolean
  summary: string
  display: ToolDisplay[]
  /** One-click fixes for the risks found; empty for the printer match. */
  fixes: RiskFix[]
}

type Inputs = Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'printerSlots' | 'slotSetup' | 'printerModel' | 'profile' | 'bed' | 'easy' | 'overrides'> & Partial<Pick<AppState, 'slice'>>

/** The engine's warnings of the slice on screen, when it matches the plate as it is now. */
export function freshWarnings(s: Partial<Pick<AppState, 'slice'>>): SliceWarning[] | null {
  return s.slice?.status === 'done' && !s.slice.stale ? s.slice.result.warnings : null
}

const TITLE: Record<PlateCheckKind, string> = { risks: 'Print risks on this plate', printers: 'Printers that fit this plate' }

/** The printer the plate is for, as the knowledge base spells it: "vendor model". */
export function printerName(s: Pick<AppState, 'printerModel'>): string {
  return s.printerModel ? `${s.printerModel.vendor} ${s.printerModel.model}`.trim() : ''
}

/** The material the plate prints in: the first filament type among the slots it uses. */
export function plateMaterial(s: Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'printerSlots' | 'slotSetup'>): string {
  const types = resolveSlots(s).filter((r) => r.used).map((r) => r.type).filter(Boolean)
  return types[0] ?? 'PLA'
}

/** A read-only project over the plate on screen. Objects are the printable ones, placed as they sit on the bed. */
async function plateProject(s: Inputs) {
  const { createMemoryProject, createKnowledgeBase } = await import('@slicerx/pilot')
  const kbJson = await import('@slicerx/pilot/kb.json')
  const kb = createKnowledgeBase(kbJson.default as never)
  const printable = s.plate.filter((p) => p.printable !== false)
  const objects = printable.map((p) => {
    const b = bounds(p.parts, p.transform)
    const size: [number, number, number] = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [0, 0, 0]
    return { id: p.id, name: p.name, bboxMm: size, mesh: async (): Promise<MeshPart[]> => p.parts.map((part) => bake(part, p.transform)) }
  })
  const resolved = resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>
  const project = createMemoryProject('plate', { printer: printerName(s), material: plateMaterial(s), nozzle: s.profile?.nozzle ?? 0.4 }, objects, kb, {
    warnings: async () => freshWarnings(s),
    config: (base) => ({ ...base, ...resolved, printable_area: [[0, 0], [s.bed.widthMm, 0], [s.bed.widthMm, s.bed.depthMm], [0, s.bed.depthMm]], printable_height: s.bed.heightMm }),
  })
  project.setPlates([{ index: 1, items: objects.map((o) => ({ objectId: o.id, copies: 1 })) }])
  return project
}

const NONE = { list: async () => [] } as unknown as PrinterHost

/** Runs one check on the plate. A function that cannot run reports why in the summary. */
export async function runPlateCheck(kind: PlateCheckKind, s: Inputs, printers?: PrinterHost): Promise<PlateCheck> {
  if (s.plate.every((p) => p.printable === false)) return { title: TITLE[kind], ok: false, summary: 'Add a model to the plate first.', display: [], fixes: [] }
  const { runAppFunction } = await import('@slicerx/pilot/functions')
  const project = await plateProject(s)
  const machine = project.machine()!
  const env = { host: { printers: printers ?? NONE }, project, context: { machine } }
  const r: FunctionResult = kind === 'risks' ? await runAppFunction('risk_report', {}, env) : await runAppFunction('printer_match', { material: machine.material }, env)
  return { title: TITLE[kind], ok: r.ok, summary: r.summary, display: r.display ?? [], fixes: kind === 'risks' ? riskFixes(r.output, s) : [] }
}

/** Electricity for one print: kWh, cost at an assumed price, and whether the wattage is a figure or a guess. */
export interface EnergyFigure {
  kwh: number
  cost: number
  assumed: boolean
}

/** Electricity use for a sliced plate, from the printer's typical draw. Null when the estimate cannot run. */
export async function energyFigure(timeS: number, printer: string, material: string, pricePerKwh?: number): Promise<EnergyFigure | null> {
  if (!(timeS > 0)) return null
  const { runAppFunction } = await import('@slicerx/pilot/functions')
  const r = await runAppFunction('energy_estimate', { hours: Math.max(0.05, timeS / 3600), ...(printer ? { printer } : {}), material, ...(pricePerKwh !== undefined ? { pricePerKwh } : {}) }, { host: { printers: NONE } })
  const out = r.output as { kwh?: number; cost?: number; lines?: { wattSource?: string }[] } | undefined
  if (!r.ok || typeof out?.kwh !== 'number') return null
  return { kwh: out.kwh, cost: out.cost ?? 0, assumed: out.lines?.[0]?.wattSource === 'assumption' }
}
