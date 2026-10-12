// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A host that cannot slice (the CAD-only browser build) keeps the app in Model on the plate, whatever asks for Slice,
// and its Open in SlicerX link names the downloaded design by hash and file name only. Setup and Settings skip the
// printer, the slicer look and the slicing settings.
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { setupSteps } from '../src/first-run/model'
import { HostContext } from '../src/host'
import { SettingsDialog } from '../src/shell/settings'
import { cadShown, hostSlices, modelMode, setHostSlices, stayInModel, toggleModelMode } from '../src/state/model-mode'
import { appLink } from '../src/shell/open-in-app'
import { get, set } from '../src/state/store'

beforeAll(() => {
  // jsdom has no modal dialogs.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

// the mesh-only web host, as far as Settings reads it
const host = { kind: 'web', capabilities: { secureStorage: false, slicing: false } } as unknown as Host
const settings = () => render(createElement(HostContext.Provider, { value: host }, createElement(SettingsDialog)))

describe('the CAD-only build', () => {
  afterEach(() => {
    cleanup()
    set({ settingsOpen: false, settingsSection: null })
    setHostSlices(true)
  })

  it('stays in Model on the plate', () => {
    setHostSlices(false)
    expect(hostSlices()).toBe(false)
    expect(cadShown()).toBe(true)
    set({ modelMode: 'slice', workspace: 'printers' })
    expect(modelMode()).toBe('design')
    const stop = stayInModel()
    expect(get().modelMode).toBe('design')
    expect(get().workspace).toBe('prepare')
    set({ modelMode: 'slice' })
    expect(get().modelMode).toBe('design')
    toggleModelMode()
    expect(get().modelMode).toBe('design')
    stop()
  })

  it('leaves a host that slices as it was', () => {
    set({ modelMode: 'slice', workspace: 'prepare' })
    toggleModelMode()
    expect(['design', 'slice']).toContain(get().modelMode)
    expect(hostSlices()).toBe(true)
  })

  it('links to the downloaded design by its hash and name', () => {
    expect(appLink('slicerx', 'ab'.repeat(32), 'My clip.sx3mf')).toBe(`slicerx://open?download=${'ab'.repeat(32)}&name=My%20clip.sx3mf`)
  })

  it('sets up the theme, and mimir where it is offered, without a printer or a slicer look', () => {
    expect(setupSteps({ cad: true, mimir: false, slicing: false })).toEqual(['theme'])
    expect(setupSteps({ cad: true, mimir: true, slicing: false })).toEqual(['theme', 'mimir'])
    expect(setupSteps({ cad: true, mimir: false })).toEqual(['theme', 'printer', 'look', 'open'])
  })

  it('leaves printers, presets and slicing out of Settings', () => {
    setHostSlices(false)
    set({ settingsOpen: true, settingsSection: 'slicing' })
    settings()
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const names = [...nav.querySelectorAll('button')].map((b) => b.textContent)
    expect(names).not.toContain('Presets')
    expect(names).not.toContain('Phone access')
    expect(names).not.toContain('Printer bridge')
    expect(names).toContain('Modeling')
    expect(screen.queryByText('Auto slice')).toBeNull()
    expect(screen.getByText('Drawing tools')).toBeTruthy()
    cleanup()
    set({ settingsSection: 'look' })
    settings()
    expect(screen.getByText('Accessibility')).toBeTruthy()
    expect(screen.queryByText('Open models in')).toBeNull()
    expect(screen.queryByText('Add a printer with guided setup')).toBeNull()
    expect(screen.getByRole('button', { name: /setup/ })).toBeTruthy()
  })

  it('keeps the slicing settings for a host that slices', () => {
    set({ settingsOpen: true, settingsSection: 'slicing' })
    settings()
    expect(screen.getByText('Auto slice')).toBeTruthy()
  })
})
