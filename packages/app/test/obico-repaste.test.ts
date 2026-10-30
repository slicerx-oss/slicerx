// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A new Obico address on a printer already reached through Obico (after its access was removed in Obico): the same
// masked paste box and the same parse as setup. Saving keeps the printer (its id, jobs, name and settings) and hands
// only the new host and access to the bridge. A refused paste changes nothing, and the password never reaches the
// page, the app store or the console.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TUNNEL_PROBLEM_TEXT, TUNNEL_PROBLEMS, type PrinterStatus } from '@slicerx/contracts'
import { HostContext } from '../src/host'
import { ObicoRepaste, offersRepaste, REPASTE_LABEL, repasteCardText } from '../src/features/fleet/obico-repaste'
import { registerPrinterSetup, type AppSetupHost } from '../src/first-run/setup-registry'
import type { FleetRow } from '../src/lib/queries'
import { get, set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PASSWORD = 'n3wSecretPw'
const OLD_HOST = 'abc123.tunnels.app.obico.io'
const NEW_HOST = 'def456.tunnels.app.obico.io'
const ADDRESS = `https://u2:${PASSWORD}@${NEW_HOST}`

const row = (status: Partial<PrinterStatus> = {}): FleetRow =>
  ({ id: 'far', name: 'Workshop Voron', vendor: 'Voron Design', model: 'Voron 2.4 300', plugin: 'moonraker', host: OLD_HOST, tunnel: 'obico', nozzleCount: 1, status: { printerId: 'far', state: 'offline', nozzles: [], slots: [], tunnelProblem: 'access_removed', ...status } }) as unknown as FleetRow

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

type SetTunnel = NonNullable<AppSetupHost['setTunnel']>

function mount(setTunnel: SetTunnel | undefined) {
  registerPrinterSetup(() => ({ keychain: true, scanRange: 'Your local network', ...(setTunnel ? { setTunnel } : {}) }) as unknown as AppSetupHost)
  const qc = new QueryClient()
  let refetched = 0
  qc.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'invalidate') refetched++
  })
  qc.setQueryData(['fleet', 0], [])
  let closed = 0
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const host = { kind: 'desktop', capabilities: { secureStorage: true } }
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: host as never }, createElement(ObicoRepaste, { printer: row(), open: true, onClose: () => void closed++ })))))
  const input = () => el.querySelector<HTMLInputElement>('[data-testid="setup-obico-paste"]')!
  const paste = (text: string) =>
    act(() => {
      input().value = text
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  const save = () => el.querySelector<HTMLButtonElement>('[data-testid="printer-repaste-save"]')!
  const submit = async () => {
    await act(async () => {
      el.querySelector<HTMLFormElement>('[data-testid="printer-repaste"] form')!.requestSubmit()
    })
  }
  return { el, input, paste, save, submit, refetched: () => refetched, closed: () => closed, done: () => act(() => root.unmount()) }
}

describe('pasting a new Obico address on a printer', () => {
  const logged: string[] = []
  beforeEach(() => {
    logged.length = 0
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    registerPrinterSetup(null)
    set({ toast: null })
    document.body.innerHTML = ''
  })

  it('is offered on a printer reached through Obico, and pointed to when its access is gone', () => {
    expect(offersRepaste(row())).toEqual({ menu: true, pointer: true })
    expect(offersRepaste(row({ tunnelProblem: 'no_access' }))).toEqual({ menu: true, pointer: true })
    for (const p of TUNNEL_PROBLEMS.filter((p) => p !== 'no_access' && p !== 'access_removed')) expect(offersRepaste(row({ tunnelProblem: p })), p).toEqual({ menu: true, pointer: false })
    const fine = { ...row(), status: { printerId: 'far', state: 'idle', nozzles: [], slots: [] } } as unknown as FleetRow
    expect(offersRepaste(fine)).toEqual({ menu: true, pointer: false })
    const lan = { ...row(), tunnel: undefined, host: '192.168.1.20' } as unknown as FleetRow
    expect(offersRepaste(lan)).toEqual({ menu: false, pointer: false })
    expect(REPASTE_LABEL).toBe('Paste a new Obico address')
  })

  it('the card keeps only the first sentence above the pointer, and the shared words stay whole', () => {
    expect(repasteCardText('access_removed')).toBe('Obico access was removed or revoked.')
    expect(repasteCardText('no_access')).toBe('No Obico access is stored on this computer.')
    expect(TUNNEL_PROBLEM_TEXT.access_removed).toBe('Obico access was removed or revoked. Connect the printer through Obico again.')
    expect(TUNNEL_PROBLEM_TEXT.no_access).toBe('No Obico access is stored on this computer. Connect the printer through Obico again.')
  })

  it('keeps the printer and sends only the new host and its access', async () => {
    const sent: Parameters<SetTunnel>[] = []
    const store = JSON.stringify({ ...get(), toast: null })
    const m = mount(async (printerId, c) => {
      sent.push([printerId, c])
      return { printerId, host: c.address }
    })
    expect(m.input().type).toBe('password')
    expect(m.save().disabled).toBe(true)
    m.paste(`  ${ADDRESS}/ `)
    expect(m.el.querySelector('[data-testid="setup-obico-host"]')!.textContent?.trim()).toBe(`Connects to ${NEW_HOST}`)
    expect(m.save().disabled).toBe(false)
    await m.submit()
    expect(sent).toEqual([['far', { address: NEW_HOST, credential: `u2:${PASSWORD}` }]])
    expect(m.refetched()).toBeGreaterThan(0)
    expect(m.closed()).toBe(1)
    expect(get().toast?.text).toContain(`Workshop Voron now connects through ${NEW_HOST}`)
    // The printer itself is untouched here: same id, and the app's own settings for it did not change.
    expect(JSON.stringify({ ...get(), toast: null })).toBe(store)

    // Nowhere but the call: not the page, the app store or the console.
    expect(m.input().value).toBe('')
    expect(m.el.innerHTML).not.toContain(PASSWORD)
    expect(JSON.stringify(get())).not.toContain(PASSWORD)
    expect(logged.join('\n')).not.toContain(PASSWORD)
    m.done()
  })

  it('a refused paste says why and changes nothing', async () => {
    const sent: unknown[] = []
    const m = mount(async (printerId, c) => {
      sent.push([printerId, c])
      return { printerId, host: c.address }
    })
    m.paste(`https://u2:${PASSWORD}@def456.tunnels.app.obico.io.evil.example`)
    expect(m.el.textContent).toMatch(/not an Obico tunnel address/)
    expect(m.save().disabled).toBe(true)
    await m.submit()
    m.paste(`https://${NEW_HOST}`)
    expect(m.el.textContent).toMatch(/no user name and password/)
    await m.submit()
    m.paste(`http://u2:${PASSWORD}@${NEW_HOST}`)
    expect(m.el.textContent).toMatch(/starts with https:\/\//)
    await m.submit()
    expect(sent).toEqual([])
    expect(m.refetched()).toBe(0)
    expect(m.closed()).toBe(0)
    expect(m.el.innerHTML).not.toContain(PASSWORD)
    expect(logged.join('\n')).not.toContain(PASSWORD)
    m.done()
  })

  it('a bridge that refuses the address leaves the printer as it was and says so', async () => {
    const m = mount(async () => {
      throw Object.assign(new Error(`refused u2:${PASSWORD}`), { code: 'bad_request' })
    })
    m.paste(ADDRESS)
    await m.submit()
    const alert = m.el.querySelector('[data-testid="printer-repaste"] [role="alert"]')
    expect(alert?.textContent).toMatch(/not saved\. Nothing changed/)
    expect(m.closed()).toBe(0)
    expect(m.refetched()).toBe(0)
    expect(m.el.innerHTML).not.toContain(PASSWORD)
    expect(logged.join('\n')).not.toContain(PASSWORD)
    m.done()
  })

  it('a bridge that cannot take a new address says so instead of offering it', () => {
    const m = mount(undefined)
    expect(m.el.textContent).toMatch(/Update the app/)
    expect(m.save().disabled).toBe(true)
    m.done()
  })
})
