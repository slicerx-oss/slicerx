// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gaps print-in-place pieces need, from the fit rule (assessFit): side by side and above or below, for a nozzle,
// layer height and material. design.check and geom.fit_check hold gaps to them, the dimension sheet fills them in as a
// guess, and the knowledge base's clearance table (knowledge/workflows/techniques/fits.yaml) is written from them.
import { assessFit } from './index'

/** What the fit rule needs about the print, each optional: the nozzle (0.4 mm), layer height (half the nozzle) and material (PLA). */
export interface ClearanceProfile {
  nozzleMm?: number | undefined
  layerHeightMm?: number | undefined
  material?: string | undefined
}

/** The smallest gaps print-in-place pieces keep, per side, and the profile they are for. */
export interface Clearance {
  /** Between side walls. */
  sideMm: number
  /** Between a face and the one printed over it. */
  verticalMm: number
  material: string
  nozzleMm: number
  layerHeightMm: number
}

/** The nozzle used when the printer's is unknown or not a size. */
export const DEFAULT_NOZZLE_MM = 0.4

const positive = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/** The line width the fit rule assumes for a nozzle: 105 percent, to 0.01 mm. */
export const lineWidthFor = (nozzle: number): number => Math.round(nozzle * 1.05 * 100) / 100

/** The gaps the fit rule suggests for print in place, side by side and above or below. */
export function printInPlaceClearance(p: ClearanceProfile = {}): Clearance {
  const nozzleMm = positive(p.nozzleMm) ? p.nozzleMm : DEFAULT_NOZZLE_MM
  const layerHeightMm = positive(p.layerHeightMm) ? p.layerHeightMm : nozzleMm / 2
  const material = p.material?.trim() || 'pla'
  const base = { gapMm: 0, feature: 'print_in_place' as const, layerHeight: layerHeightMm, lineWidth: lineWidthFor(nozzleMm), nozzle: nozzleMm, material }
  return { sideMm: assessFit({ ...base, direction: 'xy' }).suggestedGapMm, verticalMm: assessFit({ ...base, direction: 'z' }).suggestedGapMm, material, nozzleMm, layerHeightMm }
}

/** The nozzles and materials of the knowledge base's clearance table, each nozzle at half its size in layers. */
export const TABLE_NOZZLES = [0.2, 0.4, 0.6, 0.8] as const
export const TABLE_MATERIALS = ['PLA', 'ABS', 'PETG', 'TPU'] as const

const mm = (v: number): string => `${Math.round(v * 1000) / 1000}`

/**
 * The clearance table as knowledge base facts, one per nozzle: "Print in place gaps per side, 0.4 mm nozzle at 0.2 mm
 * layers: PLA 0.3 mm side by side and 0.4 mm above or below; ...", each entry with both ways named. Materials with
 * the same gaps share an entry.
 */
export function clearanceFacts(): string[] {
  return TABLE_NOZZLES.map((nozzleMm) => {
    const groups: { names: string[]; c: Clearance }[] = []
    for (const material of TABLE_MATERIALS) {
      const c = printInPlaceClearance({ nozzleMm, material })
      const same = groups.find((g) => g.c.sideMm === c.sideMm && g.c.verticalMm === c.verticalMm)
      if (same) same.names.push(material)
      else groups.push({ names: [material], c })
    }
    // every material's entry names its two ways, so "PETG and TPU 0.4 and 0.3 mm" never reads as one figure each
    const parts = groups.map((g) => `${g.names.join(' and ')} ${mm(g.c.sideMm)} mm side by side and ${mm(g.c.verticalMm)} mm above or below`)
    return `Print in place gaps per side, ${mm(nozzleMm)} mm nozzle at ${mm(nozzleMm / 2)} mm layers: ${parts.join('; ')}.`
  })
}

/** The sheet rows the fit rule fills in for a print-in-place part, by key. */
export const GAP_ROW_KEYS = { side: 'clearance', vertical: 'clearance_vertical' } as const

/** A row of a dimension sheet, as far as the gap rows need it. */
interface GapRow {
  key: string
  label: string
  value: number
  unit: 'mm'
  min: number
  max: number
  source: 'guess'
  note: string
}

/** The fit rule's two gap rows for a profile, as guesses. */
function ruleRows(p: ClearanceProfile): GapRow[] {
  const c = printInPlaceClearance(p)
  const note = `The fit rule's gap for ${c.material.toUpperCase()}, ${mm(c.nozzleMm)} mm nozzle, ${mm(c.layerHeightMm)} mm layers`
  return [
    { key: GAP_ROW_KEYS.side, label: 'Gap between moving pieces, side by side', value: c.sideMm, unit: 'mm', min: 0, max: 5, source: 'guess', note },
    { key: GAP_ROW_KEYS.vertical, label: 'Gap between moving pieces, above and below', value: c.verticalMm, unit: 'mm', min: 0, max: 5, source: 'guess', note },
  ]
}

/**
 * The gap rows a print-in-place part's sheet gets from the fit rule, shown as guesses for the person to confirm or
 * change: between moving pieces side by side, and above and below. A row whose key the sheet already has is left out
 * (withGapRows sets its value).
 */
export function gapRows(have: readonly { key: string }[], p: ClearanceProfile = {}): GapRow[] {
  return ruleRows(p).filter((r) => !have.some((d) => d.key === r.key))
}

/** A sheet row as far as withGapRows reads it. */
interface SheetRow {
  key: string
  value: number
  unit: string
  source: string
  max?: number | undefined
  sourceTitle?: string | undefined
  sourceUrl?: string | undefined
}

/**
 * A print-in-place part's sheet with the fit rule's gaps: the gap rows the sheet lacks are added, and a gap row mimir
 * sent takes the rule's gap when mimir guessed it, or when it is under the rule and the person did not give it (looked
 * up or read from a photo). A gap the person gave stands; design.check holds the gaps to the rule.
 */
export function withGapRows<D extends SheetRow>(dims: readonly D[], p: ClearanceProfile = {}): (D | GapRow)[] {
  const rows = ruleRows(p)
  const own = dims.map((d): D | GapRow => {
    const r = rows.find((x) => x.key === d.key)
    if (!r || d.unit !== 'mm' || d.source === 'asked' || (d.source !== 'guess' && d.value >= r.value - 1e-9)) return d
    const { sourceTitle: _t, sourceUrl: _u, ...rest } = d
    return { ...rest, value: r.value, source: 'guess', note: r.note, ...(d.max !== undefined && d.max < r.value ? { max: r.max } : {}) } as unknown as D
  })
  return [...own, ...rows.filter((r) => !dims.some((d) => d.key === r.key))]
}

/** The fit rule's profile from what a run sees of the print: the machine's nozzle and material, and the layer height set. */
export function clearanceProfileOf(ctx: { machine?: { nozzle?: number; material?: string } | undefined; overrides?: Record<string, string | number | boolean> | undefined }): ClearanceProfile {
  const layer = Number(ctx.overrides?.['layer_height'])
  return { nozzleMm: ctx.machine?.nozzle, material: ctx.machine?.material, ...(layer > 0 ? { layerHeightMm: layer } : {}) }
}
