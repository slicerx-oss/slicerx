// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// fit_check: will a designed gap fuse, bind, press or slide at this layer
// height, line width and material, and what gap to use instead. Covers part
// to part clearance and print in place joints.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import type { KbDoc } from '../../src/kb/kb'
import { defineSkill } from '../../src/tool'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export type FitFeature = 'slide' | 'press' | 'print_in_place'
export type FitOutcome = 'fuses' | 'binds' | 'press fit' | 'slides'

export interface FitInput {
  /** Air gap between the two faces as modeled, per side, mm. */
  gapMm: number
  feature: FitFeature
  /** xy: between side walls; z: between a face and the one printed over it. */
  direction: 'xy' | 'z'
  layerHeight: number
  lineWidth: number
  nozzle: number
  material: string
  /** Per face growth measured with a tolerance test, mm; replaces the rule of thumb. */
  measuredGrowthMm?: number | undefined
  /** The gap is in the first layers, where the base flares. */
  nearBed?: boolean | undefined
  elephantFootCompensation?: number | undefined
}

export interface FitResult {
  outcome: FitOutcome
  /** How much each face grows into the gap, mm. */
  growthMm: number
  /** Gap left after printing, mm (negative means overlap). */
  effectiveMm: number
  suggestedGapMm: number
  reasons: string[]
}

/**
 * Rule of thumb per face growth into a gap for XY walls: 0.05 mm, plus 0.03
 * for PETG (oozes and bonds to itself), 0.05 for TPU, a quarter of any line
 * width above 105 percent of the nozzle, a fifth of any layer height above
 * half the nozzle, and 0.1 in the first layers without elephant foot
 * compensation. A measured value from the tolerance test replaces all of it.
 */
export function faceGrowth(i: FitInput): { growth: number; reasons: string[] } {
  const reasons: string[] = []
  if (i.measuredGrowthMm !== undefined) {
    reasons.push(`measured growth ${i.measuredGrowthMm} mm per face`)
    return { growth: i.measuredGrowthMm, reasons }
  }
  let g = 0.05
  const m = i.material.toLowerCase()
  if (/^petg|pctg/.test(m)) {
    g += 0.03
    reasons.push('PETG oozes and bonds to itself')
  } else if (/^tpu/.test(m)) {
    g += 0.05
    reasons.push('TPU is soft and squishes wide')
  }
  const wide = i.lineWidth - 1.05 * i.nozzle
  if (wide > 0.005) {
    g += 0.25 * wide
    reasons.push(`line width ${i.lineWidth} mm is wider than the nozzle`)
  }
  const tall = i.layerHeight - 0.5 * i.nozzle
  if (tall > 0.005) {
    g += 0.2 * tall
    reasons.push(`layer height ${i.layerHeight} mm bulges the walls`)
  }
  if (i.nearBed && !(i.elephantFootCompensation && i.elephantFootCompensation > 0)) {
    g += 0.1
    reasons.push('the first layers flare without elephant foot compensation')
  }
  return { growth: Math.round(g * 1000) / 1000, reasons }
}

const up05 = (v: number): number => Math.ceil(Math.round(v * 1000) / 50) * 0.05

/**
 * Outcome for a gap. XY: the gap left is the modeled gap less growth on both
 * faces. Z: the gap is rounded down to whole layers and the face printed over
 * it sags about one layer (half a layer more for PETG). Thresholds on the gap
 * left: slide from 0.1 mm, print in place moves from 0.15 mm and binds from
 * 0.05 mm, a press fit wants -0.1 to 0.02 mm.
 */
