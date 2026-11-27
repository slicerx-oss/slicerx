// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A live reply cut off at the output limit with nothing said leaves no text or call, but the runtime still answers it:
// it asks again, and once the run has been cut it goes on from a reply that leaves its design empty. The recording keeps
// that reply as a cut step, so the replay is cut at the same point and follows the live run to its end.
import { createScriptedClient, isRuntimeNote, type LlmClient, type LlmEvent } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { parseRecording } from '../evals/creative/recordings'
import { keptStep, recordEvent, type RecordedStep } from '../evals/creative/replay-divergence'
import { runPrompt } from '../evals/creative/run'

const P = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!

type Reply = LlmEvent[]
const CUT: Reply = [{ type: 'reasoning', delta: 'a long plan '.repeat(20) }, { type: 'done', stop: 'length' }]
const START: Reply = [{ type: 'tool_call', call: { id: 'c1', name: 'design.new', arguments: JSON.stringify({ name: 'Organizer' }) } }, { type: 'done', stop: 'tool_calls' }]
const NARRATE: Reply = [{ type: 'text', delta: 'I started the design. Next I will plan the base and the slots.' }, { type: 'done', stop: 'end' }]
const DONE: Reply = [{ type: 'text', delta: 'Planned it; nothing more to build here.' }, { type: 'done', stop: 'end' }]

/** A live model as the provider streams it: each request gets the next reply's events. */
function live(replies: Reply[]): LlmClient & { notes: string[] } {
  let i = 0
  const c = {
    provider: 'anthropic',
    // the runtime's own notes, each as the user turn a request ends on
    notes: [] as string[],
    async *stream(req: { messages: { role: string; content?: unknown }[] }) {
      const last = req.messages.at(-1)
      if (last?.role === 'user' && typeof last.content === 'string' && isRuntimeNote(last.content)) c.notes.push(last.content)
      for (const ev of replies[i++] ?? [{ type: 'done', stop: 'end' } as LlmEvent]) yield ev
    },
  }
  return c as unknown as LlmClient & { notes: string[] }
}

describe('a reply cut off at the output limit replays as cut', () => {
  it('records the cut reply and its stop', () => {
    const step: RecordedStep = {}
    for (const ev of CUT) recordEvent(step, ev)
    expect(step).toEqual({ cut: true })
    expect(keptStep({}, step)).toBe(true)
    expect(keptStep({}, {})).toBe(false)
    expect(keptStep({ webSearch: true }, { text: 'x' })).toBe(false)
  })

  it('replays a live run that went on after a cut to its end', async () => {
    const model = live([CUT, START, NARRATE, DONE])
    const run = await runPrompt(P, { geom: undefined, client: model, defaultAnswer: false })
    // the runtime asked again after the cut, then went on once from the narrated reply
    expect(model.notes).toHaveLength(2)
    expect(model.notes[1]).toMatch(/^Your reply above stopped before anything was built/)
    expect(run.steps).toHaveLength(4)
    expect(run.steps[0]).toEqual({ cut: true })
    const replay = await runPrompt(P, { geom: undefined, steps: run.steps, tabTools: true, defaultAnswer: false })
    expect(replay.error).toBeUndefined()
    expect(replay.reply).toContain('nothing more to build')
  })

  it('stops a replay early when the cut step is left out, as recordings from before it did', async () => {
    const model = live([CUT, START, NARRATE, DONE])
    const run = await runPrompt(P, { geom: undefined, client: model, defaultAnswer: false })
    const replay = await runPrompt(P, { geom: undefined, steps: run.steps.slice(1), tabTools: true, defaultAnswer: false })
    expect(replay.error).toBe('the replay left 1 recorded reply unused')
  })

  it('stops a scripted reply at the output limit when its step is cut', async () => {
    const events: LlmEvent[] = []
    for await (const ev of createScriptedClient([{ cut: true }, { text: 'x' }], { chunk: false }).stream({ messages: [], tools: [] } as never)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: 'done', stop: 'length' })
  })

  it('reads cut from a recording file and refuses one that is not true or false', () => {
    const base = { status: 'recorded', model: 'm', provider: 'p', capturedAt: '2026-11-27T00:00:00Z' }
    const rec = parseRecording(JSON.stringify({ ...base, steps: [{ cut: true }, { text: 'Done.' }] }))
    expect(rec.status === 'recorded' && rec.steps[0]).toEqual({ cut: true })
    expect(() => parseRecording(JSON.stringify({ ...base, steps: [{ cut: 'yes' }] }))).toThrow(/cut must be true or false/)
  })
})
