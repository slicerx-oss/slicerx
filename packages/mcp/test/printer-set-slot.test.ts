// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client asks a person to set one AMS slot (filament type, color, preset, nozzle range) and reads it back. The hub
// raises a card only a person answers on the computer, and writes the slot once they approve it (sx-link
// agent_work.rs slot work). The hub is a scripted stand-in that answers as sx-link does.
import { hashParams } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { AGENT_CODE, scriptedLinkHub, type HubHandler } from './helpers/scripted-hub'

const PRINTERS = [{ id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }]
const idle = {
  printerId: 'bay-1',
  state: 'idle',
  nozzles: [{ current: 25, target: 0 }],
  slots: [
    { id: 'A1', material: 'PLA', color: '#ffffff' },
    { id: 'A2', material: 'PLA', color: '#000000' },
  ],
  cameraAvailable: true,
  updatedAt: '2026-11-05T08:00:00.000Z',
}
const SETTING = { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1a2b3c', nozzleTempMin: 220, nozzleTempMax: 260 }

function hub(over: Partial<Record<string, HubHandler>> = {}) {
  const answers: Record<string, HubHandler> = {
    list: () => PRINTERS,
    status: () => idle,
    'approvals.register': () => ({ registered: true, answeredIn: 'app' }),
    ...over,
  }
  return scriptedLinkHub((method, params) => {
    // What the hub refuses an agent connection whatever it holds.
    if (method === 'adjust.slot' || method === 'approvals.grant') throw { code: 'forbidden', message: 'a person answers this card in the app' }
    const a = answers[method]
    return a ? a(method, params) : {}
  })
}

const link = (h: ReturnType<typeof hub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: h.WS })

describe('slicerx_printer_set_slot', () => {
  it('hands the slot to the hub as work a person approves, and never answers the card', async () => {
    const h0 = hub()
    const h = await connect(link(h0), { elicit: () => true })
    const r = await h.call('slicerx_printer_set_slot', { printerId: 'bay-1', setting: { ...SETTING, material: 'petg', color: '#1A2B3C' }, reason: 'The spool tag says PETG' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ status: string }>(r).status).toBe('needs_person')
    const reg = h0.sent.find((s) => s.method === 'approvals.register')
    // The type in capitals and the color in lower case, as the printer stores them and the hub checks them.
    expect(reg?.params['work']).toEqual({ kind: 'slot', printerId: 'bay-1', setting: SETTING })
    const request = reg?.params['request'] as { actions: { action: string; target: string; paramsHash: string }[]; title: string; lines: string[] }
    // The app's own slot write, so the printer checks the person's token the same way.
    expect(request.actions).toEqual([{ action: 'printer.adjust', target: 'bay-1', paramsHash: await hashParams({ printerId: 'bay-1', slot: SETTING }) }])
    expect(request.title).toBe('Set slot A2 on Bay 1 to PETG?')
    expect(h0.sent.map((s) => s.method)).not.toContain('approvals.grant')
    expect(h0.sent.map((s) => s.method)).not.toContain('adjust.slot')
    // slicerx_approve cannot answer it either: only a person in the app can.
    const id = data<{ request_id: string }>(r).request_id
    const ok = await h.call('slicerx_approve', { request_id: id, approve: true })
    expect(ok.isError).toBe(true)
  })

  it('reads the slots back, and the card state once the hub ran the write', async () => {
    let now = idle
    const h0 = hub({ status: () => now })
    const h = await connect(link(h0), { elicit: () => true })
    const before = await h.call('slicerx_printer_set_slot', { printerId: 'bay-1' })
    expect(before.isError, text(before)).toBeFalsy()
    expect(data(before)).toMatchObject({ output: { printerId: 'bay-1', settable: true, slots: [{ id: 'A1' }, { id: 'A2', material: 'PLA', color: '#000000' }] } })
    expect(h0.sent.map((s) => s.method)).not.toContain('approvals.register')
    const r = await h.call('slicerx_printer_set_slot', { printerId: 'bay-1', setting: SETTING })
    const id = data<{ request_id: string }>(r).request_id
    const waiting = data<{ pending: { request_id: string; status: string }[] }>(await h.call('slicerx_pending_approvals', {})).pending
    expect(waiting).toEqual([expect.objectContaining({ request_id: id, tool: 'slicerx_printer_set_slot', status: 'waiting_for_person' })])
    // A person approves in the app; the hub writes the slot and reports.
    now = { ...idle, slots: [idle.slots[0]!, { id: 'A2', material: 'PETG', color: '#1a2b3c' }] }
    h0.emit('approval.done', { requestId: id, printerId: 'bay-1', ok: true })
    await new Promise((res) => setTimeout(res, 50))
    const done = data<{ pending: { request_id: string; status: string }[] }>(await h.call('slicerx_pending_approvals', {})).pending
    expect(done).toEqual([expect.objectContaining({ request_id: id, status: 'done' })])
    const after = await h.call('slicerx_printer_set_slot', { printerId: 'bay-1' })
    expect(data(after)).toMatchObject({ output: { slots: [{ id: 'A1' }, { id: 'A2', material: 'PETG', color: '#1a2b3c' }] } })
  })

  it('says a printer that takes no slot setting, or one printing, cannot be set', async () => {
    const h = await connect(link(hub({ list: () => [{ ...PRINTERS[0], plugin: 'moonraker' }] })))
    expect(data(await h.call('slicerx_printer_set_slot', { printerId: 'bay-1' }))).toMatchObject({ output: { settable: false, reason: expect.stringMatching(/does not take a slot setting/) } })
    const p = await connect(link(hub({ status: () => ({ ...idle, state: 'printing' }) })))
    expect(data(await p.call('slicerx_printer_set_slot', { printerId: 'bay-1' }))).toMatchObject({ output: { settable: false, reason: expect.stringMatching(/printing/) } })
  })

  it('refuses bad input before anything reaches the hub', async () => {
    for (const bad of [
      { ...SETTING, material: 'UNOBTAINIUM' },
      { ...SETTING, material: 'PLA\nM104 S300' },
      { ...SETTING, color: 'red' },
      { ...SETTING, color: '#12345' },
      { ...SETTING, slot: 'A2;M1' },
      { ...SETTING, filamentId: 'G'.repeat(17) },
      { ...SETTING, filamentId: '' },
      { ...SETTING, nozzleTempMin: 270 },
      { ...SETTING, nozzleTempMax: 400 },
    ]) {
      const h0 = hub()
      const h = await connect(link(h0), { elicit: () => true })
      const r = await h.call('slicerx_printer_set_slot', { printerId: 'bay-1', setting: bad })
      expect(r.isError, JSON.stringify(bad)).toBe(true)
      expect(h0.sent.map((s) => s.method)).not.toContain('approvals.register')
    }
  })

  it('passes on the hub refusing a slot the printer cannot take now', async () => {
    const h = await connect(link(hub({ 'approvals.register': () => Promise.reject({ code: 'refused', message: 'slot A2 holds a spool with an RFID tag, which sets the slot itself' }) })), { elicit: () => true })
    const r = await h.call('slicerx_printer_set_slot', { printerId: 'bay-1', setting: SETTING })
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: 'refused' } } })
  })

  it('refuses simulated printers, which have no hub', async () => {
    const h = await connect({ printers: 'demo' }, { elicit: () => true })
    const r = await h.call('slicerx_printer_set_slot', { printerId: 'demo-1', setting: SETTING })
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
  })
})