export function assessFit(i: FitInput): FitResult {
  const { growth, reasons } = faceGrowth(i)
  let effective: number
  if (i.direction === 'z') {
    const layers = Math.floor(i.gapMm / i.layerHeight + 1e-6)
    const sag = i.layerHeight * (/^petg/.test(i.material.toLowerCase()) ? 1.5 : 1)
    effective = layers * i.layerHeight - sag
    if (Math.abs(layers * i.layerHeight - i.gapMm) > 1e-6) reasons.push(`the slicer rounds a ${i.gapMm} mm vertical gap down to ${layers} layer${layers === 1 ? '' : 's'}`)
    reasons.push('the face printed over the gap sags about one layer')
  } else effective = i.gapMm - 2 * growth
  effective = Math.round(effective * 1000) / 1000
  let outcome: FitOutcome
  if (i.feature === 'press') outcome = effective > 0.02 ? 'slides' : effective >= -0.1 ? 'press fit' : 'binds'
  else if (i.feature === 'print_in_place') outcome = effective >= 0.15 ? 'slides' : effective >= 0.05 ? 'binds' : 'fuses'
  else outcome = effective >= 0.1 ? 'slides' : effective > 0 ? 'binds' : 'fuses'
  let suggested: number
  if (i.direction === 'z') {
    const want = i.feature === 'print_in_place' ? 0.15 : i.feature === 'slide' ? 0.1 : 0
    const sag = i.layerHeight * (/^petg/.test(i.material.toLowerCase()) ? 1.5 : 1)
    suggested = Math.max(1, Math.ceil((want + sag) / i.layerHeight - 1e-6)) * i.layerHeight
  } else if (i.feature === 'press') suggested = Math.max(0, up05(2 * growth - 0.05))
  else suggested = up05(2 * growth + (i.feature === 'print_in_place' ? 0.2 : 0.15))
  return { outcome, growthMm: growth, effectiveMm: effective, suggestedGapMm: Math.round(suggested * 1000) / 1000, reasons }
}

function causeSrc(doc: KbDoc | undefined, id: string): string[] {
  const c = (Array.isArray(doc?.data['causes']) ? (doc.data['causes'] as unknown[]) : []).map(obj).find((x) => x['id'] === id)
  return strs(c?.['src'])
}

