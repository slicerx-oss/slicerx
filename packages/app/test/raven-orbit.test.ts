// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A connection test that takes a while: the ravens circle the printer with a three step trail and Cancel,
// and land on it when the printer answers. A quick test never shows them.
import { connectionMethod } from '@slicerx/printer-catalog'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_FORM, type PrinterForm } from '../src/first-run/printer-form'
import { TestCard, type PrinterController } from '../src/first-run/printer-step'
import { trail } from '../src/first-run/raven-orbit'
import type { TestStep } from '../src/first-run/setup-registry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bambu = connectionMethod('bambu-lan')
const FORM: PrinterForm = { ...EMPTY_FORM, connection: 'bambu-lan', name: 'Tawain #1' }
const at = (reach: TestStep['ok'], sign: TestStep['ok'], running?: TestStep['id']): TestStep[] =>
  (['reach', 'sign_in', 'read_state', 'read_temperatures'] as const).map((id) => ({ id, ok: id === 'reach' ? reach : id === 'sign_in' ? sign : null, ...(id === running ? { running: true } : {}) }))

function ctl(test: PrinterController['test'], cancelTest = () => undefined): PrinterController {
  const noop = () => undefined
  return { form: FORM, test, method: bambu, setForm: noop, setSecret: noop, runTest: async () => undefined, cancelTest, testFrom: async () => null, scan: { status: 'idle' }, runScan: async () => undefined, addFound: noop, field: null, setField: noop, save: async () => { throw new Error('no') }, saveFrom: async () => { throw new Error('no') }, current: () => FORM, reset: noop, keepReported: null, setKeepReported: noop, host: {} as PrinterController['host'] }
}

afterEach(() => vi.useRealTimers())

describe('the ravens on a long connection test', () => {
  it('reads the four test steps as three', () => {
    expect(trail(at(true, null, 'sign_in'), bambu).map((r) => `${r.label}: ${r.state}`)).toEqual([
      'Found on your network: ok',
      'Signing in with the access code: run',
      'Reading its status and filaments: wait',
    ])
    expect(trail(at(true, false), bambu)[1]!.state).toBe('bad')
  })

  it('circle after 1.2 s with the trail and Cancel, then land when it connects', () => {
    vi.useFakeTimers()
    const el = document.createElement('div')
    const root = createRoot(el)
    const cancel = vi.fn()
    const show = (test: PrinterController['test']) => act(() => root.render(createElement(TestCard, { ctl: ctl(test, cancel), onUseReported: () => undefined })))
    show({ status: 'testing', steps: at(true, null, 'sign_in') })
    expect(el.querySelector('.fr-orbit')).toBeNull()
    expect(el.querySelector('.fr-checks')).not.toBeNull()
    act(() => void vi.advanceTimersByTime(1200))
    expect(el.querySelectorAll('.fr-orbit-arm .sx-raven[data-flap]')).toHaveLength(2)
    expect(el.querySelector('.fr-orbit-title')!.textContent).toBe('Connecting to Tawain #1')
    expect(el.querySelector('.fr-checks')).toBeNull()
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    act(() => button.click())
    expect(cancel).toHaveBeenCalledOnce()
    show({ status: 'done', outcome: { ok: true, steps: at(true, true).map((s) => ({ ...s, ok: true })) } })
    expect(el.querySelector('.fr-orbit[data-landed]')).not.toBeNull()
    expect(el.querySelectorAll('.fr-orbit-perched')).toHaveLength(2)
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(false)
    act(() => root.unmount())
  })

  it('stay away from a quick test', () => {
    vi.useFakeTimers()
    const el = document.createElement('div')
    const root = createRoot(el)
    act(() => root.render(createElement(TestCard, { ctl: ctl({ status: 'testing', steps: at(null, null, 'reach') }), onUseReported: () => undefined })))
    act(() => void vi.advanceTimersByTime(600))
    act(() => root.render(createElement(TestCard, { ctl: ctl({ status: 'done', outcome: { ok: true, steps: at(true, true).map((s) => ({ ...s, ok: true })) } }), onUseReported: () => undefined })))
    act(() => void vi.advanceTimersByTime(2000))
    expect(el.querySelector('.fr-orbit')).toBeNull()
    act(() => root.unmount())
  })
})
