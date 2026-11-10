// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tip already on screen glides to the next control's tip. A tip left outside the window (the window narrowed under
// it, from a desktop layout to a phone's) moves to its next place at once instead, so it never crosses the window's edge
// on its way in.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIP_TIMING, TooltipHost } from '../src/components/tooltip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let first: HTMLButtonElement
let next: HTMLButtonElement
// where the tip's box is, as the browser would give it
let tipBox = { left: 40, right: 360, top: 40, bottom: 120 }

function anchor(title: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.setAttribute('data-tip-title', title)
  return b
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.advanceTimersByTime(1000)
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
  const real = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.id !== 'sx-tip') return real.call(this)
    const { left, right, top, bottom } = tipBox
    return { left, right, top, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) } as DOMRect
  })
  first = anchor('Push and pull')
  next = anchor('Fillet')
  document.body.append(first, next)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(TooltipHost, { resolve: (el: HTMLElement) => ({ title: el.getAttribute('data-tip-title') ?? '' }) })))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const tip = () => document.getElementById('sx-tip')
const over = (el: Element, x: number, y: number) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
    el.dispatchEvent(Object.assign(new MouseEvent('pointerover', { bubbles: true, clientX: x, clientY: y }), { pointerType: 'mouse' }))
  })
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

describe('a tip moving to the next control', () => {
  it('glides there from a place inside the window', () => {
    over(first, 100, 40)
    wait(TIP_TIMING.cold + 100)
    expect(tip()?.textContent).toBe('Push and pull')
    over(next, 140, 40)
    wait(TIP_TIMING.warm + 50)
    expect(tip()?.textContent).toBe('Fillet')
    expect(tip()?.hasAttribute('data-glide')).toBe(true)
  })

  it('moves there at once from a place past the window edge', () => {
    over(first, 100, 40)
    wait(TIP_TIMING.cold + 100)
    expect(tip()?.textContent).toBe('Push and pull')
    // the window narrowed to 390 under a tip placed for a desktop layout: it sits from 341.5 to 661.5
    tipBox = { left: 341.5, right: 661.5, top: 40, bottom: 120 }
    over(next, 140, 40)
    wait(TIP_TIMING.warm + 50)
    expect(tip()?.textContent).toBe('Fillet')
    expect(tip()?.hasAttribute('data-glide')).toBe(false)
    tipBox = { left: 40, right: 360, top: 40, bottom: 120 }
  })
})
