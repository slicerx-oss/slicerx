// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's conversations over the app link: the sessions newest first, and one session turn by turn, with what the
// person said, what mimir said and the tools it ran; long text is cut, and an unknown session is refused.
import type { PilotEvent } from '@slicerx/contracts'
import { createMemorySessionStore } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkError, runCall } from '../src/app-link/methods'
import { setSessionSource } from '../src/app-link/sessions'

const start = (sessionId: string, at: string): PilotEvent => ({ type: 'start', runId: `r${at}`, sessionId, provider: 'scripted', model: 'scripted', at })

async function store() {
  const s = createMemorySessionStore()
  const add = (id: string, events: PilotEvent[]) => Promise.all(events.map((e) => s.append(id, e)))
  await add('mimir_a', [
    start('mimir_a', '2026-10-12T10:00:00Z'),
    { type: 'text', delta: 'I will draw the outline.' },
    { type: 'text_done' },
    { type: 'tool_call', callId: 'c1', tool: 'geom.extrude', source: 'command', input: { distance_mm: 3 } },
    { type: 'tool_result', callId: 'c1', ok: true, summary: 'Extruded: step 1, Extrude' },
    { type: 'done', stopReason: 'end', ms: 10 },
    start('mimir_a', '2026-10-12T10:01:00Z'),
    { type: 'text', delta: 'x'.repeat(5000) },
    { type: 'tool_call', callId: 'c2', tool: 'geom.fillet', source: 'command', input: {} },
    { type: 'tool_result', callId: 'c2', ok: false, summary: 'No edge there' },
    { type: 'done', stopReason: 'end', ms: 5 },
  ])
  await add('mimir_b', [start('mimir_b', '2026-10-12T11:00:00Z'), { type: 'text', delta: 'Hi' }, { type: 'done', stopReason: 'end', ms: 1 }])
  return s
}

afterEach(() => setSessionSource(null))

describe('mimir sessions over the app link', () => {
  it('are empty until the chat registers its log', async () => {
    expect(await runCall('mimir.sessions', {})).toEqual({ sessions: [] })
    expect(((await runCall('mimir.session', { id: 'mimir_a' }).catch((e: unknown) => e)) as LinkError).code).toBe('not_found')
  })

  it('list newest first', async () => {
    setSessionSource({ store: await store() })
    const out = (await runCall('mimir.sessions', {})) as { sessions: { id: string }[] }
    expect(out.sessions.map((s) => s.id)).toEqual(['mimir_b', 'mimir_a'])
  })

  it('read one turn by turn: what was said and the tools mimir ran', async () => {
    setSessionSource({ store: await store(), messages: (id) => (id === 'mimir_a' ? [{ text: 'A wall mount', attachments: ['thermostat.jpg'] }, { text: 'Round the edges' }].map((m) => ({ attachments: [], ...m })) : []) })
    const out = (await runCall('mimir.session', { id: 'mimir_a' })) as { turns: { said?: string; attachments?: string[]; steps: Record<string, unknown>[] }[] }
    expect(out.turns).toHaveLength(2)
    expect(out.turns[0]).toEqual({
      said: 'A wall mount',
      attachments: ['thermostat.jpg'],
      steps: [
        { kind: 'said', text: 'I will draw the outline.' },
        { kind: 'tool', tool: 'geom.extrude', state: 'ok', summary: 'Extruded: step 1, Extrude' },
      ],
    })
    const second = out.turns[1]!
    expect(second.said).toBe('Round the edges')
    expect((second.steps[0]!['text'] as string).length).toBeLessThan(4_100)
    expect(second.steps[1]).toMatchObject({ kind: 'tool', tool: 'geom.fillet', state: 'bad', summary: 'No edge there' })
  })

  it('refuse a missing or odd id', async () => {
    setSessionSource({ store: await store() })
    for (const id of [undefined, '', 5, 'mimir_nope', 'x'.repeat(201)]) {
      const e = await runCall('mimir.session', { id }).catch((x: unknown) => x)
      expect(e, String(id)).toBeInstanceOf(LinkError)
    }
  })
})
