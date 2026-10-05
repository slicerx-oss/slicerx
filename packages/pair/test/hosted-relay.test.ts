// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The hosted relay (packages/connect/relay, sx-relay) against the memory relay's rules, and a
// pairing plus a session through it. The rule suite runs on both relays; the hosted half is skipped
// unless target/debug/sx-relay is built (cargo build -p sx-relay).
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { checkHub, LinkError, pairWithCode } from '@slicerx/link-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { toB64url, utf8 } from '../src/bytes'
import type { HostPairingAttempt } from '../src/host'
import { createMemoryRelay, RELAY_LIMITS } from '../src/relay'
import { connectRelay, type RelayConnection, type SocketLike } from '../src/transport'
import { world, type OpenRelay } from './helpers'

const bin = new URL('../../../target/debug/sx-relay', import.meta.url).pathname
const built = existsSync(bin)
// The hub half runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link).
const linkBin = process.env['SX_LINK_BIN'] ?? ''
const linkBuilt = built && linkBin !== '' && existsSync(linkBin)
const SECRET = 'hosted relay test secret'

let proc: ChildProcessByStdio<null, Readable, Readable> | undefined
let url = ''

/** Starts sx-relay on a free port with the test secret. */
async function startRelay(): Promise<{ proc: ChildProcessByStdio<null, Readable, Readable>; url: string }> {
  const p = spawn(bin, ['--listen', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SX_RELAY_JWT_SECRET: SECRET } })
  let out = ''
  const found = await new Promise<string>((resolve, reject) => {
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const u = /ws:\/\/127\.0\.0\.1:\d+\/v1/.exec(out)
      if (u) resolve(u[0])
    })
    p.once('exit', () => reject(new Error('sx-relay exited early')))
  })
  return { proc: p, url: found }
}

beforeAll(async () => {
  if (!built) return
  const r = await startRelay()
  proc = r.proc
  url = r.url
}, 20_000)

afterAll(() => {
  proc?.kill()
})

