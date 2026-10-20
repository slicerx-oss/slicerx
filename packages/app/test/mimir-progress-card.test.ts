// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The progress card in the mimir chat: the print the run started, as the printer view shows it. Layer, time left and
// the bar come from the fleet row (the same cache the Printers tab reads), else from the run's job. A camera still
// refreshes every 30 s while the printer prints; a printer without a camera shows none. Once the job ends the card
// shows how it ended and stops updating.
import type { Host, PrintRun, PrinterInfo, PrinterStatus, RunJob } from '@slicerx/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturesContext } from '../src/features'
import { HostContext } from '../src/host'
import type { FleetRow } from '../src/lib/queries'
import { get } from '../src/state/store'
import { runCard } from '../src/workspaces/mimir/run-cards'

const info: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Voron', model: '2.4', plugin: 'moonraker', nozzleCount: 1 }
const printing: PrinterStatus = { printerId: 'bay-2', state: 'printing', layer: 12, layerCount: 100, timeLeftS: 2460, progress: 0.41, nozzles: [], slots: [], cameraAvailable: true, updatedAt: '' }
const JOB: RunJob = { printerId: 'bay-2', fileName: 'clip.gcode', startedAt: '2026-10-20T00:00:00.000Z', state: 'printing', layer: 3, layerCount: 100, timeLeftS: 9000, progress: 3 }

function runOf(job: RunJob | null): PrintRun {
  return { sessionId: 's', designId: 'des_1', plate: 1, printerId: 'bay-2', slots: {}, slice: null, send: null, job, updatedAt: '2026-10-20T00:00:00.000Z' }
}

/** Listeners the card holds on printers, by printer id. */
const listening = new Map<string, number>()
const subscribe = vi.fn((id: string) => {
  listening.set(id, (listening.get(id) ?? 0) + 1)
  return () => void listening.set(id, (listening.get(id) ?? 1) - 1)
})

const snapshot = vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }))

/** Draws the run's progress card with the fleet cache holding `rows`, as the Printers tab left it. */
function show(job: RunJob | null, rows: FleetRow[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['fleet', get().linkEpoch], rows)
  const host = { printers: { list: async () => rows, status: async (id: string) => rows.find((r) => r.id === id)!.status, subscribe, snapshot } } as unknown as Host
  const features = { ids: new Set(['connect']), features: [], workspaces: [], settings: [] } as never
  const tree = (j: RunJob | null) =>
    createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: host }, createElement(FeaturesContext.Provider, { value: features }, createElement('div', null, runCard({ stage: 'progress', run: runOf(j), actionable: true })))))
  const view = render(tree(job))
  return { qc, rerender: (j: RunJob | null) => view.rerender(tree(j)) }
}

const card = () => screen.getByTestId('mimir-progress')
const flush = () => act(async () => vi.advanceTimersByTimeAsync(0))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  snapshot.mockClear()
  subscribe.mockClear()
  listening.clear()
  let n = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:still-${++n}`), revokeObjectURL: vi.fn() }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the progress card', () => {
  it('the card reads layer and time left from the fleet row', async () => {
    show(JOB, [{ ...info, status: printing }])
    await flush()
    expect(card().textContent).toContain('Printing on Bay 2')
    expect(card().textContent).toContain('Layer 12 of 100')
    expect(card().textContent).toContain('About 41 min left')
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('41')
    expect(card().getAttribute('data-state')).toBe('printing')
    cleanup()
    // no fleet row for the printer: the run's job as the runtime last heard it
    show(JOB, [])
    await flush()
    // the printer's id is not a name to show
    expect(card().textContent).toContain('Printing on your printer')
    expect(card().textContent).not.toContain('bay-2')
    expect(card().textContent).toContain('Layer 3 of 100')
    expect(card().textContent).toContain('About 2 h 30 min left')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
    cleanup()
    // nothing without a job
    show(null, [])
    expect(screen.queryByTestId('mimir-progress')).toBeNull()
  })

  it('the camera still refreshes every 30 s while printing', async () => {
    show(JOB, [{ ...info, status: printing }])
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenLastCalledWith('bay-2')
    const still = screen.getByTestId('mimir-progress-still') as HTMLImageElement
    expect(still.alt).toBe('Camera view of Bay 2')
    expect(still.getAttribute('src')).toBe('blob:still-1')
    await act(async () => vi.advanceTimersByTimeAsync(29_000))
    expect(snapshot).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('mimir-progress-still').getAttribute('src')).toBe('blob:still-2')
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(snapshot).toHaveBeenCalledTimes(3)
    cleanup()
    // a paused printer is not printing: no new stills
    snapshot.mockClear()
    show(JOB, [{ ...info, status: { ...printing, state: 'paused' } }])
    await flush()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(snapshot).not.toHaveBeenCalled()
    expect(card().textContent).toContain('Paused on Bay 2')
  })

  it('no still without a camera', async () => {
    show(JOB, [{ ...info, status: { ...printing, cameraAvailable: false } }])
    await flush()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(snapshot).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mimir-progress-still')).toBeNull()
    expect(card().querySelector('img')).toBeNull()
    expect(card().textContent).toContain('Layer 12 of 100')
  })

  it('the card stops updating when the job ends', async () => {
    const v = show(JOB, [{ ...info, status: printing }])
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(1)
    // while it prints the card listens to its own printer, once
    expect(listening.get('bay-2')).toBe(1)
    expect([...listening.keys()]).toEqual(['bay-2'])
    v.rerender({ ...JOB, state: 'finished', layer: 100, layerCount: 100, timeLeftS: 0, progress: 100, outcome: 'finished', endedAt: '2026-10-20T01:05:00.000Z' })
    await flush()
    expect(card().textContent).toContain('Finished on Bay 2')
    expect(card().getAttribute('data-state')).toBe('finished')
    // and lets go of it once the job ended
    expect(listening.get('bay-2')).toBe(0)
    expect(card().textContent).toContain('Layer 100 of 100')
    // the printer starts something else: the card keeps the end of its own job
    act(() => v.qc.setQueryData(['fleet', get().linkEpoch], [{ ...info, status: { ...printing, layer: 5, timeLeftS: 600, progress: 0.05 } }]))
    await act(async () => vi.advanceTimersByTimeAsync(90_000))
    expect(card().textContent).toContain('Finished on Bay 2')
    expect(card().textContent).toContain('Layer 100 of 100')
    expect(card().textContent).not.toContain('Layer 5 of 100')
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    // the last still stays, and how a failed or canceled job ended reads the same way
    expect(screen.getByTestId('mimir-progress-still')).toBeTruthy()
    v.rerender({ ...JOB, state: 'error', outcome: 'failed', endedAt: '2026-10-20T01:05:00.000Z' })
    expect(card().textContent).toContain('Stopped on Bay 2')
    v.rerender({ ...JOB, state: 'idle', outcome: 'canceled', endedAt: '2026-10-20T01:05:00.000Z' })
    expect(card().textContent).toContain('Canceled on Bay 2')
    // the chat starts another print: this card keeps its own job, and the new one gets a card of its own
    v.rerender({ ...JOB, startedAt: '2026-10-20T02:00:00.000Z' })
    expect(card().textContent).toContain('Canceled on Bay 2')
    expect(card().textContent).not.toContain('Printing on')
  })
})
