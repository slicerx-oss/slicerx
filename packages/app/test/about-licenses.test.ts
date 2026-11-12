// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// About opens the license files a desktop install carries (Host.licenses), so the kernel's license and SlicerX's notice
// of its changes reach the person with the app. The browser build has no such folder and shows no button.
import type { Host } from '@slicerx/contracts'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostContext } from '../src/host'
import { AboutDialog } from '../src/shell/about'
import { set } from '../src/state/store'

// jsdom has no dialogs or resize observers; the dialog uses them.
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

const hostOf = (over: Partial<Host>) =>
  ({
    kind: 'web',
    capabilities: {},
    build: { version: '1.0.0', commit: '0123456789abcdef', sourceUrl: 'https://example.test/src' },
    slicer: {},
    ...over,
  }) as unknown as Host

const about = (host: Host) => {
  set({ aboutOpen: true })
  render(createElement(HostContext.Provider, { value: host }, createElement(AboutDialog)))
}

afterEach(() => {
  cleanup()
  set({ aboutOpen: false })
})

describe('About and the license files', () => {
  it('opens the folder the desktop app carries them in', () => {
    const openFolder = vi.fn(async () => undefined)
    about(hostOf({ kind: 'desktop', licenses: { openFolder } }))
    const row = screen.getByTestId('about-licenses')
    expect(row.textContent).toContain('license texts and notices')
    fireEvent.click(screen.getByRole('button', { name: /Show license files/ }))
    expect(openFolder).toHaveBeenCalledTimes(1)
  })

  it('shows no button where the host has no license folder', () => {
    about(hostOf({}))
    expect(screen.queryByTestId('about-licenses')).toBeNull()
    expect(screen.queryByRole('button', { name: /Show license files/ })).toBeNull()
  })
})
