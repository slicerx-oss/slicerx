// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's live view and the wait before an approval card: the view starts loading the send flow and the card as
// it opens, without waiting for them, and a press whose flow is still on its way shows on the pressed control (busy,
// at full strength, a spinner for its icon) while the other controls rest.
import type { PrinterStatus } from '@slicerx/contracts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetRow } from '../src/lib/queries'

vi.mock('../src/lib/use-printer', () => ({ usePrinter: () => ({ rows: [], printer: undefined }) }))

// Both loads stay pending until a test lets them go, as on a slow phone.
const loads = vi.hoisted(() => ({ send: 0, card: 0 }))
vi.mock('../src/shell/approval-load', () => ({ loadApprovalDialog: () => (loads.card++, new Promise(() => undefined)) }))
vi.mock('../src/state/actions', async (original) => ({ ...(await original<typeof import('../src/state/actions')>()), loadSendActions: () => (loads.send++, new Promise(() => undefined)) }))

// The press's own flow, held open until the test answers it.
const pending = vi.hoisted(() => ({ done: null as (() => void) | null, speedDone: null as (() => void) | null }))
vi.mock('../src/state/send-actions', () => ({ printerAction: () => new Promise<void>((r) => (pending.done = r)) }))
vi.mock('../src/features/fleet/hud-actions', async (original) => ({
  ...(await original<typeof import('../src/features/fleet/hud-actions')>()),
  setSpeed: () => new Promise<boolean>((r) => (pending.speedDone = () => r(false))),
}))

const { HostContext } = await import('../src/host')
const { PrinterHud } = await import('../src/features/fleet/hud-view')
const { set } = await import('../src/state/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const H2D_STATUS = JSON.parse(readFileSync(join(process.cwd(), '../contracts/fixtures/printers-status-h2d.json'), 'utf8')) as PrinterStatus
const H2D: FleetRow = { id: 'h2d', name: 'Tawain #1', vendor: 'Bambu Lab', model: 'H2D', plugin: 'bambu-lan', nozzleCount: 2, filamentSystem: 'ams', status: H2D_STATUS }

function fakeHost() {
  const printers = {
    status: async () => H2D_STATUS,
    subscribe: () => () => undefined,
    snapshot: async () => null,
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    streams: { open: async () => ({ media: null, mode: 'live', route: 'lan', supported: ['medium'], quality: 'medium', setQuality: async () => undefined, onStats: () => () => undefined, close() {} }) },
    adjust: { limits: async () => ({ speed: { levels: [50, 100, 124, 166] } }), apply: vi.fn(), light: vi.fn() },
  }
  return { kind: 'web', capabilities: {}, printers, approvals: { register: vi.fn(), deny: vi.fn(), grant: vi.fn(), verify: vi.fn() } }
}

let root: Root | null = null
let el: HTMLDivElement | null = null

async function show(row: FleetRow): Promise<HTMLDivElement> {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: fakeHost() as never }, createElement(PrinterHud, { row, onClose: () => undefined })))))
  await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
  return el
}

const button = (name: string) => [...el!.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement
const speed = () => el!.querySelector('.ph-speed select') as HTMLSelectElement
const press = (b: HTMLElement) => act(async () => void b.click())

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  localStorage.clear()
  loads.send = 0
  loads.card = 0
  pending.done = null
  pending.speedDone = null
  set({ rails: {}, approval: null, slotDialog: null, printerSlots: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  el?.remove()
  root = null
  el = null
})

describe('the live view before an approval card', () => {
  it('starts loading the send flow and the card as it opens, and shows the controls without waiting for them', async () => {
    await show(H2D)
    expect(loads).toEqual({ send: 1, card: 1 })
    // Both loads are still pending, and the view and its controls are up and live.
    expect(el!.querySelector('[aria-label="Tawain #1 live view"]')).not.toBeNull()
    for (const name of ['Pause', 'Stop']) expect(button(name).disabled, name).toBe(false)
  })

  it('loads them once for the view, not again on every status update', async () => {
    await show(H2D)
    await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: fakeHost() as never }, createElement(PrinterHud, { row: { ...H2D, status: { ...H2D_STATUS, progress: 0.5 } }, onClose: () => undefined })))))
    expect(loads).toEqual({ send: 1, card: 1 })
  })

  it('shows a press that waits on the pressed control, and rests the others until it is done', async () => {
    await show(H2D)
    const pause = button('Pause')
    expect(pause.querySelector('.sx-btn-spin')).toBeNull()
    await press(pause)

    // Pause is working: busy, not disabled (so it keeps its full look), a spinner where its icon was.
    expect(pause.getAttribute('aria-busy')).toBe('true')
    expect(pause.disabled).toBe(false)
    expect(pause.getAttribute('aria-disabled')).toBeNull()
    expect(pause.querySelector('.sx-btn-spin')).not.toBeNull()
    expect(pause.querySelector('svg')).toBeNull()
    // Stop and Speed rest while it waits.
    expect(button('Stop').disabled).toBe(true)
    expect(button('Stop').getAttribute('aria-busy')).toBeNull()
    expect(speed().disabled).toBe(true)

    // A second press while it waits starts nothing new.
    const first = pending.done
    await press(pause)
    expect(pending.done).toBe(first)

    await act(async () => pending.done!())
    expect(pause.getAttribute('aria-busy')).toBeNull()
    expect(pause.querySelector('.sx-btn-spin')).toBeNull()
    expect(pause.querySelector('svg')).not.toBeNull()
    expect(button('Stop').disabled).toBe(false)
    expect(speed().disabled).toBe(false)
  })

  it('shows a speed change that waits on the select, and rests Pause and Stop', async () => {
    await show(H2D)
    await act(async () => {
      speed().value = '166'
      speed().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(speed().getAttribute('aria-busy')).toBe('true')
    expect(speed().disabled).toBe(false)
    expect(el!.querySelector('.ph-speed .sx-btn-spin')).not.toBeNull()
    expect(button('Pause').disabled).toBe(true)
    expect(button('Stop').disabled).toBe(true)

    await act(async () => pending.speedDone!())
    expect(speed().getAttribute('aria-busy')).toBeNull()
    expect(el!.querySelector('.ph-speed .sx-btn-spin')).toBeNull()
    expect(button('Pause').disabled).toBe(false)
  })
})
