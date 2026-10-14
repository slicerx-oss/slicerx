// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's cards and the cursor pills: when the solid card folds and why, the view's mode pill words, the
// live numbers each tool's pills show, and typing and Tab in the pills.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorPills, nextPill, placePills, type CursorPillsHandle } from '../src/cad/cursor-pills'
import { emptyDraft, fieldsFor, liveValues, typedPoint, type Draft } from '../src/cad/sketch-model'
import { appState } from '../src/agent-bridge/page'
import { Card, Num } from '../src/cad/panel-kit'
import { get } from '../src/state/store'
import { applyReason, lookAtSketch, profileState, provideSketchLook, setSketchMode, sketchMode, sketchModeText, solidCard, surfaceOf } from '../src/cad/sketch-mode'

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

describe('profile and why Extrude waits', () => {
  const base = { drawing: false, checked: true, finish: 'extrude' as const, axis: false, op: 'new' as const, target: false }
  it('tells nothing drawn, open, closed but invalid, and valid apart', () => {
    expect(profileState({ drawn: false, closedProfiles: 0, checked: false, ok: false, issues: [] })).toBe('none')
    expect(profileState({ drawn: true, closedProfiles: 0, checked: true, ok: false, issues: [{}] })).toBe('open')
    expect(profileState({ drawn: true, closedProfiles: 1, checked: true, ok: false, issues: [{}] })).toBe('invalid')
    expect(profileState({ drawn: true, closedProfiles: 1, checked: true, ok: true, issues: [] })).toBe('valid')
  })
  it('gives a reason for every way Extrude or Revolve is off, and none when it can run', () => {
    expect(applyReason({ ...base, profile: 'valid', drawing: true })).toMatch(/End the shape/)
    expect(applyReason({ ...base, profile: 'none' })).toBe('Draw a closed outline to make a solid.')
    expect(applyReason({ ...base, profile: 'open' })).toBe('Close the outline to make a solid.')
    expect(applyReason({ ...base, profile: 'invalid', firstIssue: 'Loop 1 crosses itself.' })).toBe('Loop 1 crosses itself.')
    expect(applyReason({ ...base, profile: 'valid', checked: false })).toBe('Checking the sketch.')
    expect(applyReason({ ...base, profile: 'valid', finish: 'revolve' })).toBe('Pick a straight line of the sketch as the axis.')
    expect(applyReason({ ...base, profile: 'valid', op: 'cut' })).toBe('Pick a body to cut from.')
    expect(applyReason({ ...base, profile: 'valid' })).toBeNull()
    expect(applyReason({ ...base, profile: 'valid', finish: 'revolve', axis: true, op: 'join', target: true })).toBeNull()
  })
})

