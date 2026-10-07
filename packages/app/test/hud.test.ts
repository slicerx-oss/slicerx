// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The device view of one printer: a running H2D as the Bambu driver reads it (two nozzles, an AMS and an
// AMS HT, a current HMS code), drawers that open and close by mouse and keyboard and are remembered,
// approvals before pause, stop and a speed change, and what it leaves out for a printer with less.
import type { PrinterStatus } from '@slicerx/contracts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetRow } from '../src/lib/queries'

const selected: { id: string | null } = { id: null }
vi.mock('../src/lib/use-printer', () => ({ usePrinter: () => ({ rows: [], printer: selected.id ? { id: selected.id } : undefined }) }))

const { HostContext } = await import('../src/host')
const { PrinterHud } = await import('../src/features/fleet/hud-view')
const { gauges, jobLine, slotGroups, speedChoices, doneAt } = await import('../src/features/fleet/hud')
const { get, set } = await import('../src/state/store')
const { loadPrefs } = await import('../src/state/prefs')
const { BATTLE_MIN_MS, forgetFirstLooks } = await import('../src/camera/idle')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const H2D_STATUS = JSON.parse(readFileSync(join(process.cwd(), '../contracts/fixtures/printers-status-h2d.json'), 'utf8')) as PrinterStatus
const H2D: FleetRow = { id: 'h2d', name: 'Tawain #1', vendor: 'Bambu Lab', model: 'H2D', plugin: 'bambu-lan', nozzleCount: 2, filamentSystem: 'ams', status: H2D_STATUS }
const MK4S: FleetRow = {
  id: 'mk4s', name: 'Bay 3', vendor: 'Prusa Research', model: 'MK4S', plugin: 'prusalink', nozzleCount: 1,
  status: { printerId: 'mk4s', state: 'printing', jobName: 'Bracket.bgcode', progress: 0.31, layer: 62, layerCount: 200, timeLeftS: 6300, nozzles: [{ current: 215, target: 215 }], bed: { current: 60, target: 60 }, slots: [{ id: '1', material: 'PLA', color: '#ef4444' }], cameraAvailable: false, updatedAt: '2026-10-05T07:34:00.000Z' },
}

let phone = false
function media(): void {
  window.matchMedia = ((q: string) => ({ matches: phone && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
}

function fakeHost(withHub = true) {
  const calls = { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), apply: vi.fn(), light: vi.fn(), register: vi.fn(async () => undefined), deny: vi.fn(async () => undefined) }
  const printers = {
    status: async () => H2D_STATUS,
    subscribe: () => () => undefined,
    snapshot: async () => null,
    pause: calls.pause,
    resume: calls.resume,
    cancel: calls.cancel,
    streams: { open: async () => ({ media: null, mode: 'live', route: 'lan', supported: ['medium'], quality: 'medium', setQuality: async () => undefined, onStats: () => () => undefined, close() {} }) },
    ...(withHub
      ? {
          device: {
            jog: async () => undefined,
            issues: async () => [
              { code: '0300_9600_0003_0001', severity: 'common', module: 'motion controller', text: 'The front door is open. Close it; for materials that need a warm chamber the print waits until it is shut.' },
              { code: '0500_0500_0001_0007', severity: 'fatal', module: 'main board', text: 'The main board reported a fatal error.', stale: true },
            ],
          },
          bed: { state: async () => ({ askOnPrint: true }) },
          adjust: { limits: async () => ({ speed: { levels: [50, 100, 124, 166] } }), apply: calls.apply, light: calls.light },
        }
      : {}),
  }
  const approvals = { register: calls.register, deny: calls.deny, grant: vi.fn(), verify: vi.fn() }
  return { host: { kind: 'web', capabilities: {}, printers, approvals } as never, calls }
}

let root: Root | null = null
let el: HTMLDivElement | null = null

async function show(row: FleetRow, host: unknown): Promise<HTMLDivElement> {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: host as never }, createElement(PrinterHud, { row, onClose: () => undefined })))))
  await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
  return el
}

const q = (sel: string) => el!.querySelector(sel) as HTMLElement | null
const button = (name: string) => [...el!.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined
const drawer = (label: string) => el!.querySelector(`aside[aria-label="${label}"]`) as HTMLElement
const key = (target: Element, k: string) => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 50)))
const click = async (b: Element | undefined) => {
  await act(async () => void (b as HTMLElement).click())
  await settle()
}

