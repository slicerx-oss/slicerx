// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up on a design already built (a toy pod made longer, a drawer added to a desk organizer, a house roof
// recolored) is made in that design at once: no size sheet and no plan card, the plan changed with the person's words,
// a built size changed at the step that made it, and the reply ends on what changed, with no question.
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, type ScriptStep } from '../src/index'
import { FOLLOWUP_LINE, systemPrompt } from '../src/prompt'
import { defineTool, type PilotTool } from '../src/tool'

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

  it('is in the cloud prompt of a turn that follows a built design, with design.plan and design.edit_step, and in no other', () => {
    for (const scope of ['full', 'cad'] as const) {
      expect(systemPrompt(scope, () => true, '', { cloud: true, followUp: true }).split(FOLLOWUP_LINE)).toHaveLength(2)
      expect(systemPrompt(scope, () => true, '', { cloud: true })).not.toContain(FOLLOWUP_LINE)
      expect(systemPrompt(scope, () => true, '', { followUp: true })).not.toContain(FOLLOWUP_LINE)
      expect(systemPrompt(scope, (n) => n !== 'design.edit_step', '', { cloud: true, followUp: true })).not.toContain(FOLLOWUP_LINE)
    }
  })
})

describe('the follow-up line by turn', () => {
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
  const tool = (name: string) =>
    defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: 'test', input: z.object({}), async run() { return { summary: 'ok' } } }) as PilotTool<never>

  it('leaves a first build without it, and gives it to the next turn once a design is built', async () => {
    let built = false
    const seen: Record<string, string[]> = { first: [], next: [] }
    let turn: 'first' | 'next' = 'first'
    const say: ScriptStep = (messages) => {
      seen[turn]!.push(String(messages[0]!.content))
      return { text: 'Done.' }
    }
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(Array.from({ length: 8 }, () => say), { chunk: false }), builtins: false, tools: [tool('design.new'), tool('design.plan'), tool('design.edit_step')], hasDesign: () => built })
    for await (const _e of p.run('s', 'make a planter')) void _e
    built = true
    turn = 'next'
    for await (const _e of p.run('s', 'make it taller')) void _e
    expect(seen.first!.length).toBeGreaterThan(0)
    expect(seen.next!.length).toBeGreaterThan(0)
    for (const sys of seen.first!) expect(sys).not.toContain(FOLLOWUP_LINE)
    for (const sys of seen.next!) expect(sys).toContain(FOLLOWUP_LINE)
  })
})
