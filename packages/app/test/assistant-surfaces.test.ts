// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition that names its own assistant ("yourmate", with its icon and accent) shows that name on every surface that
// speaks for it: the tab, the chat head and its input, the Settings section and the About credit that stays. The mark
// and accent resolution are in packages/ui/test/assistant-brand.test.tsx; this is the app's copy. Moved here from the
// assistant-brand Playwright spec, which ran only on a special build (SX_E2E_ASSISTANT_EDITION) and so never ran in CI.
import { setAssistantBrand } from '@slicerx/contracts'
import type { Host } from '@slicerx/contracts'
import { POWERED_BY } from '@slicerx/edition-config'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostContext } from '../src/host'
import { NEUTRAL, currentEdition, setCurrentEdition } from '../src/edition'
import { PilotSettingsSection } from '../src/pilot-connect/settings-section'
import { AboutDialog } from '../src/shell/about'
import { ModeTabs } from '../src/shell/mode-tab'
import { set } from '../src/state/store'
import { MimirChat } from '../src/workspaces/mimir/mimir-panes'

const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 4h14"/></svg>')}`
const YOURMATE = { name: 'yourmate', icon: ICON, accent: { light: '#006b65', dark: '#63e6d4' } }
const before = currentEdition()

// jsdom has no dialogs, resize observers, scrolling or media queries; the screens use them.
Element.prototype.scrollTo ??= () => undefined
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false
}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
if (!window.matchMedia) window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia

const host = {
  kind: 'web',
  capabilities: {},
  build: { version: '1.0.0', commit: '0123456789abcdef', sourceUrl: 'https://example.test/src' },
  slicer: {},
} as unknown as Host

beforeEach(() => {
  setCurrentEdition({ ...NEUTRAL, brand: { ...NEUTRAL.brand, assistant: YOURMATE } })
  set({ workspace: 'prepare', modelMode: 'mimir', modelModeDefault: 'slice', devBuild: true, settingsMode: 'simple', pilot: { mode: 'off' } })
})

afterEach(() => {
  cleanup()
  setCurrentEdition(before)
  setAssistantBrand()
})

const inHost = (child: ReturnType<typeof createElement>) => createElement(HostContext.Provider, { value: host }, child)

describe('an edition with its own assistant', () => {
  it('names the tab', () => {
    render(createElement(ModeTabs))
    expect(screen.getByTestId('tab-mimir').textContent).toBe('yourmate')
  })

  it('names the chat, its input and its mark, with the ravens watermark kept', async () => {
    await act(async () => void render(inHost(createElement(MimirChat))))
    const chat = screen.getByTestId('mimir-chat')
    expect(chat.querySelector('.mimir-chat-head h2')?.textContent).toBe('yourmate')
    expect(screen.getByPlaceholderText('Ask yourmate')).toBeTruthy()
    expect(chat.querySelector('.mimir-chat-mark image')?.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/)
    expect(screen.getByTestId('mimir-ravens').querySelector('image, svg')).not.toBeNull()
  })

  it('names the Settings section', () => {
    render(inHost(createElement(PilotSettingsSection)))
    const section = document.querySelector('[aria-labelledby="pilot-h"]')!
    expect(section.querySelector('#pilot-h')?.textContent).toBe('yourmate')
    expect(section.textContent).toContain('yourmate answers questions')
  })

  it('keeps the SlicerX credit, linked, on About', () => {
    set({ aboutOpen: true })
    render(inHost(createElement(AboutDialog)))
    const credit = screen.getByTestId('about-attribution').querySelector('a')!
    expect(credit.textContent).toBe(POWERED_BY.text)
    expect(credit.getAttribute('href')).toBe(POWERED_BY.url)
  })
})
