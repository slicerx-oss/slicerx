// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sessions between paired devices. Each connection runs a fresh X25519 exchange authenticated
// with the device key and the host's static key, so recorded traffic stays sealed even if a device
// key leaks later, and a device key alone cannot answer as the host.
//
//   device -> host  init   { v, s, r, eD, nD, mac(kMac, s, r, eD, nD) }
//   host -> device  accept { v, s, eH, nH, mac(kAcc, init, eH, nH) }
//   sS   = DH(eD, host static)      the key phones pinned at pairing
//   kAcc = HKDF(kMac || sS)
//   keys = HKDF(DH(eD, eH) || deviceKey || sS, H(init, accept))
//   data            { s, c, AEAD(key, nonce = dir || c, aad = s || dir) }
//
// Counters must rise strictly per direction, so replayed or reordered frames are dropped. Both ends
// refuse any version but SESSION_VERSION, so neither can be talked down to the old key schedule.
import { concat, equalBytes, frame, fromB64url, fromUtf8, toB64url, u32be, utf8 } from './bytes'
import { dh, dhKeyPair, kdf, mac, open, seal, sha256, type KeyPair, type PairEnv } from './crypto'
import { pairingRoutes } from './offer'
import { parseFrame, type DeviceGrant, type FrameOf } from './schema'
import type { Pipe } from './transport'

/** Version 2 mixed the host's static key into the key schedule. */
export const SESSION_VERSION = 2
const DIR_DEVICE = 3
const DIR_HOST = 4
/** Largest decrypted message. Upload chunks are the biggest messages and stay well under it. */
export const MAX_MESSAGE_BYTES = 768 * 1024

