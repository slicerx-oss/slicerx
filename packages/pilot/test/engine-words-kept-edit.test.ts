// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edit the design keeps although a step then no longer builds is answered failed ("Edited step 6, ...; step 6
// broke: ..."), and it is no refusal. A ship run's model took two such edits for refusals and sent the opposite move to
// undo them: one row read "That step left slivers too thin to keep, so it was not made", the other the engine's line,
// and neither said the edit was kept. The row now says the edit was made and which step broke, carrying the reason
// when it is already plain, and the model is told the edit is kept. The texts are the run's own two edits.
import { describe, expect, it } from 'vitest'
import { plainEngine } from '../src/engine-words'

const NEVER_QUOTE = 'Try again once, and tell the person in plain words if it still fails; never quote the engine text or its setting names.'
const UNSAFE = 'Edited step 6, Rectangle extrude 3.2 mm: moved by [11, 0, 3.25] mm; step 6 broke: boolean: the result is unsafe at mesh storage precision (intersecting faces); change the cut or placement'
const SHORT = 'Edited step 6, Rectangle extrude 3.2 mm: moved by [11, 0, 3.2] mm; step 6 broke: The shape stops 3.2 mm short of the part.'
const HINT = `The edit is kept in the design, with step 6 broken. Fix that step or edit this one again from where it is now; it was not refused, so do not send the opposite change to undo it. ${NEVER_QUOTE}`

describe('an edit kept with a step broken', () => {
  it('says the edit was made and carries a plain reason, where the row used to show the engine line', () => {
    expect(plainEngine(SHORT, 'design.edit_step')).toEqual({
      title: 'Edit kept, a step broke',
      shown: 'The edit was made, but step 6 no longer builds: the shape stops 3.2 mm short of the part. Edit it again, or edit it back.',
      hint: HINT,
      raw: SHORT,
    })
  })

  it('is never shown in a reason group\'s words, which said the edit was not made', () => {
    const r = plainEngine(UNSAFE, 'design.edit_step')
    expect(r?.title).toBe('Edit kept, a step broke')
    expect(r?.shown).toBe('The edit was made, but step 6 no longer builds. Edit it again, or edit it back.')
    expect(r?.shown).not.toMatch(/not made|slivers/i)
    expect(r?.hint).toBe(HINT)
  })

  it('says an edit was made when the step it breaks lost its pick or its part, which used to read as not made', () => {
    // these two read "That step lost track of the face or edge it works on, so it was not made" and "The part that
    // step works on is no longer there, so the step was not made"; the edit was kept both times
    expect(plainEngine('Edited step 2, Fillet; step 3 broke: Missing face; pick the face again to repair this step.', 'design.edit_step')).toMatchObject({
      title: 'Edit kept, a step broke',
      shown: 'The edit was made, but step 3 no longer builds. Edit it again, or edit it back.',
    })
    expect(plainEngine('Edited step 2, Cut; step 4 broke: A part this step combines is gone.', 'design.edit_step')).toMatchObject({
      title: 'Edit kept, a step broke',
      shown: 'The edit was made, but step 4 no longer builds. Edit it again, or edit it back.',
    })
  })

  it('leaves a refused edit and a refused step as they were', () => {
    // a refused edit is thrown, never "Edited step": it keeps its own words, or its group's
    expect(plainEngine('move: this step has no place of its own to move', 'design.edit_step')?.title).toBe('Step not made')
    expect(plainEngine('boolean: the result is unsafe at mesh storage precision (intersecting faces); change the cut or placement', 'geom.extrude')?.title).toBe('Slivers too thin')
    expect(plainEngine('The shape stops 3.2 mm short of the part.', 'geom.extrude')).toBeUndefined()
  })
})
