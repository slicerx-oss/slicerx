// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { energyFigure } from '../src/plate/checks'
import { normalizePrefs } from '../src/state/prefs'
import { DEFAULT_ELECTRICITY, set } from '../src/state/store'
import { EnergyRow, priceText } from '../src/workspaces/prepare/energy-row'

describe('electricity price', () => {
  beforeEach(() => set({ electricity: DEFAULT_ELECTRICITY }))

  it('stays $0.15 per kWh until the person sets one', () => {
    expect(DEFAULT_ELECTRICITY).toEqual({ pricePerKwh: 0.15, symbol: '$' })
    expect(normalizePrefs({}).electricity).toBeUndefined()
  })

  it('keeps a stored price and symbol and drops a bad one', () => {
    expect(normalizePrefs({ electricity: { pricePerKwh: 0.31, symbol: '€' } }).electricity).toEqual({ pricePerKwh: 0.31, symbol: '€' })
    expect(normalizePrefs({ electricity: { pricePerKwh: -1, symbol: '€' } }).electricity).toBeUndefined()
    expect(normalizePrefs({ electricity: { pricePerKwh: 0.3, symbol: '' } }).electricity).toBeUndefined()
    expect(normalizePrefs({ electricity: { pricePerKwh: 0.3, symbol: 'toolong' } }).electricity).toBeUndefined()
  })

  it('writes the price with two to four decimals', () => {
    expect(priceText(0.15)).toBe('0.15')
    expect(priceText(0.2)).toBe('0.20')
    expect(priceText(1)).toBe('1.00')
    expect(priceText(0.2175)).toBe('0.2175')
  })

  it('costs the same energy at the given price', async () => {
    const at15 = await energyFigure(7200, 'Bambu Lab P1S', 'PLA', 0.15)
    const at30 = await energyFigure(7200, 'Bambu Lab P1S', 'PLA', 0.3)
    expect(at15).not.toBeNull()
    expect(at30!.kwh).toBeCloseTo(at15!.kwh)
    expect(at30!.cost).toBeCloseTo(at15!.cost * 2, 1)
  })

  it('shows the symbol in the row and the price in its tooltip', async () => {
    set({ electricity: { pricePerKwh: 0.31, symbol: '€' } })
    const el = document.createElement('div')
    flushSync(() => createRoot(el).render(createElement(EnergyRow, { timeS: 7200 })))
    await vi.waitFor(() => expect(el.querySelector('dd')?.textContent).toMatch(/^about [\d.]+ kWh, €[\d.]+$/))
    expect(el.textContent).not.toContain('$')
    expect(el.innerHTML).toContain('€0.31 per kWh')
  })
})
