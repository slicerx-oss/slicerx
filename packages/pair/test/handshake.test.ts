// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { toB64url } from '../src/bytes'
import {
  createOffererState,
  joinerOnChallenge,
  offererOnHello,
  offererOnReveal,
  startJoin,
} from '../src/handshake'
import { createShortCode, offerFromShortCode, parsePairingInput } from '../src/offer'
import type { HostPairingAttempt } from '../src/host'
import { flush, LAN, pairByLink, RELAY, testEnv, world } from './helpers'

describe('pairing by QR link', () => {
  it('shows the same digits on both screens and stores the pairing on both sides', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    const r = await pairByLink(w, phone)
    expect(r.phoneSas).toMatch(/^\d{3} \d{3}$/)
    expect(r.phoneSas).toBe(r.hostSas)
    expect(r.phoneResult.ok && r.hostResult.ok).toBe(true)
    const [hostSide] = await w.hostStore.list()
    const [phoneSide] = await phone.store.list()
    expect(hostSide?.deviceKey).toBe(phoneSide?.deviceKey)
    expect(hostSide?.peer.signPub).toBe(phone.id.public.signPub)
    expect(phoneSide?.peer.signPub).toBe(w.hostId.public.signPub)
    expect(phoneSide?.endpoints).toEqual({ lan: [LAN], relay: RELAY })
    expect(w.lan.opened).toEqual([LAN])
    const devices = await w.host.devices()
    expect(devices.map((d) => d.name)).toEqual(['Pocket'])
  })

  it('falls back to the relay when the LAN address is not reachable, and the relay never sees the names', async () => {
    const w = await world()
    const phone = w.phone('Pocket', { lan: false })
    const r = await pairByLink(w, phone)
    expect(r.phoneResult.ok).toBe(true)
    const seen = w.relay.log.map((m) => m.body).join('\n')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).not.toContain('Pocket')
    expect(seen).not.toContain('Studio Mac')
    expect(seen).not.toContain(phone.id.public.signPub)
  })

  it('stores nothing when the person says the digits differ', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    const offer = w.host.createOffer()
    const attempts: HostPairingAttempt[] = []
    offer.onAttempt((a) => attempts.push(a))
    const flow = await phone.client.pair(offer.link)
    await flow.sas
    await flush()
    flow.confirm()
    attempts[0]?.reject()
    const [p, h] = await Promise.all([flow.result, attempts[0]?.result])
    expect(p).toEqual({ ok: false, reason: 'mismatch' })
    expect(h?.ok).toBe(false)
    expect(await w.hostStore.list()).toEqual([])
    expect(await phone.store.list()).toEqual([])
  })

  it('serves one phone per offer', async () => {
    const w = await world()
    const offer = w.host.createOffer()
    await pairByLink(w, w.phone('First'), offer)
    const second = await w.phone('Second').client.pair(offer.link)
    expect(await second.result).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a wrong secret and burns the offer after five tries', async () => {
    const w = await world()
    const offer = w.host.createOffer()
    const forged = offer.link.replace(/&s=[^&]+/, `&s=${toB64url(new Uint8Array(32).fill(7))}`)
    for (let i = 0; i < 5; i++) {
      const f = await w.phone(`Guess ${i}`).client.pair(forged)
      expect(await f.result).toEqual({ ok: false, reason: 'bad_proof' })
    }
    const real = await w.phone('Owner').client.pair(offer.link)
    expect(await real.result).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses an expired link on the phone', async () => {
    const w = await world()
    const offer = w.host.createOffer()
    w.env.advance(6 * 60 * 1000)
    await expect(w.phone('Late').client.pair(offer.link)).rejects.toThrow(/expired/)
  })

  it('pins the host key from the QR code', async () => {
    const w = await world()
    const offer = w.host.createOffer()
    const other = toB64url(w.env.random(32))
    const tampered = offer.link.replace(/&k=[^&]+/, `&k=${other}`)
    const f = await w.phone('Pocket').client.pair(tampered)
    expect(await f.result).toEqual({ ok: false, reason: 'bad_proof' })
  })
})

describe('pairing by short code', () => {
  it('pairs through the relay', async () => {
    const w = await world()
    const phone = w.phone('Pocket', { lan: false })
    const offer = w.host.createOffer()
    const attempts: HostPairingAttempt[] = []
    offer.onAttempt((a) => attempts.push(a))
    const flow = await phone.client.pair(offer.code.toLowerCase())
    const sas = await flow.sas
    await flush()
    expect(await attempts[0]?.sas).toBe(sas)
    flow.confirm()
    attempts[0]?.confirm()
    const r = await flow.result
    expect(r.ok).toBe(true)
    expect((await w.host.devices()).length).toBe(1)
  })

  it('a code and the link share one offer', async () => {
    const w = await world()
    const offer = w.host.createOffer()
    await pairByLink(w, w.phone('First'), offer)
    const f = await w.phone('Second', { lan: false }).client.pair(offer.code)
    expect(await f.result).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('protocol properties', () => {
  it('a relay in the middle of a code pairing cannot make the digits match', () => {
    // The attacker knows the code (the worst case) and runs one handshake with each side.
    const env = testEnv('mitm')
    let matches = 0
    for (let run = 0; run < 40; run++) {
      const valid = offerFromShortCode(createShortCode(env.random), RELAY)
      if (!valid?.secret) throw new Error('code')
      const host = createOffererState(env, valid.secret, valid.offerId, 60_000)
      // Phone to attacker (attacker plays the host).
      const phone = startJoin(env, valid)
      const fakeHost = createOffererState(env, valid.secret, valid.offerId, 60_000)
      const a1 = offererOnHello(env, fakeHost, phone.hello)
      if (!a1.ok) throw new Error('a1')
      // Attacker to host (attacker plays the phone).
      const fakePhone = startJoin(env, valid)
      const h1 = offererOnHello(env, host, fakePhone.hello)
      if (!h1.ok) throw new Error('h1')
      const f2 = joinerOnChallenge(fakePhone.ctx, h1.challenge)
      const p2 = joinerOnChallenge(phone.ctx, a1.challenge)
      if (!f2.ok || !p2.ok) throw new Error('challenge')
      const h3 = offererOnReveal(h1.ctx, f2.reveal)
      const a3 = offererOnReveal(a1.ctx, p2.reveal)
      if (!h3.ok || !a3.ok) throw new Error('reveal')
      if (p2.keys.sas === h3.keys.sas) matches++
    }
    expect(matches).toBe(0)
  })

  it('a changed reveal fails the commitment', () => {
    const env = testEnv('commit')
    const code = createShortCode(env.random)
    const o = offerFromShortCode(code, RELAY)
    if (!o?.secret) throw new Error('code')
    const st = createOffererState(env, o.secret, o.offerId, 60_000)
    const j = startJoin(env, o)
    const h = offererOnHello(env, st, j.hello)
    if (!h.ok) throw new Error('hello')
    const c = joinerOnChallenge(j.ctx, h.challenge)
    if (!c.ok) throw new Error('challenge')
    const bad = { ...c.reveal, n: toB64url(env.random(32)) }
    expect(offererOnReveal(h.ctx, bad)).toEqual({ ok: false, reason: 'bad_proof' })
  })

  it('parses a link the host made', async () => {
    const w = await world()
    const offer = w.host.createOffer()
    const parsed = parsePairingInput(offer.link, { relays: [RELAY] })
    expect(parsed.kind).toBe('link')
  })
})
