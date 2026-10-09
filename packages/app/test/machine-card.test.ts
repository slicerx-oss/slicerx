// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The machine card's words: the folded summary line, and the card with no printer (the web build always has its demo
// printers, so the e2e suite cannot reach that state).
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/use-printer', () => ({ usePrinter: () => ({ rows: [], printer: undefined }), printTarget: () => undefined }))

const { MachineCard, machineSummary } = await import('../src/workspaces/prepare/machine-card')
const { printerPicture } = await import('../src/workspaces/prepare/printer-thumb')
const { get, set } = await import('../src/state/store')

const mount = () => {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  flushSync(() => root.render(createElement(MachineCard)))
  return { el, done: () => (root.unmount(), el.remove()) }
}

describe('machine card', () => {
  it('folds to one line: name, nozzle, plate type and status', () => {
    expect(machineSummary('Desk A1', 0.4, 'Textured PEI', 'Ready')).toBe('Desk A1, 0.4 mm, Textured PEI, Ready')
    // While the printer profile loads there is no nozzle yet.
    expect(machineSummary('Desk A1', null, 'Textured PEI', 'Offline')).toBe('Desk A1, Textured PEI, Offline')
  })

  it('shows each printer\'s picture, or a drawing of its kind of machine, never an empty box', () => {
    expect(printerPicture('Bambu Lab', 'A1')).toEqual({ src: expect.stringContaining('bambu-a1.webp') })
    // In the catalog with no picture: its frame type.
    expect(printerPicture('Sovol', 'SV04')).toEqual({ icon: expect.stringMatching(/^printer-/) })
    // Not in the catalog at all: the generic frame.
    expect(printerPicture('Homebrew', 'Garage special')).toEqual({ icon: 'printer-corexy-open' })
  })

  it('with no printer says what the slice is for, offers Add printer, and Slice without a printer until chosen', () => {
    set({ noPrinter: false })
    const { el, done } = mount()
    expect(el.textContent).toContain('Generic 256 mm bed')
    expect(el.querySelector('[data-testid="slice-machine-printer-add"]')?.textContent).toBe('Add printer')
    const keep = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Slice without a printer')!
    expect(keep).toBeTruthy()
    flushSync(() => keep.click())
    expect(get().noPrinter).toBe(true)
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Slice without a printer')).toBe(false)
    done()
    set({ noPrinter: false })
  })
})
