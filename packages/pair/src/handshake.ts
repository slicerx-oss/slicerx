// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pairing handshake: X25519 with a commit-then-reveal short authentication string.
//
//   joiner -> offerer  hello     { o, eJ, c = H(o, eJ, nJ), mac }
//   offerer -> joiner  challenge { o, eO, nO, mac }
//   joiner -> offerer  reveal    { o, nJ }                      offerer checks c
//   both               SAS = 6 digits of H(transcript), shown on both screens
//   joiner -> offerer  confirm   AEAD(kJ, identity, sig)        after the joiner's person confirms
//   offerer -> joiner  confirm   AEAD(kO, identity, sig, ...)   after the offerer's person confirms
//
// The joiner commits to its nonce before it sees the offerer's, and the offerer reveals its
// nonce before it sees the joiner's, so a party in the middle matches both screens with odds of
// one in a million per attempt. The MACs prove knowledge of the QR secret or the short code.
import { equalBytes, frame, fromB64url, fromUtf8, toB64url, utf8 } from './bytes'
import { dh, dhKeyPair, kdf, mac, open, sasDigits, seal, sha256, sign, verifySig, type KeyPair, type PairEnv } from './crypto'
import type { DeviceIdentity } from './identity'
import { offerProofKey, type OfferInfo } from './offer'
import {
  JoinerConfirm,
  OffererConfirm,
  parseFrame,
  type AbortReason,
  type DevicePlatform,
  type FrameOf,
  type PublicIdentity,
} from './schema'
import type { Pipe } from './transport'

export interface HandshakeKeys {
  transcript: Uint8Array
  sas: string
  pairingId: string
  deviceKey: Uint8Array
  joinerKey: Uint8Array
  offererKey: Uint8Array
}

function deriveKeys(offerId: Uint8Array, eJ: Uint8Array, commit: Uint8Array, eO: Uint8Array, nO: Uint8Array, nJ: Uint8Array, shared: Uint8Array): HandshakeKeys {
  const transcript = sha256(frame('transcript', offerId, eJ, commit, eO, nO, nJ))
  const okm = kdf(shared, transcript, 'pair keys', 96)
  return {
    transcript,
    sas: sasDigits(kdf(transcript, undefined, 'sas', 5)),
    pairingId: toB64url(kdf(transcript, undefined, 'pairing id', 16)),
    joinerKey: okm.slice(0, 32),
    offererKey: okm.slice(32, 64),
    deviceKey: okm.slice(64, 96),
  }
}

const commitTo = (offerId: Uint8Array, eJ: Uint8Array, nJ: Uint8Array) => sha256(frame('commit', offerId, eJ, nJ))

const CONFIRM_JOINER = 1
const CONFIRM_OFFERER = 2

// ---------------------------------------------------------------------------
// Joiner steps

export interface JoinerCtx {
  offer: OfferInfo
  eph: KeyPair
  nonce: Uint8Array
  commit: Uint8Array
  proofKey: Uint8Array
}

/**
 * `announce` puts the device name in the plaintext hello. Only account join requests do that,
 * since the reviewer needs a name before any keys exist; QR and code pairings keep the name inside
 * the encrypted confirm, away from the relay.
 */
export function startJoin(env: PairEnv, offer: OfferInfo, announce?: { name: string; platform: DevicePlatform }): { ctx: JoinerCtx; hello: FrameOf<'hello'> } {
  const eph = dhKeyPair(env)
  const nonce = env.random(32)
  const commit = commitTo(offer.offerId, eph.publicKey, nonce)
  const proofKey = offerProofKey(offer)
  const o = toB64url(offer.offerId)
  const m = mac(proofKey, 'hello', offer.offerId, eph.publicKey, commit, announce?.name ?? '', announce?.platform ?? '')
  return {
    ctx: { offer, eph, nonce, commit, proofKey },
    hello: { k: 'hello', v: 1, o, e: toB64url(eph.publicKey), c: toB64url(commit), m: toB64url(m), ...(announce ? { name: announce.name, platform: announce.platform } : {}) },
  }
}

export type StepResult<T> = ({ ok: true } & T) | { ok: false; reason: AbortReason }

export function joinerOnChallenge(ctx: JoinerCtx, ch: FrameOf<'challenge'>): StepResult<{ reveal: FrameOf<'reveal'>; keys: HandshakeKeys }> {
  const eO = fromB64url(ch.e)
  const nO = fromB64url(ch.n)
  const m = fromB64url(ch.m)
  if (!eO || !nO || !m) return { ok: false, reason: 'protocol' }
  if (ctx.offer.offererKey && !equalBytes(eO, ctx.offer.offererKey)) return { ok: false, reason: 'bad_proof' }
  const expect = mac(ctx.proofKey, 'challenge', ctx.offer.offerId, ctx.eph.publicKey, ctx.commit, eO, nO)
  if (!equalBytes(m, expect)) return { ok: false, reason: 'bad_proof' }
  let shared: Uint8Array
  try {
    shared = dh(ctx.eph.secretKey, eO)
  } catch {
    return { ok: false, reason: 'protocol' }
  }
  const keys = deriveKeys(ctx.offer.offerId, ctx.eph.publicKey, ctx.commit, eO, nO, ctx.nonce, shared)
  return { ok: true, keys, reveal: { k: 'reveal', o: toB64url(ctx.offer.offerId), n: toB64url(ctx.nonce) } }
}

