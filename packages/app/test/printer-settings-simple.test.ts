// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer settings opened in Simple (always on a phone, and from Search in Simple on a wider window) lists the
// Advanced printer settings on every tab: no printer setting is at the Simple level, so Simple's own list is empty.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SETTINGS } from '../src/adapters/settings'
import { PrinterSettingsDialog } from '../src/workspaces/prepare/printer-settings'
import { set } from '../src/state/store'

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

let root: Root | null = null
let el: HTMLElement | null = null
afterEach(() => {
  if (root) flushSync(() => root!.unmount())
  el?.remove()
  root = null
  el = null
  vi.unstubAllGlobals()
  set({ overrides: {}, settingsMode: 'advanced', printerSettingsOpen: false })
})

/** A window at a width, with a touch screen or a mouse. */
function screenAt(width: number, touch: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width: (\d+)px/.exec(q)
    const coarse = q.includes('pointer: coarse')
    return { matches: (!max || width <= Number(max[1])) && (!coarse || touch), addEventListener() {}, removeEventListener() {} }
  })
}

/** Opens the dialog and counts its rows on each tab. */
function rowsPerTab(): Record<string, number> {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  flushSync(() => root!.render(createElement(PrinterSettingsDialog, { printer: undefined })))
  const out: Record<string, number> = {}
  for (const radio of el.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Printer settings tab"] [role="radio"]')) {
    flushSync(() => radio.click())
    expect(radio.getAttribute('aria-checked')).toBe('true')
    out[radio.textContent!.trim()] = el.querySelectorAll('ul.expert > li').length
  }
  return out
}

describe('Printer settings opened in Simple', () => {
  it('has no printer setting at the Simple level, so it needs a list of its own', () => {
    expect(SETTINGS.some((d) => d.section === 'printer' && d.mode === 'simple')).toBe(false)
  })

  it('lists the Advanced rows on every tab on a phone, whatever mode is saved', () => {
    screenAt(390, true)
    set({ settingsMode: 'advanced', printerSettingsOpen: true, overrides: {} })
    const rows = rowsPerTab()
    expect(Object.keys(rows)).toHaveLength(5)
    for (const [tab, n] of Object.entries(rows)) expect(n, tab).toBeGreaterThan(0)
    expect(el!.textContent).not.toContain('No printer setting matches.')
  })

  it('lists the same rows in Simple on a wider window as in Advanced', () => {
    screenAt(1440, false)
    set({ settingsMode: 'advanced', printerSettingsOpen: true, overrides: {} })
    const advanced = rowsPerTab()
    flushSync(() => root!.unmount())
    el!.remove()
    set({ settingsMode: 'simple', printerSettingsOpen: true })
    expect(rowsPerTab()).toEqual(advanced)
  })
})
