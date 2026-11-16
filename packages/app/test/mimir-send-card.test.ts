// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The send card for a print started from chat (docs/safety.md): the slide stays off until a spool is picked and the bed
// is ticked, for a stale slice, on a busy printer (with the time left) and with Developer Mode off (with Bambu Connect as
// the other way). The tick and the pick start empty on every card. The spool strip shows the slots the printer reports
// and nothing else; an empty slot and a spool of another material can't be picked. Completing the slide (or its end
// ring, or End on the knob) writes the send ledger entry for the request the answer grants, then approves with the bed
// clear and, for another spool than the request's, the slot map. After the answer the slide says Sending, then Sent.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashParams, pickedRequestId, type ApprovalRequest, type Host, type MeshHandle, type PrintRun, type PrinterInfo, type PrinterStatus } from '@slicerx/contracts'
import type { ApprovalCardProps } from '@slicerx/pilot/ui'
import { refusal } from '../src/agent-bridge/dom'
import { HostContext } from '../src/host'
import { boxMesh } from '../src/plate/mesh-ops'
import { sendLedger } from '../src/plate/send-ledger'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { plateFingerprint } from '../src/workspaces/mimir/print-run'
import { plateName, SendCard, sendRows, slideState } from '../src/workspaces/mimir/send-card'
import { pickedLine, spoolUnits } from '../src/workspaces/mimir/send-spools'

const SHA = 'ab'.repeat(32)
const info: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }
const idle: PrinterStatus = {
  printerId: 'bay-2',
  state: 'idle',
  nozzles: [],
  // A1 holds PLA, A2 the PETG the request sends from, A3 more PETG, A4 nothing, and white PETG on the external spool
  slots: [
    { id: 'A1', material: 'PLA', color: '#3b82f6' },
    { id: 'A2', material: 'PETG', color: '#000000' },
    { id: 'A3', material: 'PETG', color: '#ff7f50' },
    { id: 'A4' },
    { id: '1', material: 'PETG', color: '#ffffff' },
  ],
  cameraAvailable: false,
  updatedAt: '',
}

