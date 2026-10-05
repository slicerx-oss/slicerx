// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PrintSheet, type PrintSheetAsk } from '../src/send/print-sheet'
import { defaultOptions, safeJobName, supportedOptions } from '../src/send/options'
import { set } from '../src/state/store'

beforeAll(() => {
  // jsdom has no modal dialogs.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

const roots: (() => void)[] = []
afterEach(() => {
  for (const u of roots.splice(0)) u()
  set({ printSheet: null })
})

function ask(over: Partial<PrintSheetAsk> = {}): PrintSheetAsk {
  return {
    printer: { id: 'h2d', name: 'Tawain #1', vendor: 'Bambu Lab', model: 'H2D', plugin: 'bambu-lan', filamentSystem: 'ams' } as PrintSheetAsk['printer'],
    status: { state: 'idle', slots: [], cameraAvailable: true } as unknown as PrintSheetAsk['status'],
    plateName: 'Plate 1',
    specs: [],
    initial: {},
    name: 'benchy.gcode.3mf',
    ending: '.gcode.3mf',
    filaments: [
      { index: 1, color: '#ff0000', type: 'PLA' },
      { index: 2, color: '#ffffff', type: 'PETG' },
    ],
    slots: [
      { id: 'A1', material: 'PLA', color: '#ff0000' },
      { id: 'A2', material: 'PETG', color: '#ffffff' },
    ],
    auto: { 1: 'A1', 2: 'A2' },
    stats: { timeS: 3600, grams: 42.5, layers: 304 },
    check: { errors: [], warnings: [], sha256: 'abcdef0123456789' },
    bed: 'unknown',
    resolve: () => {},
    ...over,
  }
}

function open(a: PrintSheetAsk): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  set({ printSheet: a })
  flushSync(() => root.render(createElement(PrintSheet)))
  roots.push(() => {
    root.unmount()
    el.remove()
  })
  return el
}

describe('Print sheet summary', () => {
  it('shows the file and the filaments as text, with no field or slot picker', () => {
    const el = open(ask())
    expect(el.querySelector('.ps-file')?.textContent).toBe('benchy.gcode.3mf')
    expect(el.querySelectorAll('input:not([type=datetime-local])')).toHaveLength(0)
    expect(el.querySelectorAll('select')).toHaveLength(0)
    const fils = [...el.querySelectorAll('.ps-fil')].map((f) => f.textContent)
    expect(fils[0]).toContain('PLA')
    expect(fils[0]).toContain('AMS A1')
    expect(fils[1]).toContain('AMS A2')
    expect(el.querySelector('.ps-meta')?.textContent).toContain('42.5 g')
  })

  it('offers a slot picker only when a filament has no matching slot', () => {
    const el = open(ask({ auto: { 1: 'A1' } }))
    expect(el.querySelectorAll('select')).toHaveLength(2)
    expect(el.textContent).toContain('Pick a slot for each filament')
  })

  it('makes a file name the printer would refuse fit, instead of asking for one', () => {
    expect(safeJobName('a/b:c ')).toBe('a-b-c')
    expect(safeJobName('  ')).toBe('plate')
    const el = open(ask({ name: 'part: v2?.gcode.3mf' }))
    expect(el.querySelector('.ps-file')?.textContent).toBe('part- v2-.gcode.3mf')
  })

  it('shows each check as one short line, its detail in a tooltip, and lets a warning go ahead anyway', () => {
    const el = open(ask({ check: { errors: [], warnings: [{ text: 'A1 runs out before the print ends', tip: 'About 40 g left in A1; the print needs 120 g.' }], sha256: 'abcdef0123456789' } }))
    const line = el.querySelector('.cl-line[data-tone=warn]')
    expect(line?.querySelector('.cl-text')?.textContent).toBe('A1 runs out before the print ends')
    const more = line?.querySelector('button[data-tip-click]')
    expect(more?.textContent).toBe('Details')
    expect(more?.getAttribute('data-tip-body')).toContain('About 40 g left')
    const go = el.ownerDocument.querySelector<HTMLButtonElement>('.ps-go-main')
    expect(go?.textContent).toBe('Bed is clear, start anyway')
    expect(go?.disabled || go?.getAttribute('aria-disabled') === 'true').toBe(false)
  })

  it('shows nothing extra when no check fires', () => {
    const el = open(ask())
    expect(el.querySelector('.cl-list')).toBeNull()
    expect(el.querySelector('.ps-checking')).toBeNull()
    expect(el.ownerDocument.querySelector('.ps-go-main')?.textContent).toBe('Bed is clear, start print')
  })

  it('blocks the start on an error, its first sentence as the line and the rest in the tooltip', () => {
    const el = open(ask({ check: { errors: ['Tawain #1 is busy (printing). Wait until it is idle.'], warnings: [], sha256: 'abcdef0123456789' } }))
    const line = el.querySelector('.cl-line[data-tone=bad]')
    expect(line?.querySelector('.cl-text')?.textContent).toBe('Tawain #1 is busy (printing)')
    expect(line?.querySelector('button[data-tip-click]')?.getAttribute('data-tip-body')).toBe('Wait until it is idle.')
    const go = el.ownerDocument.querySelector<HTMLButtonElement>('.ps-go-main')
    expect(go?.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('Print sheet options', () => {
  const specs = supportedOptions({ vendor: 'Bambu Lab', model: 'H2D', plugin: 'bambu-lan' }, { cameraAvailable: true })

  it('shows every option as a toggle, no menu, set to the defaults', () => {
    // Checked right after the first render: the toggles must not wait on an effect (CI at 0d3a6df4 saw them all off).
    const el = open(ask({ specs, initial: defaultOptions(specs) }))
    const switches = [...el.querySelectorAll<HTMLButtonElement>('.ps-opt [role=switch]')]
    expect(switches.map((b) => el.querySelector(`label[for="${b.id}"]`)?.textContent)).toEqual(['Bed leveling', 'Flow dynamics calibration', 'Vibration compensation', 'Timelapse'])
    expect(switches.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false', 'true'])
    expect(el.querySelector('[aria-haspopup][aria-label*="Before"], .ps-row-head')).toBeNull()
  })

  it('gives each toggle a tooltip anchor that opens on hover, focus and click', () => {
    const el = open(ask({ specs, initial: defaultOptions(specs) }))
    const tips = [...el.querySelectorAll<HTMLButtonElement>('.ps-opt .ps-tip-btn')]
    expect(tips).toHaveLength(specs.length)
    for (const [i, b] of tips.entries()) {
      expect(b.hasAttribute('data-tip-click')).toBe(true)
      expect(b.getAttribute('data-tip-title')).toBe(specs[i]!.label)
      expect(b.getAttribute('data-tip-body')).toMatch(/Adds /)
      expect(b.getAttribute('aria-label')).toBe(`About ${specs[i]!.label.toLowerCase()}`)
    }
  })
})
