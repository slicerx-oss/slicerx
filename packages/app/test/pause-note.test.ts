// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { pauseNoteOf } from '../src/features/fleet/device'
import { DeviceDialog } from '../src/features/fleet/device-dialog'
import { HostContext } from '../src/host'

const NOTE = 'Paused with the heaters on. This printer does not turn them off by itself while paused, so resume or cancel the print when you can.'

const status = (s: Partial<PrinterStatus>): PrinterStatus => ({ printerId: 'p1', state: 'paused', nozzles: [{ current: 215, target: 215 }], slots: [], cameraAvailable: false, updatedAt: '2026-10-02T06:00:00Z', ...s })

describe('pause note from the hub', () => {
  it('shows only on a paused print that carries one', () => {
    expect(pauseNoteOf(status({ pauseNote: NOTE }))).toBe(NOTE)
    expect(pauseNoteOf(status({}))).toBeNull()
    expect(pauseNoteOf(status({ pauseNote: '  ' }))).toBeNull()
    // A stale note on a printer that resumed is not shown.
    expect(pauseNoteOf(status({ state: 'printing', pauseNote: NOTE }))).toBeNull()
  })

  it('reads out in the device dialog in plain text', () => {
    // jsdom has no modal dialogs; the dialog only needs to open.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    const printer = { id: 'p1', name: 'Bay 3', model: 'Voron 2.4', plugin: 'moonraker' } as unknown as PrinterInfo
    const host = { kind: 'web', capabilities: {} } as never
    flushSync(() => root.render(createElement(HostContext.Provider, { value: host }, createElement(DeviceDialog, { printer, status: status({ pauseNote: NOTE }), onClose: () => undefined }))))
    const note = document.body.querySelector('[role="note"]')
    expect(note?.textContent).toBe(NOTE)
    root.unmount()
    el.remove()
  })
})
