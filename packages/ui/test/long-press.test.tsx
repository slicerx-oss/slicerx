// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A long press on touch stands in for a right click: about half a second, cancelled by a move or a scroll, and
// nothing at all for a mouse.
// @vitest-environment jsdom
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, useLongPress } from '../src/components/context-menu'

const fired: Array<{ x: number; y: number }> = []
const clicks: number[] = []

function Probe() {
  const press = useLongPress((_, at) => fired.push(at))
  return createElement('button', { id: 'b', ...press.bind, onClick: () => clicks.push(1) }, 'x')
}

function down(el: Element, pointerType: string, x = 10, y = 10): void {
  const e = new Event('pointerdown', { bubbles: true })
  Object.assign(e, { pointerType, clientX: x, clientY: y })
  flushSync(() => el.dispatchEvent(e))
}
function move(el: Element, x: number, y: number): void {
  const e = new Event('pointermove', { bubbles: true })
  Object.assign(e, { pointerType: 'touch', clientX: x, clientY: y })
  flushSync(() => el.dispatchEvent(e))
}

let btn: Element
beforeEach(() => {
  vi.useFakeTimers()
  fired.length = 0
  clicks.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  flushSync(() => createRoot(host).render(createElement(Probe)))
  btn = document.getElementById('b')!
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the long press hook', () => {
  it('fires after the hold on touch, at the point of the press', () => {
    down(btn, 'touch', 30, 40)
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual([{ x: 30, y: 40 }])
  })

  it('does nothing for a mouse or a pen', () => {
    down(btn, 'mouse')
    down(btn, 'pen')
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(fired).toEqual([])
  })

  it('cancels when the finger moves past the slop', () => {
    down(btn, 'touch', 10, 10)
    move(btn, 11, 10)
    vi.advanceTimersByTime(LONG_PRESS_MS - 100)
    move(btn, 40, 10)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toEqual([])
  })

  it('cancels when the page scrolls', () => {
    down(btn, 'touch')
    vi.advanceTimersByTime(200)
    document.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toEqual([])
  })

  it('cancels when the finger lifts early, and drops the click after a long press only', () => {
    down(btn, 'touch')
    vi.advanceTimersByTime(100)
    btn.dispatchEvent(new Event('pointerup', { bubbles: true }))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toEqual([])
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1])

    down(btn, 'touch')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveLength(1)
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1])
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1, 1])
  })
})

describe('the edge tab', () => {
  it('takes the long press handlers, so touch reaches what a right click does', async () => {
    const { EdgeTab } = await import('../src/components/edge-tab')
    const host = document.createElement('div')
    document.body.appendChild(host)
    function Tab() {
      const press = useLongPress((_, at) => fired.push(at))
      return createElement(EdgeTab, { side: 'bottom', open: false, onToggle: () => undefined, label: 'Preview', longPress: press.bind })
    }
    flushSync(() => createRoot(host).render(createElement(Tab)))
    down(host.querySelector('button')!, 'touch', 5, 6)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toEqual([{ x: 5, y: 6 }])
  })
})
