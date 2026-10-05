// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import type { ApprovalDecision, ApprovalRequest, DemoFleet } from '@slicerx/contracts'
import { createFleetSim, type FleetSim } from '@slicerx/fleet-sim'
import { createApprovalBroker } from '@slicerx/pilot'
import { concat, u32be } from '../src/bytes'
import { sha256, type PairEnv } from '../src/crypto'
import { createPairClient, type PairClient } from '../src/client'
import { createPairHost, type ApprovalFeed, type HostOffer, type HostServices, type PairHost, type PairHostOptions } from '../src/host'
import { createIdentity, memoryPairingStore, type DeviceIdentity, type PairingStore } from '../src/identity'
import { createMemoryRelay, type MemoryRelay } from '../src/relay'
import { memoryPipePair, type Pipe, type RelayConnection, type SocketFactory, type SocketLike } from '../src/transport'

export const RELAY = 'wss://relay.example.test/v1'
export const LAN = 'ws://192.168.1.20:47616/pair'

/** Deterministic randomness and a clock the test moves by hand. */
export function testEnv(seed: string): PairEnv & { advance(ms: number): void } {
  let counter = 0
  let t = Date.UTC(2026, 8, 30, 12, 0, 0)
  const seedBytes = new TextEncoder().encode(seed)
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    random(n) {
      const out = new Uint8Array(n)
      for (let o = 0; o < n; o += 32) out.set(sha256(concat(seedBytes, u32be(counter++))).slice(0, Math.min(32, n - o)), o)
      return out
    },
  }
}

export const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A LAN socket factory that hands the other end of each connection to the host. */
export function fakeLan(onConnection: (pipe: Pipe) => void, reachable: readonly string[] = [LAN]): SocketFactory & { opened: string[] } {
  const opened: string[] = []
  const factory = (url: string): SocketLike => {
    opened.push(url)
    const listeners = new Map<string, Set<(ev: { data: unknown }) => void>>()
    const on = (type: string, cb: (ev: { data: unknown }) => void) => {
      let s = listeners.get(type)
      if (!s) listeners.set(type, (s = new Set()))
      s.add(cb)
    }
    const fire = (type: string, data?: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ data })
    }
    let state = 0
    let mine: Pipe | null = null
    setTimeout(() => {
      if (!reachable.includes(url)) {
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
      addEventListener: on as SocketLike['addEventListener'],
    }
  }
  return Object.assign(factory, { opened })
}

export function loadFleet(): DemoFleet {
  return JSON.parse(readFileSync(new URL('../../connect/fixtures/demo-fleet.json', import.meta.url), 'utf8')) as DemoFleet
}

export interface World {
  env: ReturnType<typeof testEnv>
  relay: MemoryRelay
  hostId: DeviceIdentity
  hostStore: PairingStore
  host: PairHost
  sim: FleetSim
  broker: ReturnType<typeof createApprovalBroker>
  lan: ReturnType<typeof fakeLan>
  feed: TestFeed
  phone(name: string, opts?: { accountId?: string; lan?: boolean; store?: PairingStore; socket?: SocketFactory; openRelay?: OpenRelay }): Phone
}

export interface Phone {
  id: DeviceIdentity
  store: PairingStore
  client: PairClient
}

export interface TestFeed extends ApprovalFeed {
  push(r: ApprovalRequest): void
  decisions: { requestId: string; decision: ApprovalDecision; by: { deviceId: string; name: string } }[]
}

export function testFeed(): TestFeed {
  const pending: ApprovalRequest[] = []
  const reqCbs = new Set<(r: ApprovalRequest) => void>()
  const decisions: TestFeed['decisions'] = []
  return {
    decisions,
    push(r) {
      pending.push(r)
      for (const cb of reqCbs) cb(r)
    },
    pending: () => [...pending],
    onRequest(cb) {
      reqCbs.add(cb)
      return () => reqCbs.delete(cb)
    },
    onResolved: () => () => {},
    async decide(requestId, decision, by) {
      decisions.push({ requestId, decision, by })
      const i = pending.findIndex((r) => r.id === requestId)
      if (i >= 0) pending.splice(i, 1)
    },
  }
}

