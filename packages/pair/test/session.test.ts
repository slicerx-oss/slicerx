// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { fromB64url, toB64url } from '../src/bytes'
import { pairingRoutes } from '../src/offer'
import type { FrameOf } from '../src/schema'
import { dhKeyPair } from '../src/crypto'
import { acceptSession, createChannel, openSession, SESSION_VERSION, verifyInit } from '../src/session'
import { memoryPipePair } from '../src/transport'
import { flush, pairByLink, testEnv, world } from './helpers'

describe('sessions', () => {
  it('connects over the LAN first and reads printers', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    await pairByLink(w, phone)
    const [host] = await phone.client.hosts()
    const conn = await phone.client.connect(host?.pairingId ?? '')
    expect(conn.via).toBe('lan')
    expect(conn.info.identity.name).toBe('Studio Mac')
    expect((await conn.printers()).map((p) => p.id)).toContain('bay-2')
    expect((await conn.fleets()).map((f) => f.name)).toEqual(['Workshop'])
    expect((await conn.status('bay-2')).state).toBe('idle')
    conn.close()
  })

  it('works through the relay, which sees only ciphertext', async () => {
    const w = await world()
    const phone = w.phone('Pocket', { lan: false })
    await pairByLink(w, phone)
    const before = w.relay.log.length
    const [host] = await phone.client.hosts()
    const conn = await phone.client.connect(host?.pairingId ?? '')
    expect(conn.via).toBe('relay')
    await conn.printers()
    await conn.library()
    const seen = w.relay.log
      .slice(before)
      .map((m) => m.body)
      .join('\n')
    for (const secret of ['Bay 2', 'Workshop', 'Cable clip', 'Studio Mac', 'bay-2']) expect(seen).not.toContain(secret)
    conn.close()
  })

  it('refuses a device that does not hold the device key', async () => {
    const env = testEnv('keys')
    const good = env.random(32)
    const bad = env.random(32)
    const hostDh = dhKeyPair(env)
    const [a, b] = memoryPipePair()
    let accepted = false
    b.onFrame((t) => {
      const f = JSON.parse(t) as FrameOf<'init'>
      if (verifyInit(f, good)) accepted = acceptSession(env, f, good, hostDh.secretKey, (x) => b.send(x)) !== null
    })
    await expect(openSession(a, { env, deviceKey: bad, hostDhPub: hostDh.publicKey, route: pairingRoutes(good).host, timeoutMs: 100 })).rejects.toThrow(/did not answer/)
    expect(accepted).toBe(false)
  })

  it('L2: a device key without the host static key cannot answer as the host', async () => {
    const env = testEnv('l2')
    const deviceKey = env.random(32)
    const realHost = dhKeyPair(env)
    const impostor = dhKeyPair(env)
    const [a, b] = memoryPipePair()
    // The impostor holds the device key (say, from a phone backup) but not the host's static key.
    b.onFrame((t) => {
      const f = JSON.parse(t) as FrameOf<'init'>
      if (verifyInit(f, deviceKey)) acceptSession(env, f, deviceKey, impostor.secretKey, (x) => b.send(x))
    })
    await expect(openSession(a, { env, deviceKey, hostDhPub: realHost.publicKey, timeoutMs: 500 })).rejects.toMatchObject({ code: 'bad_accept' })
  })

  it('refuses old versions both ways, with an update message and no fallback', async () => {
    const env = testEnv('versions')
    const deviceKey = env.random(32)
    const hostDh = dhKeyPair(env)
    // A version 1 init (no v) gets no channel from a current host.
    const [a, b] = memoryPipePair()
    let init: FrameOf<'init'> | null = null
    b.onFrame((t) => {
      init = JSON.parse(t) as FrameOf<'init'>
    })
    void openSession(a, { env, deviceKey, hostDhPub: hostDh.publicKey, timeoutMs: 50 }).catch(() => {})
    await flush()
    if (!init) throw new Error('no init')
    const sent: FrameOf<'init'> = init
    expect(sent.v).toBe(SESSION_VERSION)
    const { v: _v, ...old } = sent
    expect(acceptSession(env, old, deviceKey, hostDh.secretKey, () => {})).toBeNull()
    // An old host's accept (no v) is refused as outdated, not tried with the old schedule.
    const [c, d] = memoryPipePair()
    d.onFrame((t) => {
      const f = JSON.parse(t) as FrameOf<'init'>
      d.send(JSON.stringify({ k: 'accept', s: f.s, e: f.e, n: f.n, m: f.m }))
    })
    await expect(openSession(c, { env, deviceKey, hostDhPub: hostDh.publicKey, timeoutMs: 500 })).rejects.toMatchObject({ code: 'outdated', message: /Update SlicerX on the computer/ })
    // A host that refuses with `update` tells the phone to update itself.
    const [e, f] = memoryPipePair()
    f.onFrame((t) => f.send(JSON.stringify({ k: 'refuse', s: (JSON.parse(t) as FrameOf<'init'>).s, reason: 'update' })))
    await expect(openSession(e, { env, deviceKey, hostDhPub: hostDh.publicKey, timeoutMs: 500 })).rejects.toMatchObject({ code: 'outdated', message: /Update this app/ })
  })

  it('the host answers an old phone with refuse update', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    await pairByLink(w, phone)
    const [rec] = await phone.store.list()
    const deviceKey = fromB64url(rec?.deviceKey ?? '')
    const hostDhPub = fromB64url(rec?.peer.dhPub ?? '')
    if (!deviceKey || !hostDhPub) throw new Error('no pairing')
    // Capture a properly MACed init, then send it without its version, as an old phone would.
    const [a, b] = memoryPipePair()
    let init: FrameOf<'init'> | null = null
    b.onFrame((t) => {
      init = JSON.parse(t) as FrameOf<'init'>
    })
    void openSession(a, { env: w.env, deviceKey, hostDhPub, timeoutMs: 50 }).catch(() => {})
    await flush()
    if (!init) throw new Error('no init')
    const { v: _v, ...old }: FrameOf<'init'> = init
    const [c, d] = memoryPipePair()
    w.host.handlePipe(d)
    const got: string[] = []
    c.onFrame((t) => got.push(t))
    c.send(JSON.stringify(old))
    await flush()
    expect(got.map((t) => JSON.parse(t))).toEqual([{ k: 'refuse', s: old.s, reason: 'update' }])
  })

  it('drops replayed, reordered and altered frames', () => {
    const env = testEnv('channel')
    const k1 = env.random(32)
    const k2 = env.random(32)
    const sid = toB64url(env.random(16))
    const sent: string[] = []
    const tx = createChannel(sid, { sendKey: k1, recvKey: k2, sendDir: 3, recvDir: 4 }, (f) => sent.push(f))
    const rx = createChannel(sid, { sendKey: k2, recvKey: k1, sendDir: 4, recvDir: 3 }, () => {})
    const got: unknown[] = []
    rx.onMessage((m) => got.push(m))
    tx.send({ n: 1 })
    tx.send({ n: 2 })
    const [f1, f2] = sent.map((s) => JSON.parse(s) as FrameOf<'data'>)
    if (!f1 || !f2) throw new Error('frames')
    expect(rx.deliver(f2)).toBe(true)
    expect(rx.deliver(f1)).toBe(false)
    expect(rx.deliver(f2)).toBe(false)
    const x = fromB64url(f2.x) ?? new Uint8Array()
    x[0] = (x[0] ?? 0) ^ 1
    expect(rx.deliver({ ...f2, c: 5, x: toB64url(x) })).toBe(false)
    // A frame reflected back at its sender fails too: each direction has its own key.
    expect(tx.deliver({ ...f2, c: 9 })).toBe(false)
    expect(got).toEqual([{ n: 2 }])
  })
})

