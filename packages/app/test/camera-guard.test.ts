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
import { fitFrame, guardTrips, holdStart, placeBox, resetGuard, tripCopy, watchGuard, type GuardTrip } from '../src/features/fleet/guard'
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
    handCheck: async (id: string) => (calls.push(`handCheck ${id}`), { checked: true, hand: false }),
    resume: async (id: string) => void calls.push(`resume ${id}`),
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
    // Check again looks at a new frame with the detector, not only a new still (QA M7).
    await v.click('Check again')
    expect(v.hub.calls).toContain('handCheck a1')
    expect(get().toast?.text).toContain('No hand in the new picture')
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
    expect(v.button('This plate is clear')).toBeUndefined()
    v.done()
  })
})

describe('every way out of a paused card keeps Resume until a person resumes', () => {
  const names = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent)

  it('a hand paused the print: Resume, a new picture, or dismiss it', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at, answered: false })
    expect(names(v.el)).toEqual(['Resume', 'Check again', 'Dismiss, it was me'])
    v.done()
  })

  it('after Dismiss the card stays paused with Resume and nothing to dismiss', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at, answered: true })
    expect(v.el.querySelector('h3')?.textContent).toBe('Still paused')
    expect(v.el.textContent).toContain('stays paused until you resume it')
    expect(names(v.el)).toEqual(['Resume', 'Check again'])
    v.done()
  })

  it('a paused plate offers to resume, never to save this plate as the empty one', async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'paused', at, box: [0.4, 0.6, 0.45, 0.66], startedBy: 'printer', answered: false })
    expect(names(v.el)).toEqual(["It's fine, resume", 'Check again'])
    v.done()
  })

  it('a paused plate checked clean waits on Resume', async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'paused', at, startedBy: 'printer', answered: true })
    expect(v.el.querySelector('h3')?.textContent).toBe('Still paused')
    expect(names(v.el)).toEqual(['Resume', 'Check again'])
    v.done()
  })

  it('a held start can take a new empty-plate picture once the person cleared it', async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'blocked', at, startedBy: 'slicerx' }, fakeHub(), row({ state: 'idle' }))
    expect(names(v.el)).toEqual(["It's fine", 'Check again', 'This plate is clear'])
    expect(v.el.textContent).not.toContain('keeps this picture')
    v.done()
  })

  it('a picture that does not load says so instead of a broken image', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at })
    await act(async () => v.el.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(v.el.querySelector('img')).toBeNull()
    expect(v.el.textContent).toContain('No picture from the camera')
    v.done()
  })
})

describe('the picture in its 16:9 frame (QA N2)', () => {
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-9)

  it('fits the whole picture, letterboxed, so a box lands where it is', () => {
    // 16:9 fills the frame.
    expect(near(fitFrame(1280, 720), [0, 0, 1, 1])).toBe(true)
    // 4:3 is narrower: bars left and right.
    expect(near(fitFrame(640, 480), [0.125, 0, 0.75, 1])).toBe(true)
    // An odd size, 960 by 686 (QA's A1 frame): a little narrower than 16:9.
    const odd = fitFrame(960, 686)
    expect(odd[1]).toBe(0)
    expect(odd[2]).toBeCloseTo((960 / 686) / (16 / 9), 9)
    // Wider than 16:9: bars top and bottom.
    expect(near(fitFrame(2000, 500), [0, (1 - (16 / 9) / 4) / 2, 1, (16 / 9) / 4])).toBe(true)
    // An unknown size counts as 16:9.
    expect(near(fitFrame(0, 0), [0, 0, 1, 1])).toBe(true)
  })

  it('places a box through the fit, inside the picture', () => {
    const fit = fitFrame(640, 480)
    // The bottom right corner of the picture is the bottom right of the picture's area, not of the frame.
    expect(near(placeBox([0.5, 0.5, 1, 1], fit), [0.125 + 0.375, 0.5, 0.375, 0.5])).toBe(true)
    // QA's debris box on the 960 by 686 frame stays inside the frame.
    const [l, t, w, h] = placeBox([0.496, 0.771, 0.648, 0.911], fitFrame(960, 686))
    expect(l >= 0 && t >= 0 && l + w <= 1 && t + h <= 1).toBe(true)
  })

  it('the card sizes the picture and the spot from the loaded picture', async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'blocked', at, box: [0.5, 0.5, 1, 1], startedBy: 'slicerx' }, fakeHub(), row({ state: 'idle' }))
    const img = v.el.querySelector('img')!
    Object.defineProperty(img, 'naturalWidth', { value: 640 })
    Object.defineProperty(img, 'naturalHeight', { value: 480 })
    await act(async () => img.dispatchEvent(new Event('load')))
    const pic = v.el.querySelector('.guard-pic') as HTMLElement
    expect([pic.style.left, pic.style.width]).toEqual(['12.5%', '75%'])
    const spot = v.el.querySelector('.guard-spot') as HTMLElement
    expect([spot.style.left, spot.style.top, spot.style.width, spot.style.height]).toEqual(['50%', '50%', '37.5%', '50%'])
    v.done()
  })
})

