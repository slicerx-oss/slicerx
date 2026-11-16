// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The build reply's part card in the mimir tab: the plan it reads is the card plan the turn approved (or, for a later
// turn, the plan tied to the design), so a plan's scale is a tag and its left-out details sit under Details, closed;
// a part that does not fit on the bed where it stands is a warning in view. The card's accessible name and its gone
// note keep their roles, so "Select the <name>", "Edit the <name>" and the one status line still find one match.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyTranscript, foldEvents, startTurn, TranscriptView } from '@slicerx/pilot/ui'
import type { PlateEntry } from '../src/state/store'

const { partHandlers, partOffBed, partPlan } = await import('../src/workspaces/mimir/part-actions')
const { mimirPlans } = await import('../src/workspaces/mimir/plans')
const { set } = await import('../src/state/store')

const host = { loadParts: async () => ({ id: 'h', hash: 'h', name: 'h', triangles: 12, bboxMm: [1, 1, 1] as [number, number, number], openEdges: 0, parts: [] }) }

/** A plate object of one box-shaped part, `size` mm, its corner at `at`. */
const entry = (id: string, at: [number, number], size: [number, number, number]): PlateEntry => {
  const [w, d, h] = size
  const positions = new Float32Array([0, 0, 0, w, 0, 0, w, d, 0, 0, d, h])
  return { id, name: id, parts: [{ name: id, positions, slot: 1 }], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1], colors: ['#fff'] } as unknown as PlateEntry
}

const LIGHTHOUSE = {
  planId: 'plan-light',
  part: 'Lighthouse',
  units: 'mm' as const,
  features: [
    { name: 'Tower', kind: 'loft', sizes: { height: 160 } },
    { name: 'Gallery', kind: 'extrude', sizes: { height: 4 } },
    { name: 'Base', kind: 'extrude', sizes: { height: 20 } },
  ],
  assumptions: ['Gallery rail 3 mm tall'],
  questions: [],
  scale: 150,
  leftOut: ['window panes', 'the weather vane'],
}

/** A lighthouse built in the tab: its plan approved, its design started and built in seven parts. */
function lighthouse(opts: { plan?: boolean } = {}) {
  const parts = Array.from({ length: 7 }, (_, index) => ({ index, name: `Part ${index + 1}`, sizeMm: [64, 64, 180] }))
  const calls: [string, unknown][] = [
    ...(opts.plan === false ? [] : [['design.plan', { planId: 'plan-light', accepted: true, auto: true }] as [string, unknown]]),
    ['design.new', { design: 'light', name: 'Lighthouse', steps: 0, parts: [] }],
    ['geom.loft', { design: 'light', name: 'Lighthouse', steps: 7, sizeMm: [64, 64, 180], parts }],
  ]
  const ev: PilotEvent[] = [
    { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-11-15T00:00:00Z' },
    ...calls.flatMap(([tool, output], i): PilotEvent[] => [
      { type: 'tool_call', callId: `c${i}`, tool, source: 'command', input: {}, args: '' },
      { type: 'tool_result', callId: `c${i}`, ok: true, summary: tool, output },
    ]),
    { type: 'text', delta: "Built a lighthouse, 180 mm tall at 1:150. Plan checks pass; it isn't sliced yet." },
    { type: 'done', stopReason: 'end', ms: 10 },
  ]
  return foldEvents(ev, startTurn(emptyTranscript(), { user: 'a lighthouse' }, 0), 0)
}

const approvals = { onApprove: async () => undefined, onCancel: async () => undefined }
const view = (t: ReturnType<typeof lighthouse>) => render(createElement(TranscriptView, { transcript: t, showThinking: false, approvals, parts: { ...partHandlers(host, false), can: () => true } }))

beforeEach(() => {
  mimirPlans.clear()
  mimirPlans.put(LIGHTHOUSE, 'light', 'card')
  set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate: [entry('light', [96, 96], [64, 64, 180])] })
})
afterEach(cleanup)

describe('the build reply card in the mimir tab', () => {
  it('reads the plan the turn approved, or the one tied to the design', () => {
    expect(partPlan('plan-light', 'other')?.leftOut).toEqual(['window panes', 'the weather vane'])
    expect(partPlan(null, 'light')?.scale).toBe(150)
    expect(partPlan(null, 'nothing')).toBeNull()
  })

  it('shows the plan scale and part count as tags, and the left-out details under a closed Details', () => {
    view(lighthouse())
    const card = screen.getByTestId('mimir-part')
    expect(card.getAttribute('aria-label')).toBe('7 parts created')
    expect(card.querySelector('.part-title')!.textContent).toBe('Lighthouse')
    expect(Array.from(card.querySelectorAll('.part-tag')).map((e) => e.textContent)).toEqual(['64 x 64 x 180 mm', '1:150', '7 parts'])
    const details = within(card).getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(details.getAttribute('aria-controls')!)!.hidden).toBe(true)
    // nothing here can fail the print, so no warning row
    expect(within(card).queryByRole('list', { name: 'Warnings' })).toBeNull()
    fireEvent.click(details)
    const list = document.getElementById(details.getAttribute('aria-controls')!)!
    expect(list.querySelector('[data-group="leftOut"] dd')!.textContent).toBe('Window panes, the weather vane')
    expect(list.querySelector('[data-group="parts"] dd')!.textContent).toBe('Tower, Gallery, Base')
    expect(list.querySelector('[data-group="guessed"] dd')!.textContent).toBe('Gallery rail 3 mm tall')
    // the buttons the part actions find are still one each
    expect(within(card).getAllByRole('button', { name: 'Select the Lighthouse' })).toHaveLength(1)
    expect(within(card).getAllByRole('button', { name: 'Edit the Lighthouse' })).toHaveLength(1)
  })

  it('finds the design\'s plan on a later turn that made no plan', () => {
    view(lighthouse({ plan: false }))
    expect(screen.getByTestId('mimir-reply-tags').textContent).toContain('1:150')
  })

  it('warns, in view with Details closed, when the part does not fit on the bed where it stands', () => {
    expect(partOffBed('light')).toBe(false)
    set({ plate: [entry('light', [230, 96], [64, 64, 180])] })
    expect(partOffBed('light')).toBe(true)
    expect(partOffBed('gone')).toBe(false)
    view(lighthouse())
    const warn = screen.getByRole('list', { name: 'Warnings' })
    expect(warn.textContent).toBe('The Lighthouse is off the bed. Move it onto the bed to print it.')
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe('false')
    // the warning row takes no status role: the gone note keeps the only one
    expect(screen.queryByRole('status')).toBeNull()
  })
})
