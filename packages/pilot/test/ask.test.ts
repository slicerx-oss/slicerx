// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.ask waits for the person's pick and hands it back to the run; a dismissed question hands back that it was turned
// down, and words written in place of a pick hand back the person's answer (no choice turned down); the run carries on. lookup.show puts a record in the run as a
// lookup event. A pilot made without built-ins exposes only the tools it was given.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { ASK_SAID_MAX, askTool, createPilot, createScriptedClient, DEFAULT_CONFIG, lookupTool, wasDismissed, type ScriptStep } from '../src/index'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

function pilot(steps: ScriptStep[], config = DEFAULT_CONFIG) {
  return createPilot({ host, config, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [askTool(), lookupTool()] })
}

/** Runs one message, answering each question with `answer`; returns the events and what each later step read last. */
async function runWith(p: ReturnType<typeof pilot>, answer: (askId: string) => Promise<void>): Promise<{ events: PilotEvent[]; errors: unknown[] }> {
  const events: PilotEvent[] = []
  const errors: unknown[] = []
  for await (const e of p.run('s', 'Hello')) {
    events.push(e)
    if (e.type === 'ask') answer(e.askId).catch((x: unknown) => errors.push(x))
  }
  return { events, errors }
}

/** A step that keeps what the model read last (the tool result's ok and result) and replies. */
function reader(seen: unknown[], text = 'Okay.'): ScriptStep {
  return (messages) => {
    const last = messages.at(-1)
    const read = last?.role === 'tool' ? (JSON.parse(last.content) as { ok: boolean; result: unknown }) : null
    seen.push(read ? { ok: read.ok, result: read.result } : null)
    return { text }
  }
}