describe('the status line agrees with the card (QA N1)', () => {
  it('a held start on an idle printer does not say the plate is clear', async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'blocked', at, box: [0.4, 0.6, 0.45, 0.66], startedBy: 'slicerx' }, fakeHub(), row({ state: 'idle' }))
    expect(v.el.textContent).not.toContain('Plate clear')
    expect(v.el.querySelector('.guard-stats')).toBeNull()
    v.done()
  })

  it('a running print keeps its job and layer line', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'alert', at, monitorOnly: true }, fakeHub(), row({ state: 'printing' }))
    expect(v.el.querySelector('.guard-stats')?.textContent).toContain('layer 46 of 210')
    v.done()
  })
})

describe('a hand answered by a clean Check again (QA N3)', () => {
  it('says the new picture shows no hand, not that it was dismissed, and marks nothing', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at, answered: true, answeredBy: 'clear' })
    expect(v.el.querySelector('h3')?.textContent).toBe('Still paused')
    expect(v.el.textContent).toContain('The new picture shows no hand')
    expect(v.el.textContent).not.toContain('You dismissed')
    expect(v.el.querySelector('.guard-badge')).toBeNull()
    expect(v.el.querySelector('.guard-spot')).toBeNull()
    v.done()
  })

  it('a dismissed hand still says so and keeps its badge', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at, answered: true, answeredBy: 'dismissed' })
    expect(v.el.textContent).toContain('You dismissed the hand')
    expect(v.el.querySelector('.guard-badge')).not.toBeNull()
    v.done()
  })

  it('a plate checked clean says the plate looks clear and marks nothing', async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'paused', at, startedBy: 'printer', box: [0.4, 0.6, 0.45, 0.66], answered: true, answeredBy: 'clear' })
    expect(v.el.textContent).toContain('The plate looks clear now')
    expect(v.el.querySelector('.guard-spot')).toBeNull()
    v.done()
  })
})

describe('the mark on the frame', () => {
  it('a hand with no spot gets a corner badge, never a strike on nothing', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at })
    expect(v.el.querySelector('.guard-spot')).toBeNull()
    const badge = v.el.querySelector('.guard-badge')
    expect(badge?.textContent).toContain('Hand seen')
    expect(badge?.querySelector('svg.strike')).not.toBeNull()
    v.done()
  })

  it('a hand with a spot gets the strike on it', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at, box: [0.1, 0.5, 0.4, 0.9] })
    expect(v.el.querySelector('.guard-spot svg.strike')).not.toBeNull()
    expect(v.el.querySelector('.guard-badge')).toBeNull()
    v.done()
  })
})

describe('Resume on the card', () => {
  it('is the approval itself: the hub resumes that pause, no second card (QA M9)', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at, answered: true })
    await v.click('Resume')
    expect(v.hub.calls).toEqual(expect.arrayContaining(['resume a1']))
    expect(document.querySelector('dialog.approve-dialog')).toBeNull()
    v.done()
  })

  it("It's fine on a paused plate marks the spot, then resumes the same way", async () => {
    const v = await render({ printerId: 'a1', kind: 'plate', state: 'paused', at, box: [0.4, 0.6, 0.45, 0.66], startedBy: 'printer' })
    await v.click("It's fine, resume")
    expect(v.hub.calls.filter((c) => c.startsWith('plateIgnore') || c.startsWith('resume'))).toEqual(['plateIgnore a1', 'resume a1'])
    v.done()
  })

  it('says Paused once (QA P6)', async () => {
    const v = await render({ printerId: 'a1', kind: 'hand', state: 'paused', at })
    expect(v.el.textContent!.match(/Paused(?!:)/g)?.length).toBe(1)
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
