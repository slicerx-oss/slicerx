// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Numbers for preview legends, computed from the same buffers the renderer draws.
import { SXPV_SEGMENT_BYTES, type PreviewBuffers } from '@slicerx/contracts'

export interface PreviewSummary {
  /** Extruded path length per feature id, mm. */
  featureMm: number[]
  /** Extrusion time per feature id, seconds (path length over speed). */
  featureTimeS: number[]
  /** Extruded path length per tool index, mm. */
  toolMm: number[]
  speedRange: [number, number]
  flowRange: [number, number]
  layerTimeRange: [number, number]
  widthRange: [number, number]
  heightRange: [number, number]
  /** Sum of the per-layer times, seconds. */
  totalTimeS: number
}

export function summarizePreview(b: PreviewBuffers): PreviewSummary {
  const S = b.segmentCount
  const f32 = new Float32Array(b.raw, b.segmentsOffset, (S * SXPV_SEGMENT_BYTES) / 4)
  const u8 = new Uint8Array(b.raw, b.segmentsOffset, S * SXPV_SEGMENT_BYTES)
  const u16 = new Uint16Array(b.raw, b.segmentsOffset, (S * SXPV_SEGMENT_BYTES) / 2)
  const featureMm = new Array<number>(16).fill(0)
  const featureTimeS = new Array<number>(16).fill(0)
  const toolMm: number[] = []
  let smin = Infinity, smax = 0, fmin = Infinity, fmax = 0, wmin = Infinity, wmax = 0, hmin = Infinity, hmax = 0
  for (let i = 0; i < S; i++) {
    const o = i * 8
    const len = Math.hypot((f32[o + 2] ?? 0) - (f32[o] ?? 0), (f32[o + 3] ?? 0) - (f32[o + 1] ?? 0))
    const feat = u8[i * 32 + 24] ?? 0
    const tool = u8[i * 32 + 25] ?? 0
    featureMm[feat] = (featureMm[feat] ?? 0) + len
    while (toolMm.length <= tool) toolMm.push(0)
    toolMm[tool] = (toolMm[tool] ?? 0) + len
    const sp = (u16[i * 16 + 13] ?? 0) * 0.1
    if (sp > 0) featureTimeS[feat] = (featureTimeS[feat] ?? 0) + len / sp
    const w = (u16[i * 16 + 10] ?? 0) * 0.001
    const h = (u16[i * 16 + 11] ?? 0) * 0.001
    if (w > 0) { wmin = Math.min(wmin, w); wmax = Math.max(wmax, w) }
    if (h > 0) { hmin = Math.min(hmin, h); hmax = Math.max(hmax, h) }
    const fl = f32[o + 7] ?? 0
    if (sp > 0) { smin = Math.min(smin, sp); smax = Math.max(smax, sp) }
    if (fl > 0) { fmin = Math.min(fmin, fl); fmax = Math.max(fmax, fl) }
  }
  let tmin = Infinity, tmax = 0, total = 0
  for (let k = 0; k < b.layerCount; k++) {
    const t = b.layerTimeS[k] ?? 0
    tmin = Math.min(tmin, t)
    tmax = Math.max(tmax, t)
    total += t
  }
  const fin = (v: number): number => (Number.isFinite(v) ? v : 0)
  return { featureMm, featureTimeS, toolMm, speedRange: [fin(smin), smax], flowRange: [fin(fmin), fmax], layerTimeRange: [fin(tmin), tmax], widthRange: [fin(wmin), wmax], heightRange: [fin(hmin), hmax], totalTimeS: total }
}
