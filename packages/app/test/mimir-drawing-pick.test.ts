// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone's pick of what a sheet's drawing shows: it opens on Top and Isometric together, unfolded, with Front and
// Right behind the picker; a pick or a fold holds for its sheet and starts over with the next one; and a picked row
// moves the drawing back to Top and iso only when the view showing does not draw its callout.
import type { PilotDim, PilotSheetSolid } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { drawingPick, FIRST_PANE, foldDrawing, PANE_NAMES, PANE_VIEWS, paneShowing, PHONE_PANES, pickFor, pickPane, showPane, START, toggleFold } from '../src/workspaces/mimir/drawing-pick'
import { drawView, fitScale, viewsFor, type ViewName } from '../src/workspaces/mimir/sheet-draw'
import { backplatePart } from '../src/workspaces/mimir/scripts'

describe('the phone drawing pick', () => {
  beforeEach(() => drawingPick.setState(START, true))

  it('opens on Top and Isometric together, with Front and Right one at a time behind the picker', () => {
    expect(PHONE_PANES).toEqual(['main', 'front', 'side'])
    expect(PHONE_PANES.map((p) => PANE_NAMES[p])).toEqual(['Top and iso', 'Front', 'Right'])
    expect(PANE_VIEWS).toEqual({ main: ['top', 'iso'], front: ['front'], side: ['side'] })
    expect(FIRST_PANE).toBe('main')
    expect(pickFor(START, 's1')).toEqual({ sheetId: 's1', pane: 'main', folded: false })
  })

  it('keeps a pick and a fold for the same sheet and starts over for the next one', () => {
    const held = toggleFold(pickPane(pickFor(START, 's1'), 'front'))
    expect(held).toEqual({ sheetId: 's1', pane: 'front', folded: true })
    expect(pickFor(held, 's1')).toBe(held)
    expect(pickFor(held, 's2')).toEqual({ sheetId: 's2', pane: 'main', folded: false })
  })

  it('leaves the pick alone for the choice already showing', () => {
    const s = pickFor(START, 's1')
    expect(pickPane(s, 'main')).toBe(s)
    expect(pickPane(s, 'front').pane).toBe('front')
    expect(pickPane(pickPane(s, 'front'), 'side').pane).toBe('side')
  })

  it('folds and opens again on the choice it had', () => {
    const s = pickPane(pickFor(START, 's1'), 'side')
    const folded = toggleFold(s)
    expect(folded.folded).toBe(true)
    expect(toggleFold(folded)).toEqual({ ...s, folded: false })
  })

  it('moves to a choice that draws the picked row only when the one showing does not', () => {
    const has = (views: ViewName[]) => (v: ViewName) => views.includes(v)
    expect(paneShowing('main', has(['top', 'iso']))).toBe('main')
    expect(paneShowing('main', has(['iso']))).toBe('main')
    expect(paneShowing('front', has(['front', 'iso']))).toBe('front')
    expect(paneShowing('front', has(['side', 'iso']))).toBe('main')
    expect(paneShowing('side', has(['top']))).toBe('main')
    expect(paneShowing('main', has(['side']))).toBe('side')
    expect(paneShowing('front', has([]))).toBe('front')
  })

  it("draws every one of the backplate's sizes in Top and iso, inside a phone's frames and apart", () => {
    const p = backplatePart({ plate_width: 150.4, plate_height: 110.4, thickness: 3, center_hole: 30, screw_hole: 4.5, screw_spacing: 60 })
    const dims: PilotDim[] = Object.entries(p.at).map(([key, v]) => ({ key, label: key, value: 1, unit: 'mm', source: key === 'thickness' ? 'guess' : 'lookup', at: (v as { at: NonNullable<PilotDim['at']> }).at }))
    const order: ViewName[] = ['top', 'side']
    const shown = viewsFor(dims, order)
    for (const d of dims) expect(shown.get(d.key)!.some((v) => PANE_VIEWS[FIRST_PANE].includes(v))).toBe(true)
    // the frames a 360 px and a 390 px wide phone give each view: half the width for Top and iso, all of it alone
    for (const [w, h] of [[326, 120], [356, 133]] as const) {
      for (const pane of PHONE_PANES) {
        const cw = Math.floor(w / PANE_VIEWS[pane].length)
        const flat = Math.min(...(['front', 'side', 'top'] as const).map((v) => fitScale(p.part as PilotSheetSolid[], dims, v, cw, h, 24, order)))
        for (const view of PANE_VIEWS[pane]) {
          const drawn = drawView(p.part as PilotSheetSolid[], dims, view, cw, h, { pad: 24, order, ...(view === 'iso' ? {} : { scale: flat }) })
          if (view === 'iso') expect(drawn.dims).toHaveLength(dims.length)
          for (const d of drawn.dims) {
            expect(d.badge[0], `${d.key} in ${view} at ${cw} px`).toBeGreaterThanOrEqual(10)
            expect(d.badge[0], `${d.key} in ${view} at ${cw} px`).toBeLessThanOrEqual(cw - 10)
            expect(d.badge[1], `${d.key} in ${view} at ${cw} px`).toBeGreaterThanOrEqual(10)
            expect(d.badge[1], `${d.key} in ${view} at ${cw} px`).toBeLessThanOrEqual(h - 10)
          }
          for (let i = 0; i < drawn.dims.length; i++) for (let j = i + 1; j < drawn.dims.length; j++) expect(Math.hypot(drawn.dims[i]!.badge[0] - drawn.dims[j]!.badge[0], drawn.dims[i]!.badge[1] - drawn.dims[j]!.badge[1])).toBeGreaterThanOrEqual(19)
        }
      }
    }
  })

  it('holds the store per sheet through showPane and foldDrawing', () => {
    showPane('s1', 'front')
    foldDrawing('s1')
    expect(drawingPick.getState()).toEqual({ sheetId: 's1', pane: 'front', folded: true })
    showPane('s2', 'side')
    expect(drawingPick.getState()).toEqual({ sheetId: 's2', pane: 'side', folded: false })
    showPane('s2', 'side')
    expect(drawingPick.getState().pane).toBe('side')
  })
})
