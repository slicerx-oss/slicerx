// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A build reply's part card: flat tags (size, scale only with a plan scale, part count only past one), the warnings
// that can fail the print in view at all times, and a Details line, closed on every new reply, whose groups show only
// with something in them. Each fact is sorted by where it came from (the plan, design.check, a design step, the sheet,
// the turn's citations, the host), never from the reply's words. Two unlike builds: a bookshelf and a teapot.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Citation, PilotEvent, PilotSheet } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkWarning,
  colorLine,
  DETAILS_LABEL,
  GROUP_LABELS,
  guessLine,
  offBedWarning,
  partsTag,
  passedNote,
  replyFacts,
  replyTags,
  scaleTag,
  TranscriptView,
  turnPart,
  underWarning,
  WARNINGS_LABEL,
  type FactsHost,
  type ReplyPlan,
} from '../ui/index'
import { emptyTranscript, foldEvents, startTurn } from '../ui/reduce'

afterEach(cleanup)

const approvals = { onApprove: async () => undefined, onCancel: async () => undefined }

/** A design summary as the design tools return it, with its parts by name. */
const summary = (design: string, name: string, sizeMm: number[], parts: string[], extra: Record<string, unknown> = {}) => ({ design, name, exact: true, steps: parts.length, minMm: [0, 0, 0], sizeMm, parts: parts.map((p, index) => ({ index, name: p, sizeMm })), volumeMm3: 1, ...extra })

type Call = [tool: string, output: unknown, ok?: boolean]

