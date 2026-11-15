// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A refused step's row reads the plain line. The engine's own words and the call's command line carry internal names, so
// they are in the opened row only where the host turns raw details on (Developer mode); by default nothing raw shows.
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { RawDetailsContext } from '../ui/raw-details'
import { emptyTranscript, foldEvents, startTurn, type ToolRowModel } from '../ui/reduce'
import { ToolGroup, type StepWords } from '../ui/tool-group'

afterEach(cleanup)

const RAW = 'radiusMm: 6 mm does not fit on this face; at most 5.000 mm'
const SHOWN = 'That size is too big for this part, so the step was not made. Try a smaller size.'

const asDeveloper = (ui: ReactNode) => <RawDetailsContext.Provider value={true}>{ui}</RawDetailsContext.Provider>

describe('an engine refusal in a step row', () => {
  const fold = () =>
    foldEvents(
      [
        { type: 'tool_call', callId: 'c1', tool: 'geom.fillet', source: 'command', input: {}, args: '' },
        { type: 'tool_result', callId: 'c1', ok: false, title: 'Size too big', summary: SHOWN, detail: RAW, ms: 40 },
      ],
      startTurn(emptyTranscript(), { user: 'Round the top edges' }, 0),
    )
  const rowsOf = (t: ReturnType<typeof fold>) => {
    const block = t.turns.at(-1)?.blocks.find((b) => b.kind === 'tools')
    if (block?.kind !== 'tools') throw new Error('no tool rows')
    return block.rows
  }

  it('shows the plain line and keeps the engine text out of the row by default', () => {
    const rows = rowsOf(fold())
    expect(rows[0]).toMatchObject({ state: 'bad', title: 'Size too big', summary: SHOWN, detail: RAW })
    const { container } = render(<ToolGroup rows={rows} />)
    expect(container.querySelector('.tsum')?.textContent).not.toContain('radiusMm')
    const row = container.querySelector('.tool')
    expect(row?.querySelector('.trow .tsum')?.textContent).toBe(SHOWN)
    // the title in the name's place, the sentence once, and the time beside them
    expect(row?.querySelector('.trow .tname')?.textContent).toBe('Size too big')
    expect(row?.querySelector('.trow')?.textContent?.split(SHOWN)).toHaveLength(2)
    expect(row?.querySelector('.trow .dur')?.textContent).not.toBe('')
    expect(row?.classList.contains('failed')).toBe(true)
    expect(row?.querySelector('.trow')?.textContent).not.toContain(RAW)
    // nothing person-facing to open to, so the row offers no expander and holds no raw text
    expect(container.querySelector('button.trow')).toBeNull()
    expect(container.querySelector('.tdet')).toBeNull()
    expect(container.textContent).not.toContain('radiusMm')
    expect(container.textContent).not.toContain('geom.fillet')
  })

  it('shows the engine text in the opened row when raw details are on', () => {
    const { container, getByRole } = render(asDeveloper(<ToolGroup rows={rowsOf(fold())} />))
    fireEvent.click(getByRole('button', { expanded: false }))
    const row = container.querySelector('.tool')
    expect(row?.querySelector('.trow')?.textContent).not.toContain(RAW)
    expect(row?.querySelector('.tdet [data-testid="tool-engine-detail"]')?.textContent).toBe(RAW)
    expect(row?.querySelector('.tdet .cmd')?.textContent).toBe('$ command geom.fillet')
  })
})

// A refused plan step and a normal step, as the mimir tab words them. Neutral content: a box.
const PLAN_RAW = 'A display model plan was not shown. tiers: Box is not a planned feature'
const PLAN_SUMMARY = 'That step could not be made, so the part is unchanged. Try asking for it another way.'
const KEY_PATTERN = /\b[a-z_]+: /
const refused: ToolRowModel = { callId: 'r1', tool: 'design.plan', source: 'command', args: '--tiers "box" --features 3', callSummary: undefined, state: 'bad', title: 'Step not made', summary: PLAN_SUMMARY, detail: PLAN_RAW, display: [], progress: [], ms: 30, untrusted: false }
const normal: ToolRowModel = { callId: 'n1', tool: 'design.put_plan', source: 'command', args: '--name box --size "20 x 20 x 10"', callSummary: undefined, state: 'ok', summary: 'Box planned', display: [{ kind: 'kv', rows: [['Size', '20 x 20 x 10 mm'], ['Parts', '1']] }], progress: [], ms: 60, untrusted: false }
const words: StepWords = (r) => ({ doing: 'Planning the box', done: r.state === 'ok' ? 'Planned the box' : 'Step failed' })

