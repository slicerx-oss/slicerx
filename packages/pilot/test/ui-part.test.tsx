// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The part card: a reply that made a part shows it as a card built from the tool's own result, and the next steps
// for it sit under that reply once it has finished, bound to that part: an immediate step names its value and sends,
// the size step asks for the size first, and a step for a part that is gone says so. Without part handlers the call
// stays a tool row. A design built step by step keeps its step rows and gets one card after them, for the design as
// its newest step left it: "Part created" when the turn started it, "<name> updated" when it changed one, and no card
// when an undo left it empty.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { builtPart, createdPart, followUps, partLine, partTitle, sizeRequest, Terminal, TranscriptView } from '../ui/index'
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

// a toolset with the design tools, so every next step can be done
const ALL = () => true
const handlers = (gone: string[] = []) => ({ onEdit: vi.fn(), onSelect: vi.fn(), onRun: vi.fn(), has: (id: string) => !gone.includes(id), can: ALL })
const approvals = { onApprove: async () => undefined, onCancel: async () => undefined }

describe('the part a reply made', () => {
  it('reads the part from the tool result, and names each immediate step with its value', () => {
    const t = reply()
    const block = t.turns[0]!.blocks.find((b) => b.kind === 'tools')
    const part = block?.kind === 'tools' ? createdPart(block.rows[0]!) : null
    expect(part).toEqual({ id: '20-mm-cube', name: '20 mm cube', kind: 'cube', sizeMm: [20, 20, 20] })
    expect(partTitle(part!)).toBe('Cube created')
    expect(partLine(part!)).toBe('Cube 20 x 20 x 20 mm')
    const steps = followUps(part!, ALL)
    expect(steps.map((f) => f.label)).toEqual(['Fillet edges, 2 mm', 'Center hole, 5 mm', 'Change size'])
    expect(steps.map((f) => f.request)).toEqual(['Fillet the edges of the 20 mm cube by 2 mm', 'Add a 5 mm hole through the center of the 20 mm cube', undefined])
    expect(sizeRequest(part!, [30, 20, 20])).toBe('Change the size of the 20 mm cube to 30 x 20 x 20 mm')
  })

  it('offers only the next steps the toolset can do', () => {
    const t = reply()
    const block = t.turns[0]!.blocks.find((b) => b.kind === 'tools')
    const part = block?.kind === 'tools' ? createdPart(block.rows[0]!) : null
    // the part generator alone cannot fillet or drill a part it made, only make it again at another size
    expect(followUps(part!, (n) => n === 'text_to_part').map((f) => f.id)).toEqual(['size'])
    expect(followUps(part!, (n) => n === 'geom.fillet' || n === 'design.new').map((f) => f.id)).toEqual(['fillet', 'size'])
    // without a toolset to ask, nothing is offered
    expect(followUps(part!)).toEqual([])
    render(<TranscriptView transcript={reply()} showThinking={false} approvals={approvals} parts={{ ...handlers(), can: undefined }} />)
    expect(screen.getByTestId('mimir-part')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Next steps' })).toBeNull()
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

/** The design summary a design step returns, as the design tools give it. */
const summary = (sizeMm: number[] | null, steps: number) => ({
  design: 'box-with-lid',
  name: 'Box with lid',
  exact: true,
  steps,
  ...(sizeMm ? { minMm: [0, 0, 0], sizeMm, parts: [{ index: 0, name: 'Box', sizeMm }] } : { parts: [] }),
  volumeMm3: 1,
})

/** A box with a lid built in four extrudes after design.new, as the tab's script builds it; `last` adds one more call. */
function boxWithLid(opts: { done?: boolean; last?: { tool: string; ok: boolean } } = {}): ReturnType<typeof reply> {
  const steps: [string, string, unknown][] = [
    ['design.new', 'Started Box with lid (box-with-lid)', summary(null, 0)],
    ['geom.extrude', 'Extruded: step 1, Box', summary([40, 30, 20], 1)],
    ['geom.extrude', 'Cut: step 2', summary([40, 30, 20], 2)],
    ['geom.extrude', 'Extruded: step 3, Lid', summary([90, 30, 20], 3)],
    ['geom.extrude', 'Extruded: step 4, Lip', summary([90, 30, 20], 4)],
  ]
  if (opts.last) steps.push([opts.last.tool, 'Last', summary([90, 30, 25], 5)])
  const ev: PilotEvent[] = [
    { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-10-14T00:00:00Z' },
    { type: 'text', delta: 'I will make a box with a lid.' },
    ...steps.flatMap(([tool, said, output], i): PilotEvent[] => [
      { type: 'tool_call', callId: `d${i}`, tool, source: 'command', input: {}, args: '' },
      { type: 'tool_result', callId: `d${i}`, ok: i < 5 || opts.last?.ok === true, summary: said, output },
    ]),
    { type: 'text', delta: 'Done: the box and its lid.' },
    ...(opts.done === false ? [] : [{ type: 'done', stopReason: 'end', ms: 900 } as const]),
  ]
  return foldEvents(ev, startTurn(emptyTranscript(), { user: 'a box with a lid' }, 0), 0)
}

describe('a design built step by step', () => {
  it('a box with a lid gives one card, not four, and the step rows stay', () => {
    const h = handlers()
    render(<TranscriptView transcript={boxWithLid()} showThinking={false} approvals={approvals} parts={h} />)
    const cards = screen.getAllByTestId('mimir-part')
    expect(cards).toHaveLength(1)
    // the design as its newest step left it: the design id, which is the object's id on the plate, its name and size
    expect(cards[0]!.getAttribute('data-part')).toBe('box-with-lid')
    expect(cards[0]!.textContent).toContain('Part created')
    expect(cards[0]!.textContent).toContain('Box with lid 90 x 30 x 20 mm')
    // every step keeps its row, design.new included
    expect(document.querySelectorAll('.trow')).toHaveLength(5)
    // the card follows the step rows, and the next steps follow the card
    const order = Array.from(document.querySelectorAll('.trow, .part-card, .follow')).map((e) => e.className.split(' ')[0])
    expect(order).toEqual(['trow', 'trow', 'trow', 'trow', 'trow', 'part-card', 'follow'])
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Select the Box with lid' }))
    expect(h.onSelect).toHaveBeenCalledWith('box-with-lid')
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Edit the Box with lid' }))
    expect(h.onEdit).toHaveBeenCalledWith('box-with-lid')
  })

  it('reads the design from a step that changed it, never from a read or a failed step', () => {
    const t = boxWithLid()
    const rows = t.turns[0]!.blocks.flatMap((b) => (b.kind === 'tools' ? b.rows : []))
    // design.new has nothing in it yet
    expect(builtPart(rows[0]!)).toBeNull()
    expect(builtPart(rows[1]!)).toEqual({ id: 'box-with-lid', name: 'Box with lid', kind: 'part', sizeMm: [40, 30, 20], built: true })
    // the part generator's card is unchanged: a design step is no maker
    expect(createdPart(rows[1]!)).toBeNull()
    // a read after the build leaves the card at the newest build step
    render(<TranscriptView transcript={boxWithLid({ last: { tool: 'design.steps', ok: true } })} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByTestId('mimir-part').textContent).toContain('90 x 30 x 20 mm')
    cleanup()
    // a failed step leaves it at the step before
    render(<TranscriptView transcript={boxWithLid({ last: { tool: 'geom.fillet', ok: false } })} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByTestId('mimir-part').textContent).toContain('90 x 30 x 20 mm')
    cleanup()
    render(<TranscriptView transcript={boxWithLid({ last: { tool: 'geom.fillet', ok: true } })} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByTestId('mimir-part').textContent).toContain('90 x 30 x 25 mm')
  })

  it('keeps only the rows without part handlers, and shows the card while the build runs', () => {
    render(<TranscriptView transcript={boxWithLid()} showThinking={false} approvals={approvals} />)
    expect(screen.queryByTestId('mimir-part')).toBeNull()
    expect(document.querySelectorAll('.trow')).toHaveLength(5)
    cleanup()
    render(<TranscriptView transcript={boxWithLid({ done: false })} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getAllByTestId('mimir-part')).toHaveLength(1)
    expect(screen.queryAllByTestId('mimir-follow')).toHaveLength(0)
  })

  it('a turn that only reads a design shows no card', () => {
    const ev: PilotEvent[] = [
      { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-10-14T00:00:00Z' },
      { type: 'tool_call', callId: 'r', tool: 'design.steps', source: 'command', input: {}, args: '' },
      { type: 'tool_result', callId: 'r', ok: true, summary: '4 steps', output: summary([90, 30, 20], 4) },
      { type: 'done', stopReason: 'end', ms: 10 },
    ]
    render(<TranscriptView transcript={foldEvents(ev, startTurn(emptyTranscript(), { user: 'what steps?' }, 0), 0)} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.queryByTestId('mimir-part')).toBeNull()
    expect(document.querySelectorAll('.trow')).toHaveLength(1)
  })
})

/** One turn of design calls: each is [tool, ok, the summary it returned]; `perm` adds the turn's permission line. */
function designTurn(calls: [string, boolean, unknown][], perm = false): ReturnType<typeof reply> {
  const ev: PilotEvent[] = [
    { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-10-14T00:00:00Z' },
    ...(perm ? [{ type: 'permission_note', permission: 'slice', mode: 'allow', tool: 'geom.extrude', message: 'Slice and arrange is set to Allow in Permissions, so mimir continued without asking.' } as const] : []),
    ...calls.flatMap(([tool, ok, output], i): PilotEvent[] => [
      { type: 'tool_call', callId: `c${i}`, tool, source: 'command', input: {}, args: '' },
      { type: 'tool_result', callId: `c${i}`, ok, summary: tool, output },
    ]),
    { type: 'text', delta: 'Done.' },
    { type: 'done', stopReason: 'end', ms: 10 },
  ]
  return foldEvents(ev, startTurn(emptyTranscript(), { user: 'change it' }, 0), 0)
}

describe('what the built card says the turn did', () => {
  it('says Part created only when the turn started the design', () => {
    render(<TranscriptView transcript={boxWithLid()} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByRole('group', { name: 'Part created' })).toBeTruthy()
    cleanup()
    // a later turn that fillets the same design names the design and says it was updated
    render(<TranscriptView transcript={designTurn([['geom.fillet', true, summary([90, 30, 20], 5)]])} showThinking={false} approvals={approvals} parts={handlers()} />)
    const card = screen.getByTestId('mimir-part')
    expect(card.querySelector('.part-title')!.textContent).toBe('Box with lid updated')
    expect(card.getAttribute('aria-label')).toBe('Box with lid updated')
    expect(card.textContent).toContain('Box with lid 90 x 30 x 20 mm')
    expect(card.textContent).not.toContain('created')
    // a design.new that failed started nothing, so the design was only updated
    cleanup()
    render(<TranscriptView transcript={designTurn([['design.new', false, null], ['geom.extrude', true, summary([40, 30, 20], 2)]])} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByTestId('mimir-part').querySelector('.part-title')!.textContent).toBe('Box with lid updated')
  })

  it('keeps the part generator\'s title', () => {
    expect(partTitle({ id: 'c', name: '20 mm cube', kind: 'cube', sizeMm: [20, 20, 20] })).toBe('Cube created')
    expect(partTitle({ id: 'b', name: 'Box with lid', kind: 'part', sizeMm: [1, 1, 1], built: true })).toBe('Part created')
    expect(partTitle({ id: 'b', name: 'Box with lid', kind: 'part', sizeMm: [1, 1, 1], built: true, updated: true })).toBe('Box with lid updated')
  })

  it('an undo that leaves the design empty shows no card', () => {
    render(<TranscriptView transcript={designTurn([['design.undo', true, summary(null, 0)]], true)} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.queryByTestId('mimir-part')).toBeNull()
    expect(screen.queryAllByTestId('mimir-follow')).toHaveLength(0)
    expect(document.querySelectorAll('.trow')).toHaveLength(1)
    // with no card, the permission line stays
    expect(document.body.textContent).toContain('set to Allow in Permissions')
    cleanup()
    // nor when the turn built the design first and then undid back to nothing
    render(<TranscriptView transcript={designTurn([['design.new', true, summary(null, 0)], ['geom.extrude', true, summary([40, 30, 20], 1)], ['design.undo', true, summary(null, 0)]])} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.queryByTestId('mimir-part')).toBeNull()
    cleanup()
    // an undo that leaves something shows the design as it is now
    render(<TranscriptView transcript={designTurn([['design.undo', true, summary([40, 30, 20], 3)]])} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByTestId('mimir-part').textContent).toContain('Box with lid updated')
    expect(screen.getByTestId('mimir-part').textContent).toContain('40 x 30 x 20 mm')
    cleanup()
    // and a redo after the emptying undo brings the card back
    render(<TranscriptView transcript={designTurn([['design.undo', true, summary(null, 0)], ['design.redo', true, summary([40, 30, 20], 1)]])} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByTestId('mimir-part').textContent).toContain('40 x 30 x 20 mm')
  })

  it('drops the permission line for a built design, created or updated', () => {
    render(<TranscriptView transcript={designTurn([['design.new', true, summary(null, 0)], ['geom.extrude', true, summary([40, 30, 20], 1)]], true)} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByRole('group', { name: 'Part created' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('set to Allow in Permissions')
    cleanup()
    render(<TranscriptView transcript={designTurn([['geom.fillet', true, summary([40, 30, 20], 2)]], true)} showThinking={false} approvals={approvals} parts={handlers()} />)
    expect(screen.getByRole('group', { name: 'Box with lid updated' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('set to Allow in Permissions')
    cleanup()
    // without part handlers the line stays, as a plain row
    render(<TranscriptView transcript={designTurn([['geom.fillet', true, summary([40, 30, 20], 2)]], true)} showThinking={false} approvals={approvals} />)
    expect(document.body.textContent).toContain('set to Allow in Permissions')
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
