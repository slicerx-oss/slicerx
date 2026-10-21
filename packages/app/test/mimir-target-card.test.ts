// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer and spool picker in the mimir chat: one flat card of the online printers, each with its loaded spools as
// swatches and words. A tap answers with that spool, an offline printer is not listed, and nothing on it names an
// internal id. Once settled, the plate points at the printer and its parts move to the picked spool. A new printer
// whose bed leaves a part hanging off it or in an excluded area lands that part again, as a new part lands.
import type { Bed, FilamentSlot, PilotChoice } from '@slicerx/contracts'
import type { RunLanded, RunTarget } from '@slicerx/pilot'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetRow } from '../src/lib/queries'
import { NO_MARGINS, placedOnBed, setAvoidAreas, setMarginSource, type Rect } from '../src/plate/arrange'
import { boxMesh } from '../src/plate/mesh-ops'
import { bounds, compose } from '../src/plate/transform'
import { appStore, get, set, type AppState, type PlateEntry } from '../src/state/store'
import { createHistory } from '../src/plate/history'
import { appPrintRun, BED_WAIT_MS } from '../src/workspaces/mimir/print-run'

/** What loading the new printer's profile does here: the bed and excluded areas it brings, when a test sets them. */
const profile = vi.hoisted(() => ({ load: null as null | (() => void) }))
vi.mock('../src/state/profile-sync', async (real) => ({ ...(await real<object>()), profileReady: async () => profile.load?.() }))
import { runChoiceCard } from '../src/workspaces/mimir/run-cards'
import { TargetPicker } from '../src/workspaces/mimir/target-card'

afterEach(cleanup)

const status = (printerId: string, slots: FilamentSlot[], state: FleetRow['status']['state'] = 'idle'): FleetRow['status'] => ({ printerId, state, nozzles: [], slots, cameraAvailable: false, updatedAt: '2026-10-19T00:00:00.000Z' })
const row = (id: string, name: string, model: string, slots: FilamentSlot[], state: FleetRow['status']['state'] = 'idle'): FleetRow => ({ id, name, vendor: 'Bambu Lab', model, plugin: 'bambu-lan', nozzleCount: 1, filamentSystem: 'ams', status: status(id, slots, state) })

const DESK = row('bay-1', 'Desk', 'A1', [
  { id: 'A1', material: 'PLA', color: '#FFFFFF' },
  { id: 'A2', material: 'PETG', color: '#161616' },
])
// a navy spool: the app's rail would call it Navy, the question's labels call it Blue, and the card must agree with them
const SHELF = row('bay-2', 'Shelf', 'A1 mini', [{ id: 'A1', material: 'PLA', color: '#1A237E' }])
const ATTIC = row('bay-9', 'Attic', 'P1S', [{ id: 'A1', material: 'ABS', color: '#D02020' }], 'offline')

const CHOICES: PilotChoice[] = [
  { id: 'pick:bay-1:A1', label: 'Desk, slot A1: PLA, White' },
  { id: 'pick:bay-1:A2', label: 'Desk, slot A2: PETG, Black' },
  { id: 'pick:bay-2:A1', label: 'Shelf, slot A1: PLA, Blue' },
  { id: 'pick:bay-9:A1', label: 'Attic, slot A1: ABS, Red' },
  { id: 'pick:none', label: 'None of these' },
]

function show(o: { picked?: string | null; actionable?: boolean } = {}) {
  const onChoose = vi.fn(async (_askId: string, _choiceId: string) => undefined)
  render(createElement(TargetPicker, { askId: 'ask_1', title: 'Which printer and spool?', question: '2 printers are online. Pick the spool to print with.', choices: CHOICES, picked: o.picked ?? null, actionable: o.actionable ?? true, onChoose, printers: [DESK, SHELF, ATTIC] }))
  return { card: screen.getByTestId('mimir-target'), onChoose }
}