// ---------------------------------------------------------------------------
// Offerer steps

export interface OffererState {
  offerId: Uint8Array
  secret: Uint8Array | null
  eph: KeyPair
  expiresAt: number
  /** Wrong proofs seen. The offer burns at MAX_PROOF_FAILURES. */
  failures: number
  /** Set by the first hello with a valid proof: an offer serves one joiner. */
  consumed: boolean
}

export const MAX_PROOF_FAILURES = 5

export function createOffererState(env: PairEnv, secret: Uint8Array | null, offerId: Uint8Array, ttlMs: number): OffererState {
  return { offerId, secret, eph: dhKeyPair(env), expiresAt: env.now() + ttlMs, failures: 0, consumed: false }
}

export interface OffererCtx {
  st: OffererState
  eJ: Uint8Array
  commit: Uint8Array
  nonce: Uint8Array
  joinerName?: string
  joinerPlatform?: DevicePlatform
}

export function offererOnHello(env: PairEnv, st: OffererState, hello: FrameOf<'hello'>): StepResult<{ ctx: OffererCtx; challenge: FrameOf<'challenge'> }> {
  if (env.now() > st.expiresAt || st.failures >= MAX_PROOF_FAILURES) return { ok: false, reason: 'expired' }
  if (st.consumed) return { ok: false, reason: 'busy' }
  const o = fromB64url(hello.o)
  const eJ = fromB64url(hello.e)
  const commit = fromB64url(hello.c)
  const m = fromB64url(hello.m)
  if (!o || !eJ || !commit || !m || !equalBytes(o, st.offerId)) return { ok: false, reason: 'protocol' }
  const proofKey = offerProofKey({ offerId: st.offerId, secret: st.secret })
  if (!equalBytes(m, mac(proofKey, 'hello', o, eJ, commit, hello.name ?? '', hello.platform ?? ''))) {
    st.failures += 1
    return { ok: false, reason: 'bad_proof' }
  }
  st.consumed = true
  const nonce = env.random(32)
  const cm = mac(proofKey, 'challenge', o, eJ, commit, st.eph.publicKey, nonce)
  return {
    ok: true,
    ctx: {
      st,
      eJ,
      commit,
      nonce,
      ...(hello.name ? { joinerName: hello.name } : {}),
      ...(hello.platform ? { joinerPlatform: hello.platform } : {}),
    },
    challenge: { k: 'challenge', o: hello.o, e: toB64url(st.eph.publicKey), n: toB64url(nonce), m: toB64url(cm) },
  }
}

export function offererOnReveal(ctx: OffererCtx, reveal: FrameOf<'reveal'>): StepResult<{ keys: HandshakeKeys }> {
  const nJ = fromB64url(reveal.n)
  if (!nJ || !equalBytes(commitTo(ctx.st.offerId, ctx.eJ, nJ), ctx.commit)) return { ok: false, reason: 'bad_proof' }
  let shared: Uint8Array
  try {
    shared = dh(ctx.st.eph.secretKey, ctx.eJ)
  } catch {
    return { ok: false, reason: 'protocol' }
  }
  return { ok: true, keys: deriveKeys(ctx.st.offerId, ctx.eJ, ctx.commit, ctx.st.eph.publicKey, ctx.nonce, nJ, shared) }
}

// ---------------------------------------------------------------------------
// Confirm payloads

function sealConfirm(keys: HandshakeKeys, joiner: boolean, offerId: Uint8Array, payload: object): FrameOf<'confirm'> {
  const key = joiner ? keys.joinerKey : keys.offererKey
  const x = seal(key, joiner ? CONFIRM_JOINER : CONFIRM_OFFERER, 0, keys.transcript, utf8(JSON.stringify(payload)))
  return { k: 'confirm', o: toB64url(offerId), x: toB64url(x) }
}

function openConfirm(keys: HandshakeKeys, fromJoiner: boolean, f: FrameOf<'confirm'>): unknown {
  const x = fromB64url(f.x)
  if (!x) return null
  const key = fromJoiner ? keys.joinerKey : keys.offererKey
  const pt = open(key, fromJoiner ? CONFIRM_JOINER : CONFIRM_OFFERER, 0, keys.transcript, x)
  if (!pt) return null
  try {
    return JSON.parse(fromUtf8(pt))
  } catch {
    return null
  }
}

