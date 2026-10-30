// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connecting a Klipper or OctoPrint printer through Obico: the paste box takes the tunnel address, shows only its
// host, and hands the user name and password to the keychain path. The password never reaches the page, the form,
// the store or the console, and every tunnel problem reads as a plain message.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TUNNEL_PROBLEM_TEXT, TUNNEL_PROBLEMS, type PrinterStatus, type TunnelReport } from '@slicerx/contracts'
import { connectionMethod } from '@slicerx/printer-catalog'
import { HostContext } from '../src/host'
import { addressOf, checkConnection, EMPTY_FORM, pickConnection, pickVia, testBlockers, TUNNEL_EMPTY_TEXT, TUNNEL_NO_CREDENTIAL_TEXT, type PrinterForm } from '../src/first-run/printer-form'
import { ObicoPaste, usePrinterController, type PrinterController } from '../src/first-run/printer-step'
import { fromLinkResult, type AppSetupHost, type TestOutcome } from '../src/first-run/setup-registry'
import { failureCopy } from '../src/first-run/test-failure'
import { bytesText, statusLine, tunnelLine, tunnelTip } from '../src/features/fleet/wall'
import type { FleetRow } from '../src/lib/queries'
import { get, set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PASSWORD = 's3cretpw'
const ADDRESS = `https://u1:${PASSWORD}@abc123.tunnels.app.obico.io`
const HOST = 'abc123.tunnels.app.obico.io'
const klipper = (): PrinterForm => pickVia(pickConnection({ ...EMPTY_FORM, modelId: 'custom' }, 'moonraker'), 'obico')

describe('the Obico paste box rules', () => {
  const m = connectionMethod('moonraker')

  it('asks for the address, then says why a pasted one is refused, then is ready', () => {
    expect(testBlockers(klipper(), m)).toEqual([{ field: 'tunnel', text: TUNNEL_EMPTY_TEXT }])
    const refused = { ...klipper(), tunnel: { problem: 'host' as const } }
    expect(checkConnection(refused, m).errors.tunnel).toMatch(/not an Obico tunnel address/)
    const bare = { ...klipper(), tunnel: { host: HOST, credential: false } }
    expect(checkConnection(bare, m).errors.tunnel).toBe(TUNNEL_NO_CREDENTIAL_TEXT)
    const ok = { ...klipper(), tunnel: { host: HOST, credential: true } }
    expect(checkConnection(ok, m)).toEqual({ errors: {}, warnings: [], ready: true })
    expect(addressOf(ok)).toBe(HOST)
  })

  it('is only for Klipper and OctoPrint, and a new connection type drops it', () => {
    const ok = { ...klipper(), tunnel: { host: HOST, credential: true } }
    const bambu = pickConnection(ok, 'bambu-lan')
    expect(bambu.via).toBeUndefined()
    expect(bambu.tunnel).toBeUndefined()
    expect(pickVia(ok, 'lan').tunnel).toBeUndefined()
  })
})

function mount(host: Partial<AppSetupHost>, keychain = true) {
  let ctl: PrinterController | null = null
  const Harness = () => {
    ctl = usePrinterController({ keychain, scanRange: 'Your local network', ...host } as AppSetupHost)
    return createElement(ObicoPaste, { ctl, keychain })
  }
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  act(() => root.render(createElement(HostContext.Provider, { value: { kind: 'desktop', capabilities: {} } as never }, createElement(Harness))))
  act(() => ctl!.setForm(klipper()))
  const paste = (text: string) => {
    const input = el.querySelector<HTMLInputElement>('[data-testid="setup-obico-paste"]')!
    act(() => {
      input.value = text
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { el, ctl: () => ctl!, paste, done: () => act(() => root.unmount()) }
}

describe('connecting through Obico', () => {
  const logged: string[] = []
  beforeEach(() => {
    logged.length = 0
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    set({ toast: null })
    document.body.innerHTML = ''
  })

  it('shows the host only, and sends the user name and password only as the credential', async () => {
    const tested: unknown[] = []
    const added: unknown[] = []
    const m = mount({
      testConnection: async (c) => {
        tested.push(c)
        return { ok: true, steps: [] } satisfies TestOutcome
      },
      addPrinter: async (input) => {
        added.push(input)
        return { printerId: 'far' }
      },
    })
    m.paste(`  ${ADDRESS}/ `)
    const read = m.el.querySelector('[data-testid="setup-obico-host"]')!
    expect(read.textContent?.trim()).toBe(`Connects to ${HOST}`)
    expect(m.el.querySelector<HTMLInputElement>('[data-testid="setup-obico-paste"]')!.type).toBe('password')
    expect(m.el.textContent).toMatch(/camera stays off through Obico/)

    await act(async () => void (await m.ctl().runTest()))
    await act(async () => void (await m.ctl().save()))
    const conn = { family: 'moonraker', address: HOST, tunnel: 'obico', credential: `u1:${PASSWORD}` }
    expect(tested).toEqual([conn])
    expect((added[0] as { connection: unknown }).connection).toEqual(conn)
    expect((await m.ctl().saveFrom(m.ctl().current(), true)).connection).toBe('Moonraker (Klipper) through Obico')

    // Nowhere but the credential: not the page, the form, the app store or the console.
    expect(m.el.innerHTML).not.toContain(PASSWORD)
    expect(JSON.stringify(m.ctl().form)).not.toContain(PASSWORD)
    expect(JSON.stringify(get())).not.toContain(PASSWORD)
    expect(logged.join('\n')).not.toContain(PASSWORD)
    m.done()
  })

  it('says why a pasted address is refused, and never repeats it', () => {
    const m = mount({})
    m.paste(`https://u1:${PASSWORD}@abc123.tunnels.app.obico.io.evil.example`)
    expect(m.el.textContent).toMatch(/not an Obico tunnel address/)
    expect(m.el.querySelector('[data-testid="setup-obico-host"]')!.textContent).toBe('')
    m.paste(`http://u1:${PASSWORD}@${HOST}`)
    expect(m.el.textContent).toMatch(/starts with https:\/\//)
    m.paste(`https://${HOST}`)
    expect(m.el.textContent).toContain(TUNNEL_NO_CREDENTIAL_TEXT)
    expect(m.el.innerHTML).not.toContain(PASSWORD)
    expect(m.ctl().current().tunnel).toEqual({ host: HOST, credential: false })
    m.done()
  })

  it('a browser with no keychain says the address is for the test only', () => {
    const m = mount({}, false)
    expect(m.el.textContent).toMatch(/no system keychain/)
    m.done()
  })
})

describe('tunnel problems in plain words', () => {
  const row = (status: Partial<PrinterStatus>): FleetRow =>
    ({ id: 'far', name: 'Far', vendor: 'Voron', model: '2.4', plugin: 'moonraker', host: HOST, tunnel: 'obico', nozzleCount: 1, status: { printerId: 'far', state: 'offline', nozzles: [], slots: [], ...status } }) as unknown as FleetRow

  it('has one or two short sentences for each problem, with no dashes or codes', () => {
    for (const p of TUNNEL_PROBLEMS) {
      const text = TUNNEL_PROBLEM_TEXT[p]
      const sentences = text.split(/(?<=\.)\s+/)
      expect(sentences.length, p).toBeGreaterThanOrEqual(1)
      expect(sentences.length, p).toBeLessThanOrEqual(2)
      expect(text.length, p).toBeLessThanOrEqual(110)
      expect(text, p).not.toMatch(/[–—_]|\b48[123]\b|401/)
    }
  })

  it('shows each one on the printer card and in a failed test', () => {
    for (const p of TUNNEL_PROBLEMS) {
      expect(statusLine(row({ tunnelProblem: p }), Date.now())).toBe(TUNNEL_PROBLEM_TEXT[p])
      const outcome = fromLinkResult({ ok: false, cause: 'auth', kind: 'auth', tunnelProblem: p, steps: [] })
      expect(outcome.tunnelProblem).toBe(p)
      const copy = failureCopy(outcome, { address: HOST, family: 'moonraker' })
      expect(`${copy.title} ${copy.body}`.trim()).toBe(TUNNEL_PROBLEM_TEXT[p])
    }
    // A code this version does not know is left out rather than shown raw.
    expect(fromLinkResult({ ok: false, tunnelProblem: 'something_new', steps: [] }).tunnelProblem).toBeUndefined()
  })

  it('shows this month\'s data on the card, the limit included', () => {
    const report = (usage: TunnelReport['usage']): TunnelReport => ({ printerId: 'far', tunnel: 'obico', host: HOST, camera: false, problem: null, connected: true, usage, prediction: null })
    expect(tunnelLine(null)).toBe('Through Obico')
    expect(tunnelLine(report({ usedBytes: 120e6, capBytes: 300e6, leftBytes: 180e6, unlimited: false, resetInSeconds: null }))).toBe('Through Obico · 120 MB used, 180 MB left')
    expect(tunnelLine(report({ usedBytes: 300e6, capBytes: 300e6, leftBytes: 0, unlimited: false, resetInSeconds: null }))).toBe('Through Obico · 300 MB used, 0 MB left')
    expect(tunnelLine(report({ usedBytes: 2.4e9, capBytes: null, leftBytes: null, unlimited: true, resetInSeconds: null }))).toBe('Through Obico · 2.4 GB used, no limit')
    expect([bytesText(850e3), bytesText(0), bytesText(12e9)]).toEqual(['850 KB', '0 MB', '12 GB'])
    expect(tunnelTip(report({ usedBytes: 120e6, capBytes: 300e6, leftBytes: 180e6, unlimited: false, resetInSeconds: 3 * 86_400 }))).toBe('Obico tunnel data this month: 120 MB of 300 MB used. It resets in 3 days.')
  })
})