describe('typed numbers to a point', () => {
  const close = (p: unknown, want: [number, number]) => {
    expect(Array.isArray(p)).toBe(true)
    const [x, y] = p as [number, number]
    // points keep six decimals (a nanometer), so compare to five
    expect(x).toBeCloseTo(want[0], 5)
    expect(y).toBeCloseTo(want[1], 5)
  }
  it('puts a line end at the typed length and angle from the start, whatever the cursor', () => {
    const d = at('line', [[2, 3]])
    close(typedPoint(d, [12, 30], [-50, -50]), [2 + 12 * Math.cos(Math.PI / 6), 3 + 12 * Math.sin(Math.PI / 6)])
    close(typedPoint(d, [10, 90], [99, 0]), [2, 13])
    close(typedPoint(d, [10, 225], [0, 0]), [2 - 10 / Math.SQRT2, 3 - 10 / Math.SQRT2])
  })
  it('takes the cursor for a pill left empty', () => {
    const d = at('line', [[0, 0]])
    close(typedPoint(d, [5, null], [0, 10]), [0, 5])
    close(typedPoint(d, [null, 0], [3, 4]), [5, 0])
  })
  it('refuses a length of 0 or less instead of placing a wrong point', () => {
    expect(typeof typedPoint(at('line', [[0, 0]]), [0, 30], [1, 1])).toBe('string')
    expect(typeof typedPoint(at('line', [[0, 0]]), [-4, 30], [1, 1])).toBe('string')
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
  const props = { fields, focus: 0, editing: null, onFocus: () => undefined, onChange: () => undefined, onCommit: () => undefined, onCancel: () => undefined, onLeave: () => undefined }

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

  it('type into the focused pill; Tab moves on, Enter places, Esc clears the pill', () => {
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
    // typed and live read apart: the group is in typing mode, and only the pill with typed text is marked typed
    expect(screen.getByTestId('sketch-pills').hasAttribute('data-typing')).toBe(true)
    expect(screen.getAllByTestId('sketch-pill').map((p) => p.hasAttribute('data-typed'))).toEqual([true, false])
    fireEvent.change(length, { target: { value: '25' } })
    expect(onChange).toHaveBeenLastCalledWith(['25', ''])
    fireEvent.keyDown(length, { key: 'Tab' })
    expect(onFocus).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(length, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledOnce()
    // Esc in a typed pill clears it, so it follows the cursor again; typing goes on
    fireEvent.keyDown(length, { key: 'Escape' })
    expect(onChange).toHaveBeenLastCalledWith(['', ''])
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Esc in an empty pill ends typing', () => {
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const ref = createRef<CursorPillsHandle>()
    render(createElement(CursorPills, { ...props, ref, focus: 1, editing: ['20', ''], onCancel, onChange }))
    act(() => ref.current!.show(10, 10, ['12.00', '45.0'], null))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Angle °' }), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('hold still while a number is typed, so the field never jumps from the caret', () => {
    const ref = createRef<CursorPillsHandle>()
    render(createElement(CursorPills, { ...props, ref, editing: ['2', ''] }))
    act(() => ref.current!.show(100, 200, ['12.00', '45.0'], null))
    const box = screen.getByTestId('sketch-pills')
    expect([box.style.left, box.style.top]).toEqual(['116px', '216px'])
    act(() => ref.current!.show(300, 50, ['30.00', '10.0'], null))
    expect([box.style.left, box.style.top]).toEqual(['116px', '216px'])
    // the live hint in the empty pill still follows the cursor
    expect((screen.getByRole('textbox', { name: 'Angle °' }) as HTMLInputElement).placeholder).toBe('10.0')
  })

  it('let Tab out past the last pill and Shift+Tab out before the first: no focus trap', () => {
    const onFocus = vi.fn()
    const onLeave = vi.fn()
    const ref = createRef<CursorPillsHandle>()
    render(createElement(CursorPills, { ...props, ref, focus: 1, editing: ['20', '30'], onFocus, onLeave }))
    act(() => ref.current!.show(10, 10, ['2.00', '0.0'], null))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Angle °' }), { key: 'Tab' })
    expect(onLeave).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Length mm' }), { key: 'Tab', shiftKey: true })
    expect(onLeave).toHaveBeenLastCalledWith(true)
    expect(onFocus).not.toHaveBeenCalled()
    // one pill: Tab leaves at once
    cleanup()
    render(createElement(CursorPills, { ...props, ref, fields: [{ label: 'Radius', unit: 'mm' }], focus: 0, editing: ['3'], onLeave }))
    act(() => ref.current!.show(10, 10, ['2.00'], null))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Radius mm' }), { key: 'Tab' })
    expect(onLeave).toHaveBeenCalledTimes(3)
  })
})

describe('the panel pieces the sketch adds to', () => {
  it('names what a card is doing after its title, keeping the title as its name', () => {
    render(createElement(Card, { title: 'Drawing', sub: 'Line', testId: 'sketch-drawing' }))
    const card = screen.getByRole('region', { name: 'Drawing' })
    expect(card.querySelector('h4')!.textContent).toBe('Drawing · Line')
    expect(screen.getByTestId('sketch-drawing-sub').textContent).toBe(' · Line')
  })

  it("writes a number field's unit beside its label, the field holding only the number", () => {
    render(createElement(Num, { id: 't-dist', label: 'Distance', unit: 'mm', value: '5', onChange: () => {} }))
    const field = screen.getByRole('textbox', { name: 'Distance mm' }) as HTMLInputElement
    expect(field.value).toBe('5')
    expect(field.closest('.sx-inputwrap')?.querySelector('.sx-inputwrap-unit') ?? null).toBeNull()
    expect(document.querySelector('label[for="t-dist"]')!.textContent).toBe('Distance mm')
  })
})

describe('where the pills sit', () => {
  const view = { left: 300, top: 120, right: 1110, bottom: 855 }
  const w = 220
  const h = 26
  const covers = (p: { left: number; top: number }, x: number, y: number) => x >= p.left && x <= p.left + w && y >= p.top && y <= p.top + h
  it('sits below and right of the cursor, clear of it', () => {
    expect(placePills(500, 400, w, h, view)).toEqual({ left: 516, top: 416 })
  })
  it("flips to the cursor's left near the right edge and above it near the bottom, staying in the view", () => {
    const p = placePills(1050, 840, w, h, view)
    expect(p).toEqual({ left: 1050 - 16 - w, top: 840 - 16 - h })
    expect(covers(p, 1050, 840)).toBe(false)
  })
  it('never covers the point being placed anywhere in the view', () => {
    for (let x = view.left; x <= view.right; x += 37)
      for (let y = view.top; y <= view.bottom; y += 41) {
        const p = placePills(x, y, w, h, view)
        expect(p.left).toBeGreaterThanOrEqual(view.left)
        expect(p.left + w).toBeLessThanOrEqual(view.right)
        expect(p.top).toBeGreaterThanOrEqual(view.top)
        expect(p.top + h).toBeLessThanOrEqual(view.bottom)
        expect(covers(p, x, y)).toBe(false)
      }
  })
})

describe('the read-back', () => {
  it("has the open sketch in app_state as the mode pill reads it, and null once it closes", () => {
    expect(appState(get())['sketch']).toBeNull()
    setSketchMode({ on: 'face', label: 'A face of Box', tool: 'Line' })
    expect(appState(get())['sketch']).toEqual({ on: 'face', label: 'A face of Box', tool: 'Line', mode: 'Sketching on a face · Line' })
    // with the panel's check in: the profile, dof, whether Extrude can run and why not, and the loops
    const loops = [{ closed: true, points: [[0, 0], [10, 0], [10, 10]] }]
    setSketchMode({ on: 'face', label: 'A face of Box', tool: 'Line', profile: 'valid', dof: 2, ready: true, reason: null, loops })
    expect(appState(get())['sketch']).toEqual({ on: 'face', label: 'A face of Box', tool: 'Line', mode: 'Sketching on a face · Line', profile: 'valid', dof: 2, ready: true, reason: null, loops })
    setSketchMode(null)
    expect(appState(get())['sketch']).toBeNull()
  })
})

describe('the phone keyboard', () => {
  it('lifts the sheet by what the on-screen keyboard covers, and not at all without one', async () => {
    const { keyboardLift } = await import('../src/cad/sketch-panel')
    expect(keyboardLift(844, { height: 844, offsetTop: 0 })).toBe(0)
    expect(keyboardLift(844, { height: 508, offsetTop: 0 })).toBe(336)
    expect(keyboardLift(844, { height: 508, offsetTop: 40 })).toBe(296)
    expect(keyboardLift(844, { height: 900, offsetTop: 0 })).toBe(0)
  })
})
