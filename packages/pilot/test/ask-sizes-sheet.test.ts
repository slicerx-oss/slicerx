// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Ask me for sizes" goes straight to the dimension sheet with suggested values. Where the sheet is offered, a question
// card about sizes is not shown: the model is told to put the sizes on the sheet instead, and the next step does.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { askTool, createPilot, createScriptedClient, DEFAULT_CONFIG, type ScriptStep } from '../src/index'
import { systemPrompt } from '../src/prompt'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

// the first reply 0.2.17 gave to "a Pi 5 case, ask me for sizes": a card with three buttons and no sheet
const SIZE_CARD = { name: 'pilot.ask', args: { title: 'Main dimensions', question: 'What main dimensions should I use?', choices: [{ id: 'snug', label: 'Snug fit' }, { id: 'roomy', label: 'Roomy' }, { id: 'tell', label: 'I will tell you' }] } }
const FAMILY_CARD = { name: 'pilot.ask', args: { title: 'Which Pi', question: 'Is it a Raspberry Pi 4 or a Pi 5?', choices: [{ id: '4', label: 'Pi 4' }, { id: '5', label: 'Pi 5' }] } }

async function run(call: typeof SIZE_CARD, sizesOnSheet: boolean) {
  const seen: { ok: boolean; summary: string }[] = []
  const steps: ScriptStep[] = [
    { calls: [call] },
    (messages) => {
      const last = messages.at(-1)
      if (last?.role === 'tool') seen.push(JSON.parse(last.content) as { ok: boolean; summary: string })
      return { text: 'Okay.' }
    },
  ]
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [askTool({ sizesOnSheet })] })
  const events: PilotEvent[] = []
  for await (const e of p.run('s', 'Design a Raspberry Pi 5 case. Ask me for sizes.')) {
    events.push(e)
    if (e.type === 'ask') void p.answer!(e.askId, call.args.choices[0]!.id)
  }
  return { events, seen }
}

describe('asked to ask for sizes, mimir shows the sheet', () => {
  it('turns a question card about sizes into a note to use the sheet, showing no card', async () => {
    const r = await run(SIZE_CARD, true)
    expect(r.events.some((e) => e.type === 'ask')).toBe(false)
    expect(r.seen[0]).toMatchObject({ ok: false })
    expect(r.seen[0]!.summary).toContain('pilot.sheet')
  })

  it('still asks which model a family means', async () => {
    const r = await run(FAMILY_CARD, true)
    expect(r.events.some((e) => e.type === 'ask')).toBe(true)
  })

  it('the prompt says to show the sheet at once when asked to ask for sizes', () => {
    expect(systemPrompt('full')).toContain('Asked to ask for sizes, show the sheet with suggested values at once, never a question first.')
  })
})
