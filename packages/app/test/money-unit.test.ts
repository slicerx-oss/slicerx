// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cost setting's unit reads in the person's currency, the symbol they set for the print estimate, never the
// schema's placeholder ("money/h", "money/kg").
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { settingDef } from '../src/adapters/settings'
import { set } from '../src/state/store'
import { Field } from '../src/workspaces/prepare/expert-settings'

describe('cost setting units', () => {
  let root: Root | null = null
  let el: HTMLElement | null = null
  beforeEach(() => set({ overrides: {}, settingsMode: 'advanced', electricity: { pricePerKwh: 0.15, symbol: '$' } }))
  afterEach(() => {
    if (root) flushSync(() => root!.unmount())
    el?.remove()
    root = null
  })
  function unitOf(key: string): string | null {
    const def = settingDef(key)
    expect(def, key).toBeDefined()
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    flushSync(() => root!.render(createElement(Field, { def: def!, value: def!.default as never, overridden: false, idPrefix: 'ps' })))
    return el.querySelector('.field-unit')?.textContent ?? null
  }

  it('shows the machine cost per hour in the currency symbol', () => {
    expect(settingDef('time_cost')?.unit).toBe('money/h')
    expect(unitOf('time_cost')).toBe('$/h')
  })

  it('shows the filament cost per kilogram in the currency symbol', () => {
    expect(settingDef('filament_cost')?.unit).toBe('money/kg')
    expect(unitOf('filament_cost')).toBe('$/kg')
  })

  it('follows the currency symbol the person set', () => {
    set({ electricity: { pricePerKwh: 0.3, symbol: '€' } })
    expect(unitOf('time_cost')).toBe('€/h')
  })
})