/** One build turn: its calls in order, then the reply's one sentence; `before` goes ahead of the calls. */
function build(calls: Call[], opts: { before?: PilotEvent[]; after?: PilotEvent[]; said?: string } = {}) {
  const ev: PilotEvent[] = [
    { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-11-15T00:00:00Z' },
    ...(opts.before ?? []),
    ...calls.flatMap(([tool, output, ok = true], i): PilotEvent[] => [
      { type: 'tool_call', callId: `c${i}`, tool, source: 'command', input: {}, args: '' },
      { type: 'tool_result', callId: `c${i}`, ok, summary: tool, output },
    ]),
    ...(opts.after ?? []),
    { type: 'text', delta: opts.said ?? 'Built it.' },
    { type: 'done', stopReason: 'end', ms: 10 },
  ]
  return foldEvents(ev, startTurn(emptyTranscript(), { user: 'make it' }, 0), 0)
}

/** A bookshelf: three parts, no scale, a plan with a left-out detail, a failed check item and a passed one with a note. */
const SHELF_PLAN: ReplyPlan = {
  units: 'mm',
  features: [{ name: 'Sides' }, { name: 'Shelves' }, { name: 'Back panel' }],
  assumptions: ['Shelves 18 mm thick'],
  leftOut: ['the kick plate'],
}
const shelfCalls = (check: Record<string, unknown>): Call[] => [
  ['design.plan', { planId: 'plan-shelf', accepted: true, auto: true }],
  ['design.new', { design: 'shelf', name: 'Bookshelf', steps: 0, parts: [] }],
  ['geom.extrude', summary('shelf', 'Bookshelf', [120, 40, 160], ['Sides', 'Shelves', 'Back panel'])],
  ['design.check', { planId: 'plan-shelf', design: 'shelf', ...check }],
]
const SHELF_CHECK = {
  pass: false,
  items: [
    { name: 'overall size', want: '120 x 40 x 160 mm', got: '120 x 40 x 152 mm', pass: false },
    { name: 'minimum wall', want: '0.8 mm', got: '1.2 mm', pass: true, warning: 'reads 0.4 mm only at the top edge of the sides' },
    { name: 'feature count', want: '3', got: '3', pass: true },
  ],
  notes: ['The back panel hardly shows from the front'],
}

/** A teapot: one part at 1:2 with colors, a step that now needs supports, a size kept under the floor, a sheet and a source. */
const TEAPOT_PLAN: ReplyPlan = {
  units: 'mm',
  features: [{ name: 'Body' }, { name: 'Spout' }, { name: 'Lid' }],
  assumptions: [],
  scale: '1:2',
  colors: { Body: 'white', Spout: 'white', Lid: 'blue' },
}
const SHEET: PilotSheet = {
  id: 'sheet-1',
  title: 'Teapot sizes',
  views: ['iso'],
  dims: [
    { key: 'height', label: 'Height', value: 90, unit: 'mm', source: 'guess' },
    { key: 'spout', label: 'Spout angle', value: 40, unit: 'deg', source: 'guess' },
    { key: 'wall', label: 'Wall', value: 2, unit: 'mm', source: 'guess' },
    { key: 'lid', label: 'Lid width', value: 50, unit: 'mm', source: 'asked' },
  ],
}
const SOURCE: Citation = { id: 'kb_teapot', title: 'Teapot proportions', url: 'https://example.com/teapot', kind: 'kb' }
const teapot = () =>
  build(
    [
      ['design.plan', { planId: 'plan-pot', accepted: true, underFloors: [{ feature: 'Spout', size: 'wall', name: 'Spout wall', planned: 0.5, floor: 0.8, why: 'two lines of a 0.4 mm nozzle' }] }],
      ['design.new', { design: 'pot', name: 'Teapot', steps: 0, parts: [] }],
      ['geom.loft', summary('pot', 'Teapot', [140, 90, 100], ['Teapot'])],
      ['design.edit_step', { ...summary('pot', 'Teapot', [140, 90, 100], ['Teapot']), warnings: ['Spout now needs supports: about 120 mm² more of it faces down steeper than 45 degrees'] }],
    ],
    {
      before: [
        { type: 'sheet', sheet: SHEET },
        { type: 'sheet_answered', sheetId: 'sheet-1', answer: { confirmed: true, values: { height: 100, spout: 40, wall: 2, lid: 50 }, changed: ['height'] } },
      ],
      after: [{ type: 'citations', items: [SOURCE] }],
    },
  )

const plans: Record<string, ReplyPlan> = { 'plan-shelf': SHELF_PLAN, 'plan-pot': TEAPOT_PLAN }
const host = { plan: (planId: string | null) => (planId ? plans[planId] : null), offBed: () => false }
const facts = (t: ReturnType<typeof build>, h: FactsHost = host) => replyFacts(t.turns[0]!, turnPart(t.turns[0]!)!, h)
const groups = (f: ReturnType<typeof facts>) => Object.fromEntries(f.groups.map((g) => [g.id, g.items.map((i) => i.text)]))

describe('the facts of a build reply', () => {
  it('a bookshelf: the size and part count, no scale, a failed check item as a warning, and its notes in Details', () => {
    const f = facts(build(shelfCalls(SHELF_CHECK)))
    expect(f.tags).toEqual(['120 x 40 x 160 mm', '3 parts'])
    // only the failed item warns; a passed item's warning is a plain print note
    expect(f.warnings).toEqual(['Overall size is off the plan: wanted 120 x 40 x 160 mm, got 120 x 40 x 152 mm.'])
    expect(f.groups.map((g) => g.id)).toEqual(['parts', 'guessed', 'leftOut', 'printNote'])
    expect(groups(f)).toEqual({
      parts: ['Sides', 'Shelves', 'Back panel'],
      guessed: ['Shelves 18 mm thick'],
      leftOut: ['the kick plate'],
      printNote: ['Minimum wall: reads 0.4 mm only at the top edge of the sides', 'The back panel hardly shows from the front'],
    })
  })

  it('a teapot: the scale tag, a size under the floor and a step that needs supports as warnings, colors, guesses and the source', () => {
    const f = facts(teapot())
    expect(f.tags).toEqual(['140 x 90 x 100 mm', '1:2'])
    expect(f.warnings).toEqual(['Spout wall is 0.5 mm, under the 0.8 mm this printer can print.', 'Spout now needs supports: about 120 mm² more of it faces down steeper than 45 degrees.'])
    expect(f.groups.map((g) => g.id)).toEqual(['parts', 'colors', 'guessed', 'source'])
    // the height the person changed on the sheet is theirs, not a guess; the asked row never was one
    expect(groups(f)).toEqual({ parts: ['Body', 'Spout', 'Lid'], colors: ['White: Body, Spout', 'Blue: Lid'], guessed: ['Spout angle 40 degrees', 'Wall 2 mm'], source: ['Teapot proportions'] })
    expect(f.groups.find((g) => g.id === 'source')!.items).toEqual([{ text: 'Teapot proportions', url: 'https://example.com/teapot' }])
  })

  it('warns when the part is off the bed, by the host\'s word', () => {
    expect(facts(teapot(), { ...host, offBed: () => true }).warnings.at(-1)).toBe('The Teapot is off the bed. Move it onto the bed to print it.')
  })

  it('reads the newest check of the turn, so a fixed miss no longer warns', () => {
    const fixed = build([...shelfCalls(SHELF_CHECK), ['design.check', { planId: 'plan-shelf', design: 'shelf', pass: true, items: [{ name: 'overall size', want: '120 x 40 x 160 mm', got: '120 x 40 x 160 mm', pass: true }] }]])
    expect(facts(fixed).warnings).toEqual([])
  })

  it('has no scale tag without a plan scale, and no part count for one part', () => {
    const one = { id: 'b', name: 'Block', kind: 'part' as const, sizeMm: [10, 20, 30] as [number, number, number] }
    expect(replyTags(one)).toEqual(['10 x 20 x 30 mm'])
    expect(replyTags(one, { features: [], scale: 150 })).toEqual(['10 x 20 x 30 mm', '1:150'])
    expect(replyTags(one, { features: [], scale: 'about half' })).toEqual(['10 x 20 x 30 mm'])
    expect(replyTags({ ...one, parts: 7 })).toEqual(['10 x 20 x 30 mm', '7 parts'])
  })

  it('takes the design\'s own parts when there is no plan, and leaves out every empty group', () => {
    const t = build([['design.new', { design: 'box', name: 'Box with lid', steps: 0, parts: [] }], ['geom.extrude', summary('box', 'Box with lid', [90, 30, 20], ['Box', 'Lid'])]])
    const f = facts(t, {})
    expect(f.warnings).toEqual([])
    expect(f.groups.map((g) => g.id)).toEqual(['parts'])
    expect(groups(f).parts).toEqual(['Box', 'Lid'])
    // a plan without a leftOut has no Left out group
    expect(facts(build(shelfCalls({ pass: true, items: [] })), { plan: () => ({ ...SHELF_PLAN, leftOut: undefined }), offBed: () => false }).groups.map((g) => g.id)).toEqual(['parts', 'guessed'])
  })

  it('asks the host for the plan by the turn\'s planId, or by the design when the turn made none', () => {
    const asked: [string | null, string][] = []
    facts(build(shelfCalls(SHELF_CHECK)), { plan: (id, design) => (asked.push([id, design]), null), offBed: () => false })
    facts(build(shelfCalls(SHELF_CHECK).slice(1)), { plan: (id, design) => (asked.push([id, design]), null), offBed: () => false })
    expect(asked).toEqual([
      ['plan-shelf', 'shelf'],
      [null, 'shelf'],
    ])
  })
})

describe('the words on the card', () => {
  it('are these, each from one place', () => {
    expect(DETAILS_LABEL).toBe('Details')
    expect(WARNINGS_LABEL).toBe('Warnings')
    expect(GROUP_LABELS).toEqual({ parts: 'Parts', colors: 'Colors', guessed: 'Guessed', leftOut: 'Left out', printNote: 'Print note', source: 'Source' })
    expect(scaleTag(150)).toBe('1:150')
    expect(partsTag(7)).toBe('7 parts')
    expect(checkWarning('overall size', '64 x 64 x 180 mm', '64 x 64 x 172 mm')).toBe('Overall size is off the plan: wanted 64 x 64 x 180 mm, got 64 x 64 x 172 mm.')
    expect(underWarning('tower wall', 0.5, 0.8, 'mm')).toBe('Tower wall is 0.5 mm, under the 0.8 mm this printer can print.')
    expect(offBedWarning('Lighthouse')).toBe('The Lighthouse is off the bed. Move it onto the bed to print it.')
    expect(colorLine('red', ['Bands', 'Roof'])).toBe('Red: Bands, Roof')
    expect(guessLine('Wall', 2, 'mm')).toBe('Wall 2 mm')
    expect(guessLine('Lean', 70, 'deg')).toBe('Lean 70 degrees')
    expect(guessLine('Infill', 15, '%')).toBe('Infill 15%')
    expect(passedNote('minimum wall', 'reads 0.4 mm at the rim')).toBe('Minimum wall: reads 0.4 mm at the rim')
  })
})

describe('the card of a build reply', () => {
  const parts = { onEdit: () => undefined, onSelect: () => undefined, onRun: () => undefined, has: () => true, can: () => true, ...host }

  it('shows the tags and the warnings, with Details closed', () => {
    render(<TranscriptView transcript={build(shelfCalls(SHELF_CHECK))} showThinking={false} approvals={approvals} parts={parts} />)
    const card = screen.getByTestId('mimir-part')
    expect(within(card).getByTestId('mimir-reply-tags').textContent).toBe('120 x 40 x 160 mm3 parts')
    expect(Array.from(card.querySelectorAll('.part-tag')).map((e) => e.textContent)).toEqual(['120 x 40 x 160 mm', '3 parts'])
    // the warnings are a named list in view, never a status line (the gone note takes that role)
    const warn = within(card).getByRole('list', { name: 'Warnings' })
    expect(within(warn).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Overall size is off the plan: wanted 120 x 40 x 160 mm, got 120 x 40 x 152 mm.'])
    expect(warn.querySelector('.sx-ic')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    const details = within(card).getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    const list = document.getElementById(details.getAttribute('aria-controls')!)!
    expect(list.hidden).toBe(true)
    // closed, the groups are hidden from the reader and from screen readers alike
    expect(list.closest('[hidden]')).toBe(list)
    expect(within(card).queryByRole('definition')).toBeNull()
  })

  it('opens Details to its groups, each a label and its text', () => {
    render(<TranscriptView transcript={teapot()} showThinking={false} approvals={approvals} parts={parts} />)
    const details = screen.getByRole('button', { name: 'Details' })
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    const list = document.getElementById(details.getAttribute('aria-controls')!)!
    expect(list.hidden).toBe(false)
    expect(Array.from(list.querySelectorAll('dt')).map((e) => e.textContent)).toEqual(['Parts', 'Colors', 'Guessed', 'Source'])
    expect(list.querySelector('[data-group="parts"] dd')!.textContent).toBe('Body, Spout, Lid')
    expect(Array.from(list.querySelectorAll('[data-group="guessed"] dd')).map((e) => e.textContent)).toEqual(['Spout angle 40 degrees', 'Wall 2 mm'])
    expect(within(list).getByRole('link', { name: 'Teapot proportions' }).getAttribute('href')).toBe('https://example.com/teapot')
    fireEvent.click(details)
    expect(list.hidden).toBe(true)
  })

  it('moves the turn\'s sources into Details: no Sources line beside the card', () => {
    render(<TranscriptView transcript={teapot()} showThinking={false} approvals={approvals} parts={parts} />)
    expect(screen.queryByRole('button', { name: /^Sources \(\d\)$/ })).toBeNull()
    cleanup()
    // without part handlers there is no card, so the sources keep their own line
    render(<TranscriptView transcript={teapot()} showThinking={false} approvals={approvals} />)
    expect(screen.getByRole('button', { name: 'Sources (1)' })).toBeTruthy()
  })

  it('keeps the card, the warnings and Details before the next steps', () => {
    render(<TranscriptView transcript={build(shelfCalls(SHELF_CHECK))} showThinking={false} approvals={approvals} parts={parts} />)
    const order = Array.from(document.querySelectorAll('.part-card, .part-warn, .part-details, .follow')).map((e) => e.className.split(' ')[0])
    expect(order).toEqual(['part-card', 'part-warn', 'part-details', 'follow'])
  })

  it('shows no warning row and no Details for a reply with nothing for them', () => {
    const t = build([['design.new', { design: 'b', name: 'Block', steps: 0, parts: [] }], ['geom.extrude', { design: 'b', name: 'Block', sizeMm: [10, 10, 10], parts: [] }]])
    render(<TranscriptView transcript={t} showThinking={false} approvals={approvals} parts={parts} />)
    expect(screen.queryByTestId('mimir-reply-warn')).toBeNull()
    expect(screen.queryByTestId('mimir-details')).toBeNull()
    expect(screen.getByTestId('mimir-reply-tags').textContent).toBe('10 x 10 x 10 mm')
  })
})
