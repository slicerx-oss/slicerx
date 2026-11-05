// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads the remote start setting back, asks a person to start a plate already in the hub's queue, and asks
// to skip one object of the running print. None of it starts, skips or changes anything by itself: the hub raises a
// card a person answers (sx-link remote_start.rs, hub_rpc.rs queue.start, agent_work.rs skip). The hub is a scripted
// stand-in that answers as sx-link does.
import { hashParams } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { AGENT_CODE, scriptedLinkHub, type HubHandler } from './helpers/scripted-hub'

const PRINTERS = [{ id: 'bay-4', name: 'Bay 4', vendor: 'Voron Design', model: 'Voron 2.4 350', plugin: 'moonraker', nozzleCount: 1 }]
const printing = { printerId: 'bay-4', state: 'printing', nozzles: [{ current: 210, target: 210 }], bed: { current: 60, target: 60 }, slots: [], cameraAvailable: true, updatedAt: '2026-11-05T08:00:00.000Z' }

const ROW = { printerId: 'bay-4', enabled: true, maxNozzleC: 240, maxBedC: 80, catalogMaxNozzleC: 300, catalogMaxBedC: 110, guard: true, plateCheck: { checkedAt: '2026-11-05T08:00:00.000Z', clear: true, compared: true, passes: false, reason: 'plate_stale' } }
const ITEM = { id: 'q-1a2b3c4d5e6f', printerId: 'bay-4', name: 'Plate 2', state: 'waiting' }
const CARD = { id: 'q-1a2b3c4d5e6f-card-0001', sessionId: 'hub', tool: 'queue.start', permission: 'start', title: 'Start Plate 2 on Bay 4 now?', lines: [], printerId: 'bay-4', paramsHash: 'cd'.repeat(32), actions: [{ action: 'printer.start', target: 'bay-4', paramsHash: 'ef'.repeat(32) }], expiresAt: '2099-01-01T00:00:00.000Z', origin: 'queue' }

function hub(over: Partial<Record<string, HubHandler>> = {}) {
  const answers: Record<string, HubHandler> = {
    list: () => PRINTERS,
    status: () => printing,
    'remoteStart.get': (_m, p) => (p['printerId'] && p['printerId'] !== 'bay-4' ? Promise.reject({ code: 'not_found', message: 'no printer' }) : { printers: [ROW], plateWindowSeconds: 60, startWithinSeconds: 180, chamber: 'never' }),
    'queue.list': () => [ITEM, { ...ITEM, id: 'q-done', state: 'started' }],
    'queue.start': (_m, p) => (p['itemId'] === ITEM.id ? { item: { ...ITEM, state: 'awaiting_approval' }, request: CARD } : Promise.reject({ code: 'not_found', message: `no queue item ${String(p['itemId'])}` })),
    'bed.state': () => ({ printerId: 'bay-4', state: 'busy', askOnPrint: true, epoch: 3 }),
    'approvals.register': () => ({ registered: true, answeredIn: 'app' }),
    // The user's own OK in their client, on the client's own card (the policy's ask).
    'approvals.grant': (_m, p) => ({ requestId: p['requestId'], token: 'tok', expiresAt: '2099-01-01T00:00:00.000Z' }),
    ...over,
  }
  return scriptedLinkHub((method, params) => {
    if (method === 'remoteStart.set') throw { code: 'forbidden', message: 'remoteStart.set is for the app' }
    const a = answers[method]
    return a ? a(method, params) : {}
  })
}

const link = (h: ReturnType<typeof hub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: h.WS })

describe('slicerx_remote_start_policy', () => {
  it('reads the setting and the last plate check back, and never sets it', async () => {
    const h0 = hub()
    const h = await connect(link(h0))
    const r = await h.call('slicerx_remote_start_policy', { printerId: 'bay-4' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ printers: unknown[]; plateWindowSeconds: number; startWithinSeconds: number; chamber: string }>(r)).toEqual({ printers: [ROW], plateWindowSeconds: 60, startWithinSeconds: 180, chamber: 'never' })
    expect(h0.sent.map((s) => s.method)).not.toContain('remoteStart.set')
    const gone = await h.call('slicerx_remote_start_policy', { printerId: 'gone' })
    expect(gone).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } })
  })

  it('refuses simulated printers, which have no hub', async () => {
    const h = await connect({ printers: 'demo' })
    const r = await h.call('slicerx_remote_start_policy', {})
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported', details: { reason: 'no_hub' } } } })
  })
})

