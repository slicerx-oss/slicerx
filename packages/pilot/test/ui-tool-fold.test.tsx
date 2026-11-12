// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A folded group of steps in plain words reads its last step. When that step failed, the line says so beside the
// alert, as the step's own row does, never beside the check; a group whose steps all went through keeps the check.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRowModel } from '../ui/reduce'
import { ToolGroup, type StepWords } from '../ui/tool-group'

afterEach(cleanup)

const row = (callId: string, tool: string, state: ToolRowModel['state'], summary?: string): ToolRowModel => ({ callId, tool, source: 'command', args: '', callSummary: undefined, state, summary, display: [], progress: [], ms: 100, untrusted: false })
// as the mimir tab's words do: a failed step says so
const words: StepWords = (r) => (r.state === 'bad' ? { doing: 'Working', done: 'Step failed' } : { doing: 'Working', done: 'Step done' })

describe('a folded group of steps', () => {
  it("shows the alert when its last step failed, though the failure is no permission or connection problem", () => {
    // a lookup that found nothing, then a step the engine refused in its own words
    const rows = [row('a', 'kb.sources', 'bad', '0 of 1 sources found'), row('b', 'geom.extrude', 'bad', 'The shape stops 0.6 mm short of the part.')]
    const { container } = render(<ToolGroup rows={rows} words={words} />)
    expect(container.querySelector('.tfold .tsum')?.textContent).toBe('Step failed')
    expect(container.querySelector('.tfold .st .bad')).not.toBeNull()
    // and each step's own row shows its alert
    fireEvent.click(container.querySelector('.tfold')!)
    expect(container.querySelectorAll('.trow .st .bad')).toHaveLength(2)
  })

  it('keeps the check when every step went through', () => {
    const { container } = render(<ToolGroup rows={[row('a', 'geom.extrude', 'ok'), row('b', 'geom.fillet', 'ok')]} words={words} />)
    expect(container.querySelector('.tfold .tsum')?.textContent).toBe('Step done')
    expect(container.querySelector('.tfold .st .bad')).toBeNull()
  })
})
