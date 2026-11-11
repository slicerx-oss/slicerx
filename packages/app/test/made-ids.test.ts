// Ids the design tools make are picked out of tool result text by replays and recordings, which tell an id from an
// ordinary word by its digit. A clock reading whose base 36 digits are all letters must still give ids with a digit.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { madeAt, stepId } from '@slicerx/cad-history'
import { MADE_ID } from '../../mcp/evals/creative/replay-divergence'

// 2026-11-11, a moment whose base 36 reading has no digit at all
const LETTERS_ONLY = parseInt('mwbuffca', 36)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('made ids', () => {
  it('gives every step id a digit, so a replay finds each one in the text it reads', () => {
    vi.spyOn(Date, 'now').mockReturnValue(LETTERS_ONLY)
    const ids = Array.from({ length: 40 }, () => stepId())
    for (const id of ids) {
      expect(id).toMatch(/\d/)
      expect(`Edited step 3 (${id}), Fillet 1 mm`.match(MADE_ID)).toEqual([id])
    }
    // a run of steps all made in one millisecond pairs one to one, in order
    expect(ids.join(' ').match(MADE_ID)).toEqual(ids)
  })

  it('keeps the steps of one millisecond in the order made', () => {
    vi.spyOn(Date, 'now').mockReturnValue(LETTERS_ONLY)
    const seqs = Array.from({ length: 40 }, () => madeAt(stepId())!)
    for (const m of seqs) expect(m.time).toBe(LETTERS_ONLY)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!.seq).toBeGreaterThan(seqs[i - 1]!.seq)
  })
})
