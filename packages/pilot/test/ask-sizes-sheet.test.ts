// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Ask me for sizes" goes straight to the dimension sheet with suggested values. Where the sheet is offered, a question
// card that mimir marks as asking for the part's sizes (sizes: true) is not shown: the model is told to put the sizes on
// the sheet instead, and the next step does. The words of the question decide nothing.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { askTool, createPilot, createScriptedClient, DEFAULT_CONFIG, type ScriptStep } from '../src/index'
import { systemPrompt } from '../src/prompt'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

// the first reply 0.2.17 gave to "a Pi 5 case, ask me for sizes": a card with three buttons and no sheet
const SIZE_CARD = { name: 'pilot.ask', args: { title: 'Main dimensions', question: 'What main dimensions should I use?', sizes: true, choices: [{ id: 'snug', label: 'Snug fit' }, { id: 'roomy', label: 'Roomy' }, { id: 'tell', label: 'I will tell you' }] } }
const FAMILY_CARD = { name: 'pilot.ask', args: { title: 'Which Pi', question: 'Is it a Raspberry Pi 4 or a Pi 5?', choices: [{ id: '4', label: 'Pi 4' }, { id: '5', label: 'Pi 5' }] } }

async function run(call: { name: string; args: { choices: { id: string }[] } & Record<string, unknown> }, sizesOnSheet: boolean) {
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

// mimir marks a question as asking for the part's sizes with sizes: true. Only that sends it to the sheet; a question
// about the person's own things leaves it off and stays a card, whatever words either uses. The redirect is not a
// failure: it neither counts toward moving the run to the larger model nor shows as a failed step.
describe('only a question marked sizes goes to the sheet', () => {
  const card = (question: string, sizes?: boolean) => ({ name: 'pilot.ask', args: { title: 'Question', question, ...(sizes === undefined ? {} : { sizes }), choices: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Other' }] } })
  const shown = async (c: ReturnType<typeof card>, sizesOnSheet = true) => (await run(c, sizesOnSheet)).events.some((e) => e.type === 'ask')

  for (const question of ['How much room should there be around the board?', 'What should the case be like inside?'])
    it(`sends "${question}" to the sheet when marked sizes`, async () => {
      const r = await run(card(question, true), true)
      expect(r.events.some((e) => e.type === 'ask')).toBe(false)
      expect(r.seen[0]!.summary).toContain('pilot.sheet')
    })

  for (const question of ['What size should your case be?', 'How big do you want your organizer?', 'How thick is your shelf?', 'What are the dimensions of your phone?'])
    it(`shows "${question}" when not marked sizes`, async () => {
      expect(await shown(card(question))).toBe(true)
      expect(await shown(card(question, false))).toBe(true)
    })

  it('shows a question marked sizes where the sheet is not offered', async () => {
    expect(await shown(card('How long should it be?', true), false)).toBe(true)
  })

  it('offers sizes only on the ask beside the sheet', () => {
    const shape = (t: ReturnType<typeof askTool>) => Object.keys((t.input as unknown as { shape: Record<string, unknown> }).shape)
    expect(shape(askTool({ sizesOnSheet: true }))).toContain('sizes')
    expect(shape(askTool())).not.toContain('sizes')
  })

  it('the prompt says when to mark a question sizes', () => {
    expect(systemPrompt('full')).toContain("Set sizes true on a pilot.ask that asks for the part's own sizes, never on one about the person's own things.")
  })

  it('a question marked sizes redirects without a failed step or a move to the larger model', async () => {
    const steps: ScriptStep[] = [{ calls: [SIZE_CARD] }, { calls: [card('How big should the case be?', true)] }, { text: 'Here is the sheet.' }]
    const client = createScriptedClient(steps, { chunk: false })
    const config = { ...DEFAULT_CONFIG, models: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, billing: 'key' as const, auto: true }
    const p = createPilot({ host, config, policy: DEFAULT_POLICY, client, builtins: false, tools: [askTool({ sizesOnSheet: true })] })
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Make me a Raspberry Pi 5 case. Ask me for sizes.')) events.push(e)
    expect(events.some((e) => e.type === 'ask')).toBe(false)
    expect(events.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, true])
    expect(events.some((e) => e.type === 'model_switch')).toBe(false)
    expect(new Set(client.requests.filter((q) => !q.webSearch).map((q) => q.model))).toEqual(new Set(['claude-haiku-5-5']))
  })
})
