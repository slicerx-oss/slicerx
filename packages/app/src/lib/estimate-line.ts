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

/** Grams for the line under the Goal tiles: whole grams, one decimal under 10 g. The footer keeps formatGrams. */
function roughGrams(g: number): string | null {
  if (!(g > 0)) return null
  const tenth = Math.round(g * 10) / 10
  return tenth < 10 ? `${tenth.toFixed(1)} g` : `${Math.round(g)} g`
}

/** The muted line under the Goal tiles: "About 1h 36m, 148 g", "Updating" while stale, nothing before a slice. */
export function goalEstimate(done: { result: Pick<SliceResult, 'stats'>; stale: boolean } | null): string | null {
  if (!done) return null
  if (done.stale) return 'Updating'
  const time = formatDuration(done.result.stats.timeS)
  const grams = roughGrams(done.result.stats.filamentG.reduce((a, b) => a + b, 0))
  return grams ? `About ${time}, ${grams}` : `About ${time}`
}

/** How long the engine took, for the tooltip on the estimate's time: "Sliced in 73 ms on 12 threads". */
export function slicedIn(wallMs: number, threads: number): string {
  const ms = Math.round(wallMs)
  const took = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
  return threads > 1 ? `Sliced in ${took} on ${threads} threads` : `Sliced in ${took}`
}

/** An object row's part count in plain words: "1 part", "2 parts". */
export function partCount(n: number): string {
  return n === 1 ? '1 part' : `${n} parts`
}

/** A mesh's triangle count, for the object row's tooltip and Developer mode: "56 triangles". */
export function triangles(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'triangle' : 'triangles'}`
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
