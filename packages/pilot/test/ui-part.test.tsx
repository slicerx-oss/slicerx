// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The part card: a reply that made a part shows it as a card built from the tool's own result, and the next steps
// for it sit under that reply once it has finished, bound to that part: an immediate step names its value and sends,
// the size step asks for the size first, and a step for a part that is gone says so. Without part handlers the call
// stays a tool row.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createdPart, followUps, partLine, partTitle, sizeRequest, Terminal, TranscriptView } from '../ui/index'
import { emptyTranscript, foldEvents, startTurn } from '../ui/reduce'

afterEach(cleanup)

const OUTPUT = { objectId: '20-mm-cube', name: '20 mm cube', kind: 'cube', sizeMm: [20, 20, 20], volumeCm3: 8 }

function events(done: boolean, output: unknown, said = 'Created a 20 mm cube at the origin.', call = 'c1'): PilotEvent[] {
  return [
    { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-10-14T00:00:00Z' },
    { type: 'text', delta: said },
    { type: 'permission_note', permission: 'slice', mode: 'allow', tool: 'text_to_part', message: 'Slice and arrange is set to Allow in Permissions, so mimir continued without asking.' },
    { type: 'tool_call', callId: call, tool: 'text_to_part', source: 'skill', input: {}, args: '"20 mm cube"' },
    { type: 'tool_result', callId: call, ok: true, summary: 'Added 20 mm cube, 20 x 20 x 20 mm, 8 cm3', output },
    { type: 'text', delta: 'Want rounded edges, or a hole through it?' },
    ...(done ? [{ type: 'done', stopReason: 'end', ms: 900 } as const] : []),
  ]
}

function reply(done = true, output: unknown = OUTPUT) {
  return foldEvents(events(done, output), startTurn(emptyTranscript(), { user: 'a 20 mm cube' }, 0), 0)
}

/** Two replies, each making its own cube. */
function twoCubes() {
  const first = reply()
  const small = { objectId: '10-mm-cube', name: '10 mm cube', kind: 'cube', sizeMm: [10, 10, 10] }
  return foldEvents(events(true, small, 'Created a 10 mm cube.', 'c2'), startTurn(first, { user: 'a 10 mm cube' }, 1), 1)
}

const handlers = (gone: string[] = []) => ({ onEdit: vi.fn(), onSelect: vi.fn(), onRun: vi.fn(), has: (id: string) => !gone.includes(id) })
const approvals = { onApprove: async () => undefined, onCancel: async () => undefined }

describe('the part a reply made', () => {
  it('reads the part from the tool result, and names each immediate step with its value', () => {
    const t = reply()
    const block = t.turns[0]!.blocks.find((b) => b.kind === 'tools')
    const part = block?.kind === 'tools' ? createdPart(block.rows[0]!) : null
    expect(part).toEqual({ id: '20-mm-cube', name: '20 mm cube', kind: 'cube', sizeMm: [20, 20, 20] })
    expect(partTitle(part!)).toBe('Cube created')
    expect(partLine(part!)).toBe('Cube 20 x 20 x 20 mm')
    const steps = followUps(part!)
    expect(steps.map((f) => f.label)).toEqual(['Fillet edges, 2 mm', 'Center hole, 5 mm', 'Change size'])
    expect(steps.map((f) => f.request)).toEqual(['Fillet the edges of the 20 mm cube by 2 mm', 'Add a 5 mm hole through the center of the 20 mm cube', undefined])
    expect(sizeRequest(part!, [30, 20, 20])).toBe('Change the size of the 20 mm cube to 30 x 20 x 20 mm')
  })

  it('shows a card, then the question and the next steps; the body selects, Edit opens the editor', () => {
    const h = handlers()
    render(<TranscriptView transcript={reply()} showThinking={false} approvals={approvals} parts={h} />)
    const card = screen.getByTestId('mimir-part')
    expect(card.textContent).toContain('Cube created')
    expect(card.textContent).toContain('Cube 20 x 20 x 20 mm')
    fireEvent.click(within(card).getByRole('button', { name: 'Edit the 20 mm cube' }))
    expect(h.onEdit).toHaveBeenCalledWith('20-mm-cube')
    expect(h.onSelect).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: 'Select the 20 mm cube' }))
    expect(h.onSelect).toHaveBeenCalledWith('20-mm-cube')
    // the card sits between the reply's two lines, the chips after the question
    const order = Array.from(document.querySelectorAll('.say, .part-card, .follow')).map((e) => e.className.split(' ')[0])
    expect(order).toEqual(['say', 'part-card', 'say', 'follow'])
    fireEvent.click(screen.getByRole('button', { name: 'Fillet edges, 2 mm' }))
    expect(h.onRun).toHaveBeenCalledWith('Fillet the edges of the 20 mm cube by 2 mm', '20-mm-cube')
  })

  it('drops the permission line when the card shows, and keeps it as a plain row', () => {
    render(<TranscriptView transcript={reply()} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(document.body.textContent).not.toContain('set to Allow in Permissions')
    cleanup()
    render(<TranscriptView transcript={reply()} showThinking={false} approvals={approvals} />)
    expect(document.body.textContent).toContain('set to Allow in Permissions')
  })

  it('asks for the new size before anything is sent', () => {
    const h = handlers()
    render(<TranscriptView transcript={reply()} showThinking={false} approvals={approvals} parts={h} />)
    const chip = screen.getByRole('button', { name: 'Change size' })
    fireEvent.click(chip)
    expect(h.onRun).not.toHaveBeenCalled()
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    const x = screen.getByRole('textbox', { name: /New size of the 20 mm cube X/ })
    fireEvent.change(x, { target: { value: '30' } })
    fireEvent.keyDown(x, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Resize' }))
    expect(h.onRun).toHaveBeenCalledWith('Change the size of the 20 mm cube to 30 x 20 x 20 mm', '20-mm-cube')
    expect(screen.queryByRole('button', { name: 'Resize' })).toBeNull()
  })

  it('binds each reply\'s steps to the part that reply made', () => {
    const h = handlers()
    render(<TranscriptView transcript={twoCubes()} showThinking={false} approvals={approvals} parts={h} />)
    const groups = screen.getAllByRole('group', { name: 'Next steps' })
    expect(groups).toHaveLength(2)
    // the step under the older reply targets the older cube, not the newest or the selection
    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'Fillet edges, 2 mm' }))
    expect(h.onRun).toHaveBeenLastCalledWith('Fillet the edges of the 20 mm cube by 2 mm', '20-mm-cube')
    fireEvent.click(within(groups[1]!).getByRole('button', { name: /^Fillet edges/ }))
    expect(h.onRun).toHaveBeenLastCalledWith('Fillet the edges of the 10 mm cube by 1.5 mm', '10-mm-cube')
  })

  it('says the part is gone instead of acting on whatever is selected', () => {
    const h = handlers(['20-mm-cube'])
    render(<TranscriptView transcript={twoCubes()} showThinking={false} approvals={approvals} parts={h} />)
    const older = screen.getAllByRole('group', { name: 'Next steps' })[0]!
    fireEvent.click(within(older).getByRole('button', { name: 'Fillet edges, 2 mm' }))
    expect(h.onRun).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('The 20 mm cube is no longer in the project, so this step has nothing to change.')
    // the card's Edit says the same and opens nothing
    fireEvent.click(screen.getByRole('button', { name: 'Edit the 20 mm cube' }))
    expect(h.onEdit).not.toHaveBeenCalled()
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

  it('says "Ask mimir", and shows the starters only while the thread is empty', () => {
    render(<Terminal {...props(emptyTranscript(), handlers())} />)
    expect(screen.getByRole('textbox', { name: 'Ask mimir' }).getAttribute('placeholder')).toBe('Ask mimir')
    expect(screen.getByRole('button', { name: 'Design a part' })).toBeTruthy()
    cleanup()
    render(<Terminal {...props(reply(), handlers())} />)
    expect(screen.queryByRole('button', { name: 'Design a part' })).toBeNull()
  })

  it('a step selects its own part, then sends its request', () => {
    const h = handlers()
    const p = props(twoCubes(), h)
    render(<Terminal {...p} />)
    fireEvent.click(within(screen.getAllByRole('group', { name: 'Next steps' })[0]!).getByRole('button', { name: 'Center hole, 5 mm' }))
    expect(h.onSelect).toHaveBeenCalledWith('20-mm-cube')
    expect(p.onRun).toHaveBeenCalledWith('Add a 5 mm hole through the center of the 20 mm cube')
  })
})
