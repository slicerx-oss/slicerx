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
  return host.querySelector<HTMLElement>('.sx-menu')!
}

afterEach(() => {
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

  it('scrolls itself when neither side has room for all of it', () => {
    Object.assign(boxes, { pane: { top: 100, bottom: 500 }, trigger: { top: 300, bottom: 330 } })
    layout(465)
    const m = openMenu()
    expect(m.dataset['side']).toBe('top')
    expect(m.style.maxHeight).toBe('196px')
  })
})
