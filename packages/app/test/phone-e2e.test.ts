// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Phone access and Remote access through the app's own modules against a real hub (sx-link) and a real
// relay (sx-relay): the app builds the pairing host, a phone pairs over the LAN listener the hub serves,
// Remote access hands the pairing to the hub, and the phone then makes a call through the relay alone.
// Skipped unless SX_LINK_BIN names a built sx-link and sx-relay is built (cargo build -p sx-link -p sx-relay).
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ApprovalHost, PrinterHost } from '@slicerx/contracts'
import { connectLink, type LinkHost } from '../../connect/link-client/src/index'
import { connectRelay, createIdentity, createPairClient, defaultEnv, memoryPairingStore, type SocketLike } from '@slicerx/pair'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WS from 'ws'
import { fakeLan } from '../../pair/test/helpers'
import type { ConnectedBridge } from '../src/link/bridge'
import { setPhoneAccess } from '../src/lib/phone'
import { createRemoteAccess, setRemoteAccess } from '../src/features/phone/remote'
import { sealedPairStores, type DocStore } from '../src/features/phone/sealed'
import { pairSourceFor, phoneAccessFor } from '../src/features/phone/wire'

const linkBin = process.env['SX_LINK_BIN'] ?? ''
const relayBin = process.env['SX_RELAY_BIN'] ?? new URL('../../../target/debug/sx-relay', import.meta.url).pathname
const built = linkBin !== '' && existsSync(linkBin) && existsSync(relayBin)
// A phone only accepts a wss relay in a pairing, and sx-relay here listens on plain ws at loopback (the hub allows that for loopback only).
// So pairings advertise a wss address and every phone connection is routed to the local relay.
const ADVERTISED = 'wss://relay.example.test/v1'
const SECRET = 'app phone e2e secret'

type Proc = ChildProcessByStdio<null, Readable, Readable>
const procs: Proc[] = []
const dirs: string[] = []

function start(bin: string, args: string[], env: Record<string, string>, ready: RegExp[]): Promise<{ out: string }> {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  procs.push(p)
  let out = ''
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      if (ready.every((r) => r.test(out))) resolve({ out })
    })
    // Typed by hand: the process type's event methods differ between @types/node versions.
    ;(p as unknown as { on(event: 'exit', cb: () => void): void }).on('exit', () => reject(new Error(`${bin} exited early`)))
  })
}

