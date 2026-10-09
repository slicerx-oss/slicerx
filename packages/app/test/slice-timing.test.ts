// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a slice's time went (lib/slice-timing.ts): each stage from the slice's start, once, as a performance measure;
// a newer slice drops the older one's stages.
import { describe, expect, it } from 'vitest'
import { currentSlice, sliceStage, sliceStarted, sliceTiming } from '../src/lib/slice-timing'

describe('slice timing', () => {
  it('keeps each stage once, from the start of the slice', () => {
    const id = sliceStarted(false, 1000)
    sliceStage(id, 'ready', { now: 1010 })
    sliceStage(id, 'request', { now: 1030 })
    sliceStage(id, 'result', { now: 1530, engineMs: 412.6 })
    sliceStage(id, 'result', { now: 1900 })
    sliceStage(id, 'preview', { now: 1560, previewBytes: 1234 })
    sliceStage(id, 'drawn', { now: 1700 })
    expect(sliceTiming()).toEqual({ ms: { ready: 10, request: 30, result: 530, preview: 560, drawn: 700 }, engineMs: 413, previewBytes: 1234, auto: false })
    expect(currentSlice()).toBe(id)
  })

  it('drops the stages of a slice a newer one replaced', () => {
    const old = sliceStarted(true, 0)
    const now = sliceStarted(true, 100)
    sliceStage(old, 'result', { now: 150 })
    sliceStage(now, 'result', { now: 300 })
    expect(sliceTiming()).toEqual({ ms: { result: 200 }, auto: true })
  })

  it('writes performance measures', () => {
    const id = sliceStarted(false)
    sliceStage(id, 'shown')
    expect(performance.getEntriesByName('sx:slice:shown', 'measure')).toHaveLength(1)
  })
})
