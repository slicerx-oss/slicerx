// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A refused step's row reads the plain line; the engine's own words are only in the row's details, once it is opened.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyTranscript, foldEvents, startTurn } from '../ui/reduce'
import { ToolGroup } from '../ui/tool-group'

afterEach(cleanup)

const RAW = 'radiusMm: 6 mm does not fit on this face; at most 5.000 mm'
const SHOWN = 'That size is too big for this part, so the step was not made. Try a smaller size.'

describe('an engine refusal in a step row', () => {
  it('shows the plain line and keeps the engine text in the details', () => {
    const t = foldEvents(
      [
        { type: 'tool_call', callId: 'c1', tool: 'geom.fillet', source: 'command', input: {}, args: '' },
        { type: 'tool_result', callId: 'c1', ok: false, title: 'Size too big', summary: SHOWN, detail: RAW, ms: 40 },
      ],
      startTurn(emptyTranscript(), { user: 'Round the top edges' }, 0),
    )
    const block = t.turns.at(-1)?.blocks.find((b) => b.kind === 'tools')
    if (block?.kind !== 'tools') throw new Error('no tool rows')
    expect(block.rows[0]).toMatchObject({ state: 'bad', title: 'Size too big', summary: SHOWN, detail: RAW })
    const { container, getByRole } = render(<ToolGroup rows={block.rows} />)
    expect(container.querySelector('.tsum')?.textContent).not.toContain('radiusMm')
    fireEvent.click(getByRole('button', { expanded: false }))
    const row = container.querySelector('.tool')
    expect(row?.querySelector('.trow .tsum')?.textContent).toBe(SHOWN)
    // the title in the name's place, the sentence once, and the time beside them
    expect(row?.querySelector('.trow .tname')?.textContent).toBe('Size too big')
    expect(row?.querySelector('.trow')?.textContent?.split(SHOWN)).toHaveLength(2)
    expect(row?.querySelector('.trow .dur')?.textContent).not.toBe('')
    expect(row?.classList.contains('failed')).toBe(true)
    expect(row?.querySelector('.trow')?.textContent).not.toContain(RAW)
    expect(row?.querySelector('.tdet [data-testid="tool-engine-detail"]')?.textContent).toBe(RAW)
  })
})
