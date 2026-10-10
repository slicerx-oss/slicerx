// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Menu, MenuAnchor, MenuItem } from '@slicerx/ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// jsdom has no layout: each element reports the box its class asks for.
const boxes: Record<string, { top: number; bottom: number }> = {}
function layout(menuHeight: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const b = Object.entries(boxes).find(([cls]) => this.classList.contains(cls))?.[1] ?? { top: 0, bottom: 0 }
    return { ...b, left: 0, right: 100, width: 100, height: b.bottom - b.top, x: 0, y: b.top, toJSON: () => b } as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('sx-menu') ? menuHeight : 0
  })
}

function openMenu(): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  const item = (n: number) => createElement(MenuItem, { key: n }, `Item ${n}`)
  const tree = createElement(
    'div',
    { className: 'pane', style: { overflowY: 'auto' } },
    createElement(MenuAnchor, { className: 'trigger' }, createElement(Menu, { open: true, onClose: () => undefined, label: 'Tools' }, [1, 2, 3].map(item))),
  )
  flushSync(() => createRoot(host).render(tree))
  // a menu lifted out of its panel is drawn in the page's body
  return document.querySelector<HTMLElement>('.sx-menu')!
}

const tall = window.innerHeight
/** The window's height, for a test that needs a window with no more room than its panel. */
function windowHeight(px: number): void {
  Object.defineProperty(window, 'innerHeight', { value: px, configurable: true })
}

afterEach(() => {
  windowHeight(tall)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('menu placement', () => {
  it('opens below its trigger when there is room', () => {
    Object.assign(boxes, { pane: { top: 100, bottom: 700 }, trigger: { top: 120, bottom: 150 } })
    layout(300)
    const m = openMenu()
    expect(m.dataset['side']).toBeUndefined()
    expect(m.style.maxHeight).toBe('')
  })

  it('opens above a trigger near the bottom of a scrolling panel instead of being cut off', () => {
    Object.assign(boxes, { pane: { top: 100, bottom: 700 }, trigger: { top: 600, bottom: 630 } })
    layout(465)
    const m = openMenu()
    expect(m.dataset['side']).toBe('top')
    expect(m.style.maxHeight).toBe('')
  })

  it('scrolls itself when neither side has room for all of it, in the panel or the window', () => {
    // the panel fills the window, so lifting the menu out would give it no more room
    windowHeight(520)
    Object.assign(boxes, { pane: { top: 0, bottom: 520 }, trigger: { top: 300, bottom: 330 } })
    layout(465)
    const m = openMenu()
    expect(m.dataset['lifted']).toBeUndefined()
    expect(m.dataset['side']).toBe('top')
    expect(m.style.maxHeight).toBe('296px')
  })

  it('lifts itself out of a panel too short for it when the window has room', () => {
    Object.assign(boxes, { pane: { top: 100, bottom: 260 }, trigger: { top: 120, bottom: 150 } })
    layout(465)
    const m = openMenu()
    expect(m.dataset['lifted']).toBe('true')
    expect(m.parentElement).toBe(document.body)
    expect(m.style.position).toBe('fixed')
    expect(m.style.maxHeight).toBe('')
  })
})
