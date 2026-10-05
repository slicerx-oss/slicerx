// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds small SXPV buffers with exact, hand-checkable contents for tests.
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type PreviewBuffers } from '@slicerx/contracts'

export interface Seg {
  a: [number, number]
  b: [number, number]
  feature: number
  tool?: number
  speed?: number
  flow?: number
}

/** `layers[k]` lists the segments of layer k in print order. Layer height 0.2 mm. */
export function buildPreview(layers: Seg[][]): PreviewBuffers {
  const N = layers.length
  const S = layers.reduce((a, l) => a + l.length, 0)
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + S * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, N, true)
  dv.setUint32(20, layers.reduce((n, l) => l.reduce((m, s) => Math.max(m, (s.tool ?? 0) + 1), n), 1), true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  let first = 0
  layers.forEach((l, k) => {
    dv.setUint32(o + k * 4, first, true)
    first += l.length
  })
  dv.setUint32(o + N * 4, S, true)
  o += (N + 1) * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, (k + 1) * 0.2, true))
  o += N * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, 10 + k, true))
  o += N * 4
  let i = 0
  layers.forEach((l, k) => {
    for (const s of l) {
      const r = o + i * SXPV_SEGMENT_BYTES
      dv.setFloat32(r, s.a[0], true)
      dv.setFloat32(r + 4, s.a[1], true)
      dv.setFloat32(r + 8, s.b[0], true)
      dv.setFloat32(r + 12, s.b[1], true)
      dv.setFloat32(r + 16, (k + 1) * 0.2, true)
      dv.setUint16(r + 20, 420, true)
      dv.setUint16(r + 22, 200, true)
      dv.setUint8(r + 24, s.feature)
      dv.setUint8(r + 25, s.tool ?? 0)
      dv.setUint16(r + 26, Math.round((s.speed ?? 100) * 10), true)
      dv.setFloat32(r + 28, s.flow ?? 8, true)
      i++
    }
  })
  return readPreview(raw)
}
