// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One pairing client per app run: the phone's identity, its paired computers, live connections
// to them, and the relay. Screens reach it through the hooks in ./index.ts.
import {
  connectRelay,
  createPairClient,
  createPairedPrinterHost,
  ensureIdentity,
  relayTokenSource,
  type RemoteQuota,
  type ApprovalView,
  type HostConnection,
  type PairClient,
  type PairedHost,
  type PairedPrinterHost,
  type RelayConnection,
  type SliceWhere,
} from '@slicerx/pair'
import Constants from 'expo-constants'
import * as ExpoCrypto from 'expo-crypto'
import { Alert, Platform } from 'react-native'
import type { PocketHost } from '../host'
import { secureIdentityStore, securePairingStore } from './storage'

export interface HostState {
  host: PairedHost
  online: boolean
  slicing: readonly SliceWhere[]
}

/** An approval the computer raised that this phone may decide (Pilot on the computer, or another phone's job). */
export interface ComputerApproval {
  pairingId: string
  hostName: string
  view: ApprovalView
  /** How the phone reaches the computer right now. */
  via: 'lan' | 'relay'
  /** Call only from the approval card, after device auth. Signs the decision with this phone's key. */
  decide(decision: 'approve' | 'deny', opts?: { bedClear?: boolean }): Promise<void>
}

export interface PairService {
  client: PairClient
  enabled: boolean
  hosts(): HostState[]
  refresh(): Promise<void>
  connection(pairingId: string): Promise<HostConnection>
  /** The relay quota of the first computer reached over the relay, and later updates; null at home. */
  watchQuota(cb: (q: RemoteQuota | null) => void): () => void
  /** Sends removals that could not reach their computer. Resolves with how many went through. */
  retryRemovals(): Promise<number>
  /** The PrinterHost for one paired computer. Side effects need a token from `host.approvals`. */
  printers(pairingId: string): PairedPrinterHost
  /** The account relay, when signed in and a relay is configured. */
  accountRelay(): Promise<RelayConnection | null>
  onChange(cb: () => void): () => void
  onApproval(cb: (a: ComputerApproval) => void): () => void
}

/** The edition config names the relay by its https URL; the relay itself speaks WebSocket. */
export function relaySocketUrl(url: string | null): string | null {
  if (!url) return null
  if (url.startsWith('https://')) return `wss://${url.slice(8)}`
  if (url.startsWith('http://')) return `ws://${url.slice(7)}`
  return url
}

const services = new WeakMap<PocketHost, Promise<PairService>>()

export function pairService(host: PocketHost): Promise<PairService> {
  let s = services.get(host)
  if (!s) {
    s = createService(host)
    services.set(host, s)
  }
  return s
}