export function createFitCheck() {
  return defineSkill({
    name: 'fit_check',
    version: '1.0.0',
    permission: 'read',
    description:
      'Check whether a designed gap will fuse, bind, press fit or slide at the layer height, line width and material, and suggest the gap to model instead. For part to part clearance (a lid that should slide, a pin that should press in) and print in place joints (hinges, chains). The gap is the air between the two faces per side, in mm, in XY (side walls) or Z (a face printed over another). Uses the tolerance calibration and dimensional accuracy knowledge. Read only; gaps cannot be measured from the mesh on this host, so the user supplies them.',
    input: z.object({
      gapMm: z.number().min(0).max(5).describe('Modeled air gap per side, mm'),
      feature: z.enum(['slide', 'press', 'print_in_place']).describe('slide: should move freely; press: should grip; print_in_place: a hinge, chain or joint printed assembled'),
      direction: z.enum(['xy', 'z']).optional().describe('xy (default): gap between side walls; z: gap between a face and the one printed over it'),
      layerHeight: z.number().min(0.04).max(0.8).optional().describe('Layer height, mm; default the project setting'),
      lineWidth: z.number().min(0.1).max(2).optional().describe('Line width, mm; default the project setting'),
      material: z.string().optional().describe('Filament id or name; default the loaded material'),
      measuredGrowthMm: z.number().min(-0.2).max(0.5).optional().describe('Per face growth from a tolerance test, when the user has measured it'),
      nearBed: z.boolean().optional().describe('The gap is within the first millimeter or so above the bed'),
    }),
    args: (i) => [`--gap ${i.gapMm}`, `--feature ${i.feature}`, i.direction ? `--direction ${i.direction}` : null, i.material ? `--material ${i.material}` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const project = ctx.project
      const machine = project?.machine() ?? ctx.context.machine
      const cfg = project ? project.config(project.plates()[0]?.index ?? 1) : undefined
      const nozzle = machine?.nozzle ?? 0.4
      const lh = i.layerHeight ?? (typeof cfg?.layer_height === 'number' ? cfg.layer_height : 0.2)
      const lw = i.lineWidth ?? (typeof cfg?.line_width === 'number' ? cfg.line_width : Math.round(nozzle * 1.05 * 100) / 100)
      const matName = i.material ?? machine?.material ?? 'pla'
      const mat = ctx.kb.get('filament', matName) ?? ctx.kb.search(matName, { kinds: ['filament'], limit: 1 })[0]?.doc
      const efc = cfg?.['elefant_foot_compensation']
      const input: FitInput = {
        gapMm: i.gapMm,
        feature: i.feature,
        direction: i.direction ?? 'xy',
        layerHeight: lh,
        lineWidth: lw,
        nozzle,
        material: mat?.id ?? matName,
        measuredGrowthMm: i.measuredGrowthMm,
        nearBed: i.nearBed,
        elephantFootCompensation: typeof efc === 'number' ? efc : undefined,
      }
      const r = assessFit(input)
      const tolerance = ctx.kb.get('workflow', 'tolerance')
      const accuracy = ctx.kb.get('troubleshoot', 'dimensional_accuracy')
      const test = String(obj(tolerance?.data['orca_test'])['model'] ?? '')
      const sources = new Set<string>([...strs(tolerance?.data['src']), ...causeSrc(accuracy, 'c_hole_compensation')])
      const advice: string[] = []
      if (i.measuredGrowthMm === undefined) advice.push(`These growth values are mimir rules of thumb, not a measurement of this printer. Print the Orca tolerance test to measure it${test ? ` (${test.replace(/\.$/, '')})` : ''}, then run this again with measuredGrowthMm.`)
      if (i.nearBed && !(typeof efc === 'number' && efc > 0)) {
        advice.push('Set elephant foot compensation, or keep moving joints out of the first layers; the base flare closes gaps near the bed.')
        for (const s of causeSrc(accuracy, 'c_elephant_foot')) sources.add(s)
      }
      if (i.feature !== 'press' && r.outcome !== 'slides') advice.push(`Model the gap at ${r.suggestedGapMm} mm${input.direction === 'z' ? ` (${Math.round(r.suggestedGapMm / lh)} layers)` : ''}, or raise xy_hole_compensation in 0.05 mm steps for round holes.`)
      if (i.feature === 'press' && r.outcome !== 'press fit') advice.push(`Model the gap at ${r.suggestedGapMm} mm for a press fit.`)
      if (/^petg/.test(input.material) && i.feature === 'print_in_place') advice.push('PETG strings across small gaps; slower travel and a little more gap help joints break free.')
      const tone = r.outcome === 'slides' || r.outcome === 'press fit' ? (i.feature === 'press' && r.outcome === 'slides' ? 'warn' : 'ok') : r.outcome === 'binds' ? 'warn' : 'bad'
      const rows: [string, Cell][] = [
        ['verdict', { text: r.outcome, tone }],
        ['gap modeled', `${i.gapMm} mm per side (${input.direction})`],
        ['growth per face', `${r.growthMm} mm${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}`],
        ['gap after printing', `${r.effectiveMm} mm`],
        ['suggested gap', `${r.suggestedGapMm} mm`],
        ['profile', `${lh} mm layers, ${lw} mm lines, ${nozzle} mm nozzle, ${mat?.name ?? matName}`],
      ]
      return {
        summary: `${i.gapMm} mm ${i.feature.replaceAll('_', ' ')} gap ${r.outcome}; ${r.outcome === (i.feature === 'press' ? 'press fit' : 'slides') ? 'keep it' : `use ${r.suggestedGapMm} mm`}`,
        output: { ...r, input: { ...input }, advice, note: "SlicerX can't measure the gap from the mesh here yet, so this uses the gap you gave." },
        display: [
          { kind: 'kv', rows },
          { kind: 'log', lines: advice.map((t) => ({ text: t, tone: 'run' as const })) },
        ],
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
