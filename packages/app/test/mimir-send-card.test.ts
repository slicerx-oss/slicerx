// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The send card for a print started from chat (docs/safety.md): Print stays off until the bed is ticked, for a stale
// slice, on a busy printer (with the time left) and with Developer Mode off (with Bambu Connect as the other way). The
// tick starts unchecked on every card. Print writes the send ledger entry for this request, printer and file, then
// approves with the bed clear.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashParams, type ApprovalRequest, type Host, type MeshHandle, type PrintRun, type PrinterInfo, type PrinterStatus } from '@slicerx/contracts'
import { refusal } from '../src/agent-bridge/dom'
import { HostContext } from '../src/host'
import { boxMesh } from '../src/plate/mesh-ops'
import { sendLedger } from '../src/plate/send-ledger'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { plateFingerprint } from '../src/workspaces/mimir/print-run'
import { plateName, SendCard, sendRows } from '../src/workspaces/mimir/send-card'

const SHA = 'ab'.repeat(32)
const info: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }
const idle: PrinterStatus = { printerId: 'bay-2', state: 'idle', nozzles: [], slots: [{ id: 'A2', material: 'PETG', color: '#000000' }], cameraAvailable: false, updatedAt: '' }

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

async function card(opts: { status?: PrinterStatus | (() => Promise<PrinterStatus>); stale?: boolean; req?: ApprovalRequest } = {}) {
  const status = opts.status ?? idle
  const host = { printers: { list: async () => [info], status: typeof status === 'function' ? status : async () => status } } as unknown as Host
  const onApprove = vi.fn(async () => undefined)
  const onCancel = vi.fn(async () => undefined)
  const req = opts.req ?? (await request())
  const view = render(createElement(HostContext.Provider, { value: host }, createElement(SendCard, { request: req, resolution: null, actionable: true, onApprove, onCancel, run: runOf(opts.stale) })))
  return { req, onApprove, onCancel, view }
}

const printButton = () => screen.getByTestId('danger-mimir-send-print') as HTMLButtonElement
const bedBox = () => screen.getByTestId('mimir-send-bed') as HTMLInputElement
/** The card has read the printer once the status stops saying it is checking. */
const checked = () => waitFor(() => expect(screen.getByTestId('mimir-send-status').textContent).not.toMatch(/^Checking/))

