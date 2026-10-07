// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Setup searches the network only when asked: the search listens for printers' announcements, which on
// macOS makes the system ask about incoming connections.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { HostContext } from '../src/host'
import { EMPTY_FORM } from '../src/first-run/printer-form'
import { PrinterStep, type PrinterController } from '../src/first-run/printer-step'

function controller(runScan: () => Promise<void>): PrinterController {
  const noop = () => undefined
  return {
    form: EMPTY_FORM,
    test: { status: 'idle' },
    method: null,
    setForm: noop,
    setSecret: noop,
    runTest: async () => undefined,
    cancelTest: noop,
    testFrom: async () => null,
    scan: { status: 'idle' },
    runScan,
    addFound: noop,
    field: null,
    setField: noop,
    save: async () => {
      throw new Error('no')
    },
    saveFrom: async () => {
      throw new Error('no')
    },
    current: () => EMPTY_FORM,
    reset: noop,
    keepReported: null,
    setKeepReported: noop,
    host: { scanRange: '192.168.1.0/24', keychain: false } as unknown as PrinterController['host'],
  }
}

describe('the setup printer step', () => {
  afterEach(() => cleanup())

  it('starts no discovery until Search my network is pressed', () => {
    const runScan = vi.fn(async () => undefined)
    const host = { kind: 'desktop', capabilities: {} } as unknown as Host
    render(createElement(HostContext.Provider, { value: host }, createElement(PrinterStep, { ctl: controller(runScan), onBack: null, onSkip: () => undefined, onSaved: () => undefined, onNoPrinter: () => undefined, helpVisible: false, phone: false })))
    expect(runScan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Search my network' }))
    expect(runScan).toHaveBeenCalledTimes(1)
  })
})
