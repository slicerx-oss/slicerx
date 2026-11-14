// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sentence an apply gives when its preview was never made because the last paint preview was refused: the reason
// without the replay's wrapping words, and what to do next by the kind of refusal.
import { describe, expect, it } from 'vitest'
import { neverMadeText, refusalNext, refusalReason, RefusedPreviews } from '../src/paint-refused'

const EXACT = 'Exact replay stopped: Exact replay does not support paint for this part. The mesh path was not used. The design is unchanged.'
const NOTHING = 'The target paints nothing new on this design; try another target, part or state.'

describe('refusalReason', () => {
  it('drops the replay wrapper and both tails', () => {
    expect(refusalReason(EXACT)).toBe('Exact replay does not support paint for this part')
  })

  it('drops a tail alone, and the wrapper alone', () => {
    expect(refusalReason('Exact replay does not support paint for this part. The mesh path was not used.')).toBe('Exact replay does not support paint for this part')
    expect(refusalReason("Exact replay stopped: This part's faces could not be split cleanly at the band, so the band was not painted. The design is unchanged.")).toBe("This part's faces could not be split cleanly at the band, so the band was not painted")
  })

  it('keeps any other refusal as it is, less its closing period', () => {
    expect(refusalReason(NOTHING)).toBe('The target paints nothing new on this design; try another target, part or state')
    expect(refusalReason('part: the design has 1 part')).toBe('part: the design has 1 part')
  })
})

describe('refusalNext', () => {
  it('sends an exact replay refusal to another part or target', () => {
    expect(refusalNext(EXACT)).toBe('Preview again on a part that supports paint, or with a different target, then apply.')
  })

  it('sends a preview that paints nothing new to another target, part or state', () => {
    expect(refusalNext(NOTHING)).toBe('Preview again with another target, part or state, then apply.')
  })

  it('says preview again for anything else', () => {
    expect(refusalNext('part: the design has 1 part')).toBe('Preview again, then apply.')
  })
})

describe('neverMadeText', () => {
  it('fills the sentence', () => {
    expect(neverMadeText('p1', { step: 'Paint below 4 mm filament 2', message: EXACT })).toBe('preview: p1 was never made. The last paint preview, Paint below 4 mm filament 2, was refused: Exact replay does not support paint for this part. Preview again on a part that supports paint, or with a different target, then apply.')
  })
})

describe('RefusedPreviews', () => {
  it('keeps the last refusal per key until it is cleared', () => {
    const r = new RefusedPreviews()
    expect(r.neverMade('a', 'p1', 'plain')).toBe('plain')
    r.refused('a', 'First', new Error('part: the design has 1 part'))
    r.refused('a', 'Second', new Error(NOTHING))
    expect(r.neverMade('a', 'p1', 'plain')).toBe(neverMadeText('p1', { step: 'Second', message: NOTHING }))
    expect(r.neverMade('b', 'p1', 'plain')).toBe('plain')
    r.clear('a')
    expect(r.neverMade('a', 'p1', 'plain')).toBe('plain')
  })
})
