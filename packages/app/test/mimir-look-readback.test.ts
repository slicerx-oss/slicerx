// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The picture mimir looks at on a vague follow-up is never a silent step: the tab shows "Looked at the model", and the
// conversation an MCP client or the bridge reads over the app link has the same row.
import type { PilotEvent, SessionStore } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { readSession, setSessionSource } from '../src/app-link/sessions'
import { stepWords } from '../src/workspaces/mimir/step-words'

describe('design.look in the conversation', () => {
  const events = [
    { type: 'start', sessionId: 's_look', model: 'claude-sonnet-5-5' },
    { type: 'tool_call', callId: 'c1', tool: 'design.look', source: 'command', input: { design: 'obj_1' } },
    { type: 'tool_result', callId: 'c1', ok: true, summary: 'Looked at the model' },
    { type: 'text', delta: 'Beveled the seat edges.' },
    { type: 'done', stopReason: 'end' },
  ] as unknown as PilotEvent[]
  const store = { list: async () => [{ id: 's_look', title: 'Toy car', status: 'done', startedAt: '2026-11-11T00:00:00Z' }], read: async () => events } as unknown as SessionStore

  it('reads back as a step an MCP client sees', async () => {
    setSessionSource({ store, messages: () => [{ text: 'add bevels', attachments: [] }] })
    try {
      const read = (await readSession({ id: 's_look' })) as { turns: { steps: { kind: string; tool?: string; summary?: string }[] }[] }
      expect(read.turns.at(-1)!.steps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', tool: 'design.look', summary: 'Looked at the model' })]))
    } finally {
      setSessionSource(null)
    }
  })

  it('shows in the tab as one plain line', () => {
    expect(stepWords({ tool: 'design.look', state: 'ok', summary: 'Looked at the model' } as never)).toMatchObject({ done: 'Looked at the model' })
  })
})
