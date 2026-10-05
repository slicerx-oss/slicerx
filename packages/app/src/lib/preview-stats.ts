// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One pass over the SXPV segments for the Preview legend and time breakdown.
import { SXPV_SEGMENT, SXPV_SEGMENT_BYTES, type FeatureId, type PreviewBuffers } from '@slicerx/contracts'

export interface FeatureTotals {
  feature: FeatureId
  lengthM: number
  timeS: number
}

export interface PreviewStats {
  features: FeatureTotals[]
  toolLengthM: number[]
  printTimeS: number
}

const cache = new WeakMap<PreviewBuffers, PreviewStats>()

export function previewStats(p: PreviewBuffers): PreviewStats {
  const hit = cache.get(p)
  if (hit) return hit
  const view = new DataView(p.raw, p.segmentsOffset, p.segmentCount * SXPV_SEGMENT_BYTES)
  const len = new Float64Array(16)
  const time = new Float64Array(16)
  const tools = new Float64Array(Math.max(1, p.toolCount))
  for (let i = 0; i < p.segmentCount; i++) {
    const o = i * SXPV_SEGMENT_BYTES
    const dx = view.getFloat32(o + SXPV_SEGMENT.x1, true) - view.getFloat32(o + SXPV_SEGMENT.x0, true)
    const dy = view.getFloat32(o + SXPV_SEGMENT.y1, true) - view.getFloat32(o + SXPV_SEGMENT.y0, true)
    const l = Math.hypot(dx, dy)
    const f = view.getUint8(o + SXPV_SEGMENT.feature) & 15
    const t = view.getUint8(o + SXPV_SEGMENT.tool)
    const speed = view.getUint16(o + SXPV_SEGMENT.speedDeciMmS, true) / 10
    len[f] = (len[f] ?? 0) + l
    if (speed > 0) time[f] = (time[f] ?? 0) + l / speed
    if (t < tools.length) tools[t] = (tools[t] ?? 0) + l
  }
  const features: FeatureTotals[] = []
  for (let f = 0; f < 15; f++) {
    const l = len[f] ?? 0
    if (l > 0) features.push({ feature: f as FeatureId, lengthM: l / 1000, timeS: time[f] ?? 0 })
  }
  features.sort((a, b) => b.timeS - a.timeS)
  let printTimeS = 0
  for (let i = 0; i < p.layerCount; i++) printTimeS += p.layerTimeS[i] ?? 0
  const out = { features, toolLengthM: [...tools].map((v) => v / 1000), printTimeS }
  cache.set(p, out)
  return out
}

export interface TimeRow {
  /** A feature id, or `start` for what happens before the first layer. */
  key: string
  seconds: number
}

/**
 * The rows of "Where the time goes": the printing split by feature in the shares the moves take, and the start
 * before the first layer, together exactly the estimate (`timeS`), so the list agrees with the figures above it.
 */
export function timeRows(features: readonly FeatureTotals[], timeS: number, prepareS = 0): TimeRow[] {
  const start = Math.min(Math.max(prepareS, 0), Math.max(timeS, 0))
  const total = features.reduce((a, f) => a + f.timeS, 0) || 1
  return [
    ...features.map((f) => ({ key: String(f.feature), seconds: (f.timeS / total) * (timeS - start) })),
    ...(start > 0 ? [{ key: 'start', seconds: start }] : []),
  ].sort((a, b) => b.seconds - a.seconds)
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '0m'
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h === 0) return m === 0 ? `${Math.max(1, Math.round(s))} s` : `${m}m`
  return `${h}h ${m}m`
}

/** Shown where the slicer returned no estimate, instead of a misleading zero. */
export const NOT_ESTIMATED = 'not estimated'

export function formatGrams(g: number): string {
  return g > 0 ? `${g.toFixed(1)} g` : NOT_ESTIMATED
}

export function formatCost(c: number): string {
  return c > 0 ? `$${c.toFixed(2)}` : NOT_ESTIMATED
}
