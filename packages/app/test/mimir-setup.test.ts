// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One mimir setup: first-run, Settings and the mimir panel show the same component, the model list starts on Auto and
// never on Opus, and first-run's steps fit the build (the desktop app, and the CAD-only browser studio).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, Suspense } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { NEUTRAL } from '../src/edition'
import { HostContext } from '../src/host'
import { MimirStep } from '../src/first-run/mimir-step'
import { setupSteps } from '../src/first-run/model'
import { ModelPicker } from '../src/pilot-connect/connect-panel'
import { pilotModel } from '../src/pilot-connect/llm'
import { PROVIDERS } from '../src/pilot-connect/keys'
import { PilotSettingsSection } from '../src/pilot-connect/settings-section'
import { setHostSlices } from '../src/state/model-mode'
import { normalizePrefs } from '../src/state/prefs'
import { set } from '../src/state/store'

const HOST = { kind: 'web', capabilities: { secureStorage: false } } as unknown as Host
const inHost = (el: ReturnType<typeof createElement>) => createElement(HostContext.Provider, { value: HOST }, createElement(Suspense, { fallback: null }, el))

afterEach(() => {
  cleanup()
  set({ pilot: null })
})

describe('one mimir setup', () => {
  it('first-run and Settings render the same component', () => {
    const a = render(inHost(createElement(MimirStep, { choice: 'skip', onChoose: () => undefined })))
    const setup = a.container.querySelector('.ms')
    expect(setup?.getAttribute('data-place')).toBe('setup')
    a.unmount()
    const b = render(inHost(createElement(PilotSettingsSection)))
    const settings = b.container.querySelector('.ms')
    expect(settings?.getAttribute('data-place')).toBe('settings')
    // the same parts: the key panel with its model list (one way in, so no cards, in this browser host)
    expect(b.container.querySelectorAll('.ms').length).toBe(1)
    expect(screen.getByTestId('pc-model')).toBeTruthy()
    // Anthropic first and picked, OpenAI second
    const cards = [...b.container.querySelectorAll('.pc-provider')]
    expect(cards.map((c) => c.querySelector('b')?.textContent)).toEqual(['Anthropic', 'OpenAI'])
    expect(cards[0]?.getAttribute('aria-checked')).toBe('true')
  })

  it('says what a CAD-only build sends, with no printer claims and no agent section', () => {
    setHostSlices(false)
    try {
      const view = render(inHost(createElement(PilotSettingsSection)))
      const privacy = view.container.querySelector('.pc-privacy')?.textContent ?? ''
      expect(privacy).toContain("the design you're working on")
      expect(view.container.textContent).not.toMatch(/printer/i)
      expect(view.container.querySelector('.ag-sec')).toBeNull()
      view.unmount()
    } finally {
      setHostSlices(true)
    }
  })

  it('lists the integrations with the same states the dock shows, and none in a CAD-only build', async () => {
    const manifests = [
      { id: 'bambu', name: 'Bambu Lab', kind: 'printer', tools: [{}, {}] },
      { id: 'moonraker', name: 'Klipper', kind: 'printer', tools: [{}] },
    ]
    const printers = { plugins: async () => manifests, list: async () => [{ id: 'a1', name: 'A1 mini', plugin: 'bambu' }] }
    const host = { ...HOST, printers } as unknown as Host
    const withPrinters = (el: ReturnType<typeof createElement>) => createElement(HostContext.Provider, { value: host }, createElement(Suspense, { fallback: null }, el))
    const view = render(withPrinters(createElement(PilotSettingsSection)))
    const list = await screen.findByTestId('mimir-integrations')
    await screen.findByText('A1 mini')
    const rows = [...list.querySelectorAll('li')].map((li) => li.textContent)
    expect(rows).toEqual(['Bambu LabA1 miniConnected', 'KlipperNo printers assignedOff'])
    view.unmount()
    setHostSlices(false)
    try {
      const cad = render(withPrinters(createElement(PilotSettingsSection)))
      expect(cad.queryByTestId('mimir-integrations')).toBeNull()
      cad.unmount()
    } finally {
      setHostSlices(true)
    }
  })

  it('starts the model list on Auto, never on Opus, and keeps any other id', () => {
    let model = 'auto'
    const view = render(inHost(createElement(ModelPicker, { idPrefix: 't', provider: 'anthropic', value: model, onChange: (v: string) => (model = v) })))
    const select = screen.getByTestId('pc-model') as HTMLSelectElement
    expect(select.value).toBe('auto')
    expect(select.selectedOptions[0]?.textContent).toMatch(/^Auto/)
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Auto (Haiku, Sonnet for hard parts)',
      'Haiku 5.5 (lowest)',
      'Sonnet 5.5 (medium)',
      'Opus 5.5 (highest)',
      'Other model id',
    ])
    fireEvent.change(select, { target: { value: '\u0000other' } })
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'claude-custom' } })
    expect(model).toBe('claude-custom')
    view.unmount()
    const openai = render(inHost(createElement(ModelPicker, { idPrefix: 'o', provider: 'openai', value: 'auto', onChange: () => undefined })))
    expect([...(screen.getByTestId('pc-model') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['auto', 'gpt-6-luna', 'gpt-6-sol', '\u0000other'])
    openai.unmount()
    // a local server names its own models: a plain field, empty for Auto
    const local = render(inHost(createElement(ModelPicker, { idPrefix: 'l', provider: 'local', value: 'auto', onChange: () => undefined })))
    expect((screen.getByTestId('pc-model') as HTMLInputElement).value).toBe('')
    local.unmount()
    // Auto is saved as 'auto'; an old pref with no model reads as Auto, and Auto runs Haiku, never Opus
    expect(PROVIDERS.anthropic.defaultModel).not.toMatch(/opus/)
    expect(normalizePrefs({ pilot: { mode: 'on', provider: 'anthropic' } }).pilot).toEqual({ mode: 'on', provider: 'anthropic', model: 'auto' })
    expect(normalizePrefs({ pilot: { mode: 'on', provider: 'mimir-cloud' } }).pilot).toEqual({ mode: 'on', provider: 'mimir-cloud' })
    expect(pilotModel(NEUTRAL, { mode: 'on', provider: 'anthropic', model: 'auto' }, false)?.model).toBe('claude-haiku-5-5')
    expect(pilotModel(NEUTRAL, { mode: 'on', provider: 'anthropic' }, false)?.model).toBe('claude-haiku-5-5')
    expect(pilotModel(NEUTRAL, { mode: 'on', provider: 'anthropic', model: 'claude-custom' }, false)?.model).toBe('claude-custom')
  })
})

describe('first-run steps', () => {
  it('the desktop app: theme, printer, slicer, opens in, mimir', () => {
    expect(setupSteps({ cad: true, mimir: true, slicing: true })).toEqual(['theme', 'printer', 'look', 'open', 'mimir'])
  })
  it('the CAD-only browser studio: theme and mimir only', () => {
    expect(setupSteps({ cad: true, mimir: true, slicing: false })).toEqual(['theme', 'mimir'])
  })
})
