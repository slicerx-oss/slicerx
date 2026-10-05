// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { fromB64url, toB64url } from '../src/bytes'
import { createShortCode, isLocalUrl, normalizeShortCode, offerLink, parsePairingInput } from '../src/offer'
import { RELAY, testEnv } from './helpers'

const env = testEnv('offer')

describe('short codes', () => {
  it('round trips and normalizes look-alike letters', () => {
    for (let i = 0; i < 50; i++) {
      const code = createShortCode(env.random)
      expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
      expect(normalizeShortCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''))
    }
    const code = '0000-0000-0000'
    expect(normalizeShortCode('oooo oooo oooo')).toBe(normalizeShortCode(code))
  })

  it('catches every single-symbol typo', () => {
    const code = createShortCode(env.random).replace(/-/g, '')
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let caught = 0
    let total = 0
    for (let i = 0; i < code.length; i++) {
      for (const c of alphabet) {
        if (c === code[i]) continue
        const typo = code.slice(0, i) + c + code.slice(i + 1)
        total++
        if (normalizeShortCode(typo) === null) caught++
      }
    }
    // The check symbol is mod 31 over 32 symbols, so a 0 and Z swap in one place can slip by.
    expect(caught / total).toBeGreaterThan(0.99)
  })

  it('rejects wrong lengths and foreign characters', () => {
    expect(normalizeShortCode('ABCD-EFGH')).toBeNull()
    expect(normalizeShortCode('ABCD-EFGH-JKU!')).toBeNull()
  })
})

describe('pairing links', () => {
  const offerId = env.random(16)
  const secret = env.random(32)
  const key = env.random(32)
  const make = (endpoints: { lan: string[]; relay?: string }, name = 'Studio Mac') =>
    offerLink('slicerx://pair', { offerId, secret, offererKey: key, expiresAt: 123, hostName: name, endpoints })

  it('round trips', () => {
    const r = parsePairingInput(make({ lan: ['ws://192.168.1.20:47616/pair'], relay: RELAY }), { relays: [RELAY] })
    expect(r.kind).toBe('link')
    if (r.kind !== 'link') return
    expect(toB64url(r.offer.offerId)).toBe(toB64url(offerId))
    expect(r.offer.secret && toB64url(r.offer.secret)).toBe(toB64url(secret))
    expect(r.offer.endpoints).toEqual({ lan: ['ws://192.168.1.20:47616/pair'], relay: RELAY })
    expect(r.offer.hostName).toBe('Studio Mac')
  })

  it('drops relays the app does not trust and addresses outside the LAN', () => {
    const r = parsePairingInput(make({ lan: ['ws://203.0.113.9:47616/pair', 'ws://printer-host.local:1/x'], relay: 'wss://evil.example/relay' }), {
      relays: [RELAY],
      defaultRelay: RELAY,
    })
    if (r.kind !== 'link') throw new Error(r.kind)
    expect(r.offer.endpoints).toEqual({ lan: ['ws://printer-host.local:1/x'], relay: RELAY })
  })

  it('refuses other link prefixes and damaged fields', () => {
    const link = make({ lan: [] })
    expect(parsePairingInput(link.replace('slicerx://pair', 'https://evil.example/pair'), { relays: [] }).kind).toBe('invalid')
    expect(parsePairingInput(link.replace(/&s=[^&]+/, '&s=AAAA'), { relays: [] }).kind).toBe('invalid')
    expect(parsePairingInput(link.replace('v=1', 'v=2'), { relays: [] }).kind).toBe('invalid')
  })

  it('strips control characters from the host name', () => {
    const r = parsePairingInput(make({ lan: [] }, 'Mac‮\nx'), { relays: [] })
    if (r.kind !== 'link') throw new Error(r.kind)
    expect(r.offer.hostName).not.toContain('\n')
  })
})

describe('isLocalUrl', () => {
  it.each([
    ['ws://10.0.0.5:47616/pair', true],
    ['ws://172.20.1.1/pair', true],
    ['ws://172.32.1.1/pair', false],
    ['ws://192.168.0.1', true],
    ['ws://169.254.1.1', true],
    ['ws://127.0.0.1:1', true],
    ['ws://8.8.8.8', false],
    ['ws://[fe80::1]:47616/pair', true],
    ['ws://[2001:db8::1]/pair', false],
    ['ws://studio.local/pair', true],
    ['ws://studio/pair', true],
    ['ws://slicerx.app/pair', false],
    ['ws://999.1.1.1', false],
    ['http://192.168.0.1', false],
    ['ws://192.168.0.1:70000', false],
  ])('%s is %s', (url, local) => {
    expect(isLocalUrl(url)).toBe(local)
  })
})

describe('base64url', () => {
  it('has exactly one encoding per byte string', () => {
    const b = env.random(31)
    expect(fromB64url(toB64url(b))).toEqual(b)
    expect(fromB64url('AA')).toEqual(new Uint8Array([0]))
    expect(fromB64url('AB')).toBeNull()
    expect(fromB64url('A')).toBeNull()
    expect(fromB64url('A+')).toBeNull()
  })
})