beforeEach(() => set({ approval: null, plate: [], slice: { status: 'idle' } }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the send card', () => {
  it('names the slot and the filament used apart, and the plate by its own name, never the file', () => {
    const send = { printerId: 'bay-6', fileName: 'plate-native-slice-1.gcode.3mf', fileKind: 'gcode.3mf' as const, sha256: SHA, slots: { 1: 'A4' }, timeS: 960, grams: 1.8 }
    const check = { slots: [{ id: 'A4', material: 'PLA', color: '#50fa7b' }] }
    const rows = sendRows(send, check, 'Bay 6', 'Plate 1')
    expect(rows).toEqual([['Printer', 'Bay 6'], ['Slot', 'A4, PLA, Green'], ['Time', '16m'], ['Filament used', '1.8 g'], ['Plate', 'Plate 1']])
    expect(rows.flat().join(' ')).not.toContain('gcode')
    // two filaments: each slot says which filament it feeds
    const two = sendRows({ ...send, slots: { 2: 'A2', 1: 'A4' } }, check, 'Bay 6', 'Plate 1')
    expect(two.map(([k]) => k)).toEqual(['Printer', 'Slot, filament 1', 'Slot, filament 2', 'Time', 'Filament used', 'Plate'])
    expect(plateName([{ name: 'Brackets' }], 1)).toBe('Brackets')
    expect(plateName([{ name: 'Brackets' }, { name: '  ' }], 2)).toBe('Plate 2')
    expect(plateName([], 3)).toBe('Plate 3')
  })

  it('shows the printer, each filament, the time, the grams and the plate', async () => {
    await card()
    await checked()
    expect(screen.getByText('Print on Bay 2?')).toBeTruthy()
    const row = (k: string) => screen.getByTestId('mimir-send').querySelector(`[data-row="${k}"] .sheet-rec-v`)?.textContent
    expect(row('Printer')).toBe('Bay 2')
    expect(row('Slot')).toBe('A2, PETG, Black')
    expect(row('Time')).toBe('1h 0m')
    expect(row('Filament used')).toBe('12.0 g')
    expect(row('Plate')).toBe(plateName(get().plates, 1))
    expect(screen.getByTestId('mimir-send').textContent).not.toContain('clip.gcode.3mf')
    expect(screen.getByText('The bed is clear and the right build plate is on it')).toBeTruthy()
    expect(screen.getByTestId('mimir-send-cancel').textContent).toBe('Not now')
  })

  it('Print stays off until the bed is ticked', async () => {
    await card()
    await checked()
    expect(printButton().disabled).toBe(true)
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(true))
  })

  it('Print stays off for a stale slice', async () => {
    await card({ stale: true })
    await checked()
    fireEvent.click(bedBox())
    await checked()
    expect(screen.getByText('The plate changed after this slice. Slice it again.')).toBeTruthy()
    expect(printButton().disabled).toBe(true)
  })

  it('a plate change after the card shows turns Print off and says so, with no new run', async () => {
    await card()
    await checked()
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    expect(screen.queryByText('The plate changed after this slice. Slice it again.')).toBeNull()
    // a part lands on the plate: the run the card was drawn with still says fresh
    const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Clip', triangles: 12, bboxMm: [30, 12, 8], openEdges: 0, parts: [] }
    const clip: PlateEntry = { id: 'a', name: 'Clip', handle, parts: [{ ...boxMesh(30, 12, 8), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
    act(() => set({ plate: [clip] }))
    await waitFor(() => expect(screen.getByText('The plate changed after this slice. Slice it again.')).toBeTruthy())
    expect(printButton().disabled).toBe(true)
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
  })

  it('a busy printer keeps Print off and says how long is left', async () => {
    await card({ status: { ...idle, state: 'printing', timeLeftS: 5400 } })
    await checked()
    fireEvent.click(bedBox())
    await checked()
    expect(screen.getByText('Bay 2 is printing, about 1h 30m left. Pick another printer or wait until it finishes.')).toBeTruthy()
    expect(printButton().disabled).toBe(true)
  })

  it('Developer Mode off is explained with Bambu Connect', async () => {
    await card({ status: { ...idle, live: { needsDeveloperMode: true } } })
    await checked()
    fireEvent.click(bedBox())
    const dev = await screen.findByTestId('mimir-send-dev')
    expect(dev.textContent).toContain('Turn on LAN Only Mode and Developer Mode')
    expect(dev.textContent).toContain('Or: Send with Bambu Connect')
    expect(printButton().disabled).toBe(true)
  })

  it('the tick is unchecked on every new card', async () => {
    const first = await card()
    await checked()
    fireEvent.click(bedBox())
    expect(bedBox().checked).toBe(true)
    first.view.unmount()
    await card()
    await checked()
    expect(bedBox().checked).toBe(false)
    expect(printButton().disabled).toBe(true)
  })

  it('Print marks the ledger and approves with the bed clear', async () => {
    const mark = vi.spyOn(sendLedger, 'mark')
    const { req, onApprove } = await card()
    await checked()
    fireEvent.click(bedBox())
    await waitFor(() => expect(printButton().disabled).toBe(false))
    fireEvent.click(printButton())
    expect(mark).toHaveBeenCalledWith(req.id, 'bay-2', SHA, req.expiresAt)
    expect(onApprove).toHaveBeenCalledWith(req, { bedClear: true })
    // the entry is for this request, printer and file, once
    expect(sendLedger.take(req.id, 'bay-2', SHA)).toBe(true)
    expect(sendLedger.take(req.id, 'bay-2', SHA)).toBe(false)
  })

  it('a send record that does not match the request keeps Print off', async () => {
    const mark = vi.spyOn(sendLedger, 'mark')
    await card({ req: await request('cd'.repeat(32)) })
    expect(await screen.findByText('The file for this request could not be matched, so Print stays off.')).toBeTruthy()
    fireEvent.click(bedBox())
    expect(printButton().disabled).toBe(true)
    fireEvent.click(printButton())
    expect(mark).not.toHaveBeenCalled()
  })

  it('the agent bridge refuses the bed tick and the whole card', async () => {
    await card()
    await checked()
    expect(refusal(bedBox())).not.toBeNull()
    expect(refusal(printButton())).not.toBeNull()
    expect(refusal(screen.getByTestId('mimir-send-cancel'))).not.toBeNull()
  })

  it('Print is off while a new preflight runs, never on against an older reading', async () => {
    let calls = 0
    let release: (() => void) | null = null
    const status = () => {
      calls += 1
      if (calls === 1) return Promise.resolve(idle)
      return new Promise<PrinterStatus>((resolve) => {
        release = () => resolve(idle)
      })
    }
    await card({ status })
    await checked()
    fireEvent.click(bedBox())
    // the tick starts a fresh reading: until it is back, Print is off and the card says it is checking
    await waitFor(() => expect(screen.getByTestId('mimir-send-status').textContent).toMatch(/^Checking/))
    expect(printButton().disabled).toBe(true)
    await waitFor(() => expect(release).not.toBeNull())
    release!()
    await waitFor(() => expect(printButton().disabled).toBe(false))
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
