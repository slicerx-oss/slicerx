// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The launch-time printer setup: a printer the scan found asks only for its access code. Its address,
// serial number, model and name come from the scan, stay put when the scan runs again, and nothing
// reads as an error before the person types.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { shouldAskForPrinter } from '../src/first-run/ask-printer'
import { FirstRun } from '../src/first-run/first-run'
import { openSetup } from '../src/first-run/look'
import { registerPrinterSetup, type AppSetupHost, type FoundPrinter } from '../src/first-run/setup-registry'
import { HostContext } from '../src/host'
import { set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollTo ??= function () {}
Element.prototype.scrollIntoView ??= function () {}
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia

/** The owner's H2D as the desktop bridge lists it from its SSDP answer. */
const H2D: FoundPrinter = { id: '0948AB510800227', name: 'Tawain #1', family: 'bambu-lan', address: '192.168.68.52', model: 'H2D', serial: '0948AB510800227', firmware: '01.03.00.00', lanOnly: true }

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 300)))

async function launch(scans: FoundPrinter[][]): Promise<{ el: HTMLDivElement; tests: { address: string; serial?: string }[]; codes: (string | undefined)[]; done: () => void }> {
  const tests: { address: string; serial?: string }[] = []
  const codes: (string | undefined)[] = []
  let n = 0
  const setup: AppSetupHost = {
    keychain: true,
    scanRange: 'your local network',
    searchProfiles: async () => [],
    discover: async () => scans[Math.min(n++, scans.length - 1)]!,
    testConnection: async (c) => (tests.push({ address: c.address, ...(c.serial ? { serial: c.serial } : {}) }), codes.push(c.credential), { ok: false, steps: [] }),
    addPrinter: async () => ({ printerId: 'h2d' }),
  }
  registerPrinterSetup(() => setup)
  set({ agreementOpen: false, setup: null, noPrinter: false, firstRun: null })
  // What the desktop's launch check does with no printers once the bridge has settled.
  expect(shouldAskForPrinter({ kind: 'desktop', printers: 0, bridgeSettled: true, setupOpen: false, agreementOpen: false, noPrinter: false, offered: false })).toBe(true)
  openSetup('printer')
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const host = { kind: 'desktop', build: {}, capabilities: { printers: 'link', secureStorage: true }, printers: undefined } as never
  await act(async () => root.render(createElement(HostContext.Provider, { value: host }, createElement(FirstRun))))
  // Setup searches only when asked.
  const search = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Search my network'))
  if (!search) throw new Error('no Search my network button')
  await act(async () => search.click())
  return { el, tests, codes, done: () => (act(() => root.unmount()), el.remove(), registerPrinterSetup(null)) }
}

const visibleInputs = (el: HTMLElement) => [...el.querySelectorAll<HTMLInputElement>('.fr-scanview input')].map((i) => i.id)

afterEach(() => set({ setup: null }))

describe('picking a printer the launch-time scan found', () => {
  it('asks only for the access code, with the address and serial number carried through', async () => {
    const r = await launch([[H2D]])
    await settle()
    if (!r.el.querySelector('.fr-foundcard')) throw new Error(r.el.textContent ?? '')
    const card = r.el.querySelector<HTMLButtonElement>('.fr-foundcard')!
    expect(card.textContent).toContain('H2D')
    await act(async () => card.click())
    await settle()
    expect(visibleInputs(r.el)).toEqual(['fr-f-accessCode'])
    expect(r.el.querySelector('#fr-enterip')).toBeNull()
    // Nothing is an error before the person types.
    expect(r.el.querySelector('#fr-test-why')).toBeNull()
    expect(r.el.querySelector('[role="alert"]')).toBeNull()
    expect(r.el.querySelector('.fr-codecard-h')?.textContent?.trim()).toBe('Tawain #1 (H2D) found')
    expect(r.el.querySelector('.fr-codecard-lede')?.textContent).toBe("Enter the access code from the printer's LAN Only screen.")
    // The details are there, prefilled, behind one link.
    const edit = [...r.el.querySelectorAll('button')].find((b) => b.textContent === 'Edit connection details')!
    await act(async () => edit.click())
    expect(r.el.querySelector<HTMLInputElement>('#fr-f-host')?.value).toBe('192.168.68.52')
    expect(r.el.querySelector<HTMLInputElement>('#fr-f-serial')?.value).toBe('0948AB510800227')
    r.done()
  })

  it('keeps the address when the scan runs again and finds nothing', async () => {
    const r = await launch([[H2D], []])
    await settle()
    await act(async () => r.el.querySelector<HTMLButtonElement>('.fr-foundcard')!.click())
    const again = [...r.el.querySelectorAll('button')].find((b) => b.textContent?.includes('Scan again'))!
    await act(async () => again.click())
    await settle()
    expect(visibleInputs(r.el)).toEqual(['fr-f-accessCode'])
    expect(r.el.querySelector('.fr-foundcard')?.textContent).toContain('Tawain #1')
    // The code is all the test needs; it goes out with the scanned address and serial number.
    const code = r.el.querySelector<HTMLInputElement>('#fr-f-accessCode')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(code, '12345678')
      code.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => new Promise<void>((res) => setTimeout(res, 700)))
    expect(r.tests).toEqual([{ address: '192.168.68.52', serial: '0948AB510800227' }])
    r.done()
  })
})

