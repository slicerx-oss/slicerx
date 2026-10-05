// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printers as a camera wall: the order that puts printers needing a person first, the count strip, bays and
// the All printers / By bay toggle, and a tile that opens the printer's live view by click or keyboard.
import type { PrinterStatus } from '@slicerx/contracts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetRow } from '../src/lib/queries'

// The live view itself is tested in hud.test.ts; here it only has to open.
vi.mock('../src/features/fleet/hud-view', () => ({
  PrinterHud: ({ row, onClose }: { row: FleetRow; onClose: () => void }) =>
    createElement('section', { role: 'region', 'aria-label': `${row.name} live view` }, createElement('button', { type: 'button', onClick: onClose }, 'Back to all printers')),
}))

const { HostContext } = await import('../src/host')
const { FeaturesContext } = await import('../src/features')
const { Fleet } = await import('../src/features/fleet/fleet')
const { bayGroups, baySummary, statusLine, timeLeftText, wallCounts, wallOrder } = await import('../src/features/fleet/wall')
const { moveToBay, newBay } = await import('../src/features/fleet/bays')
const { get, set } = await import('../src/state/store')
const { normalizePrefs } = await import('../src/state/prefs')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-10-05T07:00:00')

function row(id: string, name: string, s: Partial<PrinterStatus>, plugin = 'bambu-lan'): FleetRow {
  return { id, name, vendor: 'Bambu Lab', model: 'A1', plugin, nozzleCount: 1, status: { printerId: id, state: 'idle', nozzles: [{ current: 25, target: 0 }], bed: { current: 24, target: 0 }, slots: [], cameraAvailable: false, updatedAt: '2026-10-05T06:00:00Z', ...s } }
}

const ROWS: FleetRow[] = [
  row('atlas', 'Atlas', { state: 'idle', slots: [{ id: 'A1', material: 'PLA', color: '#ffffff', remainingPct: 40 }, { id: 'A2', material: 'PETG', color: '#d9473f', remainingPct: 20 }] }),
  row('voron', 'Voron 350', { state: 'offline', slots: [{ id: '1', material: 'ABS', color: '#000000', remainingPct: 5 }] }),
  row('desk', 'Desk A1', { state: 'printing', jobName: 'Benchy.gcode.3mf', progress: 0.31, layer: 74, layerCount: 240, timeLeftS: 2880 }),
  row('mini', 'Mini', { state: 'paused', message: 'Slot 1 ran out', jobName: 'Clip.gcode.3mf', progress: 0.44, layer: 88, layerCount: 200, slots: [{ id: 'A1', material: 'PLA', color: '#3a3a3a', remainingPct: 0 }] }),
  row('tawain', 'Tawain #1', { state: 'printing', jobName: 'Cube.gcode.3mf', progress: 0.62, layer: 62, layerCount: 100, timeLeftS: 840 }),
  row('hand', 'Garage Ender', {}, 'export'),
]

describe('wall order', () => {
  it('puts printers that need you first, then printing soonest done, ready, offline and export only', () => {
    expect(wallOrder(ROWS).map((r) => r.name)).toEqual(['Mini', 'Tawain #1', 'Desk A1', 'Atlas', 'Voron 350', 'Garage Ender'])
  })

  it('keeps a printing printer with no time left after the ones that report it', () => {
    const rows = [row('a', 'A', { state: 'printing' }), row('b', 'B', { state: 'printing', timeLeftS: 600 })]
    expect(wallOrder(rows).map((r) => r.name)).toEqual(['B', 'A'])
  })
})