afterAll(() => {
  for (const p of procs) p.kill()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const memoryDoc = (): DocStore => {
  let t: string | null = null
  return { read: async () => t, write: async (x) => void (t = x) }
}
// The hub's LAN listener refuses a request that carries an Origin header, as a browser's does; a phone sends none.
// Node's built-in WebSocket sends one, so the phone side here uses the ws package.
/** A relay token (audience sx-relay, as the backend's relay-token function mints) signed with the relay's test secret. The hub refuses an account's own session. */
function relayToken(accountId: string): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const input = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: accountId, aud: 'sx-relay', exp: Math.floor(Date.now() / 1000) + 600 })}`
  return `${input}.${createHmac('sha256', SECRET).update(input).digest('base64url')}`
}
const socket = (u: string) => new WS(u) as unknown as SocketLike

let link: LinkHost
let relayUrl = ''

beforeAll(async () => {
  if (!built) return
  const relay = await start(relayBin, ['--listen', '127.0.0.1:0'], { SX_RELAY_JWT_SECRET: SECRET }, [/ws:\/\/127\.0\.0\.1:\d+\/v1/])
  relayUrl = /ws:\/\/127\.0\.0\.1:\d+\/v1/.exec(relay.out)![0]
  const dir = mkdtempSync(join(tmpdir(), 'sx-app-e2e-'))
  dirs.push(dir)
  const hub = await start(linkBin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns', ...(process.env['SX_TEST_LAN'] === '1' ? [] : ['--loopback'])], {}, [/ws:\/\/127\.0\.0\.1:\d+/, /pairing code: [A-Z0-9]{4}-[A-Z0-9]{4}/])
  const url = /ws:\/\/127\.0\.0\.1:\d+/.exec(hub.out)![0]
  const code = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(hub.out)![1]!
  link = await connectLink({ url, code })
}, 30_000)

afterAll(() => link?.close())

describe.skipIf(!built)('Phone access and Remote access against a real hub and relay', () => {
  it('pairs a phone through the app, turns Remote access on and answers a call through the relay', async () => {
    const storage = { ...sealedPairStores(memoryDoc()), name: 'Studio Mac', kind: 'desktop' as const }
    const bridge: ConnectedBridge = {
      printers: link as unknown as PrinterHost,
      approvals: link.approvals as unknown as ApprovalHost,
      setup: { discover: async () => [], testConnection: async () => ({ ok: true, steps: [] }), addPrinter: async () => ({ printerId: 'x' }) },
      pair: link.pair,
      camera: link.camera as never,
      push: link.push,
      close: () => undefined,
    }
    const remote = createRemoteAccess({ remote: link.remote, source: pairSourceFor(storage), relayUrl })
    setRemoteAccess(remote)
    const phoneAccess = phoneAccessFor(bridge, storage, ADVERTISED, 47800 + Math.floor(Math.random() * 150))
    setPhoneAccess(phoneAccess)

    await phoneAccess.setEnabled(true)
    const state = phoneAccess.getState()
    expect(state.status, state.error).toBe('on')
    if (state.urls.length === 0) return // no private LAN address on this machine: nothing for a phone to dial

    // A phone on the same Wi-Fi pairs with the code the app shows.
    const phoneId = createIdentity(defaultEnv, 'Pocket', 'ios')
    const phoneStore = memoryPairingStore()
    const phone = (lan: boolean) =>
      createPairClient({
        env: defaultEnv,
        identity: phoneId,
        store: phoneStore,
        relays: [ADVERTISED],
        defaultRelay: ADVERTISED,
        socket: lan ? socket : fakeLan(() => undefined, []),
        openRelay: () => connectRelay({ url: relayUrl, socket }),
        accountId: null,
        lanTimeoutMs: 1500,
        sessionTimeoutMs: 8000,
        pairAnswerTimeoutMs: 8000,
      })
    const offer = await phoneAccess.offer()
    const attempts: import('../src/lib/phone').PhoneAttempt[] = []
    offer.onAttempt((a) => attempts.push(a))
    // The listener answers on every interface, but a firewall may refuse the LAN address from this same machine, so the phone dials loopback.
    const loopback = offer.link.replace(/(l=ws%3A%2F%2F)[^%]+/, '$1127.0.0.1')
    const flow = await phone(true).pair(loopback)
    await flow.sas
    for (let i = 0; i < 200 && attempts.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    expect(attempts).toHaveLength(1)
    expect(await attempts[0]!.sas).toBe(await flow.sas)
    flow.confirm()
    attempts[0]!.confirm()
    const outcome = await flow.result
    expect(outcome).toMatchObject({ ok: true })
    expect((await attempts[0]!.result).ok).toBe(true)
    for (let i = 0; i < 100 && phoneAccess.getState().devices.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    expect(phoneAccess.getState().devices).toHaveLength(1)

    // Remote access: the hub takes the identity and the pairing and answers on the relay.
    await remote.setToken(relayToken('e2e-account'))
    expect(remote.getState().error).toBeUndefined()
    await remote.setEnabled(true)
    expect(remote.getState().error).toBeUndefined()
    // The relay connection comes up first; the account sign-in on it follows.
    for (let i = 0; i < 100 && !(remote.getState().status?.connected && remote.getState().status?.signedIn); i++) {
      await new Promise((r) => setTimeout(r, 100))
      await remote.refresh()
    }
    expect(remote.getState().status).toMatchObject({ enabled: true, connected: true, pairings: 1, signedIn: true })
    expect(remote.getState().status?.quota?.tier).toBe('account')

    // The phone leaves the LAN: the only way in is the relay, and the hub answers.
    const pairing = (await phoneStore.list())[0]!
    const conn = await phone(false).connect(pairing.pairingId)
    expect(conn.via).toBe('relay')
    expect(conn.info.kind).toBe('link')
    expect(await conn.printers()).toEqual([])
    conn.close()

    // Signing out clears the hub's token.
    await remote.setToken(null)
    // The hub keeps reporting signedIn: true after this until the relay connection restarts (hub side, reported to connect).
    expect(remote.getState().error).toBeUndefined()

    // Turning it off drops the pairing's relay route: the hub no longer answers there.
    await remote.setEnabled(false)
    expect(remote.getState().status?.enabled).toBe(false)
    await phoneAccess.setEnabled(false)
  }, 60_000)
})
