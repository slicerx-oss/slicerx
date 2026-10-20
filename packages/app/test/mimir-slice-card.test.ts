// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slice card in the mimir chat: the plate's outline, the print time, filament and cost, each warning on its own
// line, and Open in Slice, which shows that plate in the Slice tab. A slice the plate no longer matches says to slice
// again, whether the run said so or the plate changed after the run ended.
import type { MeshHandle, PrintRun, RunSlice } from '@slicerx/contracts'
import { fmtDuration, fmtGrams } from '@slicerx/pilot'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatCost } from '../src/lib/preview-stats'
import { boxMesh } from '../src/plate/mesh-ops'
import { switchPlate } from '../src/plate/plates'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { createRunBook, runHandle } from '@slicerx/pilot'
import { appPrintRun } from '../src/workspaces/mimir/print-run'
import { runCard } from '../src/workspaces/mimir/run-cards'
import { SliceCard } from '../src/workspaces/mimir/slice-card'

afterEach(cleanup)

const STALE = 'The plate changed after this slice. Slice it again.'

const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Clip', triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [{ name: 'Body', slot: 1 }] as MeshHandle['parts'] }
const at = (x: number) => compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const clip: PlateEntry = { id: 'a', name: 'Clip', handle, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: at(60) }
const hook: PlateEntry = { ...clip, id: 'b', name: 'Hook', transform: at(120) }

/** A slice of plate `patch.plate` (1 by default) made from that plate as it is now. */
function slice(patch: Partial<RunSlice> = {}): RunSlice {
  const plate = patch.plate ?? 1
  return { sliceId: 'sl_1', plate, at: '2026-10-20T00:00:00.000Z', timeS: 3723, grams: 12.5, cost: 0.46, warnings: [], fingerprint: appPrintRun().fingerprint(plate), stale: false, ...patch }
}

function run(s: RunSlice | null): PrintRun {
  return { sessionId: 's', designId: null, plate: s?.plate ?? 1, printerId: 'bay-1', slots: {}, slice: s, send: null, job: null, updatedAt: '2026-10-20T00:00:00.000Z' }
}

const show = (r: PrintRun, actionable = true) => render(createElement(SliceCard, { run: r, actionable }))

describe('the slice card', () => {
  beforeEach(() => {
    set({
      workspace: 'prepare',
      modelMode: 'mimir',
      plate: [clip],
      plates: [
        { id: 'p1', name: 'Plate 1', objects: [], settings: {} },
        { id: 'p2', name: 'Plate 2', objects: [hook], settings: {} },
      ],
      activePlate: 'p1',
      printerId: 'bay-1',
      overrides: {},
      objectSettings: {},
    })
  })

  it('the card shows time, grams and cost', () => {
    show(run(slice()))
    const card = screen.getByTestId('mimir-slice')
    expect(within(card).getByText(fmtDuration(3723))).toBeTruthy()
    expect(within(card).getByText(fmtGrams(12.5))).toBeTruthy()
    expect(within(card).getByText(formatCost(0.46))).toBeTruthy()
    expect(card.textContent).toContain('1h 02m')
    expect(card.textContent).toContain('12.5 g')
    expect(card.textContent).toContain('$0.46')
    // the plate picker's outline thumbnail, with the plate's object in it
    expect(card.querySelector('svg.plate-thumb polygon')).not.toBeNull()
    expect(card.textContent).not.toContain(STALE)
    expect(card.hasAttribute('data-stale')).toBe(false)
    // nothing without a slice
    cleanup()
    expect(show(run(null)).container.innerHTML).toBe('')
    // the chat's run block draws this card for the slice stage
    cleanup()
    render(createElement('div', null, runCard({ stage: 'slice', run: run(slice()), actionable: true })))
    expect(screen.getByTestId('mimir-slice')).toBeTruthy()
  })

  it('a warning shows as its own line', () => {
    show(run(slice({ warnings: ['A wall on Clip is thinner than the nozzle.', 'Clip has an overhang past 60 degrees.'] })))
    const list = screen.getByRole('list', { name: 'Warnings' })
    const lines = within(list).getAllByRole('listitem').map((li) => li.textContent)
    expect(lines).toEqual(['A wall on Clip is thinner than the nozzle.', 'Clip has an overhang past 60 degrees.'])
    cleanup()
    show(run(slice()))
    expect(screen.queryByRole('list', { name: 'Warnings' })).toBeNull()
  })

  it('Open in Slice opens that plate in the Slice tab', () => {
    show(run(slice({ plate: 2 })))
    // plate 2's own objects in the thumbnail
    expect(screen.getByTestId('mimir-slice').textContent).toContain('Plate 2')
    const open = screen.getByTestId('mimir-slice-open')
    expect(open.textContent).toBe('Open in Slice')
    fireEvent.click(open)
    expect(get().activePlate).toBe('p2')
    expect(get().workspace).toBe('prepare')
    expect(get().modelMode).toBe('slice')
    // a card from a saved log has no button
    cleanup()
    show(run(slice()), false)
    expect(screen.queryByTestId('mimir-slice-open')).toBeNull()
  })

  it('a stale slice says to slice again', () => {
    show(run(slice({ stale: true })))
    expect(screen.getByTestId('mimir-slice').textContent).toContain(STALE)
    expect(screen.getByTestId('mimir-slice').hasAttribute('data-stale')).toBe(true)
    cleanup()
    // a fresh slice, then the part moves after the run ended
    show(run(slice()))
    expect(screen.getByTestId('mimir-slice').textContent).not.toContain(STALE)
    act(() => set({ plate: [{ ...clip, transform: at(90) }] }))
    expect(screen.getByTestId('mimir-slice').textContent).toContain(STALE)
    // the figures stay where they were
    expect(screen.getByTestId('mimir-slice').textContent).toContain('$0.46')
  })

  it('a slice of a plate that was not active stays fresh after Open in Slice', () => {
    // plate 2 sliced while plate 1 is the one shown, recorded through the run book as the slice skill records it
    const book = createRunBook(appPrintRun(), () => Date.parse('2026-10-20T00:00:00.000Z'))
    const runs = runHandle(book, 's')
    runs.update({ plate: 2, slice: slice({ plate: 2, fingerprint: runs.fingerprint(2) }) })
    expect(get().activePlate).toBe('p1')
    expect(book.get('s').slice!.stale).toBe(false)
    show(book.get('s'))
    const card = () => screen.getByTestId('mimir-slice')
    expect(card().hasAttribute('data-stale')).toBe(false)
    fireEvent.click(screen.getByTestId('mimir-slice-open'))
    expect(get().activePlate).toBe('p2')
    expect(get().modelMode).toBe('slice')
    // showing plate 2 is not a change to it: the card and the run both still read it fresh
    expect(card().hasAttribute('data-stale')).toBe(false)
    expect(card().textContent).not.toContain(STALE)
    expect(book.get('s').slice!.stale).toBe(false)
    // nor is showing plate 1 again, which the slice is not of
    act(() => switchPlate('p1'))
    expect(card().hasAttribute('data-stale')).toBe(false)
    expect(book.get('s').slice!.stale).toBe(false)
    // an edit to plate 2 does make it stale
    act(() => switchPlate('p2'))
    act(() => set({ plate: get().plate.map((e) => ({ ...e, transform: at(150) })) }))
    expect(card().textContent).toContain(STALE)
    expect(book.get('s').slice!.stale).toBe(true)
  })
})
