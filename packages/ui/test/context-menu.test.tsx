// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A context menu opens at the pointer, inside the window, from a right click, a long press or the keyboard.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContextMenu, focusGoesBack, isMenuKey, LONG_PRESS_SLOP, MenuIcon, MenuIconRow, placeAt, pressStays } from '../src/components/context-menu'
import { MenuItem } from '../src/components/menu'

const view = { width: 1000, height: 800 }
const size = { width: 220, height: 300 }
const noop = () => undefined

describe('placing a menu at a point', () => {
  it('opens down and right of the point when there is room', () => {
    expect(placeAt({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100 })
  })

  it('flips left at the right edge and up at the bottom edge', () => {
    expect(placeAt({ x: 900, y: 100 }, size, view)).toEqual({ left: 680, top: 100 })
    expect(placeAt({ x: 100, y: 700 }, size, view)).toEqual({ left: 100, top: 400 })
    expect(placeAt({ x: 900, y: 700 }, size, view)).toEqual({ left: 680, top: 400 })
  })

  it('stays 8 px inside the window when neither side fits', () => {
    const tall = { width: 220, height: 780 }
    expect(placeAt({ x: 4, y: 400 }, tall, view)).toEqual({ left: 8, top: 8 })
    const wide = { width: 990, height: 100 }
    expect(placeAt({ x: 500, y: 10 }, wide, view).left).toBe(8)
  })
})

describe('opening it', () => {
  it('takes Shift+F10 and the menu key, and nothing else', () => {
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
    expect(isMenuKey({ key: 'Enter', shiftKey: true })).toBe(false)
  })

  it('keeps a long press while the finger stays within the slop', () => {
    expect(pressStays({ x: 10, y: 10 }, { x: 10 + LONG_PRESS_SLOP, y: 10 })).toBe(true)
    expect(pressStays({ x: 10, y: 10 }, { x: 10 + LONG_PRESS_SLOP, y: 11 })).toBe(false)
  })
})

describe('closing it', () => {
  const el = (isConnected: boolean) => ({ isConnected }) as Element
  const body = el(true)

  it('gives focus back to the trigger while nothing else has it', () => {
    expect(focusGoesBack(null, body)).toBe(true)
    expect(focusGoesBack(body, body)).toBe(true)
    // the menu item that had it is gone
    expect(focusGoesBack(el(false), body)).toBe(true)
  })

  it('leaves it where the person has gone since', () => {
    expect(focusGoesBack(el(true), body)).toBe(false)
  })
})

describe('the menu', () => {
  it('renders nothing while shut', () => {
    expect(renderToStaticMarkup(<ContextMenu at={null} onClose={noop} label="Bracket" />)).toBe('')
  })

  it('leads with an icon row whose buttons are menu items, then the items', () => {
    const html = renderToStaticMarkup(
      <ContextMenu at={{ x: 10, y: 10 }} onClose={noop} label="Bracket">
        <MenuIconRow>
          <MenuIcon icon="rename" label="Rename" shortcut="F2" onClick={noop} />
          <MenuIcon icon="lock" label="Lock" disabled reason="Locked objects can't move" onClick={noop} />
        </MenuIconRow>
        <MenuItem>Split to parts</MenuItem>
      </ContextMenu>,
    )
    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="Bracket"')
    expect(html).toContain('class="sx-menu sx-ctx"')
    expect(html.match(/role="menuitem"/g)).toHaveLength(3)
    expect(html).toContain('aria-label="Rename"')
    expect(html).toContain('data-tip-key="F2"')
    // an icon that is off says why instead of going gray in silence
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain("data-tip-body=\"Locked objects can&#x27;t move\"")
  })
})
