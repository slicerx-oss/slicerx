// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The camera guard's card on the Printers tab, in each state the hub can put a printer in: paused for a hand, a hand
// on a printer SlicerX cannot pause (Bambu Lab with Developer Mode off), a start held for something on the plate, and a
// print the printer started itself onto a dirty plate. And the wiring: a trip brings up Printers with its card.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GuardCard } from '../src/features/fleet/guard-card'
import { guardTrips, holdStart, resetGuard, tripCopy, watchGuard, type GuardTrip } from '../src/features/fleet/guard'
import type { FleetRow } from '../src/lib/queries'
import { HostContext } from '../src/host'
import { get, set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  // Node's object URLs take only Node's own blobs, not jsdom's.
  URL.createObjectURL = () => 'blob:frame'
  URL.revokeObjectURL = () => undefined
})

const row = (over: Partial<FleetRow['status']> = {}): FleetRow =>
  ({
    id: 'a1',
    name: 'Desk A1',
    vendor: 'Bambu Lab',
    model: 'A1',
    plugin: 'bambu-lan',
    nozzleCount: 1,
    status: { printerId: 'a1', state: 'paused', nozzles: [], slots: [], cameraAvailable: true, updatedAt: '', layer: 46, layerCount: 210, progress: 0.21, ...over },
  }) as unknown as FleetRow

function fakeHub() {
  const calls: string[] = []
  let onGuard: ((t: GuardTrip) => void) | null = null
  const watch = {
    onGuard: (cb: (t: GuardTrip) => void) => ((onGuard = cb), () => (onGuard = null)),
    guardState: async () => ({ trips: {}, off: [], plates: { a1: '2026-10-04T08:20:00.000Z' }, detector: true }),
    evidence: async (id: string, fresh?: boolean) => (calls.push(`evidence ${id}${fresh ? ' fresh' : ''}`), { contentType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff]), capturedAt: '2026-10-06T08:52:07.000Z' }),
    dismiss: async (id: string, kind: string) => void calls.push(`dismiss ${id} ${kind}`),
    plateClear: async (id: string) => (calls.push(`plateClear ${id}`), { plateFrom: '2026-10-06T09:00:00.000Z' }),
    plateCheck: async (id: string) => (calls.push(`plateCheck ${id}`), { checked: true, clear: false }),
    plateIgnore: async (id: string) => (calls.push(`plateIgnore ${id}`), { remembered: 'spot' as const }),
  }
  const printers = { watch, list: async () => [{ id: 'a1', name: 'Desk A1' }] }
  const host = { kind: 'desktop', capabilities: {}, printers }
  return { host, calls, fire: (t: GuardTrip) => onGuard?.(t) }
}

async function render(trip: GuardTrip, hub = fakeHub(), r = row()) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: hub.host as never }, createElement(GuardCard, { row: r, trip, now: Date.now() }))))
  })
  const button = (name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)
  const click = async (name: string) => {
    const b = button(name)
    if (!b) throw new Error(`no button ${name} in: ${el.textContent}`)
    await act(async () => b.click())
  }
  return { el, hub, button, click, done: () => act(() => root.unmount()) }
}

const at = '2026-10-06T08:52:08.000Z'

afterEach(() => {
  resetGuard()
  set({ toast: null })
  document.body.innerHTML = ''
})

describe('the guard card', () => {
  it('a hand paused the print: frame with the strike, Resume, Check again and Dismiss', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at, box: [0.15, 0.4, 0.45, 0.95], note: '2 of the last 3 frames, siglip2-base-224', monitorOnly: false })
    expect(v.el.querySelector('h3')?.textContent).toBe('Paused: a hand in the printer')
    expect(v.el.textContent).toContain('saw a hand in 2 of the last 3 frames')
    expect(v.el.querySelector('img')?.getAttribute('src')).toBe('blob:frame')
    const spot = v.el.querySelector('.guard-spot') as HTMLElement
    expect([spot.style.left, spot.style.top]).toEqual(['15%', '40%'])
    expect(spot.querySelector('svg.strike')).not.toBeNull()
    expect(v.button('Resume')?.disabled).toBe(false)
    await v.click('Check again')
    expect(v.hub.calls).toContain('evidence a1 fresh')
    await v.click('Dismiss, it was me')
    expect(v.hub.calls).toContain('dismiss a1 hand')
    v.done()
  })

  it('a hand on a printer SlicerX cannot pause says so plainly and keeps Pause off', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'alert', at, monitorOnly: true }, fakeHub(), row({ state: 'printing' }))
    expect(v.el.querySelector('h3')?.textContent).toBe('Hand seen, print still running')
    const banner = v.el.querySelector('.guard-banner')?.textContent ?? ''
    expect(banner).toContain("SlicerX can't stop this print")
    expect(banner).toContain('Bambu Connect')
    const pause = v.button('Pause')
    expect(pause?.disabled || pause?.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(v.button('Resume')).toBeUndefined()
    expect(v.el.textContent).toContain('Monitor only')
    v.done()
  })

  it("a start held for the plate: It's fine remembers the spot and starts the same plate anyway", async () => {
    let started = 0
    holdStart('a1', async () => void started++)
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'blocked', at, box: [0.4, 0.6, 0.45, 0.66], startedBy: 'slicerx', plateFrom: '2026-10-04T08:20:00.000Z' }, fakeHub(), row({ state: 'idle' }))
    expect(v.el.querySelector('h3')?.textContent).toBe('Something on the plate')
    expect(v.el.textContent).toContain("doesn't match your empty-plate picture from")
    expect(v.el.textContent).toContain('Start on hold')
    await v.click("It's fine, start anyway")
    expect(v.hub.calls).toContain('plateIgnore a1')
    expect(started).toBe(1)
    await v.click('Check again')
    expect(v.hub.calls).toContain('plateCheck a1')
    await v.click('This plate is clear')
    expect(v.hub.calls).toContain('plateClear a1')
    v.done()
  })

  it('a print the printer started onto a dirty plate was paused', async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'paused', at, startedBy: 'printer' })
    expect(v.el.querySelector('h3')?.textContent).toBe('Paused: something on the plate')
    expect(v.el.textContent).toContain("There's no empty-plate picture for Desk A1 yet")
    expect(v.button("It's fine, resume")).toBeDefined()
    v.done()
  })
})

describe('the words', () => {
  it('a dirty plate on a monitor-only printer says SlicerX cannot stop it', () => {
    const c = tripCopy({ printerId: 'a1', kind: 'plate', state: 'alert', at, monitorOnly: true, startedBy: 'printer' }, 'Garage A1')
    expect(c.cannotStop).toContain('Developer Mode is off on Garage A1')
    expect(`${c.title} ${c.body} ${c.cannotStop}`).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('a trip from the hub', () => {
  it('brings up Printers with the card, and a clear ends it', async () => {
    set({ workspace: 'prepare' })
    const hub = fakeHub()
    const stop = watchGuard(hub.host as never)
    await act(async () => hub.fire({ printerId: 'a1', kind: 'hand', state: 'paused', at }))
    expect(get().workspace).toBe('printers')
    expect(guardTrips()['a1']?.kind).toBe('hand')
    await act(async () => hub.fire({ printerId: 'a1', state: 'clear', at }))
    expect(guardTrips()['a1']).toBeUndefined()
    stop()
  })
})
