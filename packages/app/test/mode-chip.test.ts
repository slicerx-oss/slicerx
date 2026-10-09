// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings mode chip in the Slice pane title: it names the mode, its menu says what each mode shows, and picking
// one sets the mode for the whole app.
import { resolvePreset } from '@slicerx/ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MODE_LINE, ModeChip } from '../src/first-run/mode-chip'
import { get, set } from '../src/state/store'

const mount = () => {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  flushSync(() => root.render(createElement(ModeChip, { layout: resolvePreset('slicerx').layout })))
  return { el, done: () => (root.unmount(), el.remove()) }
}

describe('settings mode chip', () => {
  afterEach(() => set({ settingsMode: 'simple' }))

  it('names the mode and lists every mode of the look with its line', () => {
    set({ settingsMode: 'advanced' })
    const { done } = mount()
    const chip = document.querySelector<HTMLElement>('[data-testid="slice-mode-chip"]')!
    expect(chip.textContent).toBe('Advanced')
    expect(chip.getAttribute('aria-haspopup')).toBe('menu')
    flushSync(() => chip.click())
    const items = [...document.querySelectorAll<HTMLElement>('[data-testid^="slice-mode-chip-"]')]
    expect(items.map((i) => i.querySelector('b')?.textContent)).toEqual(['Simple', 'Advanced', 'Expert', 'Developer'])
    expect(items.map((i) => i.querySelector('small')?.textContent)).toEqual([MODE_LINE.simple, MODE_LINE.advanced, MODE_LINE.expert, MODE_LINE.developer])
    expect(items.find((i) => i.getAttribute('aria-checked') === 'true')?.dataset['testid']).toBe('slice-mode-chip-advanced')
    done()
  })

  it('picking a mode sets it and closes the menu', () => {
    const { done } = mount()
    const chip = document.querySelector<HTMLElement>('[data-testid="slice-mode-chip"]')!
    flushSync(() => chip.click())
    flushSync(() => document.querySelector<HTMLElement>('[data-testid="slice-mode-chip-expert"]')!.click())
    expect(get().settingsMode).toBe('expert')
    expect(document.querySelector('[data-testid="slice-mode-chip-expert"]')).toBeNull()
    expect(chip.textContent).toBe('Expert')
    done()
  })
})
