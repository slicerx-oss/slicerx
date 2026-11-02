// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A read-only skill or tool never talks about an approval: whatever text the model sees for it (its playbook line, its
// description), and the general approval wording only names actions that change something. A model that reads "needs
// your OK" next to a lookup repeats it in the answer.
import { describe, expect, it } from 'vitest'
import { setAssistantBrand } from '@slicerx/contracts'
import { systemPrompt } from '../src/prompt'
import { builtinTools } from '../src/tools'
import { EMPTY_KB_INDEX, createKnowledgeBase, type KbSkill } from '../src/kb/kb'
import { availableSkills, playbooks } from '../skills/catalog'
import generated from '../src/kb/generated/kb.json'

const APPROVAL = /approv|\byour ok\b|\bok\b|confirm before|confirm that|permission/i

const kb = createKnowledgeBase(generated as unknown as typeof EMPTY_KB_INDEX)
const tools = builtinTools({ planner: undefined, commands: [] })
const has = (n: string): boolean => tools.some((t) => t.name === n)
const readSkills: KbSkill[] = availableSkills(kb.skills(), has).filter((s) => s.approval === 'read')
const readTools = tools.filter((t) => t.permission === 'read')

describe('read-only skills and tools never invite an approval', () => {
  it('finds read-only skills and tools to check', () => {
    expect(readSkills.length).toBeGreaterThan(2)
    expect(readTools.length).toBeGreaterThan(10)
    expect(readTools.map((t) => t.name)).toEqual(expect.arrayContaining(['parts.lookup', 'web.lookup', 'kb.printer', 'printer.status', 'diagnose']))
  })

  it.each(readSkills.map((s) => [s.id, s] as const))('the playbook line of read-only skill %s has no approval wording', (_id, skill) => {
    expect(playbooks([skill])).not.toMatch(APPROVAL)
    expect(skill.purpose).not.toMatch(APPROVAL)
  })

  it.each(readTools.map((t) => [t.name, t] as const))('the description of read-only tool %s has no approval wording', (_name, tool) => {
    expect(tool.description).not.toMatch(APPROVAL)
  })

  it('the prompt names an approval only for actions that change something', () => {
    setAssistantBrand()
    const p = systemPrompt('full')
    const lines = p.split('\n').filter((l) => /approv|your ok/i.test(l) && !l.endsWith(':'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      // every approval line says which actions: ones that queue, start, send or change something
      expect(l, l).toMatch(/queue|start|send|change|edit|apply|save/i)
    }
    // the step-list line limits "needs your OK" to those steps and keeps lookups and answers out of it
    const steps = p.split('\n').find((l) => l.includes('needs your OK'))!
    expect(steps).toMatch(/only (a|the) steps? that (queue|start|send|change)/i)
    expect(steps).toMatch(/lookups?/i)
  })
})
