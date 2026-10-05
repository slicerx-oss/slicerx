// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One print time everywhere: the Model estimate, the Preview summary, the playback bar and the send sheet all read
// the slice's own figure, and the bar and the summary rows add up to it.
import { describe, expect, it } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type PreviewBuffers } from '@slicerx/contracts'
import { toolChangerSpec } from '@slicerx/viewport'
import { buildTimeline, clock, fitOf, positionAt, timeAt } from '../src/lib/preview-timeline'
import { formatDuration, timeRows, type FeatureTotals } from '../src/lib/preview-stats'

/** Layers of one 10 mm segment each (tool 0 unless given), with the layer seconds the engine wrote. */
function preview(layerTimeS: number[], tools: number[] = []): PreviewBuffers {
  const N = layerTimeS.length
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + N * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, N, true)
  dv.setUint32(12, N, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  for (let k = 0; k <= N; k++) dv.setUint32(o + k * 4, k, true)
  o += (N + 1) * 4
  for (let k = 0; k < N; k++) dv.setFloat32(o + k * 4, 0.2 * (k + 1), true)
  o += N * 4
  layerTimeS.forEach((t, k) => dv.setFloat32(o + k * 4, t, true))
  o += N * 4
  for (let k = 0; k < N; k++) {
    dv.setFloat32(o, k * 10, true)
    dv.setFloat32(o + 8, k * 10 + 10, true)
    dv.setFloat32(o + 16, 0.2 * (k + 1), true)
    dv.setUint16(o + 20, 400, true)
    dv.setUint16(o + 22, 200, true)
    dv.setUint8(o + 25, tools[k] ?? 0)
    dv.setUint16(o + 26, 1000, true)
    o += SXPV_SEGMENT_BYTES
  }
  return readPreview(raw)
}

// The default plate's figures: the file's total, and the part of it before the first layer.
const stats = { timeS: 2504, prepareS: 374 }

describe('one print time', () => {
  // The engine's layer times add up to the total less the start (what the preview carries after a slice).
  const layers = Array.from({ length: 20 }, () => (stats.timeS - stats.prepareS) / 20)
  const p = preview(layers)

  it('ends the playback at the estimate, and opens with the start while nothing is drawn', () => {
    const tl = buildTimeline(p, null, fitOf(stats))
    expect(tl.total).toBeCloseTo(stats.timeS, 6)
    expect(clock(tl.total)).toBe(clock(stats.timeS))
    expect(tl.lead).toBe(374)
    expect(positionAt(tl, p, 100)).toEqual({ layerHi: 1, moveCut: 0 })
    expect(timeAt(tl, p, 1, 0)).toBe(374)
    expect(positionAt(tl, p, stats.timeS)).toEqual({ layerHi: 20, moveCut: 1 })
    // Right after the start the first layer begins to fill.
    expect(positionAt(tl, p, 374 + 1).layerHi).toBe(1)
    expect(positionAt(tl, p, 374 + 1).moveCut).toBeGreaterThan(0)
  })

  it('reads the estimate even when the layers do not add up to it', () => {
    // A preview with the engine's own layer times (no acceleration, no start): the bar is stretched to the estimate.
    const raw = preview(layers.map((t) => t * 0.9))
    const tl = buildTimeline(raw, null, fitOf(stats))
    expect(tl.total).toBeCloseTo(stats.timeS, 6)
    expect(tl.layerEnd.at(-1)).toBeCloseTo(stats.timeS, 6)
  })

  it('keeps the tool changes the simulation adds inside the estimate', () => {
    const u1 = toolChangerSpec('snapmaker-u1', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5', travel_speed: '350' }, { widthMm: 270, depthMm: 270, heightMm: 270 }, 4)!
    const tools = layers.map((_, k) => (k < 8 ? 0 : 1))
    const q = preview(layers, tools)
    const plain = buildTimeline(q, u1)
    expect(plain.changes.length).toBe(1)
    expect(plain.total).toBeGreaterThan(stats.timeS - stats.prepareS)
    const tl = buildTimeline(q, u1, fitOf(stats))
    expect(tl.total).toBeCloseTo(stats.timeS, 6)
    expect(tl.changes[0]!.duration).toBeCloseTo(plain.changes[0]!.duration, 6)
  })

  it('plays the preview as it is when the slice states no estimate', () => {
    expect(fitOf(null)).toBeNull()
    expect(fitOf({ timeS: 0 })).toBeNull()
    const tl = buildTimeline(p)
    expect(tl.total).toBeCloseTo(stats.timeS - stats.prepareS, 6)
    expect(tl.lead).toBe(0)
  })

  it('splits the summary into rows that add up to the estimate', () => {
    const features: FeatureTotals[] = [
      { feature: 5, lengthM: 3, timeS: 600 },
      { feature: 2, lengthM: 2, timeS: 400 },
      { feature: 1, lengthM: 1, timeS: 200 },
    ]
    const rows = timeRows(features, stats.timeS, stats.prepareS)
    expect(rows.reduce((a, r) => a + r.seconds, 0)).toBeCloseTo(stats.timeS, 6)
    expect(rows.find((r) => r.key === 'start')?.seconds).toBe(374)
    expect(rows[0]!.key).toBe('5')
    // Without a start the rows still add up.
    expect(timeRows(features, stats.timeS).reduce((a, r) => a + r.seconds, 0)).toBeCloseTo(stats.timeS, 6)
  })

  it('shows the same figure in every place that formats it', () => {
    expect(formatDuration(stats.timeS)).toBe('42m')
    expect(clock(buildTimeline(p, null, fitOf(stats)).total)).toBe('41:44')
  })
})
