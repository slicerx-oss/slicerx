// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's cards and the cursor pills: when the solid card folds and why, the view's mode pill words, the
// live numbers each tool's pills show, and typing and Tab in the pills.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorPills, nextPill, type CursorPillsHandle } from '../src/cad/cursor-pills'
import { emptyDraft, fieldsFor, liveValues, type Draft } from '../src/cad/sketch-model'
import { appState } from '../src/agent-bridge/page'
import { Choice } from '../src/cad/panel-kit'
import { get } from '../src/state/store'
import { lookAtSketch, provideSketchLook, setSketchMode, sketchMode, sketchModeText, solidCard, surfaceOf } from '../src/cad/sketch-mode'

afterEach(() => {
  cleanup()
  setSketchMode(null)
})

const at = (tool: Draft['tool'], points: [number, number][]): Draft => ({ ...emptyDraft(tool), points })

describe('solid card', () => {
  it('is folded with the first problem as its reason while the profile is open', () => {
    expect(solidCard({ featureOnly: false, closedProfiles: 0, issues: [{ message: 'Loop 1 is open: its ends do not meet.' }, { message: 'Two loops cross.' }], drawn: true })).toEqual({ open: false, reason: 'Loop 1 is open: its ends do not meet.' })
  })
  it('says what is missing when nothing is wrong yet', () => {
    expect(solidCard({ featureOnly: false, closedProfiles: 0, issues: [], drawn: false })).toEqual({ open: false, reason: 'Draw a closed outline to make a solid.' })
    expect(solidCard({ featureOnly: false, closedProfiles: 0, issues: [], drawn: true })).toEqual({ open: false, reason: 'Close the outline to make a solid.' })
  })
  it('opens on a closed profile and stays open while more is drawn', () => {
    expect(solidCard({ featureOnly: false, closedProfiles: 1, issues: [], drawn: true })).toEqual({ open: true, reason: null })
    expect(solidCard({ featureOnly: false, closedProfiles: 1, issues: [{ message: 'Loop 2 is open.' }], drawn: true }).open).toBe(true)
  })
  it('is always open for Extrude or Revolve from a finished sketch', () => {
    expect(solidCard({ featureOnly: true, closedProfiles: 0, issues: [], drawn: false }).open).toBe(true)
  })
})

describe('mode pill', () => {
  it('names where the sketch draws and the tool', () => {
    expect(sketchModeText({ on: 'face', label: 'A face of Box', tool: 'Line' })).toBe('Sketching on a face · Line')
    expect(sketchModeText({ on: 'bed', label: 'The bed', tool: 'Rectangle' })).toBe('Sketching on the bed · Rectangle')
    expect(sketchModeText({ on: 'plane', label: 'The XY plane', tool: 'Circle' })).toBe('Sketching on a plane · Circle')
    expect(sketchModeText({ on: 'sketch', label: 'Sketch 1', tool: 'Select' })).toBe('Sketching · Select')
  })
  it('reads the surface from the plane', () => {
    expect(surfaceOf({ target: { objectId: 'a' }, label: 'A face of Box' }, false)).toBe('face')
    expect(surfaceOf({ label: 'The bed' }, false)).toBe('bed')
    expect(surfaceOf({ label: 'The XZ plane' }, false)).toBe('plane')
    expect(surfaceOf({ target: { objectId: 'a' }, label: 'Editing step 2' }, true)).toBe('sketch')
  })
  it('keeps the open sketch and its look for the view', () => {
    setSketchMode({ on: 'face', label: 'A face of Box', tool: 'Line' })
    expect(sketchMode()?.tool).toBe('Line')
    const look = vi.fn()
    const release = provideSketchLook(look)
    expect(lookAtSketch()).toBe(true)
    expect(look).toHaveBeenCalledOnce()
    release()
    expect(lookAtSketch()).toBe(false)
  })
})

