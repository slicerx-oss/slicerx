// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A menu at the edge of a scrolling side pane (Export, at the right end of the Objects actions) is lifted out of
// the pane so nothing cuts it off, and stays inside the window.
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu, MenuAnchor, MenuItem } from '@slicerx/ui'

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

describe('a floating menu in a side pane', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('is lifted out of the pane when the pane would cut it off at the side, and stays in the window', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(260)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if ((this as HTMLElement).dataset?.['testid'] === 'pane') return rect(0, 0, 340, 800)
      if ((this as HTMLElement).classList?.contains('sx-menu-anchor')) return rect(260, 100, 70, 28)
      return rect(0, 0, 0, 0)
    })
    render(
      createElement(
        'div',
        { 'data-testid': 'pane', style: { overflowX: 'auto', overflowY: 'auto' } },
        createElement(MenuAnchor, null, createElement('button', null, 'Export'), createElement(Menu, { open: true, onClose: () => undefined, label: 'Export' }, createElement(MenuItem, null, 'Save project'))),
      ),
    )
    const menu = await screen.findByRole('menu', { name: 'Export' })
    expect(menu.dataset['lifted']).toBe('true')
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.position).toBe('fixed')
    const left = parseFloat(menu.style.left)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + 260).toBeLessThanOrEqual(1440 - 8)
    expect(menu.style.top).toBe('132px')
    spy.mockRestore()
  })

  it('stays in the pane when it fits there', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if ((this as HTMLElement).dataset?.['testid'] === 'pane') return rect(0, 0, 340, 800)
      if ((this as HTMLElement).classList?.contains('sx-menu-anchor')) return rect(20, 100, 70, 28)
      return rect(0, 0, 0, 0)
    })
    render(
      createElement(
        'div',
        { 'data-testid': 'pane', style: { overflowX: 'auto', overflowY: 'auto' } },
        createElement(MenuAnchor, null, createElement('button', null, 'Add shape'), createElement(Menu, { open: true, onClose: () => undefined, label: 'Add shape' }, createElement(MenuItem, null, 'Box'))),
      ),
    )
    const menu = await screen.findByRole('menu', { name: 'Add shape' })
    expect(menu.dataset['lifted']).toBeUndefined()
    expect(menu.parentElement?.classList.contains('sx-menu-anchor')).toBe(true)
  })
})
