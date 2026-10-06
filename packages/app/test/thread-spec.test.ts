// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The thread tool turns a size and a length into what the engine cuts: an ISO coarse thread with the fit's
// clearance (at most a quarter of the pitch), and words that say the size, the clearance and the layer height
// the flanks need.
import { describe, expect, it } from 'vitest'
import { threadSpecFor } from '../src/cad/thread-spec'
import type { ThreadTarget } from '../src/geom/cad'
import type { Clearance } from '../src/plate/clearance'

const nozzle: Clearance = { mm: 0.2, measured: false, words: '0.20 mm a side, half the 0.4 mm nozzle.' }
const measured: Clearance = { mm: 0.1, measured: true, words: '0.10 mm a side, from your hole test.' }
const SIZES = [
  { name: 'M3', majorMm: 3, pitchMm: 0.5 },
  { name: 'M8', majorMm: 8, pitchMm: 1.25 },
]
const rod: ThreadTarget = { start: [0, 0, 20], axis: [0, 0, 1], diameterMm: 8, lengthMm: 20, internal: false, openEnd: true, suggested: 'M8', sizes: SIZES }
const hole: ThreadTarget = { ...rod, diameterMm: 6.8, lengthMm: 10, internal: true }

describe('thread specs', () => {
  it('cuts the size with the fit as clearance and says what it made', () => {
    const r = threadSpecFor(rod, { size: 'M8' }, measured)
    expect(r.spec).toEqual({ size: 'M8', clearanceMm: 0.1 })
    expect(r.label).toBe('M8 thread')
    const words = r.words.join(' ')
    expect(words).toMatch(/M8 x 1\.25 on the outside, 20 mm long/)
    expect(words).toMatch(/0\.10 mm a side, from your hole test/)
    expect(words).toMatch(/0\.31 mm layers or finer/)
    expect(words).toMatch(/not yet checked by a test print/)
    expect(threadSpecFor(hole, { size: 'M8' }, measured).words.join(' ')).toMatch(/in the hole, 10 mm long/)
  })

  it('keeps the clearance to a quarter of the pitch', () => {
    const r = threadSpecFor(rod, { size: 'M3' }, nozzle)
    expect(r.spec.clearanceMm).toBeCloseTo(0.125)
    expect(r.words.join(' ')).toMatch(/0\.13 mm a side, the most an M3 thread takes/)
  })

  it('takes a shorter length, and never a longer one than the surface', () => {
    expect(threadSpecFor(rod, { size: 'M8', lengthMm: 12 }, nozzle).spec.lengthMm).toBe(12)
    expect(threadSpecFor(rod, { size: 'M8', lengthMm: 30 }, nozzle).spec.lengthMm).toBeUndefined()
    expect(threadSpecFor(rod, { size: 'M8', lengthMm: 12 }, nozzle).words.join(' ')).toMatch(/12 mm long/)
  })
})