describe('live values', () => {
  it('match the fields of each step', () => {
    const cases: [Draft, [number, number], (number | null)[]][] = [
      [at('line', []), [3, -4], [3, -4]],
      [at('line', [[0, 0]]), [0, 10], [10, 90]],
      [at('line', [[0, 0]]), [-10, 0], [10, 180]],
      [at('rect', [[0, 0]]), [-20, 5], [20, 5]],
      [at('rectCenter', [[0, 0]]), [3, 4], [6, 8]],
      [at('circle', [[0, 0]]), [3, 4], [10]],
      [at('circle2', [[0, 0]]), [3, 4], [5]],
      [at('polygon', [[0, 0]]), [0, 7], [7]],
    ]
    for (const [d, p, want] of cases) {
      const got = liveValues(d, p)
      expect(got.length).toBe(fieldsFor(d).length)
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6))
    }
  })
  it('gives no numbers for a step that takes none', () => {
    expect(liveValues(at('arcTangent', []), [1, 1])).toEqual([])
    expect(liveValues(emptyDraft('select'), [1, 1])).toEqual([])
  })
})

describe('cursor pills', () => {
  const fields = [
    { label: 'Length', unit: 'mm' },
    { label: 'Angle', unit: '°' },
  ]
  const props = { fields, focus: 0, editing: null, onFocus: () => undefined, onChange: () => undefined, onCommit: () => undefined, onCancel: () => undefined }

  it('Tab goes round the pills, Shift+Tab back', () => {
    expect(nextPill(0, 2)).toBe(1)
    expect(nextPill(1, 2)).toBe(0)
    expect(nextPill(0, 2, true)).toBe(1)
    expect(nextPill(0, 0)).toBe(0)
  })

  it('wait hidden for the cursor, then follow it with the live numbers and the snap', () => {
    const ref = createRef<CursorPillsHandle>()
    render(createElement(CursorPills, { ...props, ref }))
    const box = screen.getByTestId('sketch-pills')
    expect(box.hidden).toBe(true)
    act(() => ref.current!.show(100, 200, ['12.00', '45.0'], 'Grid'))
    expect(box.hidden).toBe(false)
    expect(box.style.left).toBe('116px')
    expect(box.style.top).toBe('216px')
    expect(box.textContent).toContain('Length12.00mm')
    expect(box.textContent).toContain('Angle45.0°')
    expect(box.textContent).toContain('Grid')
    expect(screen.getAllByTestId('sketch-pill')[0]!.hasAttribute('data-focus')).toBe(true)
    act(() => ref.current!.hide())
    expect(box.hidden).toBe(true)
  })

  it('type into the focused pill; Tab moves on, Enter places, Esc drops', () => {
    const ref = createRef<CursorPillsHandle>()
    const onFocus = vi.fn()
    const onChange = vi.fn()
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(createElement(CursorPills, { ...props, ref, focus: 0, editing: ['2', ''], onFocus, onChange, onCommit, onCancel }))
    act(() => ref.current!.show(10, 10, ['12.00', '45.0'], null))
    const length = screen.getByRole('textbox', { name: 'Length mm' }) as HTMLInputElement
    const angle = screen.getByRole('textbox', { name: 'Angle °' }) as HTMLInputElement
    expect(document.activeElement).toBe(length)
    expect(angle.placeholder).toBe('45.0')
    fireEvent.change(length, { target: { value: '25' } })
    expect(onChange).toHaveBeenLastCalledWith(['25', ''])
    fireEvent.keyDown(length, { key: 'Tab' })
    expect(onFocus).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(length, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledOnce()
    fireEvent.keyDown(length, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('the panel pieces the sketch adds to', () => {
  it('puts a choice glyph before its word, under the same accessible name', () => {
    render(
      createElement(Choice, {
        id: 't-result',
        label: 'Result',
        value: 'join',
        onChange: () => {},
        options: [
          { value: 'join', label: 'Join', glyph: createElement('svg', { 'data-glyph': 'join' }) },
          { value: 'cut', label: 'Cut', glyph: createElement('svg', { 'data-glyph': 'cut' }) },
        ],
      }),
    )
    const join = screen.getByRole('radio', { name: 'Join' })
    expect(join.querySelector('[data-glyph="join"]')).not.toBeNull()
    expect(join.textContent).toBe('Join')
  })
})

describe('the read-back', () => {
  it("has the open sketch in app_state as the mode pill reads it, and null once it closes", () => {
    expect(appState(get())['sketch']).toBeNull()
    setSketchMode({ on: 'face', label: 'A face of Box', tool: 'Line' })
    expect(appState(get())['sketch']).toEqual({ on: 'face', label: 'A face of Box', tool: 'Line', mode: 'Sketching on a face · Line' })
    setSketchMode(null)
    expect(appState(get())['sketch']).toBeNull()
  })
})