describe('count strip', () => {
  it('counts each state with its one-line sub, and slots under 25% on reachable printers', () => {
    const c = Object.fromEntries(wallCounts(ROWS, NOW).map((x) => [x.id, x]))
    expect(c['print']!.value).toBe(2)
    expect(c['print']!.sub).toMatch(/^Next done 7:14\sAM, Tawain #1$/)
    expect(c['need']).toMatchObject({ value: 1, sub: 'Mini: Slot 1 ran out' })
    expect(c['ready']).toMatchObject({ value: 1, sub: 'Atlas' })
    expect(c['off']).toMatchObject({ value: 1, sub: 'Voron 350' })
    // Atlas A2 at 20% and Mini's empty slot; the offline Voron's 5% does not count.
    expect(c['low']).toMatchObject({ value: 2, sub: 'Slots under 25%' })
  })

  it('reads plainly with no printers in a state', () => {
    const c = Object.fromEntries(wallCounts([row('a', 'Atlas', {})], NOW).map((x) => [x.id, x.sub]))
    expect(c).toMatchObject({ print: 'Nothing printing', need: 'All clear', off: 'All reachable' })
  })

  it('gives each tile one status line and the time left', () => {
    const tawain = ROWS.find((r) => r.id === 'tawain')!
    expect(statusLine(tawain, NOW)).toMatch(/^Cube · layer 62 of 100 · done 7:14\sAM$/)
    expect(timeLeftText(tawain)).toBe('14 min left')
    const mini = ROWS.find((r) => r.id === 'mini')!
    expect(statusLine(mini, NOW)).toBe('Slot 1 ran out · Clip · layer 88 of 200')
    expect(timeLeftText(mini)).toBe('Paused')
  })
})

describe('bays', () => {
  const bays = [{ id: 'a', name: 'Bay A', place: 'Workshop rack' }, { id: 'b', name: 'Bay B' }, { id: 'c', name: 'Bay C' }]

  it('groups printers per bay in wall order, then the unassigned ones', () => {
    const groups = bayGroups(ROWS, bays, { tawain: 'a', atlas: 'a', voron: 'a', desk: 'b', mini: 'b', hand: 'gone' })
    expect(groups.map((g) => [g.name, g.rows.map((r) => r.name), g.summary])).toEqual([
      ['Bay A', ['Tawain #1', 'Atlas', 'Voron 350'], '1 printing · 1 ready · 1 offline'],
      ['Bay B', ['Mini', 'Desk A1'], '1 printing · 1 needs you'],
      ['Bay C', [], ''],
      // A bay that no longer exists reads as no bay.
      ['Unassigned', ['Garage Ender'], '1 export only'],
    ])
    expect(groups[0]!.place).toBe('Workshop rack')
    expect(bayGroups(ROWS, bays, Object.fromEntries(ROWS.map((r) => [r.id, 'a']))).some((g) => g.id === null)).toBe(false)
    expect(baySummary([])).toBe('')
  })

  it('makes a bay for a printer, moves it, and drops a bay its last printer leaves', () => {
    set({ bays: [], printerBays: {} })
    const id = newBay('atlas', ' Bay A ', ' Workshop ')
    expect(get().bays).toEqual([{ id, name: 'Bay A', place: 'Workshop' }])
    expect(get().printerBays).toEqual({ atlas: id })
    const second = newBay('mini', 'Bay A', '')
    expect(second).not.toBe(id)
    moveToBay('mini', id)
    expect(get().bays.map((b) => b.id)).toEqual([id])
    moveToBay('atlas', null)
    expect(get().bays.map((b) => b.id)).toEqual([id])
    moveToBay('mini', null)
    expect(get().bays).toEqual([])
    expect(get().printerBays).toEqual({})
  })

  it('reads stored bays safely: none by default, bad entries dropped', () => {
    const empty = normalizePrefs({})
    expect([empty.bays, empty.printerBays, empty.printersView]).toEqual([[], {}, 'all'])
    const p = normalizePrefs({ bays: [{ id: 'a', name: 'Bay A', place: 'Desk' }], printerBays: { atlas: 'a', bad: 7 }, printersView: 'bay' })
    expect(p.bays).toEqual([{ id: 'a', name: 'Bay A', place: 'Desk' }])
    expect(p.printerBays).toEqual({ atlas: 'a' })
    expect(p.printersView).toBe('bay')
    expect(normalizePrefs({ bays: [{ id: 'a' }], printersView: 'grid' })).toMatchObject({ bays: [], printersView: 'all' })
  })
})

describe('Printers page', () => {
  let root: Root
  let el: HTMLDivElement

  beforeEach(() => {
    set({ bays: [{ id: 'a', name: 'Bay A', place: 'Workshop rack' }], printerBays: { tawain: 'a', atlas: 'a' }, printersView: 'all' })
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
  })
  afterEach(() => {
    act(() => root.unmount())
    el.remove()
  })

  async function render(rows: FleetRow[] = ROWS): Promise<void> {
    const printers = {
      list: async () => rows.map(({ status: _s, ...p }) => p),
      status: async (id: string) => rows.find((r) => r.id === id)!.status,
      subscribe: () => () => undefined,
      snapshot: async () => null,
      fleets: async () => [],
    }
    const host = { kind: 'web', capabilities: {}, printers } as never
    const features = { ids: new Set(['connect']), features: [], workspaces: [], settings: [] } as never
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: new QueryClient() }, createElement(FeaturesContext.Provider, { value: features }, createElement(HostContext.Provider, { value: host }, createElement(Fleet)))),
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  }

  const tiles = () => [...el.querySelectorAll<HTMLElement>('.pcard')].map((t) => t.getAttribute('aria-label'))

  it('shows the count strip and every printer in wall order', async () => {
    await render()
    expect(tiles()).toEqual(['Mini, Needs you', 'Tawain #1, Printing', 'Desk A1, Printing', 'Atlas, Ready', 'Voron 350, Offline', 'Garage Ender, Export only'])
    const strip = el.querySelector('[aria-label="Printers by state"]')!
    expect([...strip.querySelectorAll('li')].map((li) => li.querySelector('b')!.textContent)).toEqual(['2', '1', '1', '1', '2'])
    const idle = (name: string) => el.querySelector<HTMLElement>(`.pcard[aria-label^="${name}"] .cam-idle-line`)!
    expect(idle('Voron').textContent).toMatch(/^(Not seen on this computer yet|Lost the connection|Last seen \d+ (min|h) ago|Last seen \d+ days? ago)$/)
    expect(idle('Voron').dataset['tipBody']).toContain('The printer is not reachable.')
    const away = el.querySelector<HTMLElement>('.pcard[aria-label^="Voron"] .cam-idle')!
    expect(away.dataset['breathe']).toBe('slow')
    expect(away.querySelector('button')!.textContent).toBe('Try again')
    expect(idle('Atlas').textContent).toBe('No camera')
    expect(idle('Garage').textContent).toBe('No connection')
    expect(el.querySelector('.pcard[aria-label^="Atlas"] .cam-idle[data-connecting]')).toBeNull()
    expect(el.querySelector('.pcard[aria-label^="Atlas"] .wall-slot[data-active]')).toBeNull()
  })

  it('switches to bays and back, and remembers the choice', async () => {
    await render()
    const byBay = [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'By bay')!
    await act(async () => byBay.click())
    expect(get().printersView).toBe('bay')
    const heads = [...el.querySelectorAll('.wall-bay-h')].map((h) => h.textContent)
    expect(heads).toEqual(['Bay AWorkshop rack1 printing · 1 ready', 'Unassigned1 printing · 1 needs you · 1 offline · 1 export only'])
    const all = [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'All printers')!
    await act(async () => all.click())
    expect(get().printersView).toBe('all')
    expect(el.querySelectorAll('.wall-bay')).toHaveLength(0)
  })

  it('opens the live view from anywhere on a tile, by click or by keyboard', async () => {
    await render()
    const open = el.querySelector<HTMLButtonElement>('.pcard[aria-label^="Atlas"] > .wall-open')!
    // One real button covers the tile, so Tab reaches it and Enter or Space presses it.
    expect(open.tagName).toBe('BUTTON')
    expect(open.getAttribute('aria-label')).toBe('Atlas')
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toBe('Plate clear, ready for a job')
    open.focus()
    expect(document.activeElement).toBe(open)
    await act(async () => open.click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const hud = el.querySelector('[role="region"][aria-label="Atlas live view"]')
    expect(hud).not.toBeNull()
    await act(async () => hud!.querySelector('button')!.click())
    expect(el.querySelectorAll('.pcard')).toHaveLength(6)
    // A printer with no connection has no live view to open.
    expect(el.querySelector('.pcard[aria-label^="Garage Ender"] > .wall-open')).toBeNull()
  })

  it('sends the ravens scouting from an empty wall', async () => {
    set({ setup: null })
    await render([])
    const empty = el.querySelector<HTMLElement>('.wall-empty')!
    expect(empty.querySelector('h2')!.textContent).toBe('No printers yet')
    expect(empty.querySelectorAll('.wall-empty-raven')).toHaveLength(2)
    const [find, byHand] = [...empty.querySelectorAll('button')]
    expect([find!.textContent, byHand!.textContent]).toEqual(['Find printers', 'Add one by hand'])
    await act(async () => byHand!.click())
    expect(get().setup).toMatchObject({ step: 'printer', byHand: true })
    await act(async () => find!.click())
    expect(get().setup).toEqual({ step: 'printer' })
  })
})
