// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one size rule for slices (state/slice-estimate.ts): a plate's expected slice time from its last slice when it is
// still about that size, else from its triangles, and whether that makes it a big slice.
import { describe, expect, it } from 'vitest'
import { BIG_SLICE_MS, expectedSliceMs, isBigSlice, noteSliceTiming, plateTriangles, SLICE_MS_PER_TRIANGLE, sliceTimingsOf, type SliceTiming } from '../src/state/slice-estimate'

/** An object of parts with these triangle counts. */
const object = (counts: number[], printable?: boolean) => ({ ...(printable === undefined ? {} : { printable }), parts: counts.map((n) => ({ indices: { length: n * 3 } })) })

describe('the slice size rule', () => {
  it('counts the triangles of every part that prints', () => {
    expect(plateTriangles([object([100, 50]), object([1000], false), object([7], true)])).toBe(157)
    expect(plateTriangles([])).toBe(0)
  })

  it('estimates from the triangles when there is no last slice', () => {
    expect(expectedSliceMs([object([1000])])).toBeCloseTo(1000 * SLICE_MS_PER_TRIANGLE)
    expect(expectedSliceMs([object([1000])], [])).toBeCloseTo(1000 * SLICE_MS_PER_TRIANGLE)
  })

  const three = (t: SliceTiming) => [t, t, t]

  it("scales the plate's recent slices to its triangles while the plate is about that size", () => {
    expect(expectedSliceMs([object([150_000])], three({ triangles: 100_000, ms: 800 }))).toBeCloseTo(1200)
    expect(expectedSliceMs([object([50_000])], three({ triangles: 100_000, ms: 800 }))).toBeCloseTo(400)
    // Another model altogether: a tiny slice's time says nothing about a big one, and the other way round.
    expect(expectedSliceMs([object([500_000])], three({ triangles: 12, ms: 200 }))).toBeCloseTo(500_000 * SLICE_MS_PER_TRIANGLE)
    expect(expectedSliceMs([object([12])], three({ triangles: 500_000, ms: 5000 }))).toBeCloseTo(12 * SLICE_MS_PER_TRIANGLE)
  })

  it('goes by the median of three slices, so one slow slice on a busy machine keeps a normal plate on auto', () => {
    const plate = [object([92_000])]
    const quick = { triangles: 92_000, ms: 1000 }
    // One 3.5 s outlier among 1 s slices: still auto.
    expect(isBigSlice(plate, [quick, { triangles: 92_000, ms: 3500 }, quick])).toBe(false)
    // A first slow slice alone, or two, decide nothing: the triangles do.
    expect(isBigSlice(plate, [{ triangles: 92_000, ms: 3500 }])).toBe(false)
    expect(isBigSlice(plate, [{ triangles: 92_000, ms: 3500 }, { triangles: 92_000, ms: 3600 }])).toBe(false)
    // Three slow ones say the plate is slow here.
    expect(isBigSlice(plate, three({ triangles: 92_000, ms: 3500 }))).toBe(true)
  })

  it('calls a slice big from BIG_SLICE_MS on', () => {
    const line = Math.ceil(BIG_SLICE_MS / SLICE_MS_PER_TRIANGLE)
    expect(isBigSlice([object([line])])).toBe(true)
    expect(isBigSlice([object([line - 1])])).toBe(false)
    // A 1.4 million triangle part is big, a 92k one is not.
    expect(isBigSlice([object([1_400_000])])).toBe(true)
    expect(isBigSlice([object([92_000])])).toBe(false)
    // Recent slices decide when they speak for the plate: this plate sliced slowly three times.
    expect(isBigSlice([object([92_000])], three({ triangles: 90_000, ms: 1600 }))).toBe(true)
  })

  it('keeps the last three slice timings per plate', () => {
    expect(sliceTimingsOf('plate-x')).toEqual([])
    for (const ms of [1, 2, 3, 4]) noteSliceTiming('plate-x', { triangles: 10, ms })
    expect(sliceTimingsOf('plate-x').map((t) => t.ms)).toEqual([2, 3, 4])
  })
})
