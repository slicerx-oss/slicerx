// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.ask waits for the person's pick and hands it back to the run; lookup.show puts a record in the run as a
// lookup event. A pilot made without built-ins exposes only the tools it was given.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { askTool, createPilot, createScriptedClient, DEFAULT_CONFIG, lookupTool, type ScriptStep } from '../src/index'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

function pilot(steps: ScriptStep[]) {
  return createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [askTool(), lookupTool()] })
}

const ASK = { name: 'pilot.ask', args: { title: 'Confirm model', question: 'Is this the one?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }] } }

describe('pilot.ask', () => {
  it('waits for the pick and gives it to the next step', async () => {
    const seen: string[] = []
    const p = pilot([
      { calls: [ASK] },
      (messages) => {
        const last = messages.at(-1)
        seen.push(last?.role === 'tool' ? last.content : '')
        return { text: 'Thanks.' }
      },
    ])
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Hello')) {
      events.push(e)
      if (e.type === 'ask') void p.answer!(e.askId, 'other')
    }
    const ask = events.find((e) => e.type === 'ask')
    expect(ask).toMatchObject({ title: 'Confirm model', choices: [{ id: 'same' }, { id: 'other' }] })
    expect(events.find((e) => e.type === 'ask_answered')).toMatchObject({ choiceId: 'other' })
    expect(JSON.parse(seen[0]!)).toMatchObject({ ok: true, result: { picked: 'other', label: 'No' } })
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('refuses an answer to a question nobody asked', async () => {
    await expect(pilot([]).answer!('ask_nope', 'same')).rejects.toThrow(/No open question/)
  })

  it('stops waiting when the run is canceled', async () => {
    const p = pilot([{ calls: [ASK] }, { text: 'never' }])
    const ac = new AbortController()
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Hello', { signal: ac.signal })) {
      events.push(e)
      if (e.type === 'ask') ac.abort()
    }
    expect(events.some((e) => e.type === 'ask_answered')).toBe(false)
    expect(events.some((e) => e.type === 'text' && e.delta === 'never')).toBe(false)
  })
})

describe('lookup.show', () => {
  it('becomes a lookup event with its fields and source', async () => {
    const p = pilot([{ calls: [{ name: 'lookup.show', args: { title: 'Reference found', fields: [['Trim plate', '150.4 x 110.4 mm']], source: { title: 'Spec sheet', url: 'https://example.com/specs' } } }] }])
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Hello')) events.push(e)
    const lookup = events.find((e) => e.type === 'lookup')
    expect(lookup).toMatchObject({ lookup: { title: 'Reference found', fields: [['Trim plate', '150.4 x 110.4 mm']], source: { url: 'https://example.com/specs' } } })
  })

  it('refuses a source that is not a link', async () => {
    const p = pilot([{ calls: [{ name: 'lookup.show', args: { title: 'Reference', fields: [['a', 'b']], source: { title: 'x', url: 'not a url' } } }] }])
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Hello')) events.push(e)
    expect(events.some((e) => e.type === 'lookup')).toBe(false)
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false })
  })
})

describe('a pilot without built-ins', () => {
  it('offers only its own tools, and none that reaches a printer', () => {
    const names = pilot([]).tools().map((t) => t.name)
    expect(names.sort()).toEqual(['lookup.show', 'pilot.ask'])
  })
})
