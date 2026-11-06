// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Partner phones: another company's phone app pairs as a phone under its own name, bound into the pairing.
import { describe, expect, it } from 'vitest'
import type { PairPushHub } from '../src/host'
import { partnerKey, partnerName } from '../src/partner'
import { flush, pairByLink, world, type Phone, type World } from './helpers'

const PREFS = { printDone: true, printFailed: true, attention: true, approvals: true }

function fakePush() {
  const calls: { method: string; reg: unknown }[] = []
  const push: PairPushHub = {
    register: async (reg) => void calls.push({ method: 'register', reg }),
    unregister: async (by) => void calls.push({ method: 'unregister', reg: by }),
    registerPartner: async (reg) => void calls.push({ method: 'registerPartner', reg }),
    partnerApprovals: async (tag, approvals) => void calls.push({ method: 'partnerApprovals', reg: { tag, approvals } }),
  }
  return { push, calls }
}

/** A pairing attempt that may fail before the host ever sees an attempt. */
async function tryPair(w: World, phone: Phone, partner?: string) {
  const offer = w.host.createOffer(partner === undefined ? {} : { partner })
  let attempts = 0
  offer.onAttempt(() => (attempts += 1))
  const flow = await phone.client.pair(offer.link)
  const r = await flow.result
  await flush()
  return { ok: r.ok, attempts }
}

describe('partner names', () => {
  it('are cleaned and folded the same way on both sides', () => {
    expect(partnerName('  Example\tPhone  ')).toBe('Example Phone')
    expect(partnerName('')).toBeNull()
    expect(partnerName('--')).toBeNull()
    expect(partnerName('x'.repeat(65))).toBeNull()
    expect(partnerKey('Example Phone')).toBe(partnerKey('example phone'))
    expect(partnerKey('Ｅｘａｍｐｌｅ Ｐｈｏｎｅ')).toBe(partnerKey('Example Phone'))
    expect(partnerKey(' Example   Phone ')).toBe(partnerKey('example phone'))
  })
})

