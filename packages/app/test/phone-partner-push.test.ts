// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A partner phone paired on the LAN with the pairing host the app builds (pairHostServices) over a real hub (sx-link):
// it registers its own push token, and the hub's token follows its approve right as the person changes it in Devices.
// Skipped unless SX_LINK_BIN names a built sx-link (cargo build -p sx-link).
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ApprovalHost, PrinterHost } from '@slicerx/contracts'
import { createIdentity, createPairClient, createPairHost, defaultEnv, memoryPairingStore, memoryPipePair, type HostPairingAttempt, type Pipe, type SocketFactory, type SocketLike } from '@slicerx/pair'
import { createMemoryRelay } from '@slicerx/pair/relay'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectLink, type LinkHost } from '../../connect/link-client/src/index'
import { pairHostServices } from '../src/features/phone/wire'
import { binBuilt } from './binaries'

const linkBin = process.env['SX_LINK_BIN'] ?? ''
const built = binBuilt(linkBin || undefined, 'build sx-link (cargo build -p sx-link) and name it in SX_LINK_BIN')
const RELAY = 'wss://relay.example.test/v1'
const LAN = 'ws://192.168.1.20:47616/pair'
const PREFS = { printDone: true, printFailed: true, attention: true, approvals: true }
const TOKEN = 'ExponentPushToken[lanpartner0001]'

type Proc = ChildProcessByStdio<null, Readable, Readable>
let proc: Proc | null = null
let dir = ''
let link: LinkHost

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A LAN socket factory that hands the other end of each connection to the host. */
function fakeLan(onConnection: (pipe: Pipe) => void): SocketFactory {
  return (url: string): SocketLike => {
    const listeners = new Map<string, Set<(ev: { data: unknown }) => void>>()
    const fire = (type: string, data?: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ data })
    }
    let state = 0
    let mine: Pipe | null = null
    setTimeout(() => {
      if (url !== LAN) {
        state = 3
        return fire('error')
      }
      const [a, b] = memoryPipePair()
      mine = a
      a.onFrame((f) => fire('message', f))
      a.onClose(() => {
        state = 3
        fire('close')
      })
      onConnection(b)
      state = 1
      fire('open')
    }, 0)
    return {
      get readyState() {
        return state
      },
      send: (d: string) => mine?.send(d),
      close: () => mine?.close(),
      addEventListener: ((type: string, cb: (ev: { data: unknown }) => void) => {
        let s = listeners.get(type)
        if (!s) listeners.set(type, (s = new Set()))
        s.add(cb)
      }) as SocketLike['addEventListener'],
    }
  }
}

beforeAll(async () => {
  if (!built) return
  dir = mkdtempSync(join(tmpdir(), 'sx-app-partner-push-'))
  const p = spawn(linkBin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns', '--loopback'], { stdio: ['ignore', 'pipe', 'pipe'] })
  proc = p
  const out = await new Promise<string>((resolve, reject) => {
    let text = ''
    p.stdout.on('data', (d: Buffer) => {
      text += d.toString()
      if (/ws:\/\/127\.0\.0\.1:\d+/.test(text) && /pairing code: [A-Z0-9]{4}-[A-Z0-9]{4}/.test(text)) resolve(text)
    })
    ;(p as unknown as { on(event: 'exit', cb: () => void): void }).on('exit', () => reject(new Error('sx-link exited early')))
  })
  link = await connectLink({ url: /ws:\/\/127\.0\.0\.1:\d+/.exec(out)![0], code: /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)![1]! })
}, 30_000)

afterAll(() => {
  link?.close()
  proc?.kill()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!built)('a partner phone on the LAN and the hub its alerts come from', () => {
  it('registers its own push token through the app, and the token follows its approve right both ways', async () => {
    const env = defaultEnv
    const relay = createMemoryRelay()
    // The services the app hands its pairing host, over the hub's push methods as the app's bridge carries them.
    const services = pairHostServices({ printers: link as unknown as PrinterHost, approvals: link.approvals as unknown as ApprovalHost, push: link.push })
    const host = await createPairHost({ env, identity: createIdentity(env, 'Studio Mac', 'desktop'), store: memoryPairingStore(), kind: 'desktop', services, endpoints: { lan: [LAN], relay: RELAY } })
    host.attachRelay(relay.connect({}))
    const client = createPairClient({
      env,
      identity: createIdentity(env, 'Pixel 8', 'android'),
      store: memoryPairingStore(),
      relays: [RELAY],
      defaultRelay: RELAY,
      socket: fakeLan((pipe) => host.handlePipe(pipe)),
      openRelay: async () => relay.connect({}),
      accountId: null,
      partner: 'Example Phone',
      lanTimeoutMs: 50,
      sessionTimeoutMs: 500,
      pairAnswerTimeoutMs: 300,
    })

    const offer = host.createOffer({ partner: 'Example Phone' })
    const attempts: HostPairingAttempt[] = []
    offer.onAttempt((a) => attempts.push(a))
    const flow = await client.pair(offer.link)
    await flow.sas
    await flush()
    flow.confirm()
    attempts[0]!.confirm()
    const [paired] = await Promise.all([flow.result, attempts[0]!.result])
    expect(paired).toMatchObject({ ok: true })
    const pairingId = (await client.hosts())[0]!.pairingId
    const conn = await client.connect(pairingId)
    expect(conn.via).toBe('lan')
    expect(conn.info.partner).toBe('Example Phone')
    expect(conn.info.push).toBe(true)

    // Its own token, through the app's pairing host, reaches the hub under its pairing.
    await conn.push.registerPartner({ provider: 'expo', token: TOKEN, platform: 'android', prefs: PREFS })
    const mine = async () => (await link.push.status()).registrations.find((r) => r.tag === pairingId)
    expect(await mine()).toMatchObject({ partner: 'Example Phone', provider: 'expo', mayApprove: false })

    // The person turns approve on in Devices, then off again: the hub's token follows each time.
    await host.setRights(pairingId, { request: true, approve: true, introduce: false })
    expect((await mine())?.mayApprove).toBe(true)
    await host.setRights(pairingId, { request: true, approve: false, introduce: false })
    expect((await mine())?.mayApprove).toBe(false)

    // Unregistered and revoked: the hub drops the token.
    await conn.push.unregisterPartner()
    expect(await mine()).toBeUndefined()
    conn.close()
    host.close()
  })
})
