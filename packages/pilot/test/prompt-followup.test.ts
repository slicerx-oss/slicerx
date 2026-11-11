// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up on a design already built (a toy boat made longer, a drawer added to a desk organizer, a house roof
// recolored) is made in that design at once: no size sheet and no plan card, the plan changed with the person's words,
// a built size changed at the step that made it, and the reply ends on what changed, with no question.
import { describe, expect, it } from 'vitest'
import { FOLLOWUP_LINE, systemPrompt } from '../src/prompt'

describe('the line for a follow-up on a built design', () => {
  it('makes the change at once, with no sheet and no plan card, and puts it in the plan with the person\'s words', () => {
    expect(FOLLOWUP_LINE).not.toContain('\n')
    expect(FOLLOWUP_LINE).toContain('A follow-up on a design already built (a detail added, a size changed, a part recolored) is made in that design at once: no size sheet and no plan card')
    expect(FOLLOWUP_LINE).toContain('design.plan with amends and asked (the person\'s words)')
  })

  it('changes a built size at the step that made it, so a patterned detail changes once at its source', () => {
    expect(FOLLOWUP_LINE).toContain('design.edit_step with size on the step that made it')
    expect(FOLLOWUP_LINE).toContain('a patterned detail at its source step, and the copies follow; never a push on each copy')
  })

  it('ends the reply on what changed, with no question and no offer to slice or print', () => {
    expect(FOLLOWUP_LINE).toContain('The reply to a follow-up ends with what changed, in a few words: never a question, and no offer to slice or print')
  })

  it('is in the cloud prompt with design.plan and design.edit_step, and in no other', () => {
    for (const scope of ['full', 'cad'] as const) {
      expect(systemPrompt(scope, () => true, '', { cloud: true }).split(FOLLOWUP_LINE)).toHaveLength(2)
      expect(systemPrompt(scope, () => true)).not.toContain(FOLLOWUP_LINE)
      expect(systemPrompt(scope, (n) => n !== 'design.edit_step', '', { cloud: true })).not.toContain(FOLLOWUP_LINE)
    }
  })
})