describe('partner phones', () => {
  it('pair under the name the offer was made for, start without the approve right, and keep the name off the relay', async () => {
    const w = await world()
    const phone = w.phone('Pixel 8', { partner: 'Example Phone', lan: false })
    const before = w.relay.log.length
    const r = await pairByLink(w, phone, w.host.createOffer({ partner: 'example phone' }))
    expect(r.phoneSas).toBe(r.hostSas)
    expect(r.hostResult.ok).toBe(true)
    const [device] = await w.host.devices()
    expect(device?.partner).toBe('Example Phone')
    expect(device?.rights).toEqual({ request: true, approve: false, introduce: false, send: false })
    const [host] = await phone.client.hosts()
    expect(host?.partner).toBe('Example Phone')
    const conn = await phone.client.connect(host?.pairingId ?? '')
    expect(conn.info.partner).toBe('Example Phone')
    expect(conn.info.rights.approve).toBe(false)
    expect((await conn.printers()).length).toBeGreaterThan(0)
    // The relay saw a partner hello, never the name.
    const seen = w.relay.log.slice(before).map((m) => m.body).join('\n')
    expect(seen).not.toMatch(/example phone/i)
    conn.close()
  })

  it('cannot pair under another name, on a plain offer, or by account approval; a plain phone cannot use a partner offer', async () => {
    const w = await world()
    expect(await tryPair(w, w.phone('Pixel 8', { partner: 'OtherApp' }), 'Example Phone')).toEqual({ ok: false, attempts: 0 })
    expect(await tryPair(w, w.phone('Pixel 8', { partner: 'Example Phone' }))).toEqual({ ok: false, attempts: 0 })
    expect(await tryPair(w, w.phone('iPhone'), 'Example Phone')).toEqual({ ok: false, attempts: 0 })
    expect(await w.host.devices()).toEqual([])
    const signedIn = w.phone('Pixel 8', { partner: 'Example Phone', accountId: 'acct-1' })
    await expect(signedIn.client.joinAccount()).rejects.toThrow(/QR code or short code/)
    expect(() => w.phone('Pixel 8', { partner: '  ' })).toThrow(/partner name/)
    expect(() => w.host.createOffer({ partner: '' })).toThrow(/partner name/)
  })

  it('a partner phone never introduces devices, whatever rights the person picks', async () => {
    const w = await world({ accountId: 'acct-1' })
    const phone = w.phone('Pixel 8', { partner: 'Example Phone' })
    const offer = w.host.createOffer({ partner: 'Example Phone' })
    offer.onAttempt((a) => {
      expect(a.partner).toBe('Example Phone')
      void a.sas.then(() => a.confirm({ request: true, approve: true, introduce: true }))
    })
    const flow = await phone.client.pair(offer.link)
    await flow.sas
    flow.confirm()
    expect((await flow.result).ok).toBe(true)
    await flush()
    const [device] = await w.host.devices()
    expect(device?.rights).toEqual({ request: true, approve: true, introduce: false, send: false })
    expect(device?.accountLinked).toBe(false)
  })

  it('answers mimir only with the approve right, and registers only its own partner push', async () => {
    const fp = fakePush()
    const w = await world({ services: { push: fp.push } })
    const phone = w.phone('Pixel 8', { partner: 'Example Phone' })
    await pairByLink(w, phone, w.host.createOffer({ partner: 'Example Phone' }))
    const [host] = await phone.client.hosts()
    const pairingId = host?.pairingId ?? ''
    let conn = await phone.client.connect(pairingId)
    await expect(conn.mimirQuestions()).rejects.toMatchObject({ code: 'forbidden' })
    await expect(conn.mimirAnswer({ sessionId: 's', askId: 'a' }, null)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(conn.push.registerPartner({ provider: 'apns', token: 'ab'.repeat(32), platform: 'ios', prefs: PREFS })).rejects.toMatchObject({ code: 'bad_request' })
    await conn.push.registerPartner({ provider: 'expo', token: 'ExponentPushToken[partnerpartner01]', platform: 'ios', prefs: PREFS })
    expect(fp.calls.at(-1)).toEqual({ method: 'registerPartner', reg: expect.objectContaining({ provider: 'expo', tag: pairingId, partner: 'Example Phone', approvals: false }) })
    await conn.push.unregisterPartner()
    expect(fp.calls.at(-1)).toEqual({ method: 'unregister', reg: { tag: pairingId } })
    conn.close()

    // The person turns the approve right on in Devices; the hub hears it for approval alerts.
    await w.host.setRights(pairingId, { request: true, approve: true, introduce: false })
    expect(fp.calls.at(-1)).toEqual({ method: 'partnerApprovals', reg: { tag: pairingId, approvals: true } })
    conn = await phone.client.connect(pairingId)
    expect(conn.info.rights.approve).toBe(true)
    await expect(conn.mimirQuestions()).rejects.toMatchObject({ code: 'not_supported' })
    conn.close()

    // Our own phone has no partner push.
    const own = w.phone('iPhone')
    await pairByLink(w, own)
    const ownHost = (await own.client.hosts())[0]
    const c = await own.client.connect(ownHost?.pairingId ?? '')
    await expect(c.push.registerPartner({ provider: 'expo', token: 'ExponentPushToken[ownphoneownphone]', platform: 'ios', prefs: PREFS })).rejects.toMatchObject({ code: 'forbidden' })
    c.close()

    // Revoked: the hub drops its push registration.
    await w.host.revoke(pairingId)
    expect(fp.calls.at(-1)).toEqual({ method: 'unregister', reg: { tag: pairingId } })
    await expect(phone.client.connect(pairingId)).rejects.toThrow()
  })

  it('sees printers and asks to pause or stop by default; sending prints and the library need their own opt-in', async () => {
    const w = await world()
    const phone = w.phone('Pixel 8', { partner: 'Example Phone' })
    await pairByLink(w, phone, w.host.createOffer({ partner: 'Example Phone' }))
    const [host] = await phone.client.hosts()
    const pairingId = host?.pairingId ?? ''
    let conn = await phone.client.connect(pairingId)
    expect((await conn.printers()).length).toBeGreaterThan(0)
    const printerId = (await conn.printers())[0]?.id ?? ''
    await expect(conn.library()).rejects.toMatchObject({ code: 'forbidden' })
    await expect(conn.slice({ source: { kind: 'library', id: 'lib-1' }, where: 'host' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(conn.startFile('AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(conn.uploadModel({ name: 'part.stl', kind: 'stl', data: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(conn.control(printerId, 'resume')).rejects.toMatchObject({ code: 'forbidden' })
    const asked = await conn.control(printerId, 'pause')
    expect(asked.requestId).toBeTruthy()
    conn.close()

    await w.host.setRights(pairingId, { request: true, approve: false, introduce: true, send: true })
    const [d] = await w.host.devices()
    expect(d?.rights).toEqual({ request: true, approve: false, introduce: false, send: true })
    conn = await phone.client.connect(pairingId)
    expect(await conn.library()).toEqual([{ id: 'lib-1', name: 'Cable clip', kind: 'model' }])
    conn.close()

    // Our own phone has no send right to set; request covers it.
    const own = w.phone('iPhone')
    await pairByLink(w, own)
    const ownConn = await own.client.connect((await own.client.hosts())[0]?.pairingId ?? '')
    expect((await ownConn.library()).length).toBe(1)
    ownConn.close()
  })

  it('approves a print our phone sent, as our phone would, but never one any partner app sent', async () => {
    const w = await world()
    const opened = async (name: string, partner?: string) => {
      const phone = w.phone(name, partner === undefined ? {} : { partner })
      await pairByLink(w, phone, partner === undefined ? undefined : w.host.createOffer({ partner }))
      const pairingId = (await phone.client.hosts())[0]?.pairingId ?? ''
      if (partner !== undefined) await w.host.setRights(pairingId, { request: true, approve: true, introduce: false, send: true })
      return phone.client.connect(pairingId)
    }
    const conn = await opened('Pixel 8', 'Example Phone')
    // Another phone of the same app, under the same name spelled otherwise.
    const twin = await opened('Pixel 9', 'example  phone')
    const own = await opened('iPhone')
    // A phone of another partner app, under another name.
    const stranger = await opened('Galaxy', 'Other App')
    const gcode = new TextEncoder().encode('G28\n')

    // Its own app's print: refused for it and for the other phone of that app. Either may deny it.
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: gcode, stats: { timeS: 60 } })
    const { requestId } = await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    for (const c of [conn, twin]) {
      const view = (await c.approvals()).find((v) => v.request.id === requestId)
      if (!view) throw new Error('no card')
      await expect(c.approve(view)).rejects.toMatchObject({ code: 'forbidden' })
    }
    expect((await w.sim.status('bay-2')).state).toBe('idle')

    // Another partner app's print, whatever its name: refused too.
    const theirs = await stranger.uploadSlice({ name: 'theirs.gcode', kind: 'gcode', data: gcode, stats: { timeS: 60 } })
    const asked = await stranger.send({ sliceId: theirs.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    const strangers = (await conn.approvals()).find((v) => v.request.id === asked.requestId)
    if (!strangers) throw new Error('no card')
    await expect(conn.approve(strangers)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await w.sim.status('bay-2')).state).toBe('idle')

    // Our phone's print: the partner phone approves it.
    const ours = await own.uploadSlice({ name: 'bracket.gcode', kind: 'gcode', data: gcode, stats: { timeS: 60 } })
    const sent = await own.send({ sliceId: ours.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    const view = (await conn.approvals()).find((v) => v.request.id === sent.requestId)
    if (!view) throw new Error('no card')
    await conn.approve(view)
    for (let i = 0; i < 200 && (await w.sim.status('bay-2')).state === 'idle'; i++) await flush(2)
    expect((await w.sim.status('bay-2')).state).not.toBe('idle')

    const mine = (await twin.approvals()).find((v) => v.request.id === requestId)
    if (!mine) throw new Error('no card')
    await twin.deny(mine)
    expect(w.host.audit()).toMatchObject([
      { requestId: sent.requestId, decision: 'approve', deviceName: 'Pixel 8' },
      { requestId, decision: 'deny', deviceName: 'Pixel 9' },
    ])
    for (const c of [conn, twin, own, stranger]) c.close()
  })

  it('asks to pause a print but never approves its own pause; it may deny it', async () => {
    const w = await world()
    const phone = w.phone('Pixel 8', { partner: 'Example Phone' })
    await pairByLink(w, phone, w.host.createOffer({ partner: 'Example Phone' }))
    const pairingId = (await phone.client.hosts())[0]?.pairingId ?? ''
    await w.host.setRights(pairingId, { request: true, approve: true, introduce: false, send: false })
    const conn = await phone.client.connect(pairingId)
    const printerId = (await conn.printers())[0]?.id ?? ''
    const asked = await conn.control(printerId, 'pause')
    const view = (await conn.approvals()).find((v) => v.request.id === asked.requestId)
    if (!view) throw new Error('no card')
    await expect(conn.approve(view)).rejects.toMatchObject({ code: 'forbidden' })
    await conn.deny(view)
    expect(w.host.audit()).toMatchObject([{ requestId: asked.requestId, decision: 'deny' }])
    conn.close()
  })

  it('never approves a card that names no action, since it cannot tell what it grants; it may deny one', async () => {
    const w = await world()
    const phone = w.phone('Pixel 8', { partner: 'Example Phone' })
    await pairByLink(w, phone, w.host.createOffer({ partner: 'Example Phone' }))
    const pairingId = (await phone.client.hosts())[0]?.pairingId ?? ''
    await w.host.setRights(pairingId, { request: true, approve: true, introduce: false, send: false })
    const conn = await phone.client.connect(pairingId)
    w.feed.push({
      id: 'pilot-1',
      sessionId: 's1',
      tool: 'start_print',
      permission: 'start',
      title: 'Start Bracket on Bay 2',
      lines: ['PETG, 0.2 mm'],
      paramsHash: '0'.repeat(64),
      actions: [],
      expiresAt: new Date(w.env.now() + 60_000).toISOString(),
    })
    const view = (await conn.approvals()).find((v) => v.request.id === 'pilot-1')
    if (!view) throw new Error('no card')
    await expect(conn.approve(view)).rejects.toMatchObject({ code: 'forbidden' })
    expect(w.feed.decisions).toEqual([])
    await conn.deny(view)
    expect(w.feed.decisions).toMatchObject([{ requestId: 'pilot-1', decision: { kind: 'deny' } }])
    conn.close()
  })

  it('never approves a card when it is not known who asked for it; our phone still may', async () => {
    const w = await world()
    const phone = w.phone('Pixel 8', { partner: 'Example Phone' })
    await pairByLink(w, phone, w.host.createOffer({ partner: 'Example Phone' }))
    const pairingId = (await phone.client.hosts())[0]?.pairingId ?? ''
    await w.host.setRights(pairingId, { request: true, approve: true, introduce: false, send: false })
    const ours = w.phone('Pixel 9')
    await pairByLink(w, ours, w.host.createOffer())
    const ourId = (await ours.client.hosts())[0]?.pairingId ?? ''
    await w.host.setRights(ourId, { request: true, approve: true, introduce: false, send: false })
    // A card from the computer's own feed names its action but carries no record of who raised it.
    const card = (id: string) => ({
      id,
      sessionId: 's1',
      tool: 'pause_print',
      permission: 'start' as const,
      title: 'Pause the print on Bay 2',
      lines: [],
      paramsHash: '0'.repeat(64),
      actions: [{ action: 'printer.pause' as const, target: 'bay-2', paramsHash: '1'.repeat(64) }],
      expiresAt: new Date(w.env.now() + 60_000).toISOString(),
    })
    w.feed.push(card('feed-1'))
    const conn = await phone.client.connect(pairingId)
    const view = (await conn.approvals()).find((v) => v.request.id === 'feed-1')
    if (!view) throw new Error('no card')
    await expect(conn.approve(view)).rejects.toMatchObject({ code: 'forbidden' })
    expect(w.feed.decisions).toEqual([])
    const mine = await ours.client.connect(ourId)
    const ourView = (await mine.approvals()).find((v) => v.request.id === 'feed-1')
    if (!ourView) throw new Error('no card for our phone')
    await mine.approve(ourView)
    expect(w.feed.decisions).toMatchObject([{ requestId: 'feed-1', decision: { kind: 'approve' } }])
    conn.close()
    mine.close()
  })

  it('keeps at most 8 partner phones on one host', async () => {
    const w = await world()
    for (let i = 0; i < 8; i++) {
      const r = await pairByLink(w, w.phone(`Phone ${i}`, { partner: 'Example Phone' }), w.host.createOffer({ partner: 'Example Phone' }))
      expect(r.hostResult.ok).toBe(true)
    }
    expect(() => w.host.createOffer({ partner: 'Example Phone' })).toThrow(/at most 8 partner phones/)
    // Our own phones are not counted.
    expect((await pairByLink(w, w.phone('iPhone'))).hostResult.ok).toBe(true)
  })
})
