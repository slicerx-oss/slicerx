// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How many layer ranges a slice asks for: one on the desktop, one per thread in the browser, and at most four for a
// painted plate, where every range's worker builds the whole painted session first.
import { describe, expect, it } from 'vitest'
import { PAINTED_SHARDS, sliceShards } from '../src/plate/painted'
import type { PlateEntry } from '../src/state/store'

const entry = (paint?: PlateEntry['paint']) => ({ id: 'o', name: 'o', parts: [], ...(paint ? { paint } : {}) }) as unknown as PlateEntry
const web = (threads: number) => ({ kind: 'web', capabilities: { threads } })

describe('the layer ranges of a slice', () => {
  it('is one on the desktop, painted or not', () => {
    expect(sliceShards({ kind: 'desktop', capabilities: { threads: 16 } }, [entry()])).toBe(1)
    expect(sliceShards({ kind: 'desktop', capabilities: { threads: 16 } }, [entry({ 0: { color: { 3: '8' } } })])).toBe(1)
  })

  it('is one per thread in the browser', () => {
    expect(sliceShards(web(11), [entry(), entry()])).toBe(11)
    expect(sliceShards(web(3), [entry()])).toBe(3)
    expect(sliceShards(web(0), [entry()])).toBe(1)
  })

  it('is at most four in the browser when any object has paint', () => {
    expect(PAINTED_SHARDS).toBe(4)
    expect(sliceShards(web(11), [entry(), entry({ 0: { color: { 3: '8' } } })])).toBe(4)
    expect(sliceShards(web(2), [entry({ 1: { seam: { 0: '4' } } })])).toBe(2)
    // Paint layers with no painted triangle are no paint.
    expect(sliceShards(web(11), [entry({ 0: { color: {} } })])).toBe(11)
  })
})
