// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The top bar gives up room in steps when its labels do not fit, measured in the page. It measures only when something
// that takes room in the bar changes: a printer's status (a temperature, a layer) leaves the bar as it was, and measuring
// on each one made every status a full layout of the page.
import type { Host, PrinterEvent, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturesContext } from '../src/features'
import { HostContext } from '../src/host'
import { TopBar } from '../src/shell/top-bar'

const IDS = ['p1', 'p2', 'p3']
const info = (id: string): PrinterInfo => ({ id, name: `Bay ${id}`, vendor: 'Voron', model: '2.4', plugin: 'moonraker', nozzleCount: 1 })
const status = (id: string, temp: number, state: PrinterStatus['state'] = 'idle'): PrinterStatus => ({ printerId: id, state, nozzles: [{ current: temp, target: 0 }], slots: [], cameraAvailable: false, updatedAt: new Date().toISOString() })

function fakeHost() {
  const listeners = new Map<string, Set<(e: PrinterEvent) => void>>()
  const printers = {
    list: async () => IDS.map(info),
    status: async (id: string) => status(id, 20),
    subscribe: (id: string, cb: (e: PrinterEvent) => void) => {
      const set = listeners.get(id) ?? new Set()
      set.add(cb)
      listeners.set(id, set)
      return () => void set.delete(cb)
    },
  }
  return {
    host: { printers } as unknown as Host,
    send: (id: string, s: PrinterStatus) => {
      for (const cb of [...(listeners.get(id) ?? [])]) cb({ type: 'status', printerId: id, status: s } as PrinterEvent)
    },
  }
}

const features = {
  ids: new Set(['connect']),
  features: [],
  workspaces: [
    { id: 'prepare', label: 'Slice', icon: 'slice', component: null },
    { id: 'library', label: 'My models', icon: 'library', component: null },
    { id: 'printers', label: 'Printers', icon: 'printer', component: null },
  ],
  settings: [],
} as never

/** Layout as the page would give it: the bar needs 1400 px until its tabs drop their labels, and has 1000. */
let reads = 0
beforeEach(() => {
  reads = 0
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    reads++
    if (!this.classList.contains('sx-appbar')) return 0
    return this.hasAttribute('data-narrow-tabs') ? 900 : 1400
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('sx-appbar') ? 1000 : 0
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount() {
  const fake = fakeHost()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: fake.host }, createElement(FeaturesContext.Provider, { value: features }, createElement(TopBar)))))
  return { ...fake, qc }
}

const bar = () => document.querySelector<HTMLElement>('.sx-appbar')!
/** Lets the fleet query settle and the bar render what it brought. */
const settle = (qc: QueryClient) =>
  act(async () => {
    await vi.waitFor(() => expect(qc.getQueryData(['fleet', 0])).toBeTruthy())
    await new Promise((r) => setTimeout(r, 10))
  })

describe('the top bar', () => {
  it('folds step by step until its labels fit', async () => {
    const app = mount()
    await settle(app.qc)
    expect(screen.getByTestId('tab-printers')).toBeTruthy()
    expect(bar().hasAttribute('data-narrow-search')).toBe(true)
    expect(bar().hasAttribute('data-narrow-tabs')).toBe(true)
    // it stops at the first step that fits
    expect(bar().hasAttribute('data-narrow-modes')).toBe(false)
  })

  it('does not measure on a printer status that changes nothing in the bar', async () => {
    const app = mount()
    await settle(app.qc)
    reads = 0
    for (let tick = 1; tick <= 3; tick++) {
      await act(async () => {
        for (const id of IDS) app.send(id, status(id, 20 + tick))
        await new Promise((r) => setTimeout(r, 10))
      })
    }
    expect(app.qc.getQueryData<{ status: PrinterStatus }[]>(['fleet', 0])?.[0]?.status.nozzles[0]?.current).toBe(23)
    expect(reads, 'layout reads on three status ticks').toBe(0)
    // a printer that fails puts a dot on the Printers tab, and the bar measures again
    await act(async () => {
      app.send('p1', status('p1', 23, 'error'))
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(reads).toBeGreaterThan(0)
    expect(screen.getByTestId('tab-printers').querySelector('.tab-dot.warn')).not.toBeNull()
    expect(bar().hasAttribute('data-narrow-tabs')).toBe(true)
  })
})
