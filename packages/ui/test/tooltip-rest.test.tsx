// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A control that slides under a resting pointer gets no tip: a press that removes a row (a copy in Compare presets)
// moves the next row's button under the pointer, and the browser reports that as the pointer coming over it. The tip
// waits until the pointer really moves.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIP_TIMING, TooltipHost } from '../src/components/tooltip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let first: HTMLButtonElement
let next: HTMLButtonElement

function anchor(title: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.setAttribute('data-tip-title', title)
  return b
}

beforeEach(() => {
  vi.useFakeTimers()
  // the host ignores hovers just after a dialog opens; start the fake clock past that
  vi.advanceTimersByTime(1000)
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
  first = anchor('Use this value in Draft')
  next = anchor('Use this value in Draft, next row')
  document.body.append(first, next)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(TooltipHost, { resolve: (el: HTMLElement) => ({ title: el.getAttribute('data-tip-title') ?? '' }) })))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
})

const tip = () => document.getElementById('sx-tip')
const at = (x: number, y: number) => ({ bubbles: true, clientX: x, clientY: y })
const fire = (el: Element, type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  act(() => void el.dispatchEvent(Object.assign(new MouseEvent(type, at(x, y)), extra)))
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

/** The pointer comes over `first` at (x, y) and clicks it. */
function press(x: number, y: number, pointerType = 'mouse') {
  fire(first, 'pointerover', x, y, { pointerType })
  fire(first, 'pointerdown', x, y, { pointerType })
  fire(first, 'pointerup', x, y, { pointerType })
  fire(first, 'click', x, y)
}

describe('a control that slides under a resting pointer', () => {
  it('gets no tip after a click, while the pointer stays where it clicked', () => {
    press(100, 40)
    // The row went away and the next button now sits under the pointer.
    fire(next, 'pointerover', 100, 40)
    fire(next, 'pointermove', 100, 40)
    wait(TIP_TIMING.cold + 100)
    expect(tip()).toBeNull()
  })

  it('gets no tip after a tap either', () => {
    press(100, 40, 'touch')
    fire(next, 'pointerover', 100, 40)
    wait(TIP_TIMING.cold + 100)
    expect(tip()).toBeNull()
  })

  it('gets its tip once the pointer moves', () => {
    press(100, 40)
    fire(next, 'pointerover', 100, 40)
    wait(TIP_TIMING.cold + 100)
    expect(tip()).toBeNull()
    fire(next, 'pointermove', 103, 41)
    fire(next, 'pointerover', 103, 41)
    wait(TIP_TIMING.cold + 100)
    expect(tip()?.textContent).toBe('Use this value in Draft, next row')
  })

  it('leaves a pointer that moves onto another control alone', () => {
    press(100, 40)
    fire(next, 'pointermove', 100, 70)
    fire(next, 'pointerover', 100, 70)
    wait(TIP_TIMING.cold + 100)
    expect(tip()?.textContent).toBe('Use this value in Draft, next row')
  })
})