/** The identity signs the transcript, which binds its long-term keys to this one pairing. */
function identityProof(identity: DeviceIdentity, keys: HandshakeKeys, joiner: boolean): string {
  return toB64url(sign(identity.signSecret, joiner ? 'pair joiner' : 'pair offerer', keys.transcript))
}

function identityValid(id: PublicIdentity, sig: string, keys: HandshakeKeys, joiner: boolean): boolean {
  const pub = fromB64url(id.signPub)
  const s = fromB64url(sig)
  if (!pub || !s) return false
  return verifySig(pub, joiner ? 'pair joiner' : 'pair offerer', keys.transcript, s) && id.deviceId === toB64url(sha256(pub).slice(0, 16))
}

export function sealJoinerConfirm(ctx: JoinerCtx, keys: HandshakeKeys, identity: DeviceIdentity, accountId?: string): FrameOf<'confirm'> {
  const payload: JoinerConfirm = { identity: identity.public, sig: identityProof(identity, keys, true), ...(accountId ? { accountId } : {}) }
  return sealConfirm(keys, true, ctx.offer.offerId, payload)
}

export function openJoinerConfirm(keys: HandshakeKeys, f: FrameOf<'confirm'>): JoinerConfirm | null {
  const r = JoinerConfirm.safeParse(openConfirm(keys, true, f))
  return r.success && identityValid(r.data.identity, r.data.sig, keys, true) ? r.data : null
}

export function sealOffererConfirm(ctx: OffererCtx, keys: HandshakeKeys, identity: DeviceIdentity, rest: Omit<OffererConfirm, 'identity' | 'sig'>): FrameOf<'confirm'> {
  const payload: OffererConfirm = { identity: identity.public, sig: identityProof(identity, keys, false), ...rest }
  return sealConfirm(keys, false, ctx.st.offerId, payload)
}

export function openOffererConfirm(keys: HandshakeKeys, f: FrameOf<'confirm'>): OffererConfirm | null {
  const r = OffererConfirm.safeParse(openConfirm(keys, false, f))
  return r.success && identityValid(r.data.identity, r.data.sig, keys, false) ? r.data : null
}

// ---------------------------------------------------------------------------
// Drivers over a pipe

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export type HandshakeFailure = AbortReason | 'timeout' | 'closed'

export type JoinResult =
  | { ok: true; keys: HandshakeKeys; offerer: OffererConfirm }
  | { ok: false; reason: HandshakeFailure }

export interface JoinAttempt {
  /** Resolves when both sides can show the six digits. */
  sas: Promise<string>
  /** Call when the person says the digits match on both screens. */
  confirm(): void
  /** Call when they do not match, or the person cancels. */
  reject(reason?: 'mismatch' | 'canceled'): void
  result: Promise<JoinResult>
}

export interface JoinParams {
  env: PairEnv
  offer: OfferInfo
  identity: DeviceIdentity
  accountId?: string
  /** Name the device in the plaintext hello (account join requests only). */
  announce?: boolean
  timeoutMs?: number
  /** How long to wait for the challenge. Short for QR and code pairing, where the host answers at once. */
  answerTimeoutMs?: number
}

export function joinOverPipe(pipe: Pipe, p: JoinParams): JoinAttempt {
  const { ctx, hello } = startJoin(p.env, p.offer, p.announce ? { name: p.identity.public.name, platform: p.identity.public.platform } : undefined)
  const o = hello.o
  const sas = deferred<string>()
  const result = deferred<JoinResult>()
  let keys: HandshakeKeys | null = null
  let userConfirmed = false
  let sentConfirm = false
  let done = false

  const finish = (r: JoinResult) => {
    if (done) return
    done = true
    clearTimeout(timer)
    clearTimeout(answerTimer)
    offFrame()
    offClose()
    if (!r.ok) sas.reject(new Error(r.reason))
    result.resolve(r)
  }
  const fail = (reason: HandshakeFailure, tell = true) => {
    if (tell && reason !== 'timeout' && reason !== 'closed') pipe.send(JSON.stringify({ k: 'abort', o, reason }))
    finish({ ok: false, reason })
  }
  const timer = setTimeout(() => fail('timeout', false), p.timeoutMs ?? 3 * 60 * 1000)
  const answerTimer = p.answerTimeoutMs === undefined ? undefined : setTimeout(() => fail('timeout', false), p.answerTimeoutMs)
  // Callers await `result`; the rejection on `sas` is for callers still waiting on digits.
  sas.promise.catch(() => {})

  const trySendConfirm = () => {
    if (keys && userConfirmed && !sentConfirm) {
      sentConfirm = true
      pipe.send(JSON.stringify(sealJoinerConfirm(ctx, keys, p.identity, p.accountId)))
    }
  }

  const offFrame = pipe.onFrame((text) => {
    if (done) return
    const f = parseFrame(text)
    if (!f || !('o' in f) || f.o !== o) return
    if (f.k === 'abort') return finish({ ok: false, reason: f.reason })
    if (f.k === 'challenge' && !keys) {
      clearTimeout(answerTimer)
      const r = joinerOnChallenge(ctx, f)
      if (!r.ok) return fail(r.reason)
      keys = r.keys
      pipe.send(JSON.stringify(r.reveal))
      sas.resolve(keys.sas)
      trySendConfirm()
      return
    }
    if (f.k === 'confirm' && keys && sentConfirm) {
      const c = openOffererConfirm(keys, f)
      if (!c) return fail('bad_proof')
      finish({ ok: true, keys, offerer: c })
    }
  })
  const offClose = pipe.onClose(() => fail('closed', false))

  pipe.send(JSON.stringify(hello))
  return {
    sas: sas.promise,
    confirm() {
      userConfirmed = true
      trySendConfirm()
    },
    reject(reason = 'mismatch') {
      fail(reason)
    },
    result: result.promise,
  }
}

