// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The toolpath legend starts as a chip, so a job opens with the view clear: the Color by menu and a list button. The
// list opens below the chip from that button or the look's legend key, Escape shuts it, and open or shut is kept
// between sessions.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PreviewBuffers } from '@slicerx/contracts'
import { loadPrefs, normalizePrefs } from '../src/state/prefs'
import { get, set } from '../src/state/store'
import { FRAMED_OVERLAYS, overlayInsets } from '../src/viewport/overlay-insets'
import { toggleLegend } from '../src/workspaces/preview/layer-keys'
import { Legend } from '../src/workspaces/preview/preview-hud'

const KEY = 'slicerx.prefs.v1'

/** A one-layer preview with no moves: enough for the legend to show. */
const preview = { raw: new ArrayBuffer(0), segmentCount: 0, layerCount: 1, layerStart: Uint32Array.from([0, 0]), layerTimeS: Float32Array.from([1]), segmentsOffset: 0, toolCount: 1, extrasOffset: -1 } as unknown as PreviewBuffers

const list = () => screen.queryByRole('list', { name: 'Toolpath legend' })
const toggle = () => screen.getByTestId('legend-toggle')

beforeEach(() => set({ preview, colorMode: 'feature', colorModePicked: false, colorModeAuto: null, legendOpen: false }))
afterEach(() => {
  cleanup()
  set({ preview: null, legendOpen: false })
})

describe('the legend chip', () => {
  it('is shut by default, in a fresh install and in saved preferences without the choice', () => {
    expect(normalizePrefs({}).legendOpen).toBe(false)
    expect(normalizePrefs({ legendOpen: 'yes' }).legendOpen).toBe(false)
    localStorage.removeItem(KEY)
    expect(loadPrefs().legendOpen ?? false).toBe(false)
  })

  it('shows only the chip at first: the Color by menu and a list button, and no list', () => {
    render(createElement(Legend))
    expect(screen.getByTestId('legend-chip')).toBeTruthy()
    expect(screen.getByTestId('legend-color-by').textContent).toContain('Feature type')
    expect(screen.getByRole('button', { name: 'Color by Feature type' })).toBeTruthy()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(list()).toBeNull()
  })

  it('opens the list below the chip from its button, and Escape shuts it and gives the focus back', () => {
    render(createElement(Legend))
    fireEvent.click(toggle())
    expect(get().legendOpen).toBe(true)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const ul = list()!
    expect(ul).toBeTruthy()
    expect(toggle().getAttribute('aria-controls')).toBe(ul.id)
    // the markers are in the list
    expect(ul.textContent).toContain('Markers')
    const box = ul.querySelector('input')!
    box.focus()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(get().legendOpen).toBe(false)
    expect(list()).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('opens and shuts with the legend key action too', () => {
    render(createElement(Legend))
    act(() => toggleLegend())
    expect(list()).toBeTruthy()
    act(() => toggleLegend())
    expect(list()).toBeNull()
  })

  it('leaves the camera framing alone when the list opens: only the chip counts as an inset', () => {
    // Boxes as at 1440 wide: the chip in the corner row, the list hanging below it over the view.
    const at = (el: Element) => (el.matches('.legend') ? { left: 445, top: 190, right: 645, bottom: 530 } : el.matches('.legend-chip') ? { left: 445, top: 140, right: 600, bottom: 180 } : { left: 0, top: 0, right: 0, bottom: 0 })
    const stage = { left: 421, top: 69, right: 1375, bottom: 855 }
    const insets = () => overlayInsets(stage, [...document.querySelectorAll(FRAMED_OVERLAYS)].map(at))
    render(createElement(Legend))
    const shut = insets()
    expect(shut.top).toBeGreaterThan(0)
    fireEvent.click(toggle())
    expect(list()).toBeTruthy()
    expect(list()!.matches(FRAMED_OVERLAYS)).toBe(false)
    expect(insets()).toEqual(shut)
  })

  it('keeps open or shut between sessions', () => {
    act(() => set({ legendOpen: true }))
    expect(JSON.parse(localStorage.getItem(KEY)!).legendOpen).toBe(true)
    expect(loadPrefs().legendOpen).toBe(true)
    act(() => set({ legendOpen: false }))
    expect(JSON.parse(localStorage.getItem(KEY)!).legendOpen).toBe(false)
    expect(normalizePrefs({ legendOpen: true }).legendOpen).toBe(true)
  })
})
