// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A failed step's line in the working loop's list never carries internal names. A reason with a field key, a tool's own
// name or a command line's "$ " shows the catch-all sentence instead; a plain reason stays as it is.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { plainReason, showsInternalNames, STEP_NOT_MADE } from '../src/engine-words'
import { TranscriptView, type StepWords } from '../ui/index'
import { emptyTranscript, foldEvents, startTurn } from '../ui/reduce'

afterEach(cleanup)

const KEYED = 'Invalid arguments: edges: Invalid input: expected array, received undefined; radius_mm: Invalid input: expected number, received undefined'
const PLAIN = 'The shape stops 0.6 mm short of the part.'
const KEY_PATTERN = /\b[a-z_]+: /
const words: StepWords = (row) => ({ doing: 'Working', done: row.state === 'bad' ? (row.title ?? 'Step failed') : 'Step done' })
const approvals = { onApprove: async () => undefined, onCancel: async () => undefined }
const parts = { onEdit: () => undefined, onSelect: () => undefined, onRun: () => undefined, has: () => true, can: () => true }

/** A block's failed fillet step with the given reason, its loop opened; returns the failed line's text. */
function failedLine(summary: string): string {
  const events: PilotEvent[] = [
    { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-11-12T00:00:00Z' },
    { type: 'tool_call', callId: 'a', tool: 'geom.fillet', source: 'command', input: {}, args: '' },
    { type: 'tool_result', callId: 'a', ok: false, summary, ms: 100 },
    { type: 'done', stopReason: 'end', ms: 900 },
  ]
  const t = foldEvents(events, startTurn(emptyTranscript(), { user: 'Round the block' }, 0))
  render(<TranscriptView transcript={t} showThinking={false} approvals={approvals} words={words} parts={parts} />)
  fireEvent.click(screen.getByTestId('mimir-loop-line'))
  return document.querySelector('.wl-sub li.failed')?.textContent ?? ''
}

describe("a failed step's line in the working loop", () => {
  it('shows the catch-all sentence when the reason carries field keys', () => {
    const line = failedLine(KEYED)
    expect(line).toContain(STEP_NOT_MADE)
    expect(line).not.toContain('radius_mm')
    expect(line).not.toMatch(KEY_PATTERN)
  })

  it('keeps a plain reason as it is', () => {
    const line = failedLine(PLAIN)
    expect(line).toContain(PLAIN)
    expect(line).not.toContain(STEP_NOT_MADE)
    expect(line).not.toMatch(KEY_PATTERN)
  })
})

describe('the internal names detector', () => {
  it.each([
    ['a field key', 'radiusMm: 6 mm does not fit on this face'],
    ['a setting key', 'wall_mm: Too small: expected number to be >0'],
    ['a tool name', 'design.plan was refused'],
    ['a doubled tool name', 'geom__fillet failed'],
    ['a command line', '$ command geom.fillet'],
  ])('catches %s', (_n, text) => {
    expect(showsInternalNames(text)).toBe(true)
    expect(plainReason(text)).toBe(STEP_NOT_MADE)
  })

  it.each(['The shape stops 0.6 mm short of the part.', 'Cut: step 2, Extrude', '0 of 1 sources found', 'Bay 2 idle, PETG in slot A3', 'It costs $5 to print.'])('leaves %j alone', (text) => {
    expect(showsInternalNames(text)).toBe(false)
    expect(plainReason(text)).toBe(text)
  })
})
