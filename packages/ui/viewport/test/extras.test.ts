// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { SXPV_EXTRA_BYTES, SXPV_EXTRA_FLAG, SXPV_SEGMENT_BYTES, type PreviewBuffers } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { extrasFromBuffers, gcodeLineOf } from '../src/toolpaths'

function fake(withExtras: boolean): PreviewBuffers {
  const S = 3
  const raw = new ArrayBuffer(S * SXPV_SEGMENT_BYTES + S * SXPV_EXTRA_BYTES)
  const f = new Float32Array(raw, 0, S * 8)
  const xs = [[1, 2, 0.2], [3, 4, 0.2], [5, 6, 0.4]]
  xs.forEach((p, i) => {
    f[i * 8] = p[0] as number
    f[i * 8 + 1] = p[1] as number
    f[i * 8 + 4] = p[2] as number
  })
  const dv = new DataView(raw, S * SXPV_SEGMENT_BYTES)
  const rec = (i: number, fan: number, flags: number, temp: number, line: number): void => {
    dv.setUint8(i * 8, fan)
    dv.setUint8(i * 8 + 1, flags)
    dv.setUint16(i * 8 + 2, temp, true)
    dv.setUint32(i * 8 + 4, line, true)
  }
  rec(0, 255, SXPV_EXTRA_FLAG.seam | SXPV_EXTRA_FLAG.pathStart, 215, 10)
  rec(1, 128, SXPV_EXTRA_FLAG.retract, 215, 11)
  rec(2, 0, SXPV_EXTRA_FLAG.lift, 220, 12)
  return { raw, segmentCount: S, segmentsOffset: 0, extrasOffset: withExtras ? S * SXPV_SEGMENT_BYTES : -1 } as unknown as PreviewBuffers
}

describe('extras from an SXPV buffer', () => {
  it('reads fan percent, nozzle temperature and marker positions', () => {
    const e = extrasFromBuffers(fake(true))
    expect(Array.from(e?.fanPct ?? [])).toEqual([100, 50, 0])
    expect(Array.from(e?.nozzleC ?? [])).toEqual([215, 215, 220])
    expect(Array.from(e?.seams ?? []).map((v) => +v.toFixed(2))).toEqual([1, 2, 0.2])
    expect(Array.from(e?.retractions ?? []).map((v) => +v.toFixed(2))).toEqual([3, 4, 0.2])
    expect(Array.from(e?.lifts ?? []).map((v) => +v.toFixed(2))).toEqual([5, 6, 0.4])
  })

  it('has none when the buffer carries no extras', () => {
    expect(extrasFromBuffers(fake(false))).toBeNull()
    expect(gcodeLineOf(fake(false), 0)).toBe(0)
  })

  it('gives the G-code line of a segment and 0 outside the buffer', () => {
    const b = fake(true)
    expect(gcodeLineOf(b, 0)).toBe(10)
    expect(gcodeLineOf(b, 2)).toBe(12)
    expect(gcodeLineOf(b, 3)).toBe(0)
    expect(gcodeLineOf(b, -1)).toBe(0)
  })
})
