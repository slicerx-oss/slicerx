// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A system keychain that refuses the access code (Windows Credential Manager error 8 on a user's PC): the printer
// is saved anyway and the person is told the code lasts until the app closes. A connection test that cannot run
// says why instead of reporting that the printer did not answer.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_FORM, type PrinterForm } from '../src/first-run/printer-form'
import { usePrinterController, type PrinterController } from '../src/first-run/printer-step'
import type { AppSetupHost } from '../src/first-run/setup-registry'
import { get, set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FORM: PrinterForm = { ...EMPTY_FORM, connection: 'bambu-lan', name: 'P1S', fields: { ...EMPTY_FORM.fields, host: '192.168.1.231', serial: '01P00A000000000' } }

function mount(host: Partial<AppSetupHost>): { ctl: () => PrinterController; done: () => void } {
  let ctl: PrinterController | null = null
  const Probe = () => {
    ctl = usePrinterController(host as AppSetupHost)
    return null
  }
  const el = document.createElement('div')
  const root = createRoot(el)
  act(() => root.render(createElement(Probe)))
  return { ctl: () => ctl!, done: () => act(() => root.unmount()) }
}

afterEach(() => set({ toast: null }))

describe('a keychain that refuses the access code', () => {
  it('saves the printer and says the code is kept until the app closes', async () => {
    const m = mount({ addPrinter: async () => ({ printerId: 'p1s', credentialKept: 'session' }) })
    const saved = await act(async () => m.ctl().saveFrom(FORM, false))
    expect(saved.printerId).toBe('p1s')
    const t = get().toast
    expect(t?.tone).toBe('warn')
    expect(t?.text).toMatch(/keychain/i)
    expect(t?.text).toMatch(/until .* closes/i)
    m.done()
  })

  it('says nothing more when the code was stored', async () => {
    const m = mount({ addPrinter: async () => ({ printerId: 'p1s' }) })
    await act(async () => m.ctl().saveFrom(FORM, false))
    expect(get().toast).toBeNull()
    m.done()
  })

  it('shows why a connection test could not run instead of "no answer"', async () => {
    const m = mount({
      testConnection: async () => {
        throw new Error('bad configuration: keychain write failed: Platform failure: Windows error code 8')
      },
    })
    const outcome = await act(async () => m.ctl().testFrom(FORM, false))
    expect(outcome?.ok).toBe(false)
    expect(outcome?.cause).not.toBe('unreachable')
    // No step ran, so none is shown as failed.
    expect(outcome?.steps.every((s) => s.ok === null)).toBe(true)
    expect(outcome?.message).toMatch(/Windows error code 8/)
    m.done()
  })
})
