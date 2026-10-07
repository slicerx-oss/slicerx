// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab has two modes, Design and Slice, over the one `prepare` workspace. The mode is session state that
// starts from a saved default; the switcher, Ctrl+E and the commands change the mode, never the default.
import type { Host } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { plateHandlers } from '../src/plate/keys'
import { ModeTab } from '../src/shell/mode-tab'
import { modelMode, toggleModelMode } from '../src/state/model-mode'
import { loadPrefs } from '../src/state/prefs'
import { get, set, setModelMode } from '../src/state/store'

const NO_CAD = { ...NEUTRAL, features: { ...NEUTRAL.features, cad: false } }

beforeEach(() => set({ workspace: 'prepare', modelMode: 'slice', modelModeDefault: 'slice' }))
afterEach(() => {
  setCurrentEdition(NEUTRAL)
  document.body.innerHTML = ''
})

describe('the default mode pref', () => {
  beforeEach(() => localStorage.clear())

  it('is Slice unless Design was saved', () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare' }))
    expect(loadPrefs().modelModeDefault).toBe('slice')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ modelModeDefault: 'design' }))
    expect(loadPrefs().modelModeDefault).toBe('design')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ modelModeDefault: 'sculpt' }))
    expect(loadPrefs().modelModeDefault).toBe('slice')
  })
})

describe('switching modes', () => {
  it('opens the first tab in the mode from any tab in one step', () => {
    set({ workspace: 'printers' })
    setModelMode('design')
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'design' })
    set({ workspace: 'preview' })
    setModelMode('slice')
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'slice' })
  })

  it('never changes the default', () => {
    setModelMode('design')
    toggleModelMode()
    toggleModelMode()
    expect(get().modelModeDefault).toBe('slice')
  })

  it('flips with the model.mode key, from the first tab and from Preview', () => {
    const flip = plateHandlers()['model.mode']!
    flip()
    expect(get().modelMode).toBe('design')
    set({ workspace: 'preview' })
    flip()
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'slice' })
  })

  it('stays in Slice in an edition without modeling tools, whatever the pref says', () => {
    setCurrentEdition(NO_CAD)
    set({ modelMode: 'design' })
    expect(modelMode()).toBe('slice')
    set({ modelMode: 'slice' })
    toggleModelMode()
    expect(get().modelMode).toBe('slice')
  })
})

describe('the commands', () => {
  const ids = () => builtinCommands({} as Host, []).map((c) => c.id)

  it('offers Switch to Design and Switch to Slice, each only when it would change something', () => {
    const cmds = builtinCommands({} as Host, [])
    const design = cmds.find((c) => c.id === 'mode-design')!
    const slice = cmds.find((c) => c.id === 'mode-slice')!
    expect(design.title).toBe('Switch to Design')
    expect(design.enabled?.()).toBe(true)
    expect(slice.enabled?.()).toBe(false)
    void design.run()
    expect(get().modelMode).toBe('design')
  })

  it('leaves them out without modeling tools', () => {
    setCurrentEdition(NO_CAD)
    expect(ids()).not.toContain('mode-design')
    expect(ids()).not.toContain('mode-slice')
  })
})

describe('the Design | Slice tab', () => {
  function render(): HTMLElement {
    const el = document.createElement('div')
    document.body.appendChild(el)
    flushSync(() => createRoot(el).render(createElement(ModeTab)))
    return el
  }
  const current = (el: HTMLElement) => [...el.querySelectorAll('[aria-current="page"]')].map((b) => b.textContent)

  it('underlines the open mode, and neither half on another tab', () => {
    const el = render()
    expect(current(el)).toEqual(['Slice'])
    flushSync(() => set({ modelMode: 'design' }))
    expect(current(el)).toEqual(['Design'])
    flushSync(() => set({ workspace: 'preview' }))
    expect(current(el)).toEqual([])
  })

  it('opens the first tab in that mode when a half is clicked from another tab', () => {
    set({ workspace: 'library' })
    const el = render()
    flushSync(() => el.querySelector<HTMLButtonElement>('[data-mode="design"]')!.click())
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'design' })
    // The Slice half keeps the workspace id, so anything that opens `prepare` by its tab lands on the plate.
    expect(el.querySelector('[data-tab="prepare"]')?.getAttribute('data-mode')).toBe('slice')
  })
})