describe('opened step rows with no raw details', () => {
  it('a refused row and a normal row show no key, tool name or command line', () => {
    const { container } = render(<ToolGroup rows={[refused, normal]} words={words} />)
    const rows = [...container.querySelectorAll('.tool')]
    expect(rows).toHaveLength(2)
    // open every row that offers to open
    for (const b of container.querySelectorAll('button.trow')) fireEvent.click(b)
    for (const row of rows) {
      const text = row.textContent ?? ''
      expect(text).not.toMatch(KEY_PATTERN)
      expect(text).not.toMatch(/design[._]+(plan|put_plan)/)
      expect(text).not.toContain('$ ')
      expect(text).not.toContain('--')
    }
    expect(container.querySelector('[data-testid="tool-engine-detail"]')).toBeNull()
    expect(container.querySelector('.cmd')).toBeNull()
  })

  it('keeps the refused row\'s title and summary, and offers no empty expander', () => {
    const { container } = render(<ToolGroup rows={[refused]} words={words} />)
    const trow = container.querySelector('.trow')
    expect(trow?.querySelector('.tname')?.textContent).toBe('Step not made')
    expect(trow?.querySelector('.tsum')?.textContent).toBe(PLAN_SUMMARY)
    expect(trow?.tagName).toBe('DIV')
    expect(trow?.hasAttribute('aria-expanded')).toBe(false)
    expect(container.querySelector('.tdet')).toBeNull()
    expect(container.querySelector('.trow .chev')).toBeNull()
  })

  it('still opens a normal row to its person-facing output', () => {
    const { container, getByRole } = render(<ToolGroup rows={[normal]} words={words} />)
    fireEvent.click(getByRole('button', { expanded: false }))
    const det = container.querySelector('.tdet')
    expect(det?.textContent).toContain('20 x 20 x 10 mm')
    expect(det?.textContent).toContain('Size')
    expect(det?.querySelector('.cmd')).toBeNull()
  })

  it('keeps the untrusted-data note and live progress, and drops only the raw parts', () => {
    const { title: _title, detail: _detail, ...plain } = refused
    const noted: ToolRowModel = { ...plain, callId: 'u1', state: 'ok', summary: 'Read the page', untrusted: true, progress: [{ line: 'Reading the page', fraction: 0.5 }] }
    const { container } = render(<ToolGroup rows={[noted]} words={words} />)
    const det = container.querySelector('.tdet')
    expect(det?.querySelector('.untr')?.textContent).toContain('treats it as data')
    expect(det?.querySelector('.prog')?.textContent).toContain('Reading the page')
    expect(det?.querySelector('.cmd')).toBeNull()
    expect(det?.querySelector('.raw')).toBeNull()
  })
})

describe('opened step rows with raw details on', () => {
  it('shows the command line and the raw refusal text, as before', () => {
    const { container } = render(asDeveloper(<ToolGroup rows={[refused, normal]} words={words} />))
    for (const b of container.querySelectorAll('button.trow')) fireEvent.click(b)
    const [bad, ok] = [...container.querySelectorAll('.tool')]
    expect(bad?.querySelector('.cmd')?.textContent).toBe('$ command design.plan --tiers "box" --features 3')
    expect(bad?.querySelector('[data-testid="tool-engine-detail"]')?.textContent).toBe(PLAN_RAW)
    expect(bad?.textContent).toMatch(KEY_PATTERN)
    expect(ok?.querySelector('.cmd')?.textContent).toBe('$ command design.put_plan --name box --size "20 x 20 x 10"')
    expect(ok?.querySelector('.tdet')?.textContent).toContain('20 x 20 x 10 mm')
  })
})
