// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The chamber cooling mode (chamber_cooling_mode, read by the Snapmaker U1's Top Cover start G-code) has no control in
// the app: the printer maker exposes no switch, and a preset, a project or a client sets it, or the slice picks it from
// the filaments. The settings panels never list it, even in Developer mode with a value set, and the slice read-back
// says which mode the G-code got.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { SliceResult } from '@slicerx/contracts'
import { isVisible, settingDef, settingsForTier } from '../src/adapters/settings'
import { sliceSummary } from '../src/agent-bridge'
import { ExpertSettings } from '../src/workspaces/prepare/expert-settings'
import { PrinterSettingsDialog } from '../src/workspaces/prepare/printer-settings'
import { set } from '../src/state/store'

const KEY = 'chamber_cooling_mode'

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

let root: Root | null = null
let el: HTMLElement | null = null
function render(node: Parameters<Root['render']>[0]): void {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  flushSync(() => root!.render(node))
}
function search(id: string, text: string): void {
  const input = document.getElementById(id) as HTMLInputElement
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
afterEach(() => {
  if (root) flushSync(() => root!.unmount())
  el?.remove()
  root = null
  el = null
  set({ overrides: {}, settingsMode: 'advanced', printerSettingsOpen: false })
})

describe('the chamber cooling mode in the settings', () => {
  it('is a hidden printer setting with no default', () => {
    expect(settingDef(KEY)).toMatchObject({ section: 'printer', type: 'int', mode: 'hidden', min: 0, max: 2 })
    expect(settingDef(KEY)?.default).toBeUndefined()
    expect(isVisible(settingDef(KEY)!, { filamentCount: 3 })).toBe(false)
    for (const tier of ['simple', 'advanced', 'expert'] as const) expect(settingsForTier('printer', tier, { filamentCount: 3 }).map((d) => d.key)).not.toContain(KEY)
  })

  it('has no row in the printer settings dialog, on its tab or by search, even in Developer mode with a value set', () => {
    set({ settingsMode: 'developer', printerSettingsOpen: true, overrides: { [KEY]: 2 } })
    render(createElement(PrinterSettingsDialog, { printer: undefined }))
    // The Cooling tab lists the other printer cooling keys.
    const tab = [...el!.querySelectorAll('button')].find((b) => b.textContent === 'Cooling')
    expect(tab).toBeTruthy()
    flushSync(() => tab!.click())
    expect(document.getElementById('ps-auxiliary_fan')).not.toBeNull()
    expect(document.getElementById(`ps-${KEY}`)).toBeNull()
    search('ps-search', 'chamber cooling')
    expect(document.getElementById(`ps-${KEY}`)).toBeNull()
    expect(el!.textContent).not.toContain('Chamber cooling mode')
  })

  it('has no row in the process settings panel either', () => {
    set({ settingsMode: 'developer', settingsTab: 'quality', overrides: { [KEY]: 2 } })
    render(createElement(ExpertSettings))
    search('expert-search', 'chamber cooling mode')
    expect(document.getElementById(`set-${KEY}`)).toBeNull()
    expect(el!.textContent).not.toContain('Chamber cooling mode')
  })
})

describe('the slice read-back', () => {
  const result = (over: Partial<SliceResult> = {}): SliceResult => ({
    id: '9', engine: 'sx', layerCount: 10, layerZ: new Float32Array(), layerTimeS: new Float32Array(),
    stats: { timeS: 60, filamentMm: [100], filamentG: [3], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 5, warnings: [], ...over,
  })
  const base = { plate: [], plates: [], activePlate: 'plate-1', autoSlice: false, autoSliceBySize: true, sliceHeld: false }

  it('names the chamber cooling mode the G-code got and where it came from', () => {
    const chamberCooling = { mode: 2, source: 'derived' as const, filaments: ['PLA'], text: 'chamber cooling mode 2, strong cooling (external circulation), from the filaments: PLA' }
    expect(sliceSummary({ ...base, slice: { status: 'done', result: result({ chamberCooling }), stale: false } })).toMatchObject({ status: 'done', chamberCooling })
  })

  it('leaves it out for a printer whose G-code does not read it', () => {
    expect(sliceSummary({ ...base, slice: { status: 'done', result: result(), stale: false } })).not.toHaveProperty('chamberCooling')
  })
})
