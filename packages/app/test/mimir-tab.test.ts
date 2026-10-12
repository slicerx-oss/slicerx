// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab is the plate's third mode and comes first: mimir, Model, Slice. It shares the workspace, the design
// and the view with Model, hides where Model hides, and answers agents through its command and the bridge's state.
import type { Host } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appState } from '../src/agent-bridge/page'
import { builtinCommands } from '../src/commands/builtin'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { pickKeysOn } from '../src/plate/pick-filter'
import { ModeTabs } from '../src/shell/mode-tab'
import { modelMode, showsDesign, toggleModelMode } from '../src/state/model-mode'
import { get, set, setModelMode } from '../src/state/store'
import { modelLook } from '../src/viewport/viewport-host'
import { captionFor, chatMax, designName } from '../src/workspaces/mimir/mimir-panes'

const NO_CAD = { ...NEUTRAL, features: { ...NEUTRAL.features, cad: false } }

beforeEach(() => set({ workspace: 'prepare', modelMode: 'slice', modelModeDefault: 'slice', devBuild: true, settingsMode: 'simple' }))
afterEach(() => {
  setCurrentEdition(NEUTRAL)
  document.body.innerHTML = ''
})

function render(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  flushSync(() => createRoot(el).render(createElement(ModeTabs)))
  return el
}

describe('the mimir tab', () => {
  it('comes first, then Model and Slice', () => {
    const el = render()
    expect([...el.querySelectorAll('.sx-tab')].map((b) => b.getAttribute('data-testid'))).toEqual(['tab-mimir', 'tab-model', 'tab-prepare'])
    const tab = el.querySelector('[data-testid="tab-mimir"]')!
    expect(tab.textContent).toBe('mimir')
    expect(tab.getAttribute('data-tip')).toBe('mode.mimir')
  })

  it('is the current page only while its mode is open on the plate', () => {
    const el = render()
    const tab = el.querySelector('[data-testid="tab-mimir"]')!
    expect(tab.getAttribute('aria-current')).toBeNull()
    flushSync(() => tab.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'mimir' })
    expect(tab.getAttribute('aria-current')).toBe('page')
    flushSync(() => set({ workspace: 'printers' }))
    expect(tab.getAttribute('aria-current')).toBeNull()
  })

  it('opens from any tab in one step and keeps the workspace, so the design stays the same', () => {
    set({ workspace: 'library' })
    setModelMode('mimir')
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'mimir' })
    const plate = get().plate
    setModelMode('design')
    expect(get().plate).toBe(plate)
    setModelMode('mimir')
    expect(get().plate).toBe(plate)
  })

  it('shows the design the way Model does: the CAD look and the picks', () => {
    set({ modelMode: 'mimir' })
    expect(showsDesign(get())).toBe(true)
    expect(modelLook({ workspace: 'prepare', modelMode: 'mimir', look: 'clay' })).toBe('cad')
    expect(pickKeysOn({ workspace: 'prepare', modelMode: 'mimir', objectTool: null })).toBe(true)
    expect(showsDesign({ workspace: 'prepare', modelMode: 'slice' })).toBe(false)
    expect(showsDesign({ workspace: 'printers', modelMode: 'mimir' })).toBe(false)
  })

  it('goes to Model on Ctrl+E, which flips Model and Slice', () => {
    set({ modelMode: 'mimir' })
    toggleModelMode()
    expect(get().modelMode).toBe('design')
  })

  it('hides where Model hides: an edition without modeling tools stays in Slice', () => {
    setCurrentEdition(NO_CAD)
    set({ modelMode: 'mimir' })
    expect(modelMode()).toBe('slice')
    expect(builtinCommands({} as Host, []).map((c) => c.id)).not.toContain('mode-mimir')
  })
})

describe('in a release build', () => {
  beforeEach(() => set({ devBuild: false }))

  it('hides until developer mode, leaving Model first', () => {
    const el = render()
    const ids = () => [...el.querySelectorAll('.sx-tab')].map((b) => b.getAttribute('data-testid'))
    expect(ids()).toEqual(['tab-model', 'tab-prepare'])
    flushSync(() => set({ settingsMode: 'developer' }))
    expect(ids()).toEqual(['tab-mimir', 'tab-model', 'tab-prepare'])
  })

  it('reads as Model while hidden, and agents cannot open it', () => {
    set({ modelMode: 'mimir' })
    expect(modelMode()).toBe('design')
    const go = builtinCommands({} as Host, []).find((c) => c.id === 'mode-mimir')!
    set({ modelMode: 'slice' })
    expect(go.enabled?.()).toBe(false)
    set({ settingsMode: 'developer' })
    expect(go.enabled?.()).toBe(true)
  })
})

describe('agents', () => {
  it('reach the tab through Go to mimir, offered only when it would change something', () => {
    const go = builtinCommands({} as Host, []).find((c) => c.id === 'mode-mimir')!
    expect(go.title).toBe('Go to mimir')
    expect(go.tool?.permission).toBe('read')
    expect(go.enabled?.()).toBe(true)
    void go.run()
    expect(get().modelMode).toBe('mimir')
    expect(go.enabled?.()).toBe(false)
  })

  it('read the mode back from the bridge state', () => {
    set({ modelMode: 'mimir' })
    expect(appState(get())).toMatchObject({ tab: 'prepare', mode: 'mimir' })
    set({ workspace: 'printers' })
    expect(appState(get())).not.toHaveProperty('mode')
  })
})

describe('the chat and the caption', () => {
  it('lets the chat grow to half the window, never under its minimum', () => {
    expect(chatMax(1440)).toBe(720)
    expect(chatMax(500)).toBe(340)
  })

  it('names the design in the chat header', () => {
    expect(designName({ name: 'Backplate.sx3mf' })).toBe('Backplate')
    expect(designName(null)).toBe('Untitled')
  })

  it('names the view and its plane', () => {
    expect(captionFor('top')).toBe('Top, XY')
    expect(captionFor('front')).toBe('Front, XZ')
    expect(captionFor('iso')).toBe('Isometric')
    expect(captionFor(null)).toBe('3D view')
  })
})

