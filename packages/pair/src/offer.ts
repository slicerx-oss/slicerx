// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pairing offers: the QR link, the short code for typing, and the keys and relay routes both
// sides derive from them.
import { fromB64url, toB64url, utf8 } from './bytes'
import { kdf, sha256 } from './crypto'
import { cleanLabel } from './identity'
import type { Endpoints } from './schema'

/** Crockford base32: no I, L, O or U, so the code survives being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_DATA = 11

export const OFFER_TTL_MS = 5 * 60 * 1000

/**
 * What the phone needs to start a pairing. `secret` is null only for account join requests,
 * where the relay's account check replaces it.
 */
export interface OfferInfo {
  offerId: Uint8Array
  secret: Uint8Array | null
  /** The offerer's ephemeral key when it came through the QR code, pinned for the handshake. */
  offererKey?: Uint8Array
  hostName?: string
  endpoints: Endpoints
  expiresAt?: number
}

// ---------------------------------------------------------------------------
// Short codes: 11 random symbols (55 bits) and one check symbol, shown as XXXX-XXXX-XXXX.

function checkSymbol(values: number[]): number {
  return values.reduce((sum, v, i) => sum + v * (i + 1), 0) % 31
}

export function createShortCode(random: (n: number) => Uint8Array): string {
  const bytes = random(CODE_DATA)
  const values = Array.from(bytes, (b) => b & 31)
  values.push(checkSymbol(values))
  const s = values.map((v) => ALPHABET.charAt(v)).join('')
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
}

/** Normalizes typed input. Returns null when the length or the check symbol is wrong. */
export function normalizeShortCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (s.length !== CODE_DATA + 1) return null
  const values: number[] = []
  for (const c of s) {
    const v = ALPHABET.indexOf(c)
    if (v < 0) return null
    values.push(v)
  }
  const check = values.pop()
  if (check !== checkSymbol(values)) return null
  return s
}

export function offerFromShortCode(code: string, relay: string | undefined): OfferInfo | null {
  const s = normalizeShortCode(code)
  if (!s) return null
  const b = utf8(s)
  return {
    offerId: kdf(b, undefined, 'code offer id', 16),
    secret: kdf(b, undefined, 'code secret'),
    endpoints: { lan: [], ...(relay ? { relay } : {}) },
  }
}

// ---------------------------------------------------------------------------
// QR links: <base>#v=1&o=..&s=..&k=..&n=..&l=..&r=..&x=..

export const DEFAULT_LINK_BASES = ['slicerx://pair', 'https://slicerx.app/pair'] as const