const ASK = { name: 'pilot.ask', args: { title: 'Confirm model', question: 'Is this the one?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }] } }

describe('pilot.ask', () => {
  it('tells the model a dismissed question stays turned down: no re-ask, no choices or question in prose, only a narrower question', () => {
    const d = askTool().description
    expect(d).toContain('every choice on it is turned down')
    expect(d).toContain('do not list its choices or repeat its question in your reply, in any wording')
    expect(d).toContain('ask a different, narrower question')
    expect(d).not.toContain('or reply in text')
  })

  it('tells the model words written in place of a pick are the answer: go on from them, never ask the same thing again', () => {
    for (const d of [askTool().description, askTool().localDescription ?? '']) {
      expect(d).toContain('said')
      expect(d).toContain('their words are the answer')
      expect(d).toContain('turn no choice down')
      expect(d).toContain('never ask the same thing again')
      expect(d).toContain('pick the choice that gives what the request asked for')
    }
  })

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

  it('a dismiss hands the model a dismissed result and the run ends as any run does', async () => {
    const seen: unknown[] = []
    const p = pilot([{ calls: [ASK] }, reader(seen, 'I will leave it.')])
    const { events } = await runWith(p, (id) => p.answer!(id, null))
    expect(seen[0]).toEqual({ ok: true, result: { picked: null, dismissed: true } })
    expect(events.find((e) => e.type === 'ask_answered')).toEqual({ type: 'ask_answered', askId: expect.stringMatching(/^ask_/), choiceId: '', dismissed: true })
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, summary: 'Dismissed' })
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
    expect(events.some((e) => e.type === 'error' || (e.type === 'tool_result' && /Run canceled/.test(e.summary)))).toBe(false)
    expect(events.some((e) => e.type === 'text' && e.delta === 'I will leave it.')).toBe(true)
    expect(wasDismissed((events.find((e) => e.type === 'ask_answered') as { choiceId: string }).choiceId)).toBe(true)
  })

  it("words written in place of a pick reach the model as the person's answer, trimmed and kept to the limit, never as a turn-down", async () => {
    const cases: [string, string | undefined][] = [
      ['  it is a different model \n', 'it is a different model'],
      ['x'.repeat(ASK_SAID_MAX + 50), 'x'.repeat(ASK_SAID_MAX)],
      ['   ', undefined],
    ]
    for (const [said, kept] of cases) {
      const seen: unknown[] = []
      const p = pilot([{ calls: [ASK] }, reader(seen)])
      const { events } = await runWith(p, (id) => p.answer!(id, null, said))
      const answered = events.find((e) => e.type === 'ask_answered')
      if (kept === undefined) {
        expect(seen[0]).toEqual({ ok: true, result: { picked: null, dismissed: true } })
        expect(answered).not.toHaveProperty('said')
      } else {
        // the card closes as set aside, but the model reads an answer in words: no choice on it is turned down
        expect(seen[0]).toEqual({ ok: true, result: { picked: null, said: kept } })
        expect(answered).toMatchObject({ choiceId: '', dismissed: true, said: kept })
        expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, summary: `Answered in words: "${kept}"` })
      }
    }
  })

  it('words sent with a pick are dropped: the pick is the whole answer', async () => {
    const seen: unknown[] = []
    const p = pilot([{ calls: [ASK] }, reader(seen)])
    const { events } = await runWith(p, (id) => p.answer!(id, 'same', 'and more'))
    expect(seen[0]).toEqual({ ok: true, result: { picked: 'same', label: 'Yes' } })
    expect(events.find((e) => e.type === 'ask_answered')).toEqual({ type: 'ask_answered', askId: expect.any(String), choiceId: 'same' })
  })

  it('dismissing is not a failure, so three dismisses never move Auto to the larger model', async () => {
    const auto = { ...DEFAULT_CONFIG, models: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, billing: 'key' as const, auto: true }
    const p = pilot([{ calls: [ASK] }, { calls: [ASK] }, { calls: [ASK] }, { text: 'Okay, no questions then.' }], auto)
    const { events } = await runWith(p, (id) => p.answer!(id, null))
    expect(events.filter((e) => e.type === 'ask_answered')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'tool_result').every((e) => (e as { ok: boolean }).ok)).toBe(true)
    expect(events.some((e) => e.type === 'model_switch')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('a second dismiss of the same question is refused', async () => {
    const p = pilot([{ calls: [ASK] }, { text: 'Okay.' }])
    const { errors } = await runWith(p, async (id) => {
      await p.answer!(id, null)
      await p.answer!(id, null)
    })
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/No open question/)
  })

  it('a dismiss after the run was canceled is refused, and no tool result comes back', async () => {
    const p = pilot([{ calls: [ASK] }, { text: 'never' }])
    const ac = new AbortController()
    const events: PilotEvent[] = []
    let askId = ''
    for await (const e of p.run('s', 'Hello', { signal: ac.signal })) {
      events.push(e)
      if (e.type === 'ask') {
        askId = e.askId
        ac.abort()
      }
    }
    await expect(p.answer!(askId, null)).rejects.toThrow(/No open question/)
    expect(events.some((e) => e.type === 'ask_answered')).toBe(false)
    expect(events.some((e) => e.type === 'tool_result' && e.ok)).toBe(false)
  })

  it("refuses a choice id the question never offered, and the question stays open for a real answer", async () => {
    const seen: unknown[] = []
    const p = pilot([{ calls: [ASK] }, reader(seen)])
    const refused: unknown[] = []
    const { events } = await runWith(p, async (id) => {
      for (const bad of ['maybe', '', 'SAME']) await p.answer!(id, bad).catch((x: unknown) => refused.push(x))
      await p.answer!(id, 'same')
    })
    expect(refused).toHaveLength(3)
    for (const r of refused) expect(String(r)).toMatch(/Not one of this question's answers/)
    expect(events.filter((e) => e.type === 'ask_answered')).toHaveLength(1)
    expect(seen[0]).toEqual({ ok: true, result: { picked: 'same', label: 'Yes' } })
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

  it.each(['not a url', 'javascript:alert(1)', 'file:///etc/hosts'])('refuses a source that is not a web link: %s', async (url) => {
    const p = pilot([{ calls: [{ name: 'lookup.show', args: { title: 'Reference', fields: [['a', 'b']], source: { title: 'x', url } } }] }])
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