describe('revocation', () => {
  it('the host revokes: the phone learns it, forgets the host, and cannot reconnect', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    await pairByLink(w, phone)
    const [host] = await phone.client.hosts()
    const id = host?.pairingId ?? ''
    const conn = await phone.client.connect(id)
    let closed = false
    conn.onClose(() => {
      closed = true
    })
    const [device] = await w.host.devices()
    await w.host.revoke(device?.pairingId ?? '')
    await flush()
    expect(closed).toBe(true)
    expect(await phone.client.hosts()).toEqual([])
    expect(await w.host.devices()).toEqual([])
  })

  it('a revoked record cannot open a session', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    await pairByLink(w, phone)
    const saved = await phone.store.list()
    const [device] = await w.host.devices()
    await w.host.revoke(device?.pairingId ?? '')
    for (const r of saved) await phone.store.put(r)
    await expect(phone.client.connect(saved[0]?.pairingId ?? '')).rejects.toThrow()
  })

  it('a removal the computer did not hear stays pending, then reaches it (M1)', async () => {
    const w = await world()
    let down = false
    const phone = w.phone('Pocket', {
      lan: false,
      openRelay: async (accountId) => {
        if (down) throw new Error('offline')
        return w.relay.connect(accountId ? { accountId } : {})
      },
    })
    await pairByLink(w, phone)
    const [host] = await phone.client.hosts()
    const id = host?.pairingId ?? ''
    down = true
    expect(await phone.client.unpair(id)).toEqual({ removedOnHost: false })
    expect((await phone.client.hosts()).map((h) => h.pendingRemoval)).toEqual([true])
    expect(await w.host.devices()).toHaveLength(1)
    await expect(phone.client.connect(id)).rejects.toThrow()
    down = false
    expect(await phone.client.retryRemovals()).toBe(0)
    await flush()
    expect(await phone.client.hosts()).toEqual([])
    expect(await w.host.devices()).toEqual([])
  })

  it('the phone unpairs: both sides forget', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    await pairByLink(w, phone)
    const [host] = await phone.client.hosts()
    await phone.client.unpair(host?.pairingId ?? '')
    await flush()
    expect(await phone.client.hosts()).toEqual([])
    expect(await w.host.devices()).toEqual([])
  })
})
