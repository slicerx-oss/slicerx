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
import { useFleet, useFleetCount, useFleetLive, useFleetPick, usePrinters, type FleetRow } from '../src/lib/queries'
import { usePrinter, useShownPrinterPick } from '../src/lib/use-printer'
import { set } from '../src/state/store'

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

afterEach(() => {
  cleanup()
  set({ printerId: null, projectPrinter: null })
})

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

  it('stays one subscription per printer when readers learn the printers in different renders', async () => {
    const fake = fakeHost()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['fleet', 0], IDS.map((id) => ({ ...info(id), status: status(id, 20) })))
    const features = { ids: new Set(['connect']), features: [], workspaces: [], settings: [] } as never
    const Live = ({ ids }: { ids: string[] }) => {
      useFleetLive(usePrinters(), ids)
      return null
    }
    const tree = (a: string[], b: string[]) =>
      createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: fake.host }, createElement(FeaturesContext.Provider, { value: features }, createElement(Live, { ids: a }), createElement(Live, { ids: b }))))
    // both readers mount before the fleet has loaded, then each gets the printers in a render of its own
    const view = render(tree([], []))
    view.rerender(tree(IDS, []))
    view.rerender(tree(IDS, IDS))
    for (const id of IDS) expect(fake.listening(id), `live subscriptions to ${id}`).toBe(1)
    const writes = vi.spyOn(qc, 'setQueryData')
    await act(async () => {
      fake.tick()
      await Promise.resolve()
    })
    expect(writes).toHaveBeenCalledTimes(1)
  })
})

/** Readers that need one thing from the fleet, each counting its renders: a count, the shown printer's model, the names. */
const names = (rows: FleetRow[]) => rows.map((r) => r.name)
const modelOf = (p: FleetRow | undefined) => p?.model ?? '-'
function narrowReaders(renders: Record<string, number>) {
  const Count = () => {
    renders.count = (renders.count ?? 0) + 1
    return createElement('p', { 'data-testid': 'count' }, String(useFleetCount() ?? '-'))
  }
  const Shown = () => {
    renders.shown = (renders.shown ?? 0) + 1
    return createElement('p', { 'data-testid': 'shown' }, useShownPrinterPick(modelOf))
  }
  const Names = () => {
    renders.names = (renders.names ?? 0) + 1
    return createElement('p', { 'data-testid': 'names' }, (useFleetPick(names) ?? []).join(','))
  }
  return [createElement(Count, { key: 'count' }), createElement(Shown, { key: 'shown' }), createElement(Names, { key: 'names' })]
}

function mountNarrow(connect: boolean) {
  const fake = fakeHost()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const features = { ids: new Set(connect ? ['connect'] : []), features: [], workspaces: [], settings: [] } as never
  const renders: Record<string, number> = {}
  // One full reader keeps the statuses coming, as the Printers page does.
  const kids = [createElement(Reader, { key: 'full', n: 0 }), ...narrowReaders(renders)]
  render(createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: fake.host }, createElement(FeaturesContext.Provider, { value: features }, ...kids))))
  return { ...fake, renders }
}

describe('readers of one value from the fleet', () => {
  it('render again only when their value changes, not on every status', async () => {
    const app = mountNarrow(true)
    await screen.findByText('20', { selector: '[data-testid=reader-0]' })
    await screen.findByText(String(IDS.length), { selector: '[data-testid=count]' })
    await screen.findByText('2.4', { selector: '[data-testid=shown]' })
    await screen.findByText(IDS.map((id) => `Bay ${id}`).join(','), { selector: '[data-testid=names]' })
    const before = { ...app.renders }
    for (let tick = 1; tick <= 3; tick++) {
      await act(async () => {
        app.tick()
        await Promise.resolve()
      })
      await screen.findByText(String(20 + tick), { selector: '[data-testid=reader-0]' })
    }
    expect(app.renders).toEqual(before)
  })

  it('show an open project printer before the fleet answers and with no printer host', async () => {
    set({ printerId: 'project-printer', projectPrinter: { id: 'project-printer', name: 'X1C 0.4', vendor: 'Bambu Lab', model: 'X1C', nozzle: 0.4, source: 'the project' } as never })
    mountNarrow(false)
    await screen.findByText('X1C', { selector: '[data-testid=shown]' })
    // With no printer host there is no count to act on.
    expect(screen.getByTestId('count').textContent).toBe('-')
  })
})
