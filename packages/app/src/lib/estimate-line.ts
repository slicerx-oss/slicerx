// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The words of the Slice footer and the Goal tiles: time, grams, cost and filament changes from a slice, the line
// under the tiles, and what each goal gives on the printer in use.
import type { EasyGoal, SettingValue, SliceResult } from '@slicerx/contracts'
import { formatCost, formatDuration, formatGrams, NOT_ESTIMATED } from './preview-stats'

export interface EstimateLine {
  time: string
  grams: string
  /** Null when the slice has no cost (no filament prices set). */
  cost: string | null
  /** Null with one filament: changes only mean something on a multi-color plate. */
  changes: string | null
  /** Null with no warnings, so the footer shows nothing for them. */
  warnings: string | null
  stale: boolean
}

export function estimateLine(done: { result: Pick<SliceResult, 'stats' | 'warnings'>; stale: boolean } | null): EstimateLine | null {
  if (!done) return null
  const { stats, warnings } = done.result
  const grams = stats.filamentG.reduce((a, b) => a + b, 0)
  const used = stats.filamentG.filter((g) => g > 0).length
  const cost = formatCost(stats.cost)
  return {
    time: formatDuration(stats.timeS),
    grams: formatGrams(grams),
    cost: cost === NOT_ESTIMATED ? null : cost,
    changes: used > 1 ? `${stats.toolChanges} ${stats.toolChanges === 1 ? 'change' : 'changes'}` : null,
    warnings: warnings.length ? `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : null,
    stale: done.stale,
  }
}

/** The muted line under the Goal tiles: "About 1h 36m, 148.0 g", "Updating" while stale, nothing before a slice. */
export function goalEstimate(line: EstimateLine | null): string | null {
  if (!line) return null
  if (line.stale) return 'Updating'
  return line.grams === NOT_ESTIMATED ? `About ${line.time}` : `About ${line.time}, ${line.grams}`
}

const num = (v: SettingValue | undefined): number => Number(Array.isArray(v) ? v[0] : v)

/** What a goal gives on this printer, from that goal's resolved settings: a layer height, or the walls for Strong. */
export function goalSubtitle(goal: EasyGoal, cfg: Readonly<Record<string, SettingValue>>): string {
  if (goal === 'strong') {
    const walls = num(cfg['wall_loops'])
    return Number.isFinite(walls) && walls > 0 ? `${walls} walls` : ''
  }
  const h = num(cfg['layer_height'])
  return Number.isFinite(h) && h > 0 ? `${h.toFixed(2)} mm` : ''
}
