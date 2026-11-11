// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A long press on touch stands in for a right click: about half a second, cancelled by a move or a scroll, and
// nothing at all for a mouse. The hold counts on the frame after the half second, and after a busy stretch only once
// frames run on time again, so a move still on its way to a busy page ends it first. A lift is read by its own time, so a
// quick tap that a busy page sees late stays a tap.
// @vitest-environment jsdom
import { createElement } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, useContextMenu, useLongPress } from '../src/components/context-menu'

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
/** The finger lifts; `at` is when it lifted by the event's own clock (the default is now), which a busy page sees late. */
function up(el: Element, at?: number): void {
  const e = new Event('pointerup', { bubbles: true })
  Object.assign(e, { pointerType: 'touch' })
  if (at !== undefined) Object.defineProperty(e, 'timeStamp', { value: at })
  flushSync(() => el.dispatchEvent(e))
}
function move(el: Element, x: number, y: number): void {
  const e = new Event('pointermove', { bubbles: true })
  Object.assign(e, { pointerType: 'touch', clientX: x, clientY: y })
  flushSync(() => el.dispatchEvent(e))
}

/** One frame on: the hold counts on the frame after its timer. */
const frame = (): void => void vi.advanceTimersByTime(20)

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
    expect(fired).toEqual([])
    frame()
    expect(fired).toEqual([{ x: 30, y: 40 }])
  })

  it('takes a move that reaches the page after the half second but before the next frame as a drag', () => {
    down(btn, 'touch', 10, 10)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    move(btn, 40, 10)
    frame()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toEqual([])
  })

  it('after a busy stretch, waits for frames to run on time a while, a second at most, before the press counts as held', () => {
    const real = performance.now.bind(performance)
    let skew = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => real() + skew)
    try {
      down(btn, 'touch', 10, 10)
      // the page was busy: the timer runs well past the half second, and the next frames come late too
      skew += 300
      vi.advanceTimersByTime(LONG_PRESS_MS)
      frame()
      expect(fired).toEqual([])
      skew += 300
      frame()
      expect(fired).toEqual([])
      move(btn, 40, 10)
      for (let i = 0; i < 6; i++) frame()
      expect(fired).toEqual([])

      // on-time frames after a late timer: held once they have run for a while
      down(btn, 'touch', 20, 20)
      skew += 300
      vi.advanceTimersByTime(LONG_PRESS_MS)
      for (let i = 0; i < 3; i++) frame()
      expect(fired).toEqual([])
      for (let i = 0; i < 5; i++) frame()
      expect(fired).toEqual([{ x: 20, y: 20 }])
      fired.length = 0

      // frames that keep coming late hold it back a second at most
      down(btn, 'touch', 10, 10)
      skew += 300
      vi.advanceTimersByTime(LONG_PRESS_MS)
      for (let i = 0; i < 6; i++) {
        skew += 300
        frame()
      }
      expect(fired).toEqual([{ x: 10, y: 10 }])
    } finally {
      now.mockRestore()
    }
  })

  it('counts a lift that comes while the hold waits on a frame as a long press', () => {
    down(btn, 'touch', 10, 10)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    up(btn)
    expect(fired).toEqual([{ x: 10, y: 10 }])
    frame()
    expect(fired).toHaveLength(1)
  })

  it('keeps a quick tap a tap when a busy page runs the timer before the lift', () => {
    const t0 = Date.now()
    down(btn, 'touch', 10, 10)
    // the page was busy past the half second: the timer runs first, then the lift made 60 ms after the press
    vi.advanceTimersByTime(LONG_PRESS_MS)
    up(btn, t0 + 60)
    for (let i = 0; i < 60; i++) frame()
    expect(fired).toEqual([])
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1])

    // a lift made after the half second, seen as late, is still a long press
    const t1 = Date.now()
    down(btn, 'touch', 20, 20)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    up(btn, t1 + LONG_PRESS_MS + 10)
    expect(fired).toEqual([{ x: 20, y: 20 }])
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1])
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
    up(btn)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toEqual([])
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1])

    down(btn, 'touch')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    frame()
    expect(fired).toHaveLength(1)
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1])
    flushSync(() => (btn as HTMLElement).click())
    expect(clicks).toEqual([1, 1])
  })
})

describe('a menu the pressed element opened', () => {
  // The marks menu over the layer track sits in a portal, and React hands its events to the track: a press held on one
  // of its items opened the track's own menu in its place, at the layer under the finger.
  it('takes no long press or right click from inside a portal it renders', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const opened: Array<{ x: number; y: number } | null> = []
    function Track() {
      const press = useLongPress((_, at) => fired.push(at))
      const ctx = useContextMenu()
      opened.push(ctx.at)
      return createElement('div', { id: 'track', ...press.bind, onContextMenu: ctx.bind.onContextMenu }, createElement('span', { id: 'own' }, 'own'), createPortal(createElement('button', { id: 'item' }, 'item'), document.body))
    }
    flushSync(() => createRoot(host).render(createElement(Track)))
    const item = document.getElementById('item')!
    down(item, 'touch', 5, 6)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    frame()
    up(item)
    expect(fired).toEqual([])
    const right = (el: Element) => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 7, clientY: 8 })
      flushSync(() => el.dispatchEvent(e))
      return e
    }
    expect(right(item).defaultPrevented).toBe(true)
    expect(opened.at(-1)).toBeNull()

    // the element's own children still take both
    const own = document.getElementById('own')!
    down(own, 'touch', 5, 6)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    frame()
    expect(fired).toEqual([{ x: 5, y: 6 }])
    right(own)
    expect(opened.at(-1)).toEqual({ x: 7, y: 8 })
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
    frame()
    expect(fired).toEqual([{ x: 5, y: 6 }])
  })
})