const type = async (input: HTMLInputElement, value: string, event = 'input') => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(event, { bubbles: true }))
  })
}
const connect = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.fr-codecard button')].find((x) => x.textContent === 'Connect')!

describe('the access code', () => {
  it('connects with the code as typed, spaces or not, and is not a password field', async () => {
    const r = await launch([[H2D]])
    await settle()
    await act(async () => r.el.querySelector<HTMLButtonElement>('.fr-foundcard')!.click())
    const code = r.el.querySelector<HTMLInputElement>('#fr-f-accessCode')!
    expect(code.type).toBe('text')
    // Connect with nothing typed says so in one sentence, and only then.
    expect(r.el.querySelector('[role="alert"]')).toBeNull()
    await act(async () => connect(r.el).click())
    expect(r.el.querySelector('.fr-codecard-msg')?.textContent).toBe('Enter the 8-character access code first.')
    await type(code, '3CC8 1426')
    expect(r.el.querySelector('.fr-codecard-msg')).toBeNull()
    await act(async () => connect(r.el).click())
    await settle()
    expect(r.tests[0]).toEqual({ address: '192.168.68.52', serial: '0948AB510800227' })
    r.done()
  })

  it('goes out with its case exactly as typed: the printer compares it as a password', async () => {
    const r = await launch([[H2D]])
    await settle()
    await act(async () => r.el.querySelector<HTMLButtonElement>('.fr-foundcard')!.click())
    await type(r.el.querySelector<HTMLInputElement>('#fr-f-accessCode')!, ' 3Cc8 14aB ')
    await act(async () => connect(r.el).click())
    await settle()
    expect(r.codes).toEqual(['3Cc814aB'])
    r.done()
  })

  it('counts a code that arrived without an input event once the field loses focus', async () => {
    const r = await launch([[H2D]])
    await settle()
    await act(async () => r.el.querySelector<HTMLButtonElement>('.fr-foundcard')!.click())
    await type(r.el.querySelector<HTMLInputElement>('#fr-f-accessCode')!, '3cc81426', 'focusout')
    await act(async () => new Promise<void>((res) => setTimeout(res, 700)))
    expect(r.tests).toHaveLength(1)
    r.done()
  })

  it('is not forgotten when the printer is picked again', async () => {
    const r = await launch([[H2D]])
    await settle()
    await act(async () => r.el.querySelector<HTMLButtonElement>('.fr-foundcard')!.click())
    await type(r.el.querySelector<HTMLInputElement>('#fr-f-accessCode')!, '3cc81426')
    await act(async () => r.el.querySelector<HTMLButtonElement>('.fr-foundcard')!.click())
    expect(r.el.querySelector<HTMLInputElement>('#fr-f-accessCode')!.value).toBe('3cc81426')
    expect(r.el.querySelector('#fr-test-why')).toBeNull()
    await act(async () => connect(r.el).click())
    await settle()
    expect(r.tests.length).toBeGreaterThan(0)
    r.done()
  })
})
