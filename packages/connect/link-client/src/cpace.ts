// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// CPace, the balanced PAKE of draft-irtf-cfrg-cpace (CPACE-RISTR255-SHA512), and the code pairing
// with sx-link built on it.
//
// Both sides derive a generator from the pairing code, send Y = y * G and compute K = y * Y_peer.
// Someone without the code learns nothing they can test offline: each run gives them one guess.
// The group operations are @noble/curves' ristretto255 (element derivation, encoding, scalar
// multiplication); this file only lays out the draft's hash inputs, and the tests check it
// against the draft's own vectors. The Rust twin is packages/connect/cpace.
//
//   client -> hub  hello   { nonce }                                  hub signs it (index.ts checkHub)
//   client -> hub  pair    { pake: Ya }
//   hub -> client          { pake: { app: Yb, agent: Yb, watch: Yb } } one per code the hub holds
//   client -> hub  pair    { confirm: { app: t, agent: t, watch: t } } t = HMAC(ISK, client label)
//   hub -> client          { paired, role, confirm: HMAC(ISK, hub label) }
//
//   G   = generator(code, CI = lv(PAIR_V2, hubKey, port), sid = lv(clientNonce, hubNonce))
//   ISK = SHA-512(lv(DSI_ISK, sid, K) || lv(Ya, "client") || lv(Yb, role))
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'
import { bytesToNumberLE } from '@noble/curves/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'

const enc = new TextEncoder()
export const DSI = enc.encode('CPaceRistretto255')
const DSI_ISK = enc.encode('CPaceRistretto255_ISK')
/** SHA-512's input block size, which the generator string pads to. */
const S_IN_BYTES = 128

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** `prepend_len`: the length as LEB128, then the bytes. */
export function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = []
  let n = data.length
  do {
    const low = n & 0x7f
    n >>>= 7
    len.push(n === 0 ? low : low | 0x80)
  } while (n !== 0)
  return cat(new Uint8Array(len), data)
}

/** `lv_cat`: each part with its length in front. */
export const lvCat = (...parts: Uint8Array[]): Uint8Array => cat(...parts.map(prependLen))

/** `generator_string(DSI, PRS, CI, sid, 128)`. */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length)
  return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid)
}

type Point = InstanceType<typeof ristretto255.Point>