export interface SecureChannel {
  readonly sid: string
  send(message: unknown): void
  onMessage(cb: (message: unknown) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
  readonly closed: boolean
}

export const macKey = (deviceKey: Uint8Array) => kdf(deviceKey, undefined, 'session mac')

function initMac(k: Uint8Array, f: Pick<FrameOf<'init'>, 's' | 'r' | 'e' | 'n'>): Uint8Array {
  return mac(k, 'init', f.s, f.r, f.e, f.n)
}

/** The accept MAC needs the host's static key as well, so a device key alone cannot forge it. */
const acceptKey = (deviceKey: Uint8Array, staticShared: Uint8Array) => kdf(concat(macKey(deviceKey), staticShared), undefined, 'session accept mac v2')

function acceptMac(k: Uint8Array, init: FrameOf<'init'>, a: Pick<FrameOf<'accept'>, 'e' | 'n'>): Uint8Array {
  return mac(k, 'accept', init.s, init.r, init.e, init.n, a.e, a.n)
}

function sessionKeys(shared: Uint8Array, deviceKey: Uint8Array, staticShared: Uint8Array, init: FrameOf<'init'>, accept: FrameOf<'accept'>) {
  const salt = sha256(frame('session', init.s, init.r, init.e, init.n, accept.e, accept.n))
  const okm = kdf(concat(shared, deviceKey, staticShared), salt, 'session keys v2', 64)
  return { toHost: okm.slice(0, 32), toDevice: okm.slice(32, 64) }
}

interface ChannelKeys {
  sendKey: Uint8Array
  recvKey: Uint8Array
  sendDir: number
  recvDir: number
}

/** The encrypted channel over one session. `deliver` feeds inbound data frames for this sid. */
export function createChannel(sid: string, keys: ChannelKeys, sendFrame: (f: string) => void, onClosed?: () => void) {
  const listeners = new Set<(m: unknown) => void>()
  const closers = new Set<() => void>()
  let sendCounter = 0
  let lastRecv = -1
  let closed = false
  const aad = (dir: number) => frame('data', sid, u32be(dir))

  const channel: SecureChannel & { deliver(f: FrameOf<'data'>): boolean } = {
    sid,
    get closed() {
      return closed
    },
    send(message) {
      if (closed) return
      const pt = utf8(JSON.stringify(message))
      if (pt.length > MAX_MESSAGE_BYTES) throw new Error('Message too large for one frame')
      const c = sendCounter++
      const x = seal(keys.sendKey, keys.sendDir, c, aad(keys.sendDir), pt)
      sendFrame(JSON.stringify({ k: 'data', s: sid, c, x: toB64url(x) }))
    },
    onMessage(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onClose(cb) {
      closers.add(cb)
      return () => closers.delete(cb)
    },
    close() {
      if (closed) return
      closed = true
      onClosed?.()
      for (const cb of [...closers]) cb()
    },
    /** Returns false for frames that fail to decrypt or arrive out of order. */
    deliver(f) {
      if (closed || f.s !== sid || f.c <= lastRecv) return false
      const x = fromB64url(f.x)
      if (!x) return false
      const pt = open(keys.recvKey, keys.recvDir, f.c, aad(keys.recvDir), x)
      if (!pt || pt.length > MAX_MESSAGE_BYTES) return false
      let msg: unknown
      try {
        msg = JSON.parse(fromUtf8(pt))
      } catch {
        return false
      }
      lastRecv = f.c
      for (const cb of [...listeners]) cb(msg)
      return true
    },
  }
  return channel
}

export type HostChannel = ReturnType<typeof createChannel>

// ---------------------------------------------------------------------------
// Device side

export interface OpenSessionParams {
  env: PairEnv
  deviceKey: Uint8Array
  /** The host's static X25519 key (`dhPub`), pinned at pairing. */
  hostDhPub: Uint8Array
  /** Where the host listens. Defaults to the pairing's host route; introductions use the intro route. */
  route?: string
  /** First contact after an introduction. */
  grant?: DeviceGrant
  timeoutMs?: number
}

export class SessionError extends Error {
  constructor(
    readonly code: 'timeout' | 'refused' | 'bad_accept' | 'closed' | 'outdated',
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

export function openSession(pipe: Pipe, p: OpenSessionParams): Promise<SecureChannel> {
  const kMac = macKey(p.deviceKey)
  const eph: KeyPair = dhKeyPair(p.env)
  const sid = toB64url(p.env.random(16))
  const body = { s: sid, r: p.route ?? pairingRoutes(p.deviceKey).host, e: toB64url(eph.publicKey), n: toB64url(p.env.random(16)) }
  const init: FrameOf<'init'> = { k: 'init', v: SESSION_VERSION, ...body, m: toB64url(initMac(kMac, body)), ...(p.grant ? { g: p.grant } : {}) }
  let staticShared: Uint8Array | null
  try {
    staticShared = dh(eph.secretKey, p.hostDhPub)
  } catch {
    staticShared = null
  }

  return new Promise((resolve, reject) => {
    let channel: HostChannel | null = null
    const timer = setTimeout(() => settle(new SessionError('timeout', 'The host did not answer')), p.timeoutMs ?? 10_000)
    const settle = (e: SessionError | null) => {
      clearTimeout(timer)
      if (e) {
        offFrame()
        offClose()
        reject(e)
      }
    }
    const offFrame = pipe.onFrame((text) => {
      const f = parseFrame(text)
      if (!f || !('s' in f) || f.s !== sid) return
      if (channel) {
        if (f.k === 'data') channel.deliver(f)
        return
      }
      if (f.k === 'refuse') {
        if (f.reason === 'update') return settle(new SessionError('outdated', 'The computer runs a newer SlicerX. Update this app to connect.'))
        return settle(new SessionError('refused', f.reason === 'busy' ? 'The host is busy' : 'The host does not know this device'))
      }
      if (f.k !== 'accept') return
      // An older host answers with the old key schedule. Say so rather than fall back to it.
      if (f.v !== SESSION_VERSION) return settle(new SessionError('outdated', 'The computer runs an older SlicerX. Update SlicerX on the computer to connect.'))
      const eH = fromB64url(f.e)
      const m = fromB64url(f.m)
      if (!staticShared) return settle(new SessionError('bad_accept', 'The pairing record holds an invalid host key'))
      if (!eH || !m || !equalBytes(m, acceptMac(acceptKey(p.deviceKey, staticShared), init, f))) return settle(new SessionError('bad_accept', 'The host failed to prove the pairing'))
      let shared: Uint8Array
      try {
        shared = dh(eph.secretKey, eH)
      } catch {
        return settle(new SessionError('bad_accept', 'The host sent an invalid key'))
      }
      const k = sessionKeys(shared, p.deviceKey, staticShared, init, f)
      channel = createChannel(sid, { sendKey: k.toHost, recvKey: k.toDevice, sendDir: DIR_DEVICE, recvDir: DIR_HOST }, (x) => pipe.send(x), () => {
        offFrame()
        offClose()
      })
      settle(null)
      resolve(channel)
    })
    const offClose = pipe.onClose(() => {
      if (channel) channel.close()
      else settle(new SessionError('closed', 'The connection closed'))
    })
    pipe.send(JSON.stringify(init))
  })
}

// ---------------------------------------------------------------------------
// Host side

/** Verifies an init against a device key. Returns null when the MAC does not hold. */
export function verifyInit(init: FrameOf<'init'>, deviceKey: Uint8Array): boolean {
  const m = fromB64url(init.m)
  return m !== null && equalBytes(m, initMac(macKey(deviceKey), init))
}

/** Whether an init speaks this session version. Hosts answer others with `refuse {reason: 'update'}`. */
export const initCurrent = (init: FrameOf<'init'>): boolean => init.v === SESSION_VERSION

/** Answers a verified, current init and returns the host end of the channel. `hostDhSecret` is the host identity's static key. */
export function acceptSession(env: PairEnv, init: FrameOf<'init'>, deviceKey: Uint8Array, hostDhSecret: Uint8Array, sendFrame: (f: string) => void, onClosed?: () => void): HostChannel | null {
  const eD = fromB64url(init.e)
  if (!eD || !initCurrent(init)) return null
  const eph = dhKeyPair(env)
  const body = { e: toB64url(eph.publicKey), n: toB64url(env.random(16)) }
  let shared: Uint8Array
  let staticShared: Uint8Array
  try {
    shared = dh(eph.secretKey, eD)
    staticShared = dh(hostDhSecret, eD)
  } catch {
    return null
  }
  const accept: FrameOf<'accept'> = { k: 'accept', v: SESSION_VERSION, s: init.s, ...body, m: toB64url(acceptMac(acceptKey(deviceKey, staticShared), init, body)) }
  const k = sessionKeys(shared, deviceKey, staticShared, init, accept)
  sendFrame(JSON.stringify(accept))
  return createChannel(init.s, { sendKey: k.toDevice, recvKey: k.toHost, sendDir: DIR_HOST, recvDir: DIR_DEVICE }, sendFrame, onClosed)
}
