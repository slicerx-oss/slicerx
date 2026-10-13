// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A setting changed in a higher settings mode stays listed after the person switches to Advanced, in the process settings panel
// and in the printer settings dialog: a change that steers the slice is never hidden by the settings mode.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { isVisible, SETTINGS } from '../src/adapters/settings'
import { EDITABLE, ExpertSettings } from '../src/workspaces/prepare/expert-settings'
import { PrinterSettingsDialog } from '../src/workspaces/prepare/printer-settings'
import { get, set } from '../src/state/store'

// The test DOM has no modal dialogs; the printer settings dialog only needs its open attribute.
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
afterEach(() => {
  if (root) flushSync(() => root!.unmount())
  el?.remove()
  root = null
  el = null
  set({ overrides: {}, settingsMode: 'advanced', printerSettingsOpen: false })
})

/** A changed value for a setting: a flipped switch, another option, or a number a little off the default. */
function changedValue(key: string): unknown {
  const def = SETTINGS.find((d) => d.key === key)!
  const v = def.default as unknown
  if (def.type === 'bool') return !v
  if (def.type === 'enum') return def.enumValues!.find((o) => o !== v)
  if (typeof v === 'number') return v + 1
  return v
}

describe('a changed setting above the settings mode', () => {
  const process = SETTINGS.find((d) => d.section === 'process' && d.mode === 'expert' && EDITABLE.has(d.type) && (d.type === 'bool' || d.type === 'int' || d.type === 'float') && isVisible(d, { filamentCount: 1 }) && d.intent === 'quality')!

  it('stays listed in Advanced under the Expert divider, and an unchanged one does not', () => {
    expect(process).toBeDefined()
    set({ settingsMode: 'advanced', settingsTab: process.intent!, overrides: {} })
    render(createElement(ExpertSettings))
    expect(document.getElementById(`set-${process.key}`)).toBeNull()
    flushSync(() => set({ overrides: { [process.key]: changedValue(process.key) as never } }))
    const row = document.getElementById(`set-${process.key}`)?.closest('li')
    expect(row).toBeTruthy()
    expect(row!.className).toContain('changed')
    // It sits under the Expert divider, after the Advanced rows, and Advanced offers no "more" to open.
    const items = [...el!.querySelectorAll(`section[data-intent="${process.intent}"] li`)]
    const divider = items.findIndex((li) => li.classList.contains('tier-divider'))
    expect(divider).toBeGreaterThanOrEqual(0)
    expect(items.indexOf(row!)).toBeGreaterThan(divider)
    expect(el!.querySelector('.tier-more')).toBeNull()
  })

  it('is found by a search in Advanced', () => {
    set({ settingsMode: 'advanced', settingsTab: 'quality', overrides: { [process.key]: changedValue(process.key) as never } })
    render(createElement(ExpertSettings))
    const search = document.getElementById('expert-search') as HTMLInputElement
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, process.label ?? process.key)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.getElementById(`set-${process.key}`)).not.toBeNull()
  })

  it('stays listed in the printer settings dialog, here a Developer key after a switch to Advanced', () => {
    const printer = SETTINGS.find((d) => d.key === 'nozzle_height')!
    expect(printer).toMatchObject({ section: 'printer', mode: 'develop', group: 'machine' })
    set({ settingsMode: 'advanced', printerSettingsOpen: true, overrides: {} })
    render(createElement(PrinterSettingsDialog, { printer: undefined }))
    expect(document.getElementById('ps-nozzle_height')).toBeNull()
    flushSync(() => set({ overrides: { nozzle_height: changedValue('nozzle_height') as never } }))
    expect(document.getElementById('ps-nozzle_height')).not.toBeNull()
    expect(get().overrides).toHaveProperty('nozzle_height')
  })
})
