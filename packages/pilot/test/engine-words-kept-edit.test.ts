// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edit the design keeps although a step then no longer builds is answered failed ("Edited step 6, ...; step 6
// broke: ..."), and it is no refusal. A ship run's model took two such edits for refusals and sent the opposite move to
// undo them: one row read "That step left slivers too thin to keep, so it was not made", the other the engine's line,
// and neither said the edit was kept. The row now says the edit was made and which step broke, carrying the reason
// when it is already plain or the reason group's cause and what to try, and the model is told the edit is kept. The
// first texts are the run's own two edits.
import { geomStuckMessage } from '@slicerx/contracts/geom-limits'
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

  it('keeps the reason group\'s cause and what to try, never its words that the edit was not made', () => {
    const r = plainEngine(UNSAFE, 'design.edit_step')
    expect(r?.title).toBe('Edit kept, a step broke')
    expect(r?.shown).toBe('The edit was made, but step 6 no longer builds: that step left slivers too thin to keep. Overlapping the shapes a little more usually fixes it.')
    expect(r?.shown).not.toMatch(/not made/i)
    expect(r?.hint).toBe(HINT)
  })

  it('says an edit was made when the step it breaks lost its pick or its part, which used to read as not made', () => {
    // these two read "That step lost track of the face or edge it works on, so it was not made" and "The part that
    // step works on is no longer there, so the step was not made"; the edit was kept both times
    expect(plainEngine('Edited step 2, Fillet; step 3 broke: Missing face; pick the face again to repair this step.', 'design.edit_step')).toMatchObject({
      title: 'Edit kept, a step broke',
      shown: 'The edit was made, but step 3 no longer builds: that step lost track of the face or edge it works on. Picking it again on the part fixes it.',
    })
    expect(plainEngine('Edited step 2, Cut; step 4 broke: A part this step combines is gone.', 'design.edit_step')).toMatchObject({
      title: 'Edit kept, a step broke',
      shown: 'The edit was made, but step 4 no longer builds: the part that step works on is no longer there. Edit it again, or edit it back.',
    })
  })

  it('leaves a refused edit and a refused step as they were', () => {
    // a refused edit is thrown, never "Edited step": it keeps its own words, or its group's
    expect(plainEngine('move: this step has no place of its own to move', 'design.edit_step')?.title).toBe('Step not made')
    expect(plainEngine('boolean: the result is unsafe at mesh storage precision (intersecting faces); change the cut or placement', 'geom.extrude')?.title).toBe('Slivers too thin')
    expect(plainEngine('The shape stops 3.2 mm short of the part.', 'geom.extrude')).toBeUndefined()
  })
})

/**
 * [the broken step's reason group, the reason as design.edit_step passes it on, the step, the row]. One reason per
 * group, the engine's own text from engine-words-families.test.ts where it has one. A kept edit keeps its group's
 * cause, with the group's try line, or "Edit it again, or edit it back." when the group has none.
 */
