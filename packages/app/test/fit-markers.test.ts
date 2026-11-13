// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check's gap lines in the viewport: the automatic check after each plate edit draws none. They show when the
// person opens a fit note or a tool checks the gaps, and go when the person moves on.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FitGap } from '../src/geom/cad'
import { watchMarkers } from '../src/plate/fit-check'
import { allTouches, fitLines, fitSettled, fitToolRan, hideMarkers, keepFits, objectFit, setFit, setTouches, type ObjectFit, type Touch } from '../src/plate/fit-state'
import { get, set } from '../src/state/store'
import { FitNotes } from '../src/workspaces/prepare/fit-notes'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const gap = (kind: FitGap['kind'], gapMm: number): FitGap => ({ kind, parts: [0, 1], gapMm, limitMm: 0.2, from: [0, 0, 0], to: [0, 0, gapMm] })
const fit = (gaps: FitGap[]): ObjectFit => ({ gaps, names: ['Funnel', 'Funnel top'], limitMm: 0.2, verticalLimitMm: 0.2, transform: I })
const touch = (a: string, b: string): Touch => ({ ids: [a, b], transforms: [I, I], gapMm: 0, from: [0, 0, 0], to: [0, 0, 0] })
/** The automatic check found these, and ran to its end on the plate as it is. */
function checked(): void {
  setFit('ship', fit([gap('apart', 0.0004)]))
  setFit('lamp', fit([gap('horizontal', 0.1)]))
  fitSettled(get().plate)
}
/** A plate edit: a new plate array, as every edit makes. */
const edit = () => act(() => set({ plate: [...get().plate] }))
const showWhich = () => fireEvent.click(screen.getByRole('button', { name: 'Show which' }))

let unwatch: () => void
beforeAll(() => {
  unwatch = watchMarkers()
})
afterAll(() => unwatch())
beforeEach(() => {
  set({ selection: null, selectedIds: [] })
  fitSettled(get().plate)
  checked()
})
afterEach(() => {
  cleanup()
  hideMarkers()
  keepFits([])
})

describe('fit check gap lines', () => {
  it('a fit note opened draws its object’s lines, and the next plate edit takes them away', () => {
    render(createElement(FitNotes, { id: 'ship' }))
    showWhich()
    expect(fitLines().map((l) => l.on[0]!.id)).toEqual(['ship'])
    edit()
    expect(fitLines()).toEqual([])
    // the check of the edited plate ran: still none, until someone asks again
    act(() => checked())
    expect(fitLines()).toEqual([])
    expect(screen.getByRole('button', { name: 'Show which' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('closing the note, or selecting another object, takes the lines away', () => {
    const view = render(createElement(FitNotes, { id: 'ship' }))
    showWhich()
    expect(fitLines()).toHaveLength(1)
    showWhich()
    expect(fitLines()).toEqual([])
    showWhich()
    expect(fitLines()).toHaveLength(1)
    // selecting the object itself keeps them; another object takes them away
    act(() => set({ selection: 'ship', selectedIds: ['ship'] }))
    expect(fitLines()).toHaveLength(1)
    act(() => set({ selection: 'lamp', selectedIds: ['lamp'] }))
    expect(fitLines()).toEqual([])
    // the notes going away while open (the row scrolled off, the list shut)
    act(() => set({ selection: null, selectedIds: [] }))
    showWhich()
    expect(fitLines()).toHaveLength(1)
    view.unmount()
    expect(fitLines()).toEqual([])
  })

  it('a gap check a tool ran draws that object’s lines, and an edit takes them away', () => {
    fitToolRan('geom.fit_check', { design: 'ship' }, { pieces: 2 })
    expect(fitLines().map((l) => l.on[0]!.id)).toEqual(['ship'])
    edit()
    expect(fitLines()).toEqual([])
    // design.check with a gaps item on the object does the same; one without a fit item draws nothing
    act(() => checked())
    fitToolRan('design.check', { planId: 'p1' }, { design: 'lamp', items: [{ name: 'size', pass: true }] })
    expect(fitLines()).toEqual([])
    fitToolRan('design.check', { planId: 'p1' }, { design: 'lamp', items: [{ name: 'gaps', pass: false }] })
    expect(fitLines().map((l) => l.on[0]!.id)).toEqual(['lamp'])
  })

  it('the automatic check alone draws no lines, while its notes keep its result', () => {
    setTouches([touch('ship', 'lamp')])
    expect(fitLines()).toEqual([])
    expect(objectFit('ship')?.gaps).toHaveLength(1)
    expect(allTouches()).toHaveLength(1)
  })

  it('a tool’s gap check on an object with no near miss draws nothing', () => {
    setFit('ship', null)
    fitToolRan('geom.fit_check', { design: 'ship' }, { pieces: 1 })
    expect(fitLines()).toEqual([])
  })
})
