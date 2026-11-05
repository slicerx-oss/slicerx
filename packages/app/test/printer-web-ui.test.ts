// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Open web interface": the printer menu and the live view link to a printer's own page (Mainsail, Fluidd,
// OctoPrint, PrusaLink, Duet Web Control) when it has one on the local network, and open it in the browser.
import type { PrinterStatus } from '@slicerx/contracts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetRow } from '../src/lib/queries'

vi.mock('../src/lib/use-printer', async (orig) => ({ ...(await orig<object>()), usePrinter: () => ({ rows: [], printer: undefined }) }))

const { HostContext } = await import('../src/host')
const { FeaturesContext } = await import('../src/features')
const { Fleet } = await import('../src/features/fleet/fleet')
const { PrinterHud } = await import('../src/features/fleet/hud-view')
const { webUiFor } = await import('../src/features/fleet/web-ui')
const { openPrinterPage, registerPrinterPageOpener } = await import('../src/lib/links')
const { get, set } = await import('../src/state/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const idle = (id: string): PrinterStatus => ({ printerId: id, state: 'idle', nozzles: [{ current: 25, target: 0 }], bed: { current: 24, target: 0 }, slots: [], cameraAvailable: false, updatedAt: '2026-11-05T06:00:00Z' })
const row = (id: string, name: string, info: Partial<FleetRow>): FleetRow => ({ id, name, vendor: 'Voron', model: 'Voron 2.4 350', plugin: 'moonraker', nozzleCount: 1, status: idle(id), ...info })

const VORON = row('voron', 'Voron 350', { host: '192.168.1.20', port: 7125 })
const QIDI = row('qidi', 'X-Max', { vendor: 'QIDI', model: 'X-Max 3', host: 'qidi.local' })
const OCTO = row('octo', 'Ender', { vendor: 'Generic', model: 'Printer behind OctoPrint', plugin: 'octoprint', host: '192.168.1.30', port: 5001 })
const BAMBU = row('a1', 'A1', { vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', host: '192.168.1.40' })
const PUBLIC = row('far', 'Far Voron', { host: '8.8.8.8' })
const ROWS = [VORON, QIDI, OCTO, BAMBU, PUBLIC]

const opened: string[] = []
beforeEach(() => {
  opened.length = 0
  registerPrinterPageOpener(async (url) => void opened.push(url))
})

describe('the web page address of a printer in the fleet', () => {
  it('comes from the saved printer: its connection, its model and its saved port', () => {
    expect(webUiFor(VORON)).toBe('http://192.168.1.20/')
    expect(webUiFor(QIDI)).toBe('http://qidi.local:10088/')
    expect(webUiFor(OCTO)).toBe('http://192.168.1.30:5001/')
    expect(webUiFor(BAMBU)).toBeNull()
    expect(webUiFor(PUBLIC)).toBeNull()
    expect(webUiFor({ ...VORON, tunnel: 'obico' })).toBeNull()
  })

  it('refuses anything that is not a local printer page before it reaches the shell', async () => {
    for (const url of ['http://8.8.8.8/', 'https://example.com/', 'http://user@192.168.1.20/', 'http://192.168.1.20/?x=1', 'javascript:alert(1)']) await openPrinterPage(url)
    expect(opened).toEqual([])
    expect(get().toast?.text).toContain('not on your local network')
    await openPrinterPage('http://192.168.1.20/')
    expect(opened).toEqual(['http://192.168.1.20/'])
  })
})

describe('the printer menu', () => {
  let root: Root
  let el: HTMLDivElement

  beforeEach(() => {
    set({ bays: [], printerBays: {}, printersView: 'all' })
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
  })
  afterEach(() => {
    act(() => root.unmount())
    el.remove()
  })

  async function render(): Promise<void> {
    const printers = {
      list: async () => ROWS.map(({ status: _s, ...p }) => p),
      status: async (id: string) => ROWS.find((r) => r.id === id)!.status,
      subscribe: () => () => undefined,
      snapshot: async () => null,
      fleets: async () => [],
    }
    const host = { kind: 'web', capabilities: {}, printers } as never
    const features = { ids: new Set(['connect']), features: [], workspaces: [], settings: [] } as never
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(FeaturesContext.Provider, { value: features }, createElement(HostContext.Provider, { value: host }, createElement(Fleet)))))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  }

  async function menuOf(name: string): Promise<HTMLElement> {
    const button = el.querySelector<HTMLButtonElement>(`[aria-label="${name} options"][data-testid="printer-card-options"]`)!
    await act(async () => button.click())
    return document.querySelector<HTMLElement>(`[role="menu"][aria-label="${name} options"]`)!
  }

  it('offers the web interface for printers that serve one, and opens it in the browser', async () => {
    await render()
    const menu = await menuOf('Voron 350')
    const item = menu.querySelector<HTMLElement>('[data-testid="printer-card-web-ui"]')!
    expect(item.textContent).toBe('Open web interface')
    expect(item.dataset['tipBody']).toContain('http://192.168.1.20/')
    await act(async () => item.click())
    expect(opened).toEqual(['http://192.168.1.20/'])
  })

  it('uses the model\'s own port and the saved OctoPrint port', async () => {
    await render()
    await act(async () => (await menuOf('X-Max')).querySelector<HTMLElement>('[data-testid="printer-card-web-ui"]')!.click())
    await act(async () => (await menuOf('Ender')).querySelector<HTMLElement>('[data-testid="printer-card-web-ui"]')!.click())
    expect(opened).toEqual(['http://qidi.local:10088/', 'http://192.168.1.30:5001/'])
  })

  it('leaves the item out for a printer with no web page, or one off the local network', async () => {
    await render()
    expect((await menuOf('A1')).querySelector('[data-testid="printer-card-web-ui"]')).toBeNull()
    expect((await menuOf('Far Voron')).querySelector('[data-testid="printer-card-web-ui"]')).toBeNull()
  })
})

describe('the live view', () => {
  let root: Root | null = null
  let el: HTMLDivElement | null = null
  afterEach(() => {
    act(() => root?.unmount())
    el?.remove()
  })

  async function show(r: FleetRow): Promise<HTMLDivElement> {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    const printers = { status: async () => r.status, subscribe: () => () => undefined, snapshot: async () => null }
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: { kind: 'web', capabilities: {}, printers } as never }, createElement(PrinterHud, { row: r, onClose: () => undefined })))))
    return el
  }

  it('has a web interface button in its top bar for a printer that serves a page', async () => {
    const view = await show(VORON)
    const button = view.querySelector<HTMLButtonElement>('.ph-top [data-testid="ph-web-ui"]')!
    expect(button.getAttribute('aria-label')).toBe('Open web interface')
    await act(async () => button.click())
    expect(opened).toEqual(['http://192.168.1.20/'])
  })

  it('has none for a printer without one', async () => {
    expect((await show(BAMBU)).querySelector('[data-testid="ph-web-ui"]')).toBeNull()
    act(() => root?.unmount())
    el?.remove()
    expect((await show(PUBLIC)).querySelector('[data-testid="ph-web-ui"]')).toBeNull()
  })
})
