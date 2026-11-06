// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer controls dialog: the firmware the printer runs, and Home on the Move tab, which homes only an idle or
// finished printer and asks about the plate when the hub cannot tell it is clear.
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { HostContext } = await import('../src/host')
const { DeviceDialog } = await import('../src/features/fleet/device-dialog')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const printer: PrinterInfo = { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'H2D', plugin: 'bambu-lan', nozzleCount: 2 }
const idle: PrinterStatus = { printerId: 'bay-1', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, firmware: '01.04.00.00', updatedAt: '2026-11-05T12:00:00.000Z' }
const refuse = (code: string) => Object.assign(new Error(`hub says ${code}`), { code })

function fakeHub(home: (...a: unknown[]) => Promise<void>) {
  const calls = { home: vi.fn(home), confirmClear: vi.fn(async () => ({})) }
  const printers = {
    device: { files: async () => [], history: async () => [], issues: async () => [], objects: async () => [], jog: async () => undefined, home: calls.home, skipObject: async () => undefined, startFile: async () => ({}) },
    bed: { state: async () => ({ askOnPrint: true }), confirmClear: calls.confirmClear },
  }
  return { host: { kind: 'web', capabilities: {}, printers } as never, calls }
}

let root: Root | null = null
let el: HTMLDivElement | null = null

async function show(host: unknown, status: PrinterStatus): Promise<void> {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => root!.render(createElement(HostContext.Provider, { value: host as never }, createElement(DeviceDialog, { printer, status, onClose: () => undefined }))))
  await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
}

// A disabled button with a tooltip stays hoverable, so it is aria-disabled rather than disabled.
const off = (b: HTMLButtonElement | undefined) => b?.disabled === true || b?.getAttribute('aria-disabled') === 'true'
const button = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined
const click = async (b: HTMLButtonElement | undefined) => {
  await act(async () => void b!.click())
  await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
}

// The test DOM has no modal dialogs: open and close by the attribute.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

afterEach(() => {
  act(() => root?.unmount())
  el?.remove()
  root = null
  el = null
})

describe('the printer controls dialog', () => {
  it('names the firmware the printer runs', async () => {
    await show(fakeHub(async () => undefined).host, idle)
    expect(document.body.querySelector('[data-testid="device-firmware"]')?.textContent).toBe('Firmware 01.04.00.00')
  })

  it('homes an idle printer from the Move tab', async () => {
    const { host, calls } = fakeHub(async () => undefined)
    await show(host, idle)
    expect(off(button('Home'))).toBe(false)
    await click(button('Home'))
    expect(calls.home).toHaveBeenCalledWith('bay-1')
    expect(calls.confirmClear).not.toHaveBeenCalled()
  })

  it('rests Home while the printer prints, and says why', async () => {
    const { host, calls } = fakeHub(async () => undefined)
    await show(host, { ...idle, state: 'printing' })
    // Mid-print the dialog opens on Skip objects; Move is one tab away.
    await click([...document.body.querySelectorAll('nav button')].find((b) => b.textContent === 'Move') as HTMLButtonElement)
    expect(off(button('Home'))).toBe(true)
    expect(document.body.textContent).toContain('The head moves and homes only while the printer is idle or finished.')
    expect(calls.home).not.toHaveBeenCalled()
  })

  // The answer goes with that home only: the hub does not record the plate as clear for a later start.
  it('asks whether the plate is clear when the hub cannot tell, then homes with that answer', async () => {
    const { host, calls } = fakeHub(async (...a: unknown[]) => {
      if (!(a[1] as { plateClear?: boolean } | undefined)?.plateClear) throw Object.assign(refuse('bed_check'), { details: { epoch: 9 } })
    })
    await show(host, { ...idle, state: 'finished' })
    await click(button('Home'))
    const ask = document.body.querySelector('[role="alertdialog"][aria-label="Confirm home"]')
    expect(ask?.textContent).toContain('Is the build plate clear?')
    await click(button('Plate is clear, home'))
    // The answer is about the plate the hub asked about: the bed epoch of its refusal.
    expect(calls.home.mock.calls).toEqual([['bay-1'], ['bay-1', { plateClear: true, epoch: 9 }]])
    expect(calls.confirmClear).not.toHaveBeenCalled()
    expect(document.body.querySelector('[aria-label="Confirm home"]')).toBeNull()
  })

  it('drops the plate question on Cancel, and when the printer starts a job', async () => {
    const { host, calls } = fakeHub(async () => {
      throw Object.assign(refuse('bed_check'), { details: { epoch: 2 } })
    })
    await show(host, { ...idle, state: 'finished' })
    await click(button('Home'))
    await click(button('Cancel'))
    expect(document.body.querySelector('[aria-label="Confirm home"]')).toBeNull()
    expect(calls.home).toHaveBeenCalledTimes(1)
    await click(button('Home'))
    expect(document.body.querySelector('[aria-label="Confirm home"]')).not.toBeNull()
    await act(async () => root!.render(createElement(HostContext.Provider, { value: host as never }, createElement(DeviceDialog, { printer, status: { ...idle, state: 'printing' }, onClose: () => undefined }))))
    await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
    expect(document.body.querySelector('[aria-label="Confirm home"]')).toBeNull()
    expect(off(button('Home'))).toBe(true)
    expect(calls.home).toHaveBeenCalledTimes(2)
  })
})
