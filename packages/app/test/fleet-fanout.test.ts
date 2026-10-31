// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Many parts of the app read the fleet at once (the top bar, the command bar, the Printers page, the sidebar's printer).
// They share one live subscription per printer, and a printer host that reports every printer in the same moment (the
// demo fleet's one second tick, a bridge's status burst) writes the fleet cache once, not once per printer per reader:
// on a slow computer that fan-out kept the page busy for most of every second.
import type { Host, PrinterEvent, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeaturesContext } from '../src/features'
import { HostContext } from '../src/host'
import { useFleet, useFleetLive, useFleetPick, usePrinters, type FleetRow } from '../src/lib/queries'
import { usePrinter } from '../src/lib/use-printer'

const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
const info = (id: string): PrinterInfo => ({ id, name: `Bay ${id}`, vendor: 'Voron', model: '2.4', plugin: 'moonraker', nozzleCount: 1 })
const status = (id: string, temp: number): PrinterStatus => ({ printerId: id, state: 'idle', nozzles: [{ current: temp, target: 0 }], slots: [], cameraAvailable: false, updatedAt: new Date().toISOString() })

/** A printer host like the demo fleet: `tick` reports every printer, one after another, in the same task. */
function fakeHost() {
  const listeners = new Map<string, Set<(e: PrinterEvent) => void>>()
  let temp = 20
  const printers = {
    list: async () => IDS.map(info),
    status: async (id: string) => status(id, temp),
    subscribe: (id: string, cb: (e: PrinterEvent) => void) => {
      const set = listeners.get(id) ?? new Set()
      set.add(cb)
      listeners.set(id, set)
      return () => void set.delete(cb)
    },
  }
  return {
    host: { printers } as unknown as Host,
    listening: (id: string) => listeners.get(id)?.size ?? 0,
    tick() {
      temp += 1
      for (const id of IDS) for (const cb of [...(listeners.get(id) ?? [])]) cb({ type: 'status', printerId: id, status: status(id, temp) } as PrinterEvent)
    },
  }
}

/** One fleet reader: shows the first printer's nozzle temperature, as a card or a count would. */
function Reader({ n }: { n: number }) {
  const rows = useFleet().data ?? []
  return createElement('p', { 'data-testid': `reader-${n}` }, String(rows[0]?.status.nozzles[0]?.current ?? '-'))
}

/** The top bar's reader: one value picked from the fleet. */
const firstTemp = (rows: FleetRow[]) => rows[0]?.status.nozzles[0]?.current ?? '-'
function Picker() {
  return createElement('p', { 'data-testid': 'picker' }, String(useFleetPick(firstTemp) ?? '-'))
}

/** The sidebar's reader: the printer it shows. */
function Sidebar() {
  const { printer } = usePrinter()
  return createElement('p', { 'data-testid': 'sidebar' }, String(printer?.status.nozzles[0]?.current ?? '-'))
}

/** The progress card's reader: the fleet query kept live for one printer. */
function OnePrinter() {
  useFleetLive(usePrinters(), ['p2'])
  return null
}

function mount(readers: number) {
  const fake = fakeHost()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const features = { ids: new Set(['connect']), features: [], workspaces: [], settings: [] } as never
  const kids = [...Array.from({ length: readers }, (_, n) => createElement(Reader, { key: n, n })), createElement(OnePrinter, { key: 'one' }), createElement(Picker, { key: 'pick' }), createElement(Sidebar, { key: 'side' })]
  render(createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: fake.host }, createElement(FeaturesContext.Provider, { value: features }, ...kids))))
  return { ...fake, qc }
}

afterEach(() => cleanup())

describe('the fleet readers', () => {
  it('share one live subscription per printer and write the cache once per tick', async () => {
    const readers = 8
    const app = mount(readers)
    for (let n = 0; n < readers; n++) await screen.findByText('20', { selector: `[data-testid=reader-${n}]` })
    for (const id of IDS) expect(app.listening(id), `live subscriptions to ${id}`).toBe(1)
    const writes = vi.spyOn(app.qc, 'setQueryData')
    for (let tick = 1; tick <= 3; tick++) {
      writes.mockClear()
      await act(async () => {
        app.tick()
        await Promise.resolve()
      })
      expect(writes, `cache writes on tick ${tick}`).toHaveBeenCalledTimes(1)
      // every reader still sees the new status
      for (let n = 0; n < readers; n++) await screen.findByText(String(20 + tick), { selector: `[data-testid=reader-${n}]` })
      for (const id of ['picker', 'sidebar']) await screen.findByText(String(20 + tick), { selector: `[data-testid=${id}]` })
    }
  })

  it('keeps the subscription while any reader is mounted and drops it with the last', async () => {
    const app = mount(2)
    await screen.findByText('20', { selector: '[data-testid=reader-0]' })
    expect(app.listening('p1')).toBe(1)
    cleanup()
    for (const id of IDS) expect(app.listening(id)).toBe(0)
  })
})