let n = 0
/** A printer.queue request as the runtime sends it: each action carries the hash of its parameters, not the parameters. */
async function request(sha256 = SHA): Promise<ApprovalRequest> {
  n += 1
  return {
    id: `apr_${n}`,
    sessionId: 't',
    tool: 'printer.queue',
    permission: 'start',
    title: 'Send plate 1 to Bay 2?',
    lines: ['Plate 1 on Bay 2 (P1S), 1h 0m, 12.0 g'],
    printerId: 'bay-2',
    paramsHash: 'h',
    actions: [
      { action: 'printer.upload', target: 'bay-2', paramsHash: await hashParams({ printerId: 'bay-2', name: 'clip.gcode.3mf', sha256 }) },
      { action: 'printer.start', target: 'bay-2', paramsHash: await hashParams({ printerId: 'bay-2', name: 'clip.gcode.3mf', opts: { slotMap: { 0: 'A2' } }, sha256 }) },
    ],
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
}

function runOf(stale = false): PrintRun {
  return {
    sessionId: 't',
    designId: 'des_1',
    plate: 1,
    printerId: 'bay-2',
    slots: { 1: 'A2' },
    slice: { sliceId: 'sl_1', plate: 1, at: '2026-10-20T00:00:00.000Z', timeS: 3600, grams: 12, cost: 0.3, warnings: [], fingerprint: plateFingerprint(get(), 1), stale },
    send: { printerId: 'bay-2', fileName: 'clip.gcode.3mf', fileKind: 'gcode.3mf', sha256: SHA, slots: { 1: 'A2' }, timeS: 3600, grams: 12 },
    job: null,
    updatedAt: '2026-10-20T00:00:00.000Z',
  }
}

async function card(opts: { status?: PrinterStatus | (() => Promise<PrinterStatus>); stale?: boolean; req?: ApprovalRequest; props?: Partial<ApprovalCardProps> } = {}) {
  const status = opts.status ?? idle
  const host = { printers: { list: async () => [info], status: typeof status === 'function' ? status : async () => status } } as unknown as Host
  const onApprove = vi.fn(async () => undefined)
  const onCancel = vi.fn(async () => undefined)
  const req = opts.req ?? (await request())
  const view = render(createElement(HostContext.Provider, { value: host }, createElement(SendCard, { request: req, resolution: null, actionable: true, onApprove, onCancel, run: runOf(opts.stale), ...opts.props })))
  return { req, onApprove, onCancel, view }
}

// the click target at the slide's end: off and on as the slide is
const printButton = () => screen.getByTestId('danger-mimir-send-print') as HTMLButtonElement
const bedBox = () => screen.getByTestId('mimir-send-bed') as HTMLInputElement
const spool = (slot: string) => screen.getByTestId('mimir-send').querySelector(`[data-testid="mimir-send-spool"][data-slot="${slot}"]`) as HTMLButtonElement
const slide = () => screen.getByTestId('mimir-send-slide')
const knob = () => screen.getByTestId('mimir-send-knob')
/** Picks the spool the request already sends from, as a person does before the slide. */
const pickOwn = () => fireEvent.click(spool('A2'))
/**
 * The card has read the printer once the status stops saying it is checking. The check loads the preflight on demand, so the
 * wait allows for a cold worker on a busy machine, and the modules load before the first one starts.
 */
const checked = () => waitFor(() => expect(screen.getByTestId('mimir-send-status').textContent).not.toMatch(/^Checking/), { timeout: 45_000 })
beforeAll(async () => void (await Promise.all([import('../src/plate/preflight'), import('../src/plate/transform'), import('../src/state/slice-plate')])))

beforeEach(() => set({ approval: null, plate: [], slice: { status: 'idle' }, layerMarks: {} } as never))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const clip = (id = 'a', x = 60, slot = 1): PlateEntry => {
  const handle: MeshHandle = { id, hash: id, name: 'Clip', triangles: 12, bboxMm: [30, 12, 8], openEdges: 0, parts: [] }
  return { id, name: id === 'a' ? 'Clip' : `Clip ${id}`, handle, parts: [{ ...boxMesh(30, 12, 8), name: 'Body', slot }], colors: ['#fff'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

describe('the send card', () => {
  it('rows name the time, the filament used and the plate by its own name, never the file', () => {
    const send = { printerId: 'bay-6', fileName: 'plate-native-slice-1.gcode.3mf', fileKind: 'gcode.3mf' as const, sha256: SHA, slots: { 1: 'A4' }, timeS: 960, grams: 1.8 }
    const rows = sendRows(send, 'Plate 1')
    expect(rows).toEqual([['Time', '16m'], ['Filament used', '1.8 g'], ['Plate', 'Plate 1']])
    expect(rows.flat().join(' ')).not.toContain('gcode')
    expect(plateName([{ name: 'Brackets' }], 1)).toBe('Brackets')
    expect(plateName([{ name: 'Brackets' }, { name: '  ' }], 2)).toBe('Plate 2')
    expect(plateName([], 3)).toBe('Plate 3')
  })

  it('the strip holds every slot the printer reports and nothing else, by unit, empty slots marked', () => {
    const units = spoolUnits(idle.slots, undefined, 'P1S', 'PETG', { 1: 'A2' })
    expect(units.map((u) => u.label)).toEqual(['AMS', 'External spool'])
    const chips = units.flatMap((u) => u.chips)
    expect(chips.map((c) => c.id)).toEqual(['A1', 'A2', 'A3', 'A4', '1'])
    expect(chips.map((c) => c.mark)).toEqual(['A1', 'A2', 'A3', 'A4', 'Ext'])
    expect(chips.find((c) => c.id === 'A4')).toMatchObject({ empty: true, material: '', color: '' })
    // the plate was sliced for PETG: the PLA spool is another material
    expect(chips.filter((c) => c.other).map((c) => c.id)).toEqual(['A1'])
    expect(chips.find((c) => c.id === 'A2')).toMatchObject({ material: 'PETG', colorWord: 'Black', empty: false, other: false })
    expect(pickedLine(chips.find((c) => c.id === 'A3')!)).toBe('Orange PETG · Slot A3')
    expect(pickedLine(chips.find((c) => c.id === '1')!)).toBe('White PETG · External spool')
    // a printer that reports nothing gets no strip
    expect(spoolUnits([], undefined, 'P1S', 'PETG', { 1: 'A2' })).toEqual([])
    // two filaments: each slot in use says which filament it feeds
    const two = spoolUnits(idle.slots, undefined, 'P1S', null, { 1: 'A2', 2: 'A1' }).flatMap((u) => u.chips)
    expect(two.filter((c) => c.feeds !== undefined).map((c) => [c.id, c.feeds])).toEqual([
      ['A1', 2],
      ['A2', 1],
    ])
    expect(two.some((c) => c.other)).toBe(false)
  })

  it('the slide reads off, ready, sending, sent and not sent from the card and the answer', () => {
    expect(slideState({ done: null, outcome: undefined, answering: false, canPrint: false })).toBe('off')
    expect(slideState({ done: null, outcome: undefined, answering: false, canPrint: true })).toBe('ready')
    expect(slideState({ done: null, outcome: undefined, answering: true, canPrint: false })).toBe('sending')
    expect(slideState({ done: { ok: true }, outcome: undefined, answering: false, canPrint: false })).toBe('sending')
    expect(slideState({ done: { ok: true }, outcome: null, answering: false, canPrint: false })).toBe('sending')
    expect(slideState({ done: { ok: true }, outcome: { ok: true, summary: 'Plate 1 accepted on bay-2' }, answering: false, canPrint: false })).toBe('sent')
    expect(slideState({ done: { ok: true }, outcome: { ok: false, summary: 'Stopped' }, answering: false, canPrint: false })).toBe('failed')
    expect(slideState({ done: { ok: false }, outcome: undefined, answering: false, canPrint: false })).toBe('off')
  })

  it('asks with the part and the printer, and shows the spools, the time, the grams and the plate', async () => {
    set({ plate: [clip()] })
    await card()
    await checked()
    expect(screen.getByTestId('mimir-send-title').textContent).toBe('Clip ready. Send it to Bay 2?')
    const row = (k: string) => screen.getByTestId('mimir-send').querySelector(`[data-row="${k}"] .sheet-rec-v`)?.textContent
    expect(row('Time')).toBe('1h 0m')
    expect(row('Filament used')).toBe('12.0 g')
    expect(row('Plate')).toBe(plateName(get().plates, 1))
    expect(screen.getByTestId('mimir-send').textContent).not.toContain('clip.gcode.3mf')
    // the strip: the unit and the printer, Choose material until a pick, and each slot with what it holds
    const strip = screen.getByTestId('mimir-send-spools')
    expect(strip.querySelector('.send-strip-where')?.textContent).toBe('AMS + External spool/Bay 2')
    expect(screen.getByTestId('mimir-send-pick').textContent).toBe('Choose material')
    expect(spool('A2').getAttribute('aria-label')).toBe('Slot A2: PETG Black')
    expect(spool('A4').getAttribute('aria-label')).toBe('Slot A4: Empty')
    expect(spool('1').getAttribute('aria-label')).toBe('External spool: PETG White')
    expect(screen.getByText('The bed is clear and the right build plate is on it')).toBeTruthy()
    expect(screen.getByTestId('mimir-send-cancel').textContent).toBe('Not now')
    expect(screen.getByTestId('mimir-send-status').textContent).toMatch(/^Pick a spool and tick the bed check to print\. Expires in /)
    expect(slide().getAttribute('data-state')).toBe('off')
  })

  it('an empty slot and a spool of another material cannot be picked; a loaded one names itself in the header', async () => {
    await card()
    await checked()
    expect(spool('A4').disabled).toBe(true)
    expect(spool('A1').disabled).toBe(true)
    expect(spool('A1').getAttribute('data-tip-title')).toBe('Sliced for PETG. Ask mimir to slice again for this spool.')
    fireEvent.click(spool('A4'))
    fireEvent.click(spool('A1'))
    expect(screen.getByTestId('mimir-send-pick').textContent).toBe('Choose material')
    fireEvent.click(spool('A3'))
    expect(screen.getByTestId('mimir-send-pick').textContent).toBe('Orange PETG · Slot A3')
    expect(spool('A3').getAttribute('aria-pressed')).toBe('true')
    expect(spool('A2').getAttribute('aria-pressed')).toBe('false')
  })

  it('the slide stays off until a spool is picked and the bed is ticked', async () => {
    await card()
    await checked()
    expect(printButton().disabled).toBe(true)
    fireEvent.click(bedBox())
    await checked()
    expect(screen.getByTestId('mimir-send-status').textContent).toMatch(/^Pick a spool to print\. Expires in /)
    expect(printButton().disabled).toBe(true)
    pickOwn()
    await waitFor(() => expect(printButton().disabled).toBe(false))
    expect(slide().getAttribute('data-state')).toBe('ready')
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(true))
    await checked()
    expect(screen.getByTestId('mimir-send-status').textContent).toMatch(/^Tick the bed check to print\. Expires in /)
  })

  it('the slide stays off for a stale slice', async () => {
    await card({ stale: true })
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    await checked()
    expect(screen.getByText('The plate changed after this slice. Slice it again.')).toBeTruthy()
    expect(screen.getByTestId('mimir-send-status').textContent).toMatch(/^Print stays off\. /)
    expect(printButton().disabled).toBe(true)
  })

  it('a plate change after the card shows turns the slide off and says so, with no new run', async () => {
    await card()
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    expect(screen.queryByText('The plate changed after this slice. Slice it again.')).toBeNull()
    // a part lands on the plate: the run the card was drawn with still says fresh
    act(() => set({ plate: [clip()] }))
    await waitFor(() => expect(screen.getByText('The plate changed after this slice. Slice it again.')).toBeTruthy())
    expect(printButton().disabled).toBe(true)
  })

  it('a pause or a rename after the card shows turns the slide off and says so, with no new run', async () => {
    for (const edit of [() => set({ layerMarks: { [get().activePlate]: [{ id: 'm1', z: 2, kind: 'pause' }] } } as never), () => set({ plate: get().plate.map((e) => ({ ...e, name: `${e.name} v2` })) })]) {
      set({ plate: [clip()], layerMarks: {} } as never)
      const { view } = await card()
      await checked()
      pickOwn()
      fireEvent.click(bedBox())
      await waitFor(() => expect(printButton().disabled).toBe(false))
      act(edit)
      await waitFor(() => expect(screen.getByText('The plate changed after this slice. Slice it again.')).toBeTruthy())
      expect(printButton().disabled).toBe(true)
      view.unmount()
    }
  })

  it('a filament swap between two objects or a support blocker after the card shows turns the slide off and says so', async () => {
    const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Clip', triangles: 12, bboxMm: [30, 12, 8], openEdges: 0, parts: [] }
    const blocker = { id: 'v1', name: 'Blocker', role: 'support_blocker', handle: { ...handle, id: 'v1', hash: 'v1' }, part: { ...boxMesh(5, 5, 5), name: 'Blocker', slot: 1 }, local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
    // the same slots stay in use and nothing printed is renamed: only the slice's inputs change
    const edits = [
      () => set({ plate: get().plate.map((e) => ({ ...e, slotOverrides: { Body: e.id === 'a' ? 2 : 1 } })) }),
      () => set({ plate: get().plate.map((e) => (e.id === 'a' ? { ...e, volumes: [blocker] } : e)) } as never),
    ]
    for (const edit of edits) {
      set({ plate: [clip('a', 60, 1), clip('b', 120, 2)], layerMarks: {} } as never)
      const { view } = await card()
      await checked()
      pickOwn()
      fireEvent.click(bedBox())
      await waitFor(() => expect(printButton().disabled).toBe(false))
      act(edit)
      await waitFor(() => expect(screen.getByText('The plate changed after this slice. Slice it again.')).toBeTruthy())
      expect(printButton().disabled).toBe(true)
      view.unmount()
    }
  })

  it('an answer the app cannot deliver says the card is no longer active, with no internal id, and turns it off', async () => {
    const { onCancel, req } = await card()
    onCancel.mockImplementationOnce(async () => Promise.reject(new Error(`No pending approval ${req.id}`)))
    await checked()
    fireEvent.click(screen.getByTestId('mimir-send-cancel'))
    await waitFor(() => expect(screen.getByTestId('mimir-send-status').textContent).toBe('This card is no longer active. Ask mimir to send it again.'))
    const text = screen.getByTestId('mimir-send').textContent ?? ''
    expect(text).not.toContain(req.id)
    expect(text).not.toMatch(/No pending approval|Could not send/)
    expect((screen.getByTestId('mimir-send-cancel') as HTMLButtonElement).disabled).toBe(true)
    expect(printButton().disabled).toBe(true)
    expect(bedBox().disabled).toBe(true)
    expect(spool('A2').disabled).toBe(true)
  })

  it('a slide whose answer cannot be delivered goes back off and says the card is no longer active', async () => {
    const { onApprove } = await card()
    onApprove.mockImplementationOnce(async () => Promise.reject(new Error('No pending approval')))
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    fireEvent.click(printButton())
    await waitFor(() => expect(screen.getByTestId('mimir-send-status').textContent).toBe('This card is no longer active. Ask mimir to send it again.'))
    expect(slide().getAttribute('data-state')).toBe('off')
  })

  it('a busy printer keeps the slide off and says how long is left', async () => {
    await card({ status: { ...idle, state: 'printing', timeLeftS: 5400 } })
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    await checked()
    expect(screen.getByText('Bay 2 is printing, about 1h 30m left. Pick another printer or wait until it finishes.')).toBeTruthy()
    expect(printButton().disabled).toBe(true)
  })

  it('Developer Mode off is explained with Bambu Connect', async () => {
    await card({ status: { ...idle, live: { needsDeveloperMode: true } } })
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    const dev = await screen.findByTestId('mimir-send-dev')
    expect(dev.textContent).toContain('Turn on LAN Only Mode and Developer Mode')
    expect(dev.textContent).toContain('Or: Send with Bambu Connect')
    expect(printButton().disabled).toBe(true)
  })

  it('the tick and the pick are empty on every new card', async () => {
    const first = await card()
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    expect(bedBox().checked).toBe(true)
    first.view.unmount()
    await card()
    await checked()
    expect(bedBox().checked).toBe(false)
    expect(screen.getByTestId('mimir-send-pick').textContent).toBe('Choose material')
    expect(printButton().disabled).toBe(true)
  })

  it('the slide on the spool the request sends from marks the ledger and approves with the bed clear', async () => {
    const mark = vi.spyOn(sendLedger, 'mark')
    const { req, onApprove } = await card()
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    fireEvent.click(printButton())
    expect(mark).toHaveBeenCalledWith(req.id, 'bay-2', SHA, req.expiresAt)
    expect(onApprove).toHaveBeenCalledWith(req, { bedClear: true })
    // the entry is for this request, printer and file, once
    expect(sendLedger.take(req.id, 'bay-2', SHA)).toBe(true)
    expect(sendLedger.take(req.id, 'bay-2', SHA)).toBe(false)
    // the slide says it is sending, and nothing on the card takes another answer
    expect(slide().getAttribute('data-state')).toBe('sending')
    expect(slide().textContent).toBe('Sending to Bay 2...')
    expect(spool('A3').disabled).toBe(true)
  })

  it('another spool goes with the answer as the slot map, and the ledger entry is for the request it makes', async () => {
    const mark = vi.spyOn(sendLedger, 'mark')
    const { req, onApprove } = await card()
    await checked()
    fireEvent.click(spool('1'))
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    fireEvent.click(printButton())
    expect(mark).toHaveBeenCalledWith(pickedRequestId(req.id), 'bay-2', SHA, req.expiresAt)
    expect(onApprove).toHaveBeenCalledWith(req, { bedClear: true, slotMap: { 0: '1' } })
    expect(sendLedger.take(req.id, 'bay-2', SHA)).toBe(false)
    expect(sendLedger.take(pickedRequestId(req.id), 'bay-2', SHA)).toBe(true)
  })

  it('a pick the printer no longer reports as loaded turns the slide off', async () => {
    let slots = idle.slots
    await card({ status: async () => ({ ...idle, slots }) })
    await checked()
    fireEvent.click(spool('A3'))
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    // the spool comes out: the next reading has the slot empty, and the pick drops
    slots = idle.slots.map((s) => (s.id === 'A3' ? { id: 'A3' } : s))
    fireEvent.click(bedBox())
    fireEvent.click(bedBox())
    await waitFor(() => expect(spool('A3').getAttribute('data-empty')).toBe('true'))
    expect(printButton().disabled).toBe(true)
    expect(screen.getByTestId('mimir-send-pick').textContent).toBe('Choose material')
  })

  it('dragging the knob to the end completes the slide; letting go short of it puts the knob back', async () => {
    const { onApprove } = await card()
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    // jsdom lays nothing out, so the track's travel is its 1 px floor: a move of 0.5 px is half way
    fireEvent.pointerDown(knob(), { clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(knob(), { clientX: 10.5, pointerId: 1 })
    fireEvent.pointerUp(knob(), { clientX: 10.5, pointerId: 1 })
    expect(onApprove).not.toHaveBeenCalled()
    expect(knob().getAttribute('aria-valuenow')).toBe('0')
    fireEvent.pointerDown(knob(), { clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(knob(), { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(knob(), { clientX: 400, pointerId: 1 })
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('the knob works from the keyboard: arrows step it, End completes it, a bare press does nothing', async () => {
    const { onApprove } = await card()
    await checked()
    pickOwn()
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    expect(knob().getAttribute('role')).toBe('slider')
    expect(knob().getAttribute('aria-label')).toBe('Slide to print on Bay 2')
    fireEvent.keyDown(knob(), { key: 'Enter' })
    fireEvent.keyDown(knob(), { key: ' ' })
    fireEvent.click(knob())
    expect(onApprove).not.toHaveBeenCalled()
    fireEvent.keyDown(knob(), { key: 'ArrowRight' })
    expect(knob().getAttribute('aria-valuenow')).toBe('25')
    fireEvent.keyDown(knob(), { key: 'Home' })
    expect(knob().getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(knob(), { key: 'End' })
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('while the slide is off the knob does not move and the end ring does nothing', async () => {
    const { onApprove } = await card()
    await checked()
    fireEvent.pointerDown(knob(), { clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(knob(), { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(knob(), { clientX: 400, pointerId: 1 })
    fireEvent.keyDown(knob(), { key: 'End' })
    fireEvent.click(printButton())
    expect(onApprove).not.toHaveBeenCalled()
    expect(knob().getAttribute('aria-valuenow')).toBe('0')
  })

  it('after the answer: Sending while the send runs, Sent once the printer took it, Not sent when it failed', async () => {
    const approved = { decision: { kind: 'approve' as const, bedClear: true }, by: 'user' as const, at: Date.parse('2026-10-20T10:00:00Z') }
    const req = await request()
    // an answered card runs no preflight; with no fleet here it names the printer by its id
    const sending = await card({ req, props: { resolution: approved, outcome: null } })
    expect(slide().getAttribute('data-state')).toBe('sending')
    expect(slide().textContent).toBe('Sending to bay-2...')
    expect(screen.getByTestId('mimir-send').getAttribute('data-state')).toBe('approved')
    expect(screen.getByTestId('mimir-send').getAttribute('data-send')).toBe('sending')
    sending.view.unmount()
    const sent = await card({ req, props: { resolution: approved, outcome: { ok: true, summary: 'Plate 1 accepted on bay-2' } } })
    expect(slide().getAttribute('data-state')).toBe('sent')
    expect(slide().textContent).toBe('Sent to bay-2')
    expect(screen.getByTestId('mimir-send-status').textContent).toMatch(/^Print approved by you at /)
    // nothing on the card answers again (the slot it went from shows on the strip from the fleet: the journeys check it)
    expect(printButton().disabled).toBe(true)
    expect(bedBox().disabled).toBe(true)
    sent.view.unmount()
    await card({ req, props: { resolution: approved, outcome: { ok: false, summary: 'Preflight failed: Bay 2 is offline. Nothing was sent to the printer.' } } })
    expect(slide().getAttribute('data-state')).toBe('failed')
    expect(slide().textContent).toBe('Not sent to bay-2')
    expect(screen.getByTestId('mimir-send-status').textContent).toBe('Preflight failed: Bay 2 is offline. Nothing was sent to the printer.')
  })

  it('a send record that does not match the request keeps the slide off', async () => {
    const mark = vi.spyOn(sendLedger, 'mark')
    await card({ req: await request('cd'.repeat(32)) })
    expect(await screen.findByText('The file for this request could not be matched, so Print stays off.')).toBeTruthy()
    fireEvent.click(bedBox())
    expect(printButton().disabled).toBe(true)
    fireEvent.click(printButton())
    expect(mark).not.toHaveBeenCalled()
  })

  it('the agent bridge refuses the spools, the bed tick, the slide and the whole card', async () => {
    await card()
    await checked()
    expect(refusal(spool('A2'))).not.toBeNull()
    expect(refusal(bedBox())).not.toBeNull()
    expect(refusal(knob())).not.toBeNull()
    expect(refusal(printButton())).not.toBeNull()
    expect(refusal(screen.getByTestId('mimir-send-cancel'))).not.toBeNull()
  })

  it('the slide is off while a new preflight runs, never on against an older reading', async () => {
    let calls = 0
    let release: (() => void) | null = null
    const status = () => {
      calls += 1
      if (calls <= 2) return Promise.resolve(idle)
      return new Promise<PrinterStatus>((resolve) => {
        release = () => resolve(idle)
      })
    }
    await card({ status })
    await checked()
    pickOwn()
    await checked()
    // every state the slide takes from the tick on, render by render: a click lands on whichever one is on screen
    const states: boolean[] = []
    const seen = new MutationObserver(() => states.push(printButton().disabled))
    seen.observe(printButton(), { attributes: true, attributeFilter: ['disabled'] })
    fireEvent.click(bedBox())
    // the tick starts a fresh reading: until it is back, the slide is off and the card says it is checking
    await waitFor(() => expect(screen.getByTestId('mimir-send-status').textContent).toMatch(/^Checking/))
    expect(printButton().disabled).toBe(true)
    // the last reading's spools stay on the card meanwhile, so nothing on it moves under the person's pointer
    expect(spool('A2').getAttribute('aria-label')).toBe('Slot A2: PETG Black')
    await waitFor(() => expect(release).not.toBeNull())
    expect(states).toEqual([])
    release!()
    await waitFor(() => expect(printButton().disabled).toBe(false))
    seen.disconnect()
    // the slide came on once, from the fresh reading, and was never on in between
    expect(states).toEqual([false])
  })

  it('Not now cancels without touching the ledger', async () => {
    const mark = vi.spyOn(sendLedger, 'mark')
    const { req, onCancel, onApprove } = await card()
    await checked()
    fireEvent.click(screen.getByTestId('mimir-send-cancel'))
    expect(onCancel).toHaveBeenCalledWith(req)
    expect(onApprove).not.toHaveBeenCalled()
    expect(mark).not.toHaveBeenCalled()
  })
})
