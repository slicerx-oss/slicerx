// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs the fit check (sx-geom fit.check) on every object with more than one part whenever the
// plate changes, and keeps the results in fit-state. Single-part objects are never checked. A
// pair that touches is reported only when both parts print with the same filament: parts on
// different slots touch on purpose (a multi-color object), parts on one slot that touch were
// meant to move.
import { useEffect } from 'react'
import { fitCheck, type FitGap, type FitReport } from '../geom/cad'
import { toGeom } from '../geom/client'
import { clearanceFor } from './clearance'
import { resolveConfig } from '../adapters/settings'
import { get, useApp, type PlateEntry } from '../state/store'
import { keepFits, setFit } from './fit-state'

/** The smallest side-by-side gap the printer keeps open, per side: the fit clearance (`clearance.ts`). */
export function minGapFor(s: ReturnType<typeof get>): number {
  return clearanceFor(s).mm
}

export function describeGap(g: FitGap, partNames: readonly string[], layerHeightMm: number): string {
  const a = partNames[g.parts[0]] ?? `part ${g.parts[0] + 1}`
  const b = partNames[g.parts[1]] ?? `part ${g.parts[1] + 1}`
  const gap = `${g.gapMm.toFixed(2)} mm`
  if (g.kind === 'fused') return `${a} and ${b} touch, so they will print as one piece. Move them at least ${g.limitMm.toFixed(2)} mm apart in the model.`
  if (g.kind === 'vertical') return `${a} sits ${gap} above ${b}, under the ${g.limitMm.toFixed(2)} mm this printer keeps open. Use a smaller layer height (${Math.max(0.08, Math.min(layerHeightMm, g.gapMm)).toFixed(2)} mm or less) or more clearance in the model.`
  return `${a} and ${b} are ${gap} apart side by side; this printer keeps ${g.limitMm.toFixed(2)} mm open. Add clearance in the model.`
}

/** Pairs worth telling the person about. */
export function relevantGaps(report: FitReport, slots: readonly number[]): FitGap[] {
  return report.gaps.filter((g) => g.kind !== 'fused' || (slots[g.parts[0]] ?? 1) === (slots[g.parts[1]] ?? 1))
}

async function checkObject(e: PlateEntry, minGapMm: number, layerHeightMm: number, signal: AbortSignal): Promise<void> {
  const parts = e.parts.map((p) => ({ mesh: toGeom(p), transform: e.transform }))
  const report = await fitCheck(parts, { minGapMm, layerHeightMm }, signal)
  if (signal.aborted) return
  const slots = e.parts.map((p) => e.slotOverrides?.[p.name] ?? p.slot)
  const gaps = relevantGaps(report, slots)
  const names = e.parts.map((p) => p.name)
  setFit(e.id, { gaps, warnings: gaps.map((g) => describeGap(g, names, layerHeightMm)), limitMm: report.limitMm, verticalLimitMm: report.verticalLimitMm })
}

/** Mount once in Prepare: checks multi-part objects as the plate changes, a moment after the last edit. */
export function useFitWatch(): void {
  const plate = useApp((s) => s.plate)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const presets = useApp((s) => s.userPresets)
  useEffect(() => {
    keepFits(plate.map((p) => p.id))
    const multi = plate.filter((p) => p.parts.length > 1 && p.printable !== false)
    if (multi.length === 0) return
    const ac = new AbortController()
    const t = setTimeout(() => {
      const s = get()
      const minGapMm = minGapFor(s)
      const layerHeightMm = Number(resolveConfig(easy, overrides)['layer_height']) || 0.2
      for (const e of multi) void checkObject(e, minGapMm, layerHeightMm, ac.signal).catch(() => setFit(e.id, null))
    }, 600)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [plate, easy, overrides, presets])
}