async function createService(pocket: PocketHost): Promise<PairService> {
  const relayUrl = relaySocketUrl(pocket.edition.backend.relay)
  const env = { now: () => Date.now(), random: (n: number) => ExpoCrypto.getRandomValues(new Uint8Array(n)) }
  const platform = Platform.OS === 'android' ? 'android' : 'ios'
  const identity = await ensureIdentity(secureIdentityStore, env, Constants.deviceName ?? (platform === 'ios' ? 'iPhone' : 'Android phone'), platform)
  const store = securePairingStore()
  const session = await pocket.account.session().catch(() => null)

  // The relay takes a token minted for it alone, never the account session. Without a backend it
  // is the anonymous tier.
  const sb = pocket.edition.backend.supabase
  const relayToken = sb ? relayTokenSource({ backend: { url: sb.url, anonKey: sb.anonKey }, session: () => pocket.account.accessToken() }) : async () => null

  const relays = new Map<string, Promise<RelayConnection>>()
  const openRelay = (url: string): Promise<RelayConnection> => {
    let r = relays.get(url)
    if (!r) {
      r = connectRelay({ url, socket: (u) => new WebSocket(u), token: relayToken })
      // A failed connection is retried on the next call.
      r.catch(() => relays.delete(url))
      relays.set(url, r)
    }
    return r
  }

  const client = createPairClient({
    env,
    identity,
    store,
    relays: relayUrl ? [relayUrl] : [],
    ...(relayUrl ? { defaultRelay: relayUrl, openRelay } : {}),
    socket: (url) => new WebSocket(url),
    accountId: session?.userId ?? null,
  })
  pocket.account.onSessionChange((s) => client.setAccount(s?.userId ?? null))

  let states: HostState[] = []
  const live = new Map<string, Promise<HostConnection>>()
  const printerHosts = new Map<string, PairedPrinterHost>()
  const changed = new Set<() => void>()
  const approvalCbs = new Set<(a: ComputerApproval) => void>()
  const notify = () => {
    for (const cb of [...changed]) cb()
  }

  const setOnline = (pairingId: string, online: boolean, slicing: readonly SliceWhere[] = []) => {
    states = states.map((s) => (s.host.pairingId === pairingId ? { ...s, online, slicing: online ? slicing : [] } : s))
    notify()
  }

  function connection(pairingId: string): Promise<HostConnection> {
    let c = live.get(pairingId)
    if (!c) {
      c = client.connect(pairingId).then((conn) => {
        setOnline(pairingId, true, conn.info.slicing)
        conn.onClose(() => {
          live.delete(pairingId)
          setOnline(pairingId, false)
          void reload()
        })
        conn.on('approval.request', async (view) => {
          // Requests the printer adapter raised for this phone are answered by the adapter itself.
          if (await printerHosts.get(pairingId)?.ownsSettled(view.request.id)) return
          const a: ComputerApproval = {
            pairingId,
            hostName: conn.info.identity.name,
            view,
            via: conn.via,
            decide: (d, o) => (d === 'approve' ? conn.approve(view, { bedClear: o?.bedClear === true }) : conn.deny(view)),
          }
          for (const cb of [...approvalCbs]) cb(a)
        })
        return conn
      })
      c.catch(() => live.delete(pairingId))
      live.set(pairingId, c)
    }
    return c
  }

  async function reload(): Promise<void> {
    const hosts = await client.hosts()
    const prev = new Map(states.map((s) => [s.host.pairingId, s]))
    states = hosts
      .sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt))
      .map((host) => ({ host, online: prev.get(host.pairingId)?.online ?? false, slicing: prev.get(host.pairingId)?.slicing ?? [] }))
    notify()
  }

  client.onHostsChanged(() => void reload())
  await reload()

  const service: PairService = {
    client,
    enabled: pocket.edition.features.phonePairing && relayUrl !== null,
    hosts: () => states,
    async refresh() {
      await reload()
      await Promise.allSettled(states.map((s) => connection(s.host.pairingId)))
    },
    connection,
    retryRemovals: () => client.retryRemovals().finally(() => void reload()),
    watchQuota(cb) {
      let live = true
      const offs: (() => void)[] = []
      void (async () => {
        for (const s of states) {
          if (!s.online || s.host.pendingRemoval) continue
          const conn = await connection(s.host.pairingId).catch(() => null)
          if (!conn || conn.via !== 'relay' || !live) continue
          offs.push(conn.on('remote.quota', (q) => cb(q)))
          const q = await conn.quota().catch(() => null)
          if (live) cb(q)
          return
        }
        if (live) cb(null)
      })()
      return () => {
        live = false
        for (const o of offs) o()
      }
    },
    printers(pairingId) {
      let p = printerHosts.get(pairingId)
      if (!p) {
        p = createPairedPrinterHost({
          connection: () => connection(pairingId),
          local: pocket.approvals,
          // A start asks the person, in their own tap, whether the plate is clear. Closing the dialog is a no.
          confirmBedClear: () =>
            new Promise<boolean>((resolve) => {
              Alert.alert('Is the build plate clear?', 'Confirm the plate is empty and the right one is on the printer.', [
                { text: 'Not yet', style: 'cancel', onPress: () => resolve(false) },
                { text: 'Plate is clear', onPress: () => resolve(true) },
              ], { cancelable: true, onDismiss: () => resolve(false) })
            }),
        })
        printerHosts.set(pairingId, p)
      }
      return p
    },
    async accountRelay() {
      if (!relayUrl || !(await pocket.account.session())) return null
      return openRelay(relayUrl).catch(() => null)
    },
    onChange(cb) {
      changed.add(cb)
      return () => changed.delete(cb)
    },
    onApproval(cb) {
      approvalCbs.add(cb)
      return () => approvalCbs.delete(cb)
    },
  }
  void service.refresh()
  return service
}