beforeEach(() => {
  phone = false
  media()
  localStorage.clear()
  selected.id = null
  set({ rails: {}, approval: null, slotDialog: null, printerSlots: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  el?.remove()
  root = null
  el = null
})

describe('device view logic', () => {
  it('names the nozzles by side, left first, and leaves out what is not reported', () => {
    expect(gauges(H2D_STATUS).map((g) => g.label)).toEqual(['Left nozzle', 'Right nozzle', 'Bed', 'Chamber'])
    expect(gauges(MK4S.status).map((g) => g.label)).toEqual(['Nozzle', 'Bed'])
    expect(gauges({ ...H2D_STATUS, state: 'offline' })).toEqual([])
  })

  it('groups the slots by unit with the nozzle each feeds', () => {
    const g = slotGroups(H2D_STATUS.slots, H2D_STATUS.live, 'H2D')
    expect(g.map((x) => [x.label, x.feeds, x.slots.map((s) => s.id)])).toEqual([
      ['AMS', 'left nozzle', ['A1', 'A2', 'A3', 'A4']],
      ['AMS HT', 'right nozzle', ['E1']],
    ])
    expect(slotGroups([{ id: 'A1' }, { id: 'B1' }, { id: '1', material: 'TPU' }], undefined, 'A1').map((x) => x.label)).toEqual(['AMS lite 1', 'AMS lite 2', 'External spool'])
  })

  it('offers the speed profiles the printer takes', () => {
    expect(speedChoices({ levels: [50, 100, 124, 166] }).map((p) => p.label)).toEqual(['Silent', 'Standard', 'Sport', 'Ludicrous'])
    expect(speedChoices({ min: 50, max: 150 }).map((p) => p.label)).toEqual(['Silent', 'Standard', 'Sport'])
  })

  it('says when the job is done', () => {
    const now = new Date('2026-10-05T07:34:00').getTime()
    expect(jobLine(H2D_STATUS, now)).toBe(`Layer 62 of 100 · 14 min left · done ${doneAt(840, now)}`)
    expect(doneAt(20 * 3600, now)).toMatch(/^Tue /)
  })
})

describe('the first look at a printer', () => {
  it('holds the battle for one clash on the first open even when the picture is ready at once, and not on the next', async () => {
    forgetFirstLooks()
    const { host } = fakeHost()
    await show(H2D, host)
    // the feed is already up, yet the ravens stay over it
    expect(q('video.ph-cam')?.hasAttribute('data-held')).toBe(true)
    expect(q('.cam-idle[data-connecting]')).not.toBeNull()
    await act(async () => new Promise<void>((r) => setTimeout(r, BATTLE_MIN_MS - 300)))
    expect(q('video.ph-cam')?.hasAttribute('data-held')).toBe(true)
    await act(async () => new Promise<void>((r) => setTimeout(r, 600)))
    expect(q('video.ph-cam')?.hasAttribute('data-held')).toBe(false)
    act(() => root?.unmount())
    el?.remove()
    // opening the same printer again this session goes straight to the picture
    await show(H2D, host)
    expect(q('video.ph-cam')?.hasAttribute('data-held')).toBe(false)
    expect(q('.cam-idle[data-connecting]')).toBeNull()
  })
})

describe('device view of a printing H2D', () => {
  // At midday, so the job's finish time stays on today: run in the last 14 minutes before midnight, it read
  // "done Wed 12:03 AM".
  beforeEach(() => vi.setSystemTime(new Date(2026, 9, 7, 12, 0)))
  afterEach(() => vi.useRealTimers())

  it('shows the job, the current problem with its code, and the edge tabs', async () => {
    const { host } = fakeHost()
    await show(H2D, host)
    expect(q('.ph-name')?.textContent).toBe('Tawain #1')
    expect(q('.ph-model')?.textContent).toBe('Bambu Lab H2D')
    expect(q('.sx-pill')?.textContent).toBe('Printing')
    expect(q('.ph-file')?.textContent).toBe('Cube 20 mm')
    expect(q('.ph-job-row .ph-muted')?.textContent).toMatch(/^Layer 62 of 100 · 14 min left · done \d/)
    expect(q('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('62')
    expect(q('.ph-pct')?.textContent).toBe('62%')
    // Only the current HMS issue, in plain words, with its code small; the leftover one stays off.
    const alert = q('.ph-alert')!
    expect(alert.textContent).toContain('The front door is open.')
    expect(alert.querySelector('small')?.textContent).toBe('Code 0300 9600 0003 0001')
    expect(alert.textContent).not.toContain('main board')
    // The camera fills the view.
    expect(q('video.ph-cam')?.getAttribute('aria-label')).toBe('Live view of Tawain #1')
    // Left tab: one mini gauge per nozzle, the bed and the chamber, left nozzle first.
    const left = button('Show temperatures and fans')!
    expect([...left.querySelectorAll('.ph-mini')].map((m) => m.textContent)).toEqual(['220 °C', '31 °C', '55 °C', '32 °C'])
    // Right tab: the AMS slots, a divider, the AMS HT; the slot printing now is ringed.
    const right = button('Show filament')!
    expect(right.querySelectorAll('.ph-sw')).toHaveLength(5)
    expect(right.querySelectorAll('.ph-divider')).toHaveLength(1)
    expect(right.querySelectorAll('.ph-sw[data-active]')).toHaveLength(1)
    expect(right.querySelector('.ph-sw[data-active]')?.getAttribute('style')).toContain('rgb(242, 242, 242)')
    // Bottom bar.
    expect(q('.ph-glyph')?.getAttribute('aria-label')).toBe('Layer 62 of 100')
    const speed = q('.ph-speed select') as HTMLSelectElement
    expect(speed.value).toBe('100')
    expect([...speed.options].map((o) => o.textContent)).toEqual(['Silent', 'Standard', 'Sport', 'Ludicrous'])
    expect(button('Light')?.getAttribute('aria-pressed')).toBe('true')
    expect(button('Pause')).toBeTruthy()
    expect(button('Stop')).toBeTruthy()
  })

  it('opens and closes the drawers by mouse and keyboard, and gives focus back to the tab', async () => {
    const { host } = fakeHost()
    await show(H2D, host)
    const tab = button('Show temperatures and fans')!
    expect(tab.tagName).toBe('BUTTON')
    expect(tab.getAttribute('aria-expanded')).toBe('false')
    expect(drawer('Temperatures and fans').hidden).toBe(true)

    await click(tab)
    const temps = drawer('Temperatures and fans')
    expect(temps.hidden).toBe(false)
    expect(tab.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close temperatures and fans')
    expect([...temps.querySelectorAll('[role=meter]')].map((m) => m.getAttribute('aria-valuetext') ?? `${m.getAttribute('aria-label')} ${m.getAttribute('aria-valuenow')}%`)).toEqual([
      '220 °C, target 220 °C',
      '31 °C, heater off',
      '55 °C, target 55 °C',
      '32 °C, heater off',
      'Part cooling fan 100%',
      'Auxiliary fan 70%',
      'Chamber fan 30%',
    ])

    // Esc closes it and focus returns to its tab.
    await key(document.activeElement!, 'Escape')
    expect(drawer('Temperatures and fans').hidden).toBe(true)
    expect(document.activeElement).toBe(tab)

    // The close button works too.
    await click(button('Show filament'))
    const fil = drawer('Filament')
    expect(fil.hidden).toBe(false)
    const rows = [...fil.querySelectorAll('.ph-slot')].map((r) => r.textContent)
    expect(rows[0]).toBe('A1 · PLA BasicPrinting now82% left')
    expect(rows[3]).toBe('A4 · Empty')
    expect([...fil.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['AMS, feeds the left nozzle', 'AMS HT, feeds the right nozzle'])
    await click(button('Close filament'))
    expect(drawer('Filament').hidden).toBe(true)
    expect(document.activeElement).toBe(button('Show filament'))
  })

  it('remembers open drawers for this person', async () => {
    const { host } = fakeHost()
    await show(H2D, host)
    await click(button('Show filament'))
    expect(get().rails['printer-hud']).toEqual({ right: true })
    expect(loadPrefs().rails['printer-hud']).toEqual({ right: true })
    act(() => root!.unmount())
    el!.remove()
    await show(H2D, host)
    expect(drawer('Filament').hidden).toBe(false)
    expect(drawer('Temperatures and fans').hidden).toBe(true)
  })

  it('asks for approval before pause, stop and a speed change, and sends nothing without it', async () => {
    const { host, calls } = fakeHost()
    await show(H2D, host)
    const deny = async () => act(async () => void (await get().approval!.deny()))

    await click(button('Pause'))
    expect(get().approval?.requests[0]?.actions.map((a) => a.action)).toEqual(['printer.pause'])
    await deny()

    await click(button('Stop'))
    const stop = get().approval?.requests[0]
    expect(stop?.actions.map((a) => a.action)).toEqual(['printer.cancel'])
    expect(stop?.lines).toContain('The job stops and cannot be resumed')
    await deny()

    const speed = q('.ph-speed select') as HTMLSelectElement
    await act(async () => {
      speed.value = '166'
      speed.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    const card = get().approval?.requests[0]
    expect(card?.tool).toBe('printer.adjust')
    expect(card?.title).toBe('Print Tawain #1 at Ludicrous speed?')
    expect(card?.actions.map((a) => [a.action, a.target])).toEqual([['printer.adjust', 'h2d']])
    await deny()

    expect(calls.pause).not.toHaveBeenCalled()
    expect(calls.cancel).not.toHaveBeenCalled()
    expect(calls.apply).not.toHaveBeenCalled()
    // The select still shows what the printer reports.
    expect((q('.ph-speed select') as HTMLSelectElement).value).toBe('100')
  })

  it('switches the light and edits slots only for the printer the plate is set up for', async () => {
    const { host, calls } = fakeHost()
    await show(H2D, host)
    await click(button('Light'))
    expect(calls.light).toHaveBeenCalledWith('h2d', false)
    await click(button('Show filament'))
    expect(button('Edit slots')?.getAttribute('aria-disabled')).toBe('true')
    act(() => root!.unmount())
    el!.remove()

    selected.id = 'h2d'
    set({ printerSlots: H2D_STATUS.slots })
    await show(H2D, host)
    await click(button('Edit slots'))
    expect(get().slotDialog).toBe(1)
  })
})

describe('device view of a Bambu Lab printer with Developer Mode off', () => {
  it('shows its status and rests every control, saying why', async () => {
    const WATCH: PrinterStatus = { ...H2D_STATUS, live: { ...H2D_STATUS.live, monitorOnly: true } }
    const { host, calls } = fakeHost()
    ;(host as unknown as { printers: { status: () => Promise<PrinterStatus> } }).printers.status = async () => WATCH
    selected.id = 'h2d'
    set({ printerSlots: H2D_STATUS.slots })
    await show({ ...H2D, status: WATCH }, host)
    expect(el!.textContent).toContain(H2D_STATUS.jobName ?? '')
    for (const name of ['Pause', 'Stop', 'Light']) expect(button(name)?.getAttribute('aria-disabled'), name).toBe('true')
    expect(button('Pause')?.getAttribute('data-tip-reason')).toBe('Developer Mode is off on Tawain #1, so SlicerX shows its status only. Use the printer\'s screen or Bambu Connect.')
    expect((q('.ph-speed select') as HTMLSelectElement).disabled).toBe(true)
    await click(button('Pause'))
    await click(button('Light'))
    expect(get().approval).toBeNull()
    expect(calls.pause).not.toHaveBeenCalled()
    expect(calls.light).not.toHaveBeenCalled()
    await click(button('Show filament'))
    expect(button('Edit slots')?.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('device view of a printer with less', () => {
  it('hides the filament tab, the fans, the light and the speed, and shows a quiet picture for no camera', async () => {
    const { host } = fakeHost(false)
    await show(MK4S, host)
    expect(button('Show filament')).toBeUndefined()
    expect(q('[data-testid=ph-placeholder]')?.textContent).toContain('This printer has no camera.')
    expect(q('video')).toBeNull()
    expect([...button('Show temperatures and fans')!.querySelectorAll('.ph-mini')]).toHaveLength(2)
    await click(button('Show temperatures and fans'))
    expect(drawer('Temperatures and fans').textContent).not.toContain('Fans')
    expect(button('Light')).toBeUndefined()
    expect(q('.ph-speed')).toBeNull()
    expect(button('Pause')).toBeTruthy()
  })

  it('has no temperature tab while the printer is offline', async () => {
    const { host } = fakeHost(false)
    await show({ ...MK4S, status: { ...MK4S.status, state: 'offline', nozzles: [], bed: undefined as never } }, host)
    expect(button('Show temperatures and fans')).toBeUndefined()
    expect(q('[data-testid=ph-placeholder]')?.textContent).toContain('The printer is not reachable.')
    expect(q('[data-testid=ph-placeholder] .cam-idle[data-breathe=slow] .cam-idle-line')?.textContent).toMatch(/^(Last seen |Lost the connection|Not seen on this computer yet)/)
    expect(button('Try again')).toBeTruthy()
  })
})

describe('device view on a phone', () => {
  it('lays out for a phone and shows one bottom sheet at a time', async () => {
    phone = true
    media()
    const { host } = fakeHost()
    await show(H2D, host)
    expect(q('.ph')?.getAttribute('data-layout')).toBe('phone')
    await click(button('Show filament'))
    expect(drawer('Filament').hidden).toBe(false)
    await click(button('Show temperatures and fans'))
    expect(drawer('Temperatures and fans').hidden).toBe(false)
    expect(drawer('Filament').hidden).toBe(true)
    expect(get().rails['printer-hud']).toEqual({ left: true, right: false })
  })
})