describe('the target card', () => {
  it('the card lists online printers with their spools', () => {
    const { card } = show()
    expect(within(card).getByText('Desk')).toBeTruthy()
    expect(within(card).getByText('Shelf')).toBeTruthy()
    const spools = within(card).getAllByTestId('mimir-target-spool')
    expect(spools).toHaveLength(3)
    expect(spools.map((s) => s.textContent)).toEqual([expect.stringContaining('PLA White'), expect.stringContaining('PETG Black'), expect.stringContaining('PLA Blue')])
    expect(card.textContent).not.toContain('Navy')
    // each spool has its swatch
    expect(spools.every((s) => s.querySelector('.sx-swatch-ring'))).toBe(true)
    expect(within(card).getByRole('button', { name: 'None of these' })).toBeTruthy()
  })

  it('a tap answers with that spool', () => {
    const { card, onChoose } = show()
    fireEvent.click(within(card).getAllByTestId('mimir-target-spool')[1]!)
    expect(onChoose).toHaveBeenCalledWith('ask_1', 'pick:bay-1:A2')
    // answered: the spool shows picked and nothing else can be pressed
    expect(card.getAttribute('data-picked')).toBe('pick:bay-1:A2')
    expect(within(card).getAllByTestId('mimir-target-spool')[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(within(card).getAllByRole('button').every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(within(card).getByRole('button', { name: 'None of these' }))
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('an offline printer is not listed', () => {
    const { card } = show()
    expect(within(card).queryByText('Attic')).toBeNull()
    expect(card.textContent).not.toContain('ABS')
  })

  it('a pick that cannot be delivered says the card is no longer active, with no internal id, and takes no more taps', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { card, onChoose } = show()
    // the line is there before it is needed, empty, so filling it does not grow the card
    expect(within(card).getByTestId('mimir-target-note').textContent).toBe('')
    onChoose.mockImplementationOnce(async () => Promise.reject(new Error('No pending ask ask_1 (pick:bay-1:A2)')))
    fireEvent.click(within(card).getAllByTestId('mimir-target-spool')[1]!)
    await waitFor(() => expect(within(card).getByTestId('mimir-target-note').textContent).toBe('Nothing picked. Ask mimir again.'))
    expect(within(card).getByTestId('mimir-target-note').getAttribute('role')).toBe('status')
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'No pending ask ask_1 (pick:bay-1:A2)' }))
    const text = card.textContent ?? ''
    expect(text).not.toMatch(/ask_1|pick:|bay-\d|No pending|Could not send/)
    // nothing shows as picked, and every spool and None of these is off, the spools dimmed
    expect(card.getAttribute('data-picked')).toBeNull()
    expect(within(card).getAllByTestId('mimir-target-spool').every((s) => s.hasAttribute('data-off'))).toBe(true)
    expect(within(card).getAllByRole('button').every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(within(card).getByRole('button', { name: 'None of these' }))
    expect(onChoose).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('the card says nothing about internal ids', () => {
    const { card } = show({ picked: 'pick:bay-2:A1', actionable: false })
    const text = card.textContent ?? ''
    expect(text).not.toMatch(/bay-\d|pick:|run\.target|#[0-9a-f]{6}/i)
    expect(text).toContain('Shelf, slot A1')
  })

  it('is the card for pick asks only', () => {
    const props = { askId: 'a', title: 'Which printer and spool?', question: 'Which one?', picked: null, actionable: true }
    expect(runChoiceCard({ ...props, choices: CHOICES })).not.toBeNull()
    expect(runChoiceCard({ ...props, choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] })).toBeNull()
  })
})

const handle = { id: 'm1', hash: 'm1', name: 'Clip', triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [{ name: 'Body', slot: 1 }] } as unknown as PlateEntry['handle']
const clip: PlateEntry = { id: 'a', name: 'Clip', handle, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }

describe('setTarget', () => {
  beforeEach(() => {
    set({ plate: [clip], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', printerId: 'bay-2', printerSlots: [{ id: 'A1', material: 'PLA', color: '#2050C0' }], slotSetup: { 2: { type: 'PLA', brand: 'Generic', color: '#00ff00' } } })
  })

  it('points the plate at the printer and moves the part to the picked spool', async () => {
    await appPrintRun().setTarget!({ printerId: 'bay-1', slots: { 1: 'A2' }, printerSlots: DESK.status.slots })
    const s = get()
    expect(s.printerId).toBe('bay-1')
    expect(s.printerSlots.map((x) => x.id)).toEqual(['A1', 'A2'])
    // the part prints on the second spool, which follows what the printer holds again
    expect(s.plate[0]!.slotOverrides).toEqual({ Body: 2 })
    expect(s.slotSetup[2]).toBeUndefined()
  })

  it('two filaments that swap spools each land on the other one', async () => {
    const duo = { ...handle, parts: [{ name: 'Body', slot: 1 }, { name: 'Cap', slot: 2 }] } as unknown as PlateEntry['handle']
    set({ plate: [{ ...clip, handle: duo, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }, { ...boxMesh(10, 10, 4), name: 'Cap', slot: 2 }] }] })
    await appPrintRun().setTarget!({ printerId: 'bay-1', slots: { 1: 'A2', 2: 'A1' }, printerSlots: DESK.status.slots })
    // both moves were worked out before either part moved, so they do not end up on one spool
    expect(get().plate[0]!.slotOverrides).toEqual({ Body: 2, Cap: 1 })
  })

  it('on a plate of several filaments only the filaments named move', async () => {
    const four: FilamentSlot[] = [
      { id: 'A1', material: 'PLA', color: '#FFFFFF' },
      { id: 'A2', material: 'PLA', color: '#000000' },
      { id: 'A3', material: 'PETG', color: '#161616' },
      { id: 'A4', material: 'PLA', color: '#D02020' },
    ]
    const on = (id: string, name: string, slot: number): PlateEntry => ({ ...clip, id, name, handle: { ...handle, id, hash: id, name, parts: [{ name: 'Body', slot }] } as unknown as PlateEntry['handle'], parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot }] })
    set({ plate: [on('a', 'Base', 1), on('b', 'Lid', 2), on('c', 'Knob', 3)] })
    await appPrintRun().setTarget!({ printerId: 'bay-1', slots: { 1: 'A3', 2: 'A4' }, printerSlots: four })
    const s = get()
    expect(s.plate.map((e) => e.slotOverrides ?? {})).toEqual([{ Body: 3 }, { Body: 4 }, {}])
    expect(s.printerSlots.map((x) => x.id)).toEqual(['A1', 'A2', 'A3', 'A4'])
  })
})

describe('a new printer lands the parts its bed leaves off', () => {
  const BIG: Bed = { ...get().bed, widthMm: 350, depthMm: 320, round: false }
  const P1S: Bed = { ...BIG, widthMm: 256, depthMm: 256 }
  // the P1S's corner nothing may print on, as the arrange boxes give it
  const CORNER: Rect = { x: 0, y: 0, w: 40, h: 40 }
  const TO_P1S: RunTarget = { printerId: 'bay-1', slots: {}, model: { vendor: 'Bambu Lab', model: 'P1S' } }

  /** `e` moved so its footprint starts at (x, y) on the bed. */
  const at = (e: PlateEntry, x: number, y: number, id = e.id): PlateEntry => {
    const b = bounds(e.parts, compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }))!
    return { ...e, id, transform: compose({ position: [x - b.min[0], y - b.min[1], -b.min[2]], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  }
  const box = (id: string) => bounds(get().plate.find((e) => e.id === id)!.parts, get().plate.find((e) => e.id === id)!.transform)!
  /** The new printer's profile brings `bed` and its excluded `areas`. */
  const loads = (bed: Bed, areas: Rect[] = [], built = true) => {
    profile.load = () => {
      set({ bed, profile: built ? ({ printerId: 'p1s' } as unknown as AppState['profile']) : null })
      setAvoidAreas(areas)
    }
  }
  const target = async (t: RunTarget = TO_P1S) => (await appPrintRun().setTarget!(t)) as RunLanded

  beforeEach(() => {
    setAvoidAreas([])
    setMarginSource(() => NO_MARGINS)
    set({ plate: [at(clip, 60, 60)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', printerId: 'bay-2', printerModel: null, printerSlots: [], bed: BIG })
  })
  afterEach(() => {
    profile.load = null
    setAvoidAreas([])
    setMarginSource(() => NO_MARGINS)
  })

  it('a part that fits on the new bed stays put', async () => {
    const before = get().plate[0]!.transform
    loads(P1S, [CORNER])
    expect(await target()).toEqual({ moved: [], offBed: [] })
    expect(get().plate[0]!.transform).toEqual(before)
    // the plate points at the new printer's model, so its bed is the one loaded
    expect(get().printerModel).toEqual({ id: 'bay-1', vendor: 'Bambu Lab', model: 'P1S' })
    expect(get().bed.widthMm).toBe(256)
  })

  it('a part hanging off the new bed lands on it, and one that fits keeps its place', async () => {
    set({ plate: [at(clip, 290, 280), at(clip, 60, 60, 'b')] })
    const stays = get().plate[1]!.transform
    loads(P1S, [CORNER])
    expect(await target()).toMatchObject({ moved: [{ name: 'Clip', plate: 'Plate 1' }], offBed: [] })
    const [moved, kept] = get().plate
    expect(placedOnBed(moved!, P1S)).toBe(true)
    expect(kept!.transform).toEqual(stays)
    // landed clear of the part that stayed
    const m = box('a')
    const k = box('b')
    expect(m.min[0] >= k.max[0] || m.max[0] <= k.min[0] || m.min[1] >= k.max[1] || m.max[1] <= k.min[1]).toBe(true)
  })

  it('a part in the new bed\'s excluded area lands clear of it, with room for its brim and skirt', async () => {
    set({ plate: [at(clip, 5, 5)] })
    // the part's skirt reaches 8 mm past it
    setMarginSource(() => ({ grow: () => 3, reach: () => 8, skirt: true, keepOut: [] }))
    loads(P1S, [CORNER])
    expect(await target()).toMatchObject({ moved: [{ name: 'Clip', plate: 'Plate 1' }], offBed: [] })
    expect(placedOnBed(get().plate[0]!, P1S)).toBe(true)
    const b = box('a')
    const gap = Math.max(b.min[0] - (CORNER.x + CORNER.w), b.min[1] - (CORNER.y + CORNER.h))
    expect(gap).toBeGreaterThanOrEqual(8)
    expect(Math.min(b.min[0], b.min[1], 256 - b.max[0], 256 - b.max[1])).toBeGreaterThanOrEqual(8)
  })

  it('a part whose outline fits on the new bed but whose skirt hangs off lands with room for it', async () => {
    // 40 mm wide at x 210: its outline ends at 250 on the 256 mm bed, but a 10 mm skirt reaches 260
    set({ plate: [at(clip, 210, 100)] })
    setMarginSource(() => ({ grow: () => 0, reach: () => 10, skirt: true, keepOut: [] }))
    loads(P1S)
    expect(placedOnBed(get().plate[0]!, P1S)).toBe(true)
    expect(await target()).toMatchObject({ moved: [{ name: 'Clip', plate: 'Plate 1' }], offBed: [] })
    const b = box('a')
    expect(Math.min(b.min[0], b.min[1], 256 - b.max[0], 256 - b.max[1])).toBeGreaterThanOrEqual(10)
  })

  it('a part with no room on the new bed stays where it was and is named', async () => {
    const wide: PlateEntry = { ...clip, parts: [{ ...boxMesh(300, 20, 10), name: 'Body', slot: 1 }] }
    set({ plate: [at(wide, 20, 100)] })
    const before = get().plate[0]!.transform
    loads(P1S)
    expect(await target()).toMatchObject({ moved: [], offBed: [{ name: 'Clip', plate: 'Plate 1' }] })
    expect(get().plate[0]!.transform).toEqual(before)
  })

  it('a part that fits only without its brim and skirt has no room either', async () => {
    const small: Bed = { ...BIG, widthMm: 60, depthMm: 60 }
    set({ plate: [at(clip, 200, 200)] })
    setMarginSource(() => ({ grow: () => 6, reach: () => 12, skirt: true, keepOut: [] }))
    loads(small)
    expect(await target()).toMatchObject({ moved: [], offBed: [{ name: 'Clip', plate: 'Plate 1' }] })
  })

  it('names the plate of each part moved, on every plate', async () => {
    set({ plate: [at(clip, 60, 60, 'b')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [at(clip, 290, 280, 'c')], settings: {} }], activePlate: 'p1' })
    loads(P1S, [CORNER])
    const r = await target()
    expect(r).toMatchObject({ moved: [{ name: 'Clip', plate: 'Plate 2' }], offBed: [], manyPlates: true })
    expect(placedOnBed(get().plates[1]!.objects[0]!, P1S)).toBe(true)
  })

  it('does not flag several plates when there is one', async () => {
    set({ plate: [at(clip, 290, 280)] })
    loads(P1S)
    expect(await target()).not.toHaveProperty('manyPlates')
  })

  it('all parts moved by one switch are one undo step', async () => {
    set({ plate: [at(clip, 290, 280, 'a')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [at(clip, 280, 290, 'c')], settings: {} }], activePlate: 'p1' })
    const h = createHistory(appStore)
    const a0 = get().plate[0]!.transform
    const c0 = get().plates[1]!.objects[0]!.transform
    loads(P1S)
    expect(((await target()) as RunLanded).moved).toHaveLength(2)
    expect(h.state().undo).toBe(1)
    h.undo()
    expect(get().plate[0]!.transform).toEqual(a0)
    expect(get().plates[1]!.objects[0]!.transform).toEqual(c0)
    h.dispose()
  })

  it('says the bed is generic when no profile built for the printer', async () => {
    set({ plate: [at(clip, 290, 280)] })
    loads(P1S, [], false)
    expect(await target()).toMatchObject({ moved: [{ name: 'Clip', plate: 'Plate 1' }], genericBed: true })
  })

  it('leaves the parts alone when the bed never loads', async () => {
    vi.useFakeTimers()
    try {
      set({ plate: [at(clip, 290, 280)] })
      const before = get().plate[0]!.transform
      profile.load = () => new Promise<void>(() => undefined) as unknown as void
      const pending = target()
      await vi.advanceTimersByTimeAsync(BED_WAIT_MS)
      expect(await pending).toEqual({ moved: [], offBed: [], bedNotReady: true })
      expect(get().plate[0]!.transform).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the same printer again moves nothing', async () => {
    set({ plate: [at(clip, 5, 5)] })
    const before = get().plate[0]!.transform
    loads(P1S, [CORNER])
    expect(await target({ ...TO_P1S, printerId: 'bay-2' })).toEqual({ moved: [], offBed: [] })
    expect(get().plate[0]!.transform).toEqual(before)
  })
})
