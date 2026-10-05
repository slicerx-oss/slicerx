// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Hole sizes for metric fasteners and fits, and the printed-hole correction.
// Tap drills and clearance holes are machining standards (ISO 2306 tap drills
// for coarse threads, ISO 273 medium clearance, ISO 10642 countersunk heads),
// so they get the per-face growth of printed walls added. Heat-set insert
// holes are the sizes insert makers publish for printed parts and are used as
// modeled. The fit clearances come from fit_check's rules.
import { assessFit, faceGrowth, type FitInput } from '../fit_check/index'
import { round } from '../geom_common/index'

export interface MetricSize {
  /** Tap drill for the coarse thread, mm. */
  tapDrill: number
  /** Medium clearance hole, mm. */
  clearance: number
  /** Hole for a standard knurled brass heat-set insert, mm, as modeled for printing. */
  insertHole: number
  /** Standard insert length, mm. */
  insertLength: number
  /** Countersunk head diameter, mm. */
  csHead: number
}

export const METRIC: Record<string, MetricSize> = {
  M2: { tapDrill: 1.6, clearance: 2.4, insertHole: 3.2, insertLength: 3.0, csHead: 4.4 },
  'M2.5': { tapDrill: 2.05, clearance: 2.9, insertHole: 3.6, insertLength: 4.0, csHead: 5.5 },
  M3: { tapDrill: 2.5, clearance: 3.4, insertHole: 4.0, insertLength: 5.7, csHead: 6.72 },
  M4: { tapDrill: 3.3, clearance: 4.5, insertHole: 5.6, insertLength: 8.1, csHead: 8.96 },
  M5: { tapDrill: 4.2, clearance: 5.5, insertHole: 6.4, insertLength: 9.5, csHead: 11.2 },
  M6: { tapDrill: 5.0, clearance: 6.6, insertHole: 8.0, insertLength: 12.7, csHead: 13.44 },
  M8: { tapDrill: 6.8, clearance: 9.0, insertHole: 10.0, insertLength: 12.7, csHead: 17.92 },
}

export const SIZE_BASIS = 'Tap drills per ISO 2306 (coarse thread), clearance holes per ISO 273 (medium), countersunk heads per ISO 10642, heat-set insert holes as published by insert makers for printed parts (check the table for your inserts).'

export const HOLE_KINDS = ['insert', 'tap', 'thread', 'clearance', 'countersunk', 'press_fit', 'slip_fit'] as const
export type HoleKind = (typeof HOLE_KINDS)[number]

export function metric(size: string | undefined): { name: string; size: MetricSize } | null {
  if (!size) return null
  const key = size.trim().toUpperCase().replace(/^M\s*/, 'M').replace(/X.*$/, '')
  const s = METRIC[key]
  return s ? { name: key, size: s } : null
}

export interface PrintBasis {
  material: string
  lineWidth: number
  layerHeight: number
  nozzle: number
  /** xy_hole_compensation already set on the plate, mm. */
  holeCompensation: number
}

export interface HoleSpec {
  kind: HoleKind
  label: string
  /** Size the finished hole should have, mm. */
  targetMm: number
  /** Diameter to model, after the printed-hole correction, mm. */
  modeledMm: number
  /** Blind depth, mm; undefined means through. */
  depthMm?: number
  countersink?: { headMm: number; depthMm: number }
  why: string[]
}

/** Per-face growth of printed walls for this setup, less any hole compensation the slicer already applies. */
export function holeCorrection(b: PrintBasis): { perSide: number; why: string[] } {
  const fit: FitInput = { gapMm: 0, feature: 'slide', direction: 'xy', layerHeight: b.layerHeight, lineWidth: b.lineWidth, nozzle: b.nozzle, material: b.material }
  const g = faceGrowth(fit)
  const perSide = Math.max(0, g.growth - Math.max(0, b.holeCompensation))
  const why = [`printed holes close up about ${g.growth} mm per side${g.reasons.length ? ` (${g.reasons.join(', ')})` : ''}`]
  if (b.holeCompensation > 0) why.push(`xy_hole_compensation ${b.holeCompensation} mm already opens holes in the slicer`)
  return { perSide: round(perSide, 3), why }
}

/**
 * The hole to model for a fastener or a fit. `size` is a metric size such as
 * M3 for inserts, tap holes, threads, clearance and countersunk holes;
 * `diameterMm` is the shaft or pin for press and slip fits.
 */
export function holeFor(kind: HoleKind, b: PrintBasis, o: { size?: string | undefined; diameterMm?: number | undefined; depthMm?: number | undefined }): HoleSpec | { error: string } {
  const corr = holeCorrection(b)
  const add = 2 * corr.perSide
  if (kind === 'press_fit' || kind === 'slip_fit') {
    if (!o.diameterMm) return { error: `A ${kind.replace('_', ' ')} needs the shaft or pin diameter` }
    const r = assessFit({ gapMm: 0, feature: kind === 'press_fit' ? 'press' : 'slide', direction: 'xy', layerHeight: b.layerHeight, lineWidth: b.lineWidth, nozzle: b.nozzle, material: b.material })
    const gap = Math.max(0, r.suggestedGapMm - Math.max(0, b.holeCompensation))
    const spec: HoleSpec = {
      kind,
      label: `${kind === 'press_fit' ? 'press fit' : 'slip fit'} for ${o.diameterMm} mm`,
      targetMm: o.diameterMm,
      modeledMm: round(o.diameterMm + 2 * gap, 2),
      why: [`${gap} mm modeled gap per side for a ${kind === 'press_fit' ? 'press' : 'sliding'} fit`, ...r.reasons],
    }
    if (o.depthMm !== undefined) spec.depthMm = o.depthMm
    return spec
  }
  const m = metric(o.size)
  if (!m) return { error: `Unknown metric size "${o.size ?? ''}"; use M2 to M8` }
  const s = m.size
  let spec: HoleSpec
  if (kind === 'insert') {
    spec = { kind, label: `${m.name} heat-set insert`, targetMm: s.insertHole, modeledMm: s.insertHole, depthMm: o.depthMm ?? round(s.insertLength + 1, 1), why: [`insert hole ${s.insertHole} mm as published for printed parts, ${round(s.insertLength + 1, 1)} mm deep for a ${s.insertLength} mm insert`] }
  } else if (kind === 'tap' || kind === 'thread') {
    spec = { kind, label: `${m.name} tap hole`, targetMm: s.tapDrill, modeledMm: round(s.tapDrill + add, 2), why: [`tap drill ${s.tapDrill} mm`, ...corr.why] }
    if (kind === 'thread') spec.why.push('mimir does not model printed threads; tap this hole, or use a heat-set insert for threads that last')
    if (o.depthMm !== undefined) spec.depthMm = o.depthMm
  } else {
    spec = { kind, label: `${m.name} clearance hole`, targetMm: s.clearance, modeledMm: round(s.clearance + add, 2), why: [`medium clearance ${s.clearance} mm`, ...corr.why] }
    if (kind === 'countersunk') {
      const head = round(s.csHead + 0.4 + add, 2)
      spec.label = `${m.name} countersunk hole`
      spec.countersink = { headMm: head, depthMm: round((head - spec.modeledMm) / 2, 2) }
      spec.why.push(`90 degree countersink for a ${s.csHead} mm head plus 0.4 mm`)
    }
    if (o.depthMm !== undefined) spec.depthMm = o.depthMm
  }
  return spec
}
