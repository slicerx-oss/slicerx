// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { TranscriptView } from '../ui/index'
import { emptyTranscript, reduceTranscript, startTurn } from '../ui/reduce'

afterEach(cleanup)

const PLUGINS: PilotEvent[] = [
  { type: 'plugins', plugins: [{ id: 'spoolman', name: 'Spoolman', state: 'loading', tools: 2 }, { id: 'moonraker', name: 'Moonraker', state: 'loading', tools: 3 }] },
  { type: 'plugins', plugins: [{ id: 'spoolman', name: 'Spoolman', state: 'ready', tools: 2 }, { id: 'moonraker', name: 'Moonraker', state: 'off', tools: 3 }] },
]

function view(events: PilotEvent[]) {
  let s = startTurn(emptyTranscript(), { user: 'Which PETG is loaded?' }, 0)
  for (const e of events) s = reduceTranscript(s, e, 0)
  return render(<TranscriptView transcript={s} showThinking={false} approvals={{ onApprove: async () => {}, onCancel: async () => {} }} />).container
}

describe('integrations in a reply', () => {
  it('a reply that used no integration shows no plugin text', () => {
    const el = view([...PLUGINS, { type: 'text', delta: 'Slot 2 has PETG.' }, { type: 'text_done' }])
    expect(el.textContent).not.toMatch(/plugin|Spoolman|Moonraker/i)
    expect(el.querySelector('.used-pill')).toBeNull()
  })

  it('a reply that used one shows one tick pill naming it', () => {
    const el = view([
      ...PLUGINS,
      { type: 'tool_call', callId: 'c1', tool: 'spoolman.check', source: 'plugin', input: {}, args: '--material PETG' },
      { type: 'tool_result', callId: 'c1', ok: true, summary: '3 PETG spools' },
      { type: 'tool_call', callId: 'c2', tool: 'spoolman.list', source: 'plugin', input: {} },
      // the built-in printer tools go through the printer plugins but are not an integration of their own
      { type: 'tool_call', callId: 'c3', tool: 'printer.list', source: 'plugin', input: {} },
      { type: 'text', delta: 'Slot 2 has PETG.' },
      { type: 'text_done' },
    ])
    const pills = el.querySelectorAll('.used-pill')
    expect(pills).toHaveLength(1)
    expect(pills[0]?.textContent).toBe('Spoolman')
    expect(el.textContent).not.toContain('Moonraker')
  })
})