const GROUPS: readonly (readonly [string, string, number, string])[] = [
  ['Part is gone', 'A part this step combines is gone.', 4, 'The edit was made, but step 4 no longer builds: the part that step works on is no longer there. Edit it again, or edit it back.'],
  ['Loft not made', "loft: the result is unsafe at mesh storage precision (collapsed triangles); change the loft's profiles or the spacing between them", 5, "The edit was made, but step 5 no longer builds: that loft left slivers too thin to keep. Try to change the loft's profiles or the spacing between them."],
  ['Slivers too thin', 'boolean: the result is unsafe at mesh storage precision (intersecting faces); change the cut or placement', 6, 'The edit was made, but step 6 no longer builds: that step left slivers too thin to keep. Overlapping the shapes a little more usually fixes it.'],
  ['Took too long', 'boolean: this join is taking too long to finish; try fewer copies or join them in smaller groups', 7, 'The edit was made, but step 7 no longer builds: that step took too long. Try fewer copies or a simpler shape.'],
  ['Shape would fold', 'loft: the lofted body runs into itself; space the profiles further apart or make them smaller', 3, 'The edit was made, but step 3 no longer builds: that shape would fold into itself. Try a gentler curve, more room between its parts, or a smaller size.'],
  ['Size too big', 'radiusMm: 6 mm does not fit on this face; at most 5.000 mm', 3, 'The edit was made, but step 3 no longer builds: that size is too big for this part. Try a smaller size.'],
  ['Picked on a curve', 'edges: edge 1: the picked face is curved. Pick the edge from the flat face on its other side', 4, 'The edit was made, but step 4 no longer builds: fillet and chamfer take an edge from the flat face beside it. Picking the edges again from that flat face fixes it.'],
  ['Edge picked twice', 'edges: edges 3, 4 and 5 meet at one point along a round; pick each edge once', 4, 'The edit was made, but step 4 no longer builds: some edges were picked more than once where they meet along a curve. Picking each edge once fixes it.'],
  ['Edge not rounded', 'edges: edge 1: both faces along this edge are curved. Fillet and chamfer need a flat face on one side', 2, 'The edit was made, but step 2 no longer builds: fillet and chamfer cannot follow that edge where it meets a curved face. Try other edges, or round the corner in the sketch before it is extruded.'],
  ['Too many fillets', 'edges: the corner at (20.000, 10.000, 5.000) joins more than three fillets; leave some of its edges out', 2, 'The edit was made, but step 2 no longer builds: too many rounded edges meet at one corner. Try rounding fewer of its edges, or a chamfer.'],
  ['Face or edge lost', 'Missing face; pick the face again to repair this step.', 3, 'The edit was made, but step 3 no longer builds: that step lost track of the face or edge it works on. Picking it again on the part fixes it.'],
  ['Would remove the part', 'face.push: the cut removes the whole body', 5, 'The edit was made, but step 5 no longer builds: that step would cut away the whole part. Check where it sits on the part, or make it smaller.'],
  ['Too much detail', 'count: at most 2000 copies', 8, 'The edit was made, but step 8 no longer builds: that step asks for more detail than can be built at once. Try fewer copies or a simpler shape.'],
]

describe('a kept edit keeps its broken step\'s cause', () => {
  it('covers every reason group but the one for a step sent the wrong way', () => {
    expect(GROUPS.map(([g]) => g)).toHaveLength(13)
    expect(new Set(GROUPS.map(([g]) => g)).size).toBe(13)
  })

  it.each(GROUPS)('%s: %s', (group, reason, step, row) => {
    // the reason on its own is in that group, as a refused step
    expect(plainEngine(reason, 'geom.build')?.title).toBe(group)
    const r = plainEngine(`Edited step 2, Fillet; step ${step} broke: ${reason}`, 'design.edit_step')
    expect(r).toEqual({
      title: 'Edit kept, a step broke',
      shown: row,
      hint: `The edit is kept in the design, with step ${step} broken. Fix that step or edit this one again from where it is now; it was not refused, so do not send the opposite change to undo it. ${NEVER_QUOTE}`,
      raw: `Edited step 2, Fillet; step ${step} broke: ${reason}`,
    })
    expect(r?.shown).not.toMatch(/not made|was stopped/)
  })

  it('says only that the step no longer builds for an engine reason no group knows, or a step sent the wrong way', () => {
    for (const reason of ['unknown operation "brep.wedge"', 'request: missing "parts"', 'part: the design has 2 parts']) {
      expect(plainEngine(`Edited step 2, Cut; step 4 broke: ${reason}`, 'design.edit_step')?.shown).toBe('The edit was made, but step 4 no longer builds. Edit it again, or edit it back.')
    }
  })

  it('carries a miss or the time limit in its own words', () => {
    expect(plainEngine(`Edited step 2, Cut; step 4 broke: ${geomStuckMessage('build', 180_000)}`, 'design.edit_step')?.shown).toBe(
      `The edit was made, but step 4 no longer builds: ${(geomStuckMessage('build', 180_000).charAt(0).toLowerCase() + geomStuckMessage('build', 180_000).slice(1)).replace(/[.\s]+$/, '')}. Edit it again, or edit it back.`,
    )
  })
})