/** A relay token (audience sx-relay) signed with the test secret. */
function sessionToken(accountId: string): string {
  const enc = (v: unknown) => toB64url(utf8(JSON.stringify(v)))
  const input = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: accountId, aud: 'sx-relay', exp: Math.floor(Date.now() / 1000) + 600 })}`
  return `${input}.${toB64url(hmac(sha256, utf8(SECRET), utf8(input)))}`
}

const hosted: OpenRelay = (accountId) =>
  connectRelay({
    url,
    socket: (u) => new WebSocket(u) as unknown as SocketLike,
    ...(accountId ? { token: async () => sessionToken(accountId) } : {}),
  })

const memory = createMemoryRelay()
const inMemory: OpenRelay = async (accountId) => memory.connect(accountId ? { accountId } : {})

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 100))

let n = 0
/** A fresh 43 character route. */
function route(): string {
  n += 1
  return toB64url(sha256(utf8(`route-${n}-${Math.random()}`)))
}

const relays: [string, () => OpenRelay, boolean][] = [
  ['memory relay', () => inMemory, true],
  ['hosted relay', () => hosted, built],
]

for (const [name, open, enabled] of relays) {
  describe.skipIf(!enabled)(`${name} rules`, () => {
    const conns: RelayConnection[] = []
    const connect = async (accountId?: string) => {
      const c = await open()(accountId)
      conns.push(c)
      return c
    }
    // The hosted relay allows four connections at once from one address without an account.
    afterEach(async () => {
      for (const c of conns.splice(0)) c.close()
      await settle()
    })

    it('forwards a body to every subscriber of a route', async () => {
      const [a, b, c] = [await connect(), await connect(), await connect()]
      const r = route()
      const got: string[] = []
      a.subscribe(r, (body) => got.push(`a:${body}`))
      b.subscribe(r, (body) => got.push(`b:${body}`))
      await settle()
      c.send(r, 'sealed')
      await until(() => got.length === 2)
      expect(got.sort()).toEqual(['a:sealed', 'b:sealed'])
    })

    it('queues for a route with no subscriber, in order, and stops after unsubscribe', async () => {
      const [a, b] = [await connect(), await connect()]
      const r = route()
      for (const i of [1, 2, 3]) a.send(r, `q${i}`)
      await settle()
      const got: string[] = []
      const off = b.subscribe(r, (body) => got.push(body))
      await until(() => got.length === 3)
      expect(got).toEqual(['q1', 'q2', 'q3'])
      off()
      await settle()
      a.send(r, 'after')
      await settle()
      expect(got).toEqual(['q1', 'q2', 'q3'])
    })

    it('carries a body of the largest size and drops a larger one', async () => {
      const [a, b] = [await connect(), await connect()]
      const r = route()
      const got: number[] = []
      b.subscribe(r, (body) => got.push(body.length))
      await settle()
      a.send(r, 'x'.repeat(RELAY_LIMITS.maxBody + 1))
      a.send(r, 'y'.repeat(RELAY_LIMITS.maxBody))
      await until(() => got.length === 1)
      await settle()
      expect(got).toEqual([RELAY_LIMITS.maxBody])
    })

    it('serves malformed routes to no one', async () => {
      const [a, b] = [await connect(), await connect()]
      const bad = route().slice(1)
      const got: string[] = []
      b.subscribe(bad, (body) => got.push(body))
      b.subscribe(`${bad}==`, (body) => got.push(body))
      await settle()
      a.send(bad, 'nope')
      a.send(`${bad}==`, 'nope')
      await settle()
      expect(got).toEqual([])
    })

    it('serves account routes only to that signed-in account', async () => {
      const id = `acct-${Math.random().toString(36).slice(2, 10)}`
      const join = `acct:${id}:join`
      const [owner, other, anon, sender] = [await connect(id), await connect(`${id}x`), await connect(), await connect(id)]
      const got: string[] = []
      owner.subscribe(join, (b) => got.push(`owner:${b}`))
      other.subscribe(join, (b) => got.push(`other:${b}`))
      anon.subscribe(join, (b) => got.push(`anon:${b}`))
      await settle()
      anon.send(join, 'from-anon')
      other.send(join, 'from-other')
      sender.send(join, 'from-owner')
      await until(() => got.length >= 1)
      await settle()
      expect(got).toEqual(['owner:from-owner'])
    })
  })
}

describe.skipIf(!built)('pairing through the hosted relay', () => {
  it('pairs a phone by short code and opens a session with no LAN path', async () => {
    const w = await world({ openRelay: hosted, realClock: true, seed: 'hosted' })
    const phone = w.phone('Pocket', { lan: false })
    const offer = w.host.createOffer()
    const attempts: HostPairingAttempt[] = []
    offer.onAttempt((a) => attempts.push(a))
    const flow = await phone.client.pair(offer.code)
    const sas = await flow.sas
    await until(() => attempts.length === 1)
    expect(await attempts[0]?.sas).toBe(sas)
    flow.confirm()
    attempts[0]?.confirm()
    expect((await flow.result).ok).toBe(true)
    const pairingId = (await phone.client.hosts())[0]?.pairingId ?? ''
    const conn = await phone.client.connect(pairingId)
    const printers = await conn.printers()
    expect(printers.length).toBeGreaterThan(0)
    conn.close()
  }, 20_000)
})

/** One JSON-RPC call on sx-link's control socket. */
function linkCall(ws: WebSocket, id: number, method: string, params: unknown): Promise<{ result?: unknown; error?: { code: string; message?: string } }> {
  return new Promise((resolve) => {
    const on = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as { id?: number }
      if (m.id === id) {
        ws.removeEventListener('message', on)
        resolve(m as { result?: unknown })
      }
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

describe.skipIf(!linkBuilt)('a phone reaching sx-link through the hosted relay', () => {
  it('connects with the pairing the app handed to the hub, with the app closed', async () => {
    // A throwaway state directory with file secrets, so the test never touches the keychain.
    const dir = mkdtempSync(join(tmpdir(), 'sx-remote-'))
    // Its own relay: one address may hold only four connections without an account.
    const own = await startRelay()
    const link = spawn(linkBin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns'], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let out = ''
      const { linkUrl, code } = await new Promise<{ linkUrl: string; code: string }>((resolve, reject) => {
        link.stdout.on('data', (d: Buffer) => {
          out += d.toString()
          const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
          const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
          if (u && c) resolve({ linkUrl: u[0], code: c[1] ?? '' })
        })
        link.once('exit', () => reject(new Error('sx-link exited early')))
      })
      // The app pairs the phone over the LAN, then hands the pairing to the hub and goes away.
      const w = await world({ realClock: true, seed: 'remote-hub' })
      const lanPhone = w.phone('Pocket')
      const flowOffer = w.host.createOffer()
      const attempts: HostPairingAttempt[] = []
      flowOffer.onAttempt((a) => attempts.push(a))
      const flow = await lanPhone.client.pair(flowOffer.link)
      await flow.sas
      await until(() => attempts.length === 1)
      flow.confirm()
      attempts[0]?.confirm()
      expect((await flow.result).ok).toBe(true)
      const rec = (await w.hostStore.list())[0]
      if (!rec) throw new Error('no pairing')

      const app = new WebSocket(`${linkUrl}/`)
      await new Promise((r) => app.addEventListener('open', r, { once: true }))
      // The app runs the code exchange over a checked hello; the hub refuses a code sent in clear.
      const port = Number(new URL(linkUrl).port)
      let nextId = 100
      const linkRpc = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
        const r = await linkCall(app, nextId++, method, params ?? {})
        if (r.error) throw new LinkError(r.error.code as never, r.error.message ?? '')
        return r.result as T
      }
      const hello = await checkHub(linkRpc, port)
      expect((await linkCall(app, 1, 'pair', { code })).error).toMatchObject({ code: 'unauthorized' })
      expect(await pairWithCode(linkRpc, hello, code)).toMatchObject({ paired: true })
      const put = await linkCall(app, 2, 'remote.pairings.put', { pairingId: rec.pairingId, deviceKey: rec.deviceKey, kind: 'phone', peer: rec.peer, rights: rec.rights })
      expect(put.result).toEqual({ saved: true })
      const conf = await linkCall(app, 3, 'remote.configure', { enabled: true, relay: own.url, host: w.hostId.public, hostDh: toB64url(w.hostId.dhSecret) })
      expect(conf.result).toMatchObject({ enabled: true })
      for (let i = 0; i < 100; i++) {
        const s = (await linkCall(app, 10 + i, 'remote.status', {})).result as { connected?: boolean }
        if (s.connected) break
        await settle()
      }

      // Same pairing store, no LAN: the only way in is the relay, and the hub answers.
      const away = w.phone('Pocket', { store: lanPhone.store, lan: false, openRelay: () => connectRelay({ url: own.url, socket: (u) => new WebSocket(u) as unknown as SocketLike }) })
      const conn = await away.client.connect(rec.pairingId)
      expect(conn.via).toBe('relay')
      expect(conn.info.kind).toBe('link')
      expect(conn.info.rights.approve).toBe(true)
      expect(await conn.printers()).toEqual([])
      expect(await conn.fleets()).toEqual([])
      await expect(conn.status('nope')).rejects.toMatchObject({ code: 'not_found' })
      expect(await conn.approvals()).toEqual([])
      conn.close()
      app.close()
    } finally {
      link.kill()
      own.proc.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
