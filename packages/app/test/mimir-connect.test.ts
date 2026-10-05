// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPrefs, savePrefs } from '../src/state/prefs'

const KEY = 'slicerx.prefs.v1'
const built = vi.hoisted(() => ({ count: 0 }))

// The connect step must never build a Pilot: that is where the transport and the model are picked.
vi.mock('../src/features/pilot/use-pilot', () => ({
  usePilot: () => {
    built.count++
    return null
  },
}))

describe('mimir before a model is connected', () => {
  beforeEach(() => {
    localStorage.clear()
    built.count = 0
  })

  it('starts a fresh install at the connect step, not off', async () => {
    vi.resetModules()
    const { get, pilotState } = await import('../src/state/store')
    expect(get().pilot).toEqual({ mode: 'unset' })
    expect(pilotState()).toBe('connect')
  })

  it('keeps mimir off for someone who turned it off, and on for installs from before setup asked', async () => {
    const { pilotState } = await import('../src/state/store')
    expect(pilotState({ pilot: { mode: 'off' }, setupPilotOff: false })).toBe('off')
    expect(pilotState({ pilot: { mode: 'unset' }, setupPilotOff: true })).toBe('off')
    expect(pilotState({ pilot: null, setupPilotOff: false })).toBe('on')
    expect(pilotState({ pilot: { mode: 'on', provider: 'openai' }, setupPilotOff: false })).toBe('on')
  })

  it('stores the not yet connected state apart from off', () => {
    savePrefs({ workspace: 'prepare', rails: {}, recents: [], easy: null, goal: 'standard', printerId: null, scheme: 'dark', pilot: { mode: 'unset' } })
    expect(loadPrefs().pilot).toEqual({ mode: 'unset' })
    localStorage.setItem(KEY, JSON.stringify({ pilot: { mode: 'maybe' } }))
    expect(loadPrefs().pilot).toBeNull()
  })

  it('opens the dock on the connect step without building a Pilot, then on the conversation once connected', async () => {
    vi.resetModules()
    const { set } = await import('../src/state/store')
    const { PilotDock } = await import('../src/features/pilot/dock')
    const { openDock } = await import('../src/features/pilot/dock-state')
    const { FeaturesContext } = await import('../src/features')
    const { HostContext } = await import('../src/host')
    const host = { kind: 'web', capabilities: { secureStorage: false } } as never
    const features = { ids: new Set(['pilot']), features: [], workspaces: [], settings: [] } as never
    const el = document.createElement('div')
    const root = createRoot(el)
    const tree = () =>
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(HostContext.Provider, { value: host }, createElement(FeaturesContext.Provider, { value: features }, createElement(PilotDock))),
      )
    set({ pilot: { mode: 'unset' }, pilotPrompt: 'Why is my first layer rough' })
    openDock()
    flushSync(() => root.render(tree()))
    expect(el.querySelector('.mimir-connect')?.textContent).toContain('Why is my first layer rough')
    expect(el.querySelector('.mimir-connect')?.textContent).toContain('Nothing is sent until you connect')
    // The browser build has no ChatGPT sign-in, so the key panel is the step.
    expect(el.querySelector('.pc-providers')).not.toBeNull()
    expect(built.count).toBe(0)
    flushSync(() => set({ pilot: { mode: 'on', provider: 'openai' } }))
    expect(el.querySelector('.mimir-connect')).toBeNull()
    expect(built.count).toBeGreaterThan(0)
    root.unmount()
  })
})