export function offerLink(base: string, o: Required<Pick<OfferInfo, 'offerId' | 'offererKey' | 'expiresAt'>> & { secret: Uint8Array; hostName: string; endpoints: Endpoints }): string {
  const parts: [string, string][] = [
    ['v', '1'],
    ['o', toB64url(o.offerId)],
    ['s', toB64url(o.secret)],
    ['k', toB64url(o.offererKey)],
    ['n', o.hostName],
    ['x', String(o.expiresAt)],
  ]
  for (const l of o.endpoints.lan) parts.push(['l', l])
  if (o.endpoints.relay) parts.push(['r', o.endpoints.relay])
  return `${base}#${parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}

export interface ParseOptions {
  /** Link prefixes the app accepts. */
  bases?: readonly string[]
  /** Relays the app trusts. A link naming any other relay loses it and falls back to `defaultRelay`. */
  relays: readonly string[]
  defaultRelay?: string
}

export type ParsedInput = { kind: 'link'; offer: OfferInfo } | { kind: 'code'; offer: OfferInfo } | { kind: 'invalid'; reason: string }

/** Accepts a scanned QR link or a typed short code. */
export function parsePairingInput(input: string, opts: ParseOptions): ParsedInput {
  const text = input.trim()
  const hash = text.indexOf('#')
  if (hash < 0) {
    const offer = offerFromShortCode(text, opts.defaultRelay)
    return offer ? { kind: 'code', offer } : { kind: 'invalid', reason: 'Check the code and try again' }
  }
  const base = text.slice(0, hash)
  if (!(opts.bases ?? DEFAULT_LINK_BASES).includes(base)) return { kind: 'invalid', reason: 'This is not a SlicerX pairing code' }
  const fields = new Map<string, string[]>()
  for (const part of text.slice(hash + 1).split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    let value: string
    try {
      value = decodeURIComponent(part.slice(eq + 1))
    } catch {
      return { kind: 'invalid', reason: 'The pairing code is damaged' }
    }
    const key = part.slice(0, eq)
    fields.set(key, [...(fields.get(key) ?? []), value])
  }
  const one = (k: string): string | undefined => fields.get(k)?.[0]
  if (one('v') !== '1') return { kind: 'invalid', reason: 'This pairing code needs a newer app' }
  const offerId = fromB64url(one('o') ?? '')
  const secret = fromB64url(one('s') ?? '')
  const key = fromB64url(one('k') ?? '')
  const expiresAt = Number(one('x'))
  if (offerId?.length !== 16 || secret?.length !== 32 || key?.length !== 32 || !Number.isSafeInteger(expiresAt)) {
    return { kind: 'invalid', reason: 'The pairing code is damaged' }
  }
  const lan = (fields.get('l') ?? []).filter(isLocalUrl).slice(0, 4)
  const named = one('r')
  const relay = named && opts.relays.includes(named) ? named : opts.defaultRelay
  return {
    kind: 'link',
    offer: {
      offerId,
      secret,
      offererKey: key,
      hostName: cleanLabel(one('n') ?? 'SlicerX'),
      endpoints: { lan, ...(relay ? { relay } : {}) },
      expiresAt,
    },
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * True for ws:// or wss:// URLs on the local network: private, loopback and link-local
 * addresses, `.local`, `.lan`, `.home.arpa` and single-label names. The same rule sx-link
 * applies to printers, so a pairing link cannot point the phone at the internet.
 */
export function isLocalUrl(url: string): boolean {
  const m = /^wss?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[A-Za-z0-9._~/-]*)?$/.exec(url)
  const host = m?.[1]
  if (!host) return false
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return false
  if (host.startsWith('[')) {
    const h = host.slice(1, -1).toLowerCase()
    return h === '::1' || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)
  }
  const v4 = IPV4.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (v4.slice(1).some((p) => Number(p) > 255)) return false
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  const h = host.toLowerCase()
  if (/^[0-9.]+$/.test(h)) return false
  return !h.includes('.') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')
}

// ---------------------------------------------------------------------------
// Derived keys and relay routes. Routes are opaque 32 byte capabilities; the relay never
// learns the keys behind them.

/** Key for the hello and challenge MACs. Proves the joiner saw the QR code or typed the code. */
export const offerProofKey = (o: Pick<OfferInfo, 'offerId' | 'secret'>): Uint8Array =>
  o.secret ? kdf(o.secret, o.offerId, 'offer proof') : kdf(o.offerId, undefined, 'open offer proof')

export const offerRoutes = (offerId: Uint8Array) => ({
  offerer: toB64url(kdf(offerId, undefined, 'route offerer')),
  joiner: toB64url(kdf(offerId, undefined, 'route joiner')),
})

export const pairingRoutes = (deviceKey: Uint8Array) => ({
  host: toB64url(kdf(deviceKey, undefined, 'route host')),
  device: toB64url(kdf(deviceKey, undefined, 'route device')),
})

/** Where a host receives first contact from phones a trusted device introduced. */
export const introRoute = (hostSignPub: Uint8Array): string => toB64url(kdf(hostSignPub, undefined, 'route intro'))

/** Account relay routes. The relay checks the account session before it serves them. */
export function accountRoutes(accountId: string, requestId: Uint8Array) {
  const reply = `acct:${accountId}:join:${toB64url(requestId)}`
  return {
    /** Trusted devices listen here for new devices asking to join. */
    join: `acct:${accountId}:join`,
    /** The new device listens here for challenges. */
    reply,
    /** The reviewing device listens here for the rest of its handshake, so two reviewers never cross. */
    reviewer: (offererKey: Uint8Array) => `${reply}:${toB64url(sha256(offererKey).slice(0, 16))}`,
  }
}

export const accountJoinRoute = (accountId: string) => `acct:${accountId}:join`
