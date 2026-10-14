// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The part card: a reply that made a part shows it as a card built from the tool's own result, and the next steps
// for it sit under the reply once it has finished, each sending its request as if typed. Without part handlers the
// call stays a tool row.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createdPart, followUps, partLine, partTitle, PartLookContext, Terminal, TranscriptView, type PartLook } from '../ui/index'
import { emptyTranscript, foldEvents, startTurn } from '../ui/reduce'

afterEach(cleanup)

const OUTPUT = { objectId: '20-mm-cube', name: '20 mm cube', kind: 'cube', sizeMm: [20, 20, 20], volumeCm3: 8 }

function reply(done = true, output: unknown = OUTPUT) {
  const events: PilotEvent[] = [
    { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-10-14T00:00:00Z' },
    { type: 'text', delta: 'A 20 mm cube is easy. I put one on the grid at the origin.' },
    { type: 'tool_call', callId: 'c1', tool: 'text_to_part', source: 'skill', input: {}, args: '"20 mm cube"' },
    { type: 'tool_result', callId: 'c1', ok: true, summary: 'Added 20 mm cube, 20 x 20 x 20 mm, 8 cm3', output },
    { type: 'text', delta: 'Want rounded edges, or a hole through it?' },
    ...(done ? [{ type: 'done', stopReason: 'end', ms: 900 } as const] : []),
  ]
  return foldEvents(events, startTurn(emptyTranscript(), { user: 'a 20 mm cube' }, 0), 0)
}

const handlers = () => ({ onEdit: vi.fn(), onSelect: vi.fn(), onRun: vi.fn() })
const approvals = { onApprove: async () => undefined, onCancel: async () => undefined }

describe('the part a reply made', () => {
  it('reads the part from the tool result', () => {
    const t = reply()
    const block = t.turns[0]!.blocks.find((b) => b.kind === 'tools')
    const part = block?.kind === 'tools' ? createdPart(block.rows[0]!) : null
    expect(part).toEqual({ id: '20-mm-cube', name: '20 mm cube', kind: 'cube', sizeMm: [20, 20, 20] })
    expect(partTitle(part!)).toBe('Cube created')
    expect(partLine(part!)).toBe('Cube 20 x 20 x 20 mm')
    expect(followUps(part!).map((f) => f.label)).toEqual(['Fillet edges', 'Center hole', 'Change size'])
  })

  it('shows a card with Edit, then the question and the next steps under it', () => {
    const h = handlers()
    render(<TranscriptView transcript={reply()} showThinking={false} approvals={approvals} parts={h} />)
    const card = screen.getByTestId('mimir-part')
    expect(card.textContent).toContain('Cube created')
    expect(card.textContent).toContain('Cube 20 x 20 x 20 mm')
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    expect(h.onEdit).toHaveBeenCalledWith('20-mm-cube')
    // the card sits between the reply's two lines, the chips after the question
    const order = Array.from(document.querySelectorAll('.say, .part-card, .follow')).map((e) => e.className.split(' ')[0])
    expect(order).toEqual(['say', 'part-card', 'say', 'follow'])
    fireEvent.click(screen.getByRole('button', { name: 'Fillet edges' }))
    expect(h.onRun).toHaveBeenCalledWith('Fillet the edges of the cube by 2 mm')
  })

  it('offers no next steps while the reply is still running', () => {
    render(<TranscriptView transcript={reply(false)} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByTestId('mimir-part')).toBeTruthy()
    expect(screen.queryAllByTestId('mimir-follow')).toHaveLength(0)
  })

  it('keeps the tool row without part handlers, or when the result names no part', () => {
    render(<TranscriptView transcript={reply()} showThinking={false} approvals={approvals} />)
    expect(screen.queryByTestId('mimir-part')).toBeNull()
    cleanup()
    render(<TranscriptView transcript={reply(true, { sizeMm: [1, 2, 3] })} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.queryByTestId('mimir-part')).toBeNull()
  })

  it('shows Select too, and the size on one line, in those looks', () => {
    const look: PartLook = { icon: 'top', actions: 'edit-select', lines: 1, chips: 'reply' }
    const h = handlers()
    render(
      <PartLookContext.Provider value={look}>
        <TranscriptView transcript={reply()} showThinking={false} approvals={approvals} parts={h} />
      </PartLookContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(h.onSelect).toHaveBeenCalledWith('20-mm-cube')
    expect(screen.getByTestId('mimir-part').querySelector('.part-sub')?.textContent).toBe('20 x 20 x 20 mm')
  })
})

describe('the prompt row', () => {
  const props = (transcript = emptyTranscript(), parts?: ReturnType<typeof handlers>) => ({
    sessionTitle: 'new',
    transcript,
    running: false,
    replaying: false,
    paused: false,
    showSpeed: false,
    speed: '1' as const,
    onSpeed: () => undefined,
    showThinking: false,
    onShowThinking: () => undefined,
    canReplay: false,
    onReplay: () => undefined,
    onPause: () => undefined,
    onRun: vi.fn(),
    onStop: () => undefined,
    suggestions: [{ id: 'design', label: 'Design a part', onSelect: () => undefined }],
    approvals,
    emptyNote: 'Ask',
    announcement: '',
    ...(parts ? { parts } : {}),
  })

  it('shows the starters only while the thread is empty', () => {
    render(<Terminal {...props(emptyTranscript(), handlers())} />)
    expect(screen.getByRole('button', { name: 'Design a part' })).toBeTruthy()
    cleanup()
    render(<Terminal {...props(reply(), handlers())} />)
    expect(screen.queryByRole('button', { name: 'Design a part' })).toBeNull()
  })

  it('puts the next steps in the prompt row in that look, sending the request', () => {
    const p = props(reply(), handlers())
    render(
      <PartLookContext.Provider value={{ icon: 'left', actions: 'edit', lines: 2, chips: 'prompt' }}>
        <Terminal {...p} />
      </PartLookContext.Provider>,
    )
    const row = screen.getByRole('group', { name: 'Next steps' })
    expect(row.closest('form')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Center hole' }))
    expect(p.onRun).toHaveBeenCalledWith('Add a hole through the center of the cube')
  })
})