export type OfferResult =
  | { ok: true; keys: HandshakeKeys; joiner: JoinerConfirm }
  | { ok: false; reason: HandshakeFailure }

export interface OfferAttempt {
  joinerName?: string
  joinerPlatform?: DevicePlatform
  sas: Promise<string>
  confirm(): void
  reject(reason?: 'mismatch' | 'canceled'): void
  result: Promise<OfferResult>
}

export interface OfferDriverParams {
  identity: DeviceIdentity
  /** Builds the offerer's confirm once the joiner's identity is known and verified. */
  buildConfirm(joiner: JoinerConfirm, keys: HandshakeKeys): Promise<Omit<OffererConfirm, 'identity' | 'sig'>>
  /** Default 7 minutes: the offer's 5 plus time to compare digits. */
  timeoutMs?: number
}

/**
 * Runs the offerer after `offererOnHello` accepted a hello on this pipe. The offerer's
 * confirm goes out only after both its own person and the joiner confirmed.
 */
export function offerOverPipe(pipe: Pipe, ctx: OffererCtx, challenge: FrameOf<'challenge'>, p: OfferDriverParams): OfferAttempt {
  const o = challenge.o
  const sas = deferred<string>()
  const result = deferred<OfferResult>()
  let keys: HandshakeKeys | null = null
  let joiner: JoinerConfirm | null = null
  let userConfirmed = false
  let sending = false
  let done = false
  sas.promise.catch(() => {})

  const finish = (r: OfferResult) => {
    if (done) return
    done = true
    clearTimeout(timer)
    offFrame()
    offClose()
    if (!r.ok) sas.reject(new Error(r.reason))
    result.resolve(r)
  }
  const fail = (reason: HandshakeFailure, tell = true) => {
    if (tell && reason !== 'timeout' && reason !== 'closed') pipe.send(JSON.stringify({ k: 'abort', o, reason }))
    finish({ ok: false, reason })
  }
  const timer = setTimeout(() => fail('timeout', false), p.timeoutMs ?? 7 * 60 * 1000)

  const tryComplete = async () => {
    if (!keys || !joiner || !userConfirmed || sending || done) return
    sending = true
    const k = keys
    const j = joiner
    try {
      const rest = await p.buildConfirm(j, k)
      if (done) return
      pipe.send(JSON.stringify(sealOffererConfirm(ctx, k, p.identity, rest)))
      finish({ ok: true, keys: k, joiner: j })
    } catch {
      fail('protocol')
    }
  }

  const offFrame = pipe.onFrame((text) => {
    if (done) return
    const f = parseFrame(text)
    if (!f || !('o' in f) || f.o !== o) return
    if (f.k === 'abort') return finish({ ok: false, reason: f.reason })
    if (f.k === 'reveal' && !keys) {
      const r = offererOnReveal(ctx, f)
      if (!r.ok) return fail(r.reason)
      keys = r.keys
      sas.resolve(keys.sas)
      return
    }
    if (f.k === 'confirm' && keys && !joiner) {
      const c = openJoinerConfirm(keys, f)
      if (!c) return fail('bad_proof')
      joiner = c
      void tryComplete()
    }
  })
  const offClose = pipe.onClose(() => fail('closed', false))

  pipe.send(JSON.stringify(challenge))
  return {
    ...(ctx.joinerName ? { joinerName: ctx.joinerName } : {}),
    ...(ctx.joinerPlatform ? { joinerPlatform: ctx.joinerPlatform } : {}),
    sas: sas.promise,
    confirm() {
      userConfirmed = true
      void tryComplete()
    },
    reject(reason = 'mismatch') {
      fail(reason)
    },
    result: result.promise,
  }
}
