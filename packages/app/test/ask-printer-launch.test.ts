// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "I do not have a printer" across launches. A desktop build with the demo fleet (dev and test builds, an edition with
// no backend) lists the made-up printers until its own bridge connects and puts the real list in their place. Those
// printers must not count as the person having a printer again: the choice was cleared, saved, and printer setup opened
// as soon as the bridge came up with no printers, on every launch.
import type { Host, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const g = globalThis as { __sxPrefs?: unknown }
const firstRun = { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: null, version: 4 }

const info = (id: string): PrinterInfo => ({ id, name: `Bay ${id}`, vendor: 'Voron', model: '2.4', plugin: 'moonraker', nozzleCount: 1 })
const status = (id: string): PrinterStatus => ({ printerId: id, state: 'idle', nozzles: [{ current: 20, target: 0 }], slots: [], cameraAvailable: false, updatedAt: new Date().toISOString() })
/** A printer host listing `ids`, like the demo fleet or a bridge. */
const printersOf = (ids: string[]) => ({ list: async () => ids.map(info), status: async (id: string) => status(id), subscribe: () => () => undefined })
const DEMO = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']

/** A launch: a fresh app with the shell's prefs file, the store and the launch check mounted on `host`. */
async function launch(o: { kind: 'desktop' | 'web'; printers: string[]; automatic: boolean; file?: string }) {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  if (o.file === undefined) delete g.__sxPrefs
  else g.__sxPrefs = o.file
  const prefs = await import('../src/state/prefs')
  const sent: string[] = []
  prefs.setPrefsMirror((json) => sent.push(json))
  const { createElement } = await import('react')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { FeaturesContext } = await import('../src/features')
  const { HostContext } = await import('../src/host')
  const { setBridgeConnector } = await import('../src/link/connector')
  const store = await import('../src/state/store')
  const { useAskForPrinter } = await import('../src/first-run/ask-printer')
  if (o.automatic) setBridgeConnector({ automatic: true, connect: () => new Promise(() => undefined) })
  store.set({ agreementOpen: false, setup: null, bridgeStatus: { state: o.automatic ? 'connecting' : 'off' } })
  const host = { kind: o.kind, printers: printersOf(o.printers) } as unknown as Host
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const features = { ids: new Set(['connect']), features: [], workspaces: [], settings: [] } as never
  const Ask = () => {
    useAskForPrinter()
    return null
  }
  render(createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: host }, createElement(FeaturesContext.Provider, { value: features }, createElement(Ask)))))
  /** The fleet has answered: the query is done, so the count was read. */
  const settled = () => waitFor(() => expect(qc.isFetching({ queryKey: ['fleet'] })).toBe(0))
  return {
    store,
    sent,
    settled,
    /** A new printer host takes over (the bridge connected, or a printer was added), as bridge.ts does it. */
    async swap(ids: string[], bridge?: 'on') {
      await act(async () => {
        host.printers = printersOf(ids) as never
        store.set((s) => ({ linkEpoch: s.linkEpoch + 1, ...(bridge ? { bridgeStatus: { state: bridge } } : {}) }))
      })
      await settled()
    },
  }
}

afterEach(() => {
  cleanup()
  delete g.__sxPrefs
  localStorage.clear()
  sessionStorage.clear()
})

const chose = JSON.stringify({ workspace: 'prepare', firstRun, noPrinter: true, savedAt: Date.now() })

describe('no printer, kept across launches', () => {
  it('keeps the choice and opens no setup when demo printers show before the bridge comes up empty', async () => {
    const app = await launch({ kind: 'desktop', printers: DEMO, automatic: true, file: chose })
    expect(app.store.get().noPrinter).toBe(true)
    await app.settled()
    await app.swap([], 'on')
    const { noPrinter, setup } = app.store.get()
    expect({ noPrinter, setup }).toEqual({ noPrinter: true, setup: null })
    expect(app.sent.every((json) => JSON.parse(json).noPrinter === true)).toBe(true)
  })

  it('clears the choice when a printer arrives after the bridge is on', async () => {
    const app = await launch({ kind: 'desktop', printers: DEMO, automatic: true, file: chose })
    await app.settled()
    await app.swap([], 'on')
    await app.swap(['bay-1'])
    await waitFor(() => expect(app.store.get().noPrinter).toBe(false))
    expect(JSON.parse(app.sent.at(-1)!).noPrinter).toBe(false)
  })

  it('clears the choice on a host with no bridge to wait for (browser, phone) once it lists a printer', async () => {
    const app = await launch({ kind: 'web', printers: ['bay-1'], automatic: false, file: chose })
    await waitFor(() => expect(app.store.get().noPrinter).toBe(false))
  })

  it('reads a choice saved in the app at the next launch, from the shell\'s file alone', async () => {
    const first = await launch({ kind: 'desktop', printers: [], automatic: true, file: JSON.stringify({ workspace: 'prepare', firstRun, savedAt: 1 }) })
    expect(first.store.get().noPrinter).toBe(false)
    first.store.set({ noPrinter: true })
    const file = first.sent.at(-1)!
    cleanup()
    const again = await launch({ kind: 'desktop', printers: [], automatic: true, file })
    expect(again.store.get().noPrinter).toBe(true)
  })
})