/** Opens a relay connection, signed in as `accountId` when given. Defaults to the world's memory relay. */
export type OpenRelay = (accountId?: string) => Promise<RelayConnection>

export async function world(opts: { accountId?: string; services?: Partial<HostServices>; host?: Partial<PairHostOptions>; realClock?: boolean; seed?: string; openRelay?: OpenRelay } = {}): Promise<World> {
  const env = testEnv(opts.seed ?? 'world')
  // Tests against a real bridge need its clock, since its broker stamps tokens with wall time.
  if (opts.realClock) env.now = () => Date.now()
  const relay = createMemoryRelay({ now: env.now })
  const hostId = createIdentity(env, 'Studio Mac', 'desktop')
  const hostStore = memoryPairingStore()
  const broker = createApprovalBroker({ now: env.now })
  const sim = createFleetSim(loadFleet(), { clock: env.now, approvals: broker })
  const feed = testFeed()
  const host = await createPairHost({
    env,
    identity: hostId,
    store: hostStore,
    kind: 'desktop',
    services: {
      printers: sim,
      approvals: broker,
      approvalFeed: feed,
      library: { list: async () => [{ id: 'lib-1', name: 'Cable clip', kind: 'model' }] },
      slicer: {
        async slice(req, onProgress) {
          onProgress('perimeters', 0.5)
          const data = new TextEncoder().encode(`; sliced ${req.source.kind} ${req.options?.material ?? ''} ${req.options?.easy?.detail ?? ''}\nG28\n`)
          return { name: 'cable-clip.gcode', kind: 'gcode', data: data.buffer, timeS: 3720, grams: 12 }
        },
      },
      ...opts.services,
    },
    accountId: opts.accountId ?? null,
    endpoints: { lan: [LAN], relay: RELAY },
    ...opts.host,
  })
  const openRelay: OpenRelay = opts.openRelay ?? (async (accountId) => relay.connect(accountId ? { accountId } : {}))
  host.attachRelay(await openRelay(opts.accountId))
  const lan = fakeLan((pipe) => host.handlePipe(pipe))
  const noLan = fakeLan(() => {}, [])
  return {
    env,
    relay,
    hostId,
    hostStore,
    host,
    sim,
    broker,
    lan,
    feed,
    phone(name, p = {}) {
      const id = createIdentity(env, name, 'ios')
      const store = p.store ?? memoryPairingStore()
      const client = createPairClient({
        env,
        identity: id,
        store,
        relays: [RELAY],
        defaultRelay: RELAY,
        socket: p.socket ?? (p.lan === false ? noLan : lan),
        openRelay: () => (p.openRelay ?? openRelay)(p.accountId),
        accountId: p.accountId ?? null,
        lanTimeoutMs: 50,
        sessionTimeoutMs: 500,
        pairAnswerTimeoutMs: 300,
      })
      return { id, store, client }
    },
  }
}

/** Runs a full QR pairing with both people confirming. */
export async function pairByLink(w: World, phone: Phone, existing?: HostOffer) {
  const offer = existing ?? w.host.createOffer()
  const attempts: import('../src/host').HostPairingAttempt[] = []
  offer.onAttempt((a) => attempts.push(a))
  const flow = await phone.client.pair(offer.link)
  const phoneSas = await flow.sas
  await flush()
  const hostAttempt = attempts[0]
  if (!hostAttempt) throw new Error('no host attempt')
  const hostSas = await hostAttempt.sas
  flow.confirm()
  hostAttempt.confirm()
  const [p, h] = await Promise.all([flow.result, hostAttempt.result])
  return { offer, phoneSas, hostSas, phoneResult: p, hostResult: h }
}