/** `calculate_generator`: SHA-512 of the generator string, mapped with ristretto255's element derivation. */
export const generator = (prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Point => ristretto255_hasher.deriveToCurve!(sha512(generatorString(prs, ci, sid)))

/** `sample_scalar` from 32 random bytes: bits above the group's 252 are cleared, so it is below the order. */
export function scalar(random: Uint8Array): bigint {
  const b = Uint8Array.from(random)
  b[31] = (b[31] ?? 0) & 0x0f
  const y = bytesToNumberLE(b)
  // A bigint cannot be wiped in JavaScript; the bytes it came from can.
  b.fill(0)
  return y
}

/** `Y = encode(y * G)`, the message each side sends. */
export const share = (y: bigint, g: Point): Uint8Array => g.multiply(y).toBytes()

/** `K = scalar_mult_vfy(y, Y_peer)`. Null when the message does not decode or K is the identity (abort). */
export function secret(y: bigint, peer: Uint8Array): Uint8Array | null {
  let p: Point
  try {
    p = ristretto255.Point.fromBytes(peer)
  } catch {
    return null
  }
  const k = p.multiply(y)
  return k.is0() ? null : k.toBytes()
}

/** The intermediate session key, initiator and responder order. */
export const iskIr = (sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array =>
  sha512(cat(lvCat(DSI_ISK, sid, k), lvCat(ya, ada), lvCat(yb, adb)))

// ---------------------------------------------------------------------------
// Pairing with sx-link

export const PAIR_V2 = enc.encode('sx-link pair v2')
export const PAKE_ROLES = ['app', 'agent', 'watch'] as const
export type PakeRole = (typeof PAKE_ROLES)[number]
const CLIENT_AD = enc.encode('client')

/** The code as the hub normalizes it: letters and digits, upper case. */
export const normalizeCode = (code: string): Uint8Array => enc.encode(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase())

/** What one pairing's CPace run is bound to: the hub's key and port from its signed hello, and both nonces. */
export interface PakeContext {
  hubKey: Uint8Array
  port: number
  clientNonce: Uint8Array
  hubNonce: Uint8Array
}

const channel = (c: PakeContext) => lvCat(PAIR_V2, c.hubKey, new Uint8Array([(c.port >> 8) & 0xff, c.port & 0xff]))
const sessionId = (c: PakeContext) => lvCat(c.clientNonce, c.hubNonce)
const tag = (isk: Uint8Array, side: 'client' | 'hub') => hmac(sha256, isk, enc.encode(`sx-link pair v2 ${side}`))

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return d === 0
}

/** The client's side of one run. `random` is 32 fresh random bytes. */
export function pakeStart(code: string, ctx: PakeContext, random: Uint8Array) {
  const y = scalar(random)
  const ya = share(y, generator(normalizeCode(code), channel(ctx), sessionId(ctx)))
  let isks: Partial<Record<PakeRole, Uint8Array>> = {}
  return {
    ya,
    /** Takes the hub's messages and returns the confirm tags to send. Null when a message is invalid. */
    respond(yb: Partial<Record<string, Uint8Array>>): Record<PakeRole, Uint8Array> | null {
      const out: Partial<Record<PakeRole, Uint8Array>> = {}
      isks = {}
      for (const role of PAKE_ROLES) {
        const m = yb[role]
        const k = m ? secret(y, m) : null
        if (!m || !k) return null
        const isk = iskIr(sessionId(ctx), k, ya, CLIENT_AD, m, enc.encode(role))
        isks[role] = isk
        out[role] = tag(isk, 'client')
      }
      return out as Record<PakeRole, Uint8Array>
    },
    /** Whether the hub's confirm proves it ran the exchange with the same code. Every key is checked. */
    hubConfirmed(t: Uint8Array): boolean {
      let ok = false
      for (const r of PAKE_ROLES) {
        const isk = isks[r]
        if (isk !== undefined && equal(t, tag(isk, 'hub'))) ok = true
      }
      return ok
    },
    /** Wipes the session keys once the run is over. */
    wipe(): void {
      for (const r of PAKE_ROLES) isks[r]?.fill(0)
    },
  }
}

/** The hub's side of one run, for tests and tools that stand in for sx-link. `random` gives 32 bytes per call. */
export function pakeAnswer(codes: Partial<Record<PakeRole, string>>, ctx: PakeContext, ya: Uint8Array, random: () => Uint8Array) {
  const yb: Partial<Record<PakeRole, Uint8Array>> = {}
  const isks: Partial<Record<PakeRole, Uint8Array>> = {}
  for (const role of PAKE_ROLES) {
    const code = codes[role]
    if (code === undefined) continue
    const y = scalar(random())
    const m = share(y, generator(normalizeCode(code), channel(ctx), sessionId(ctx)))
    const k = secret(y, ya)
    if (!k) return null
    yb[role] = m
    isks[role] = iskIr(sessionId(ctx), k, ya, CLIENT_AD, m, enc.encode(role))
  }
  return {
    yb,
    /** The role whose client tag verifies, with the hub's confirm, or null for a wrong code. */
    check(tags: Partial<Record<string, Uint8Array>>): { role: PakeRole; confirm: Uint8Array } | null {
      for (const role of PAKE_ROLES) {
        const isk = isks[role]
        const t = tags[role]
        if (isk && t && equal(t, tag(isk, 'client'))) return { role, confirm: tag(isk, 'hub') }
      }
      return null
    },
  }
}
