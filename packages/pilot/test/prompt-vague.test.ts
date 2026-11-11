// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A vague follow-up is read against the model the person is looking at: "add bevels" on a toy boat goes to its plain
// box deck houses, not its lofted hull; "make it nicer" on a house finishes its box walls and roof edges; "smooth it" on
// a toy car rounds its blocks. A loose part word is resolved and named, the nearest readable change is made instead of
// a refusal, a question comes only for two far-apart readings, and a follow-up aims at what a person expects to see.
import { describe, expect, it } from 'vitest'
import { GENEROUS_LINE, systemPrompt, VAGUE_LINE } from '../src/prompt'

// the follow-up lines are on a turn that follows a built design
const cloud = (has: (n: string) => boolean = () => true) => systemPrompt('cad', has, '', { cloud: true, followUp: true })

describe('the line for a vague follow-up', () => {
  it('reads the model first: the part forms, and one look at it', () => {
    expect(VAGUE_LINE).toContain('A vague follow-up (add bevels, more detail, make it nicer, smooth it) is read against the model the person is looking at')
    expect(VAGUE_LINE).toContain("each part's form in the design read-back (a plain block is boxes and cylinders with every edge sharp) and, once, design.look")
  })

  it('applies it where it shows and is needed, plain blocks first, and says what it took it to mean', () => {
    expect(VAGUE_LINE).toContain('apply it where it shows and is needed, plain blocks first')
    expect(VAGUE_LINE).toContain('say in a few words what you took it to mean ("Beveled the deck houses and the cabin roof edges")')
  })

  it('resolves a loose part word from position, color and the plan, and names the parts it took', () => {
    expect(VAGUE_LINE).toContain('A part word that names nothing in the plan ("the top", "the pipes", "the front") is the part whose position, color or shape fits it; name the parts you took')
  })

  it('does the nearest readable thing instead of refusing, and asks only for two far-apart readings', () => {
    expect(VAGUE_LINE).toContain('Ask only when two readings are equally likely and far apart, with two choices')
    expect(VAGUE_LINE).toContain('Never answer that the tools cannot do it: make the nearest change that reads right, and say so')
  })

  it('aims a follow-up at what a person expects to see, editing the main body in place where that is the honest change', () => {
    expect(GENEROUS_LINE).toContain('A follow-up aims at what the person expects to see, not the least that answers it')
    expect(GENEROUS_LINE).toContain('windows on every face that would have them')
    expect(GENEROUS_LINE).toContain('a full row on each side')
    expect(GENEROUS_LINE).toContain('edit the sections of the main body in place with design.edit_step')
  })

  it('is in the cloud prompt with design.look, the generous line with design.edit_step, and in no local prompt', () => {
    expect(cloud().split(VAGUE_LINE)).toHaveLength(2)
    expect(cloud().split(GENEROUS_LINE)).toHaveLength(2)
    expect(cloud((n) => n !== 'design.look')).not.toContain(VAGUE_LINE)
    expect(systemPrompt('cad', () => true)).not.toContain(VAGUE_LINE)
    expect(systemPrompt('cad', () => true, '', { cloud: true })).not.toContain(VAGUE_LINE)
    expect(systemPrompt('cad', () => true, '', { cloud: true })).not.toContain(GENEROUS_LINE)
    expect(systemPrompt('cad', () => true)).not.toContain(GENEROUS_LINE)
  })
})
