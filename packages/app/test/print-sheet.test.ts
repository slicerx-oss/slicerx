// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrintSheet, type PrintSheetAsk } from '../src/send/print-sheet'
import { defaultOptions, safeJobName, supportedOptions } from '../src/send/options'
import { get, set } from '../src/state/store'

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

  it('offers both external spools of an H2 printer whose status lists slot 2, by side', () => {
    const slots = [
      { id: 'A1', material: 'PLA', color: '#ff0000' },
      { id: '1', material: 'TPU', color: '#c0392b' },
      { id: '2', material: 'PETG', color: '#ffffff' },
    ]
    // Mapped to the right one: the summary names the side.
    const sum = open(ask({ slots, auto: { 1: 'A1', 2: '2' } }))
    expect([...sum.querySelectorAll('.ps-fil')].map((f) => f.textContent)[1]).toContain('Right external spool')
    // A filament with no slot opens the picker, which lists both spools by side and slot 2 only once.
    const el = open(ask({ slots, auto: { 1: 'A1' } }))
    const options = [...el.querySelectorAll<HTMLSelectElement>('select')[1]!.options].map((o) => [o.value, o.textContent])
    expect(options).toEqual([
      ['', 'Not loaded'],
      ['A1', 'A1 PLA'],
      ['1', 'Left external spool'],
      ['2', 'Right external spool'],
    ])
  })

  it('keeps slot 2 an ordinary slot on a printer that is not a Bambu Lab one', () => {
    const slots = [
      { id: '1', material: 'PLA', color: '#ff0000' },
      { id: '2', material: 'PETG', color: '#ffffff' },
    ]
    const printer = { id: 'mk4', name: 'MK4', vendor: 'Prusa', model: 'MK4S', plugin: 'prusalink' } as PrintSheetAsk['printer']
    const el = open(ask({ printer, slots, auto: { 1: '1', 2: '2' } }))
    const fils = [...el.querySelectorAll('.ps-fil')].map((f) => f.textContent)
    expect(fils[0]).toContain('External spool')
    expect(fils[1]).toContain('Slot 2')
    expect(fils.join(' ')).not.toContain('Right external spool')
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
    // A block with no place in the slice has no Show me.
    expect(line?.querySelector('[data-testid="check-show"]')).toBeNull()
  })

  it('offers Show me on a block with a place in the slice, which closes the sheet and goes there', async () => {
    const tall = 'The print is 300.0 mm tall; the P1S reaches 256 mm.'
    let answer: unknown = 'pending'
    const el = open(ask({ check: { errors: [tall], warnings: [], sha256: 'abcdef0123456789', spots: { [tall]: { kind: 'layer', layer: 1 } } }, resolve: (r) => (answer = r) }))
    set({ preview: { layerCount: 4 } as never, layerHi: 4, layerLo: 1, workspace: 'prepare', modelMode: 'slice', sliceLook: 'solid' as never })
    const show = el.querySelector<HTMLButtonElement>('.cl-line[data-tone=bad] [data-testid="check-show"]')
    expect(show?.textContent).toBe('Show me')
    flushSync(() => show!.click())
    // The sheet closes as a cancel, then Slice shows the toolpaths up to the first layer past the printer's height.
    expect(answer).toBeNull()
    await vi.waitFor(() => expect(get().layerHi).toBe(2))
    expect(get().printSheet).toBeNull()
    expect(get().sliceLook).toBe('toolpaths')
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

// A Bambu Lab A1 mini on Authorization Control firmware without Developer Mode: status comes through, the send does
// not, and the sheet comes back with the two ways past it.
describe('Print sheet after a Developer Mode refusal', () => {
  const refused = (resolve: PrintSheetAsk['resolve'] = () => {}) =>
    ask({
      printer: { id: 'a1m', name: 'Mini', vendor: 'Bambu Lab', model: 'Bambu Lab A1 mini', plugin: 'bambu-lan', filamentSystem: 'ams' } as PrintSheetAsk['printer'],
      bambuConnect: 'open',
      refusal: { reason: 'It sends status, but the file upload failed (FTPS upload timed out).', plainSha256: 'ffff', last: { options: {}, start: true, name: 'benchy.gcode.3mf' }, developerMode: true },
      resolve,
    })

  it('says why and shows Bambu Connect and the A1 steps in full, not plain G-code', () => {
    const el = open(refused())
    const box = el.querySelector('[data-testid="developer-mode-needed"]')
    expect(box?.textContent).toContain("Mini sends its status but didn't take the print")
    expect(el.querySelector('[data-testid="danger-bambu-connect-send"]')?.textContent).toBe('Send with Bambu Connect')
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons).not.toContain('Send as plain G-code')
    expect(buttons).not.toContain('Open in Bambu Connect')
    // Nothing to open: the steps are there from the start, after the Bambu Connect button.
    const list = el.querySelector('[data-testid="developer-mode-steps-list"]')
    expect(list?.textContent).toContain('swipe to page 3')
    expect(list?.textContent).toContain('Developer Mode (firmware 01.05.00.00 and later)')
    expect(list?.textContent).not.toContain('WLAN, then LAN Only Mode')
    expect(list?.textContent).toContain('Bambu Handy')
    expect(box?.querySelector('[aria-expanded]')).toBeNull()
  })

  it('sends the same plate through Bambu Connect on one click', () => {
    const resolve = vi.fn()
    const el = open(refused(resolve))
    flushSync(() => el.querySelector<HTMLButtonElement>('[data-testid="danger-bambu-connect-send"]')!.click())
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ bambuConnect: true, start: true }))
  })
})

describe('needs_developer_mode errors', () => {
  it('reads the reason after the printer name', async () => {
    const { developerModeReason, refusalReason } = await import('../src/state/actions')
    const e = Object.assign(new Error('printer a1m takes no prints from other apps: It sends status, but it did not answer the print start.'), { code: 'needs_developer_mode' })
    expect(developerModeReason(e)).toBe('It sends status, but it did not answer the print start.')
    expect(refusalReason(e)).toBeNull()
    expect(developerModeReason(Object.assign(new Error('x'), { code: 'refused' }))).toBeNull()
  })
})