describe('slicerx_printer_queue_start', () => {
  it('is a write the policy gates when it asks for a card, and a read when it lists', async () => {
    const { client } = await connect({ printers: 'demo' })
    const tool = (await client.listTools()).tools.find((t) => t.name === 'slicerx_printer_queue_start')
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    // The user declines in their client: nothing is asked of the hub.
    const h0 = hub()
    const h = await connect(link(h0), { elicit: () => false })
    const r = await h.call('slicerx_printer_queue_start', { itemId: ITEM.id })
    expect(r.isError).toBe(true)
    expect(h0.sent.map((s) => s.method)).not.toContain('queue.start')
  })

  it('lists the open queued plates without an item id, and asks for a card with one', async () => {
    const h0 = hub()
    const h = await connect(link(h0), { elicit: () => true })
    const list = await h.call('slicerx_printer_queue_start', {})
    expect(data<{ output: { queued: { itemId: string }[] } }>(list).output.queued.map((q) => q.itemId)).toEqual([ITEM.id])
    const r = await h.call('slicerx_printer_queue_start', { itemId: ITEM.id })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data(r)).toMatchObject({ output: { item: { itemId: ITEM.id, name: 'Plate 2', state: 'awaiting_approval', scheduled: false }, request_id: CARD.id, status: 'waiting_for_person' } })
    // It asks; it never answers the card.
    const asked = h0.sent.map((s) => s.method)
    expect(asked).toContain('queue.start')
    // It never answers the plate's card.
    expect(h0.sent.filter((s) => s.method === 'approvals.grant').map((s) => s.params['requestId'])).not.toContain(CARD.id)
    const gone = await h.call('slicerx_printer_queue_start', { itemId: 'q-nope' })
    expect(gone).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } })
  })

  it('says why a scheduled plate or a busy printer is refused', async () => {
    const h = await connect(link(hub({ 'queue.start': () => Promise.reject({ code: 'bad_state', message: 'a scheduled plate starts at its time' }) })), { elicit: () => true })
    const r = await h.call('slicerx_printer_queue_start', { itemId: ITEM.id })
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input', details: { reason: 'bad_state' } } } })
    const b = await connect(link(hub({ 'queue.start': () => Promise.reject({ code: 'busy', message: 'the printer has a print on it' }) })), { elicit: () => true })
    expect(await b.call('slicerx_printer_queue_start', { itemId: ITEM.id })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
  })
})

describe('slicerx_print_adjust skip_object', () => {
  it('hands a skip of one object to the hub as work a person approves', async () => {
    const h0 = hub()
    const h = await connect(link(h0))
    const r = await h.call('slicerx_print_adjust', { printerId: 'bay-4', change: { kind: 'skip_object', objectId: 'lid.stl_id_0_copy_0' }, reason: 'The lid came loose from the plate' })
    expect(data<{ status: string }>(r).status, text(r)).toBe('needs_person')
    const reg = h0.sent.find((s) => s.method === 'approvals.register')
    // The running print's epoch, read from the hub, names the print and is in the hash (agent_work.rs).
    expect(reg?.params['work']).toEqual({ kind: 'skip', printerId: 'bay-4', id: 'lid.stl_id_0_copy_0', epoch: 3 })
    const actions = (reg?.params['request'] as { actions: { action: string; target: string; paramsHash: string }[] }).actions
    expect(actions).toEqual([{ action: 'printer.skip', target: 'bay-4', paramsHash: await hashParams({ printerId: 'bay-4', id: 'lid.stl_id_0_copy_0', epoch: 3 }) }])
  })

  it('refuses an object id that could carry a second command', async () => {
    const h = await connect(link(hub()))
    const r = await h.call('slicerx_print_adjust', { printerId: 'bay-4', change: { kind: 'skip_object', objectId: 'lid M112' }, reason: 'The lid came loose' })
    expect(r.isError).toBe(true)
  })
})
