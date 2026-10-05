// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Remote access: the hub answers paired phones over the relay, also while this app is closed
// (sx-link remote.*, app only). The app turns it on with its pair identity and hands the hub every
// pairing it should answer. While it is on, the hub owns the pairing routes on the relay: the app's
// own pairing host must not attach to the relay for them, or two programs would answer one route.
// Off by default.
import { useSyncExternalStore } from 'react'

export interface RemoteQuota {
  tier: 'account' | 'anonymous'
  /** Bytes this month, sent plus received. */
  used: number
  cap: number
  resetsAt: number
  connections: number
  maxConnections: number
}

export interface RemoteStatus {
  enabled: boolean
  relay: string | null
  connected: boolean
  sessions: number
  pairings: number
  lastError: string | null
  quota: RemoteQuota | null
  /** The hub holds a SlicerX account token, so it signs in to the relay. */
  signedIn?: boolean
}

/** A device's public identity, as packages/pair writes it. */
export type PublicIdentity = { deviceId: string; signPub: string; dhPub: string; name: string; platform: string }

export interface RemotePairing {
  pairingId: string
  deviceKey: string
  peer: PublicIdentity
  rights?: { request?: boolean; approve?: boolean }
}

/** The hub's remote.* methods, as the link client exposes them. */
export interface BridgeRemote {
  status(): Promise<RemoteStatus>
  configure(o: { enabled: boolean; relay?: string; host?: PublicIdentity; hostDh?: string }): Promise<RemoteStatus>
  quota(): Promise<RemoteStatus>
  /** A relay token (audience sx-relay) for the signed-in account, or null on sign-out. Never the account session. */
  setToken?(token: string | null): Promise<RemoteStatus>
  pairings: {
    put(p: RemotePairing & { kind: 'phone' | 'agent' }): Promise<unknown>
    remove(pairingId: string): Promise<unknown>
    list(): Promise<{ pairingId: string; kind?: 'phone' | 'agent' }[]>
    /** Every phone pairing the hub holds that is not in `pairingIds` is removed. */
    sync?(pairingIds: string[]): Promise<unknown>
  }
  /** A phone removed itself through the hub; the app forgets it too. */
  onPairingRevoked?(cb: (pairingId: string) => void): () => void
}

/** Where the app's own pairing identity and its paired phones come from (the pairing host's stores). */
export interface PairSource {
  identity(): Promise<PublicIdentity>
  /** The identity's static X25519 secret (base64url), which the hub mixes into session keys. */
  hostDh(): Promise<string>
  pairings(): Promise<RemotePairing[]>
}

export interface RemoteState {
  status: RemoteStatus | null
  busy: boolean
  error?: string
  /** Phones removed here that the hub has not heard about yet. Retried at every sync. */
  pendingRemovals?: string[]
}

export interface RemoteAccess {
  getState(): RemoteState
  subscribe(cb: () => void): () => void
  /** True while the hub answers the pairing routes, so nothing else may attach to the relay for them. */
  ownsRelayRoutes(): boolean
  refresh(): Promise<void>
  /** Hands the hub a relay token (null on sign-out). The token is never logged or stored here. */
  setToken(token: string | null): Promise<void>
  setEnabled(on: boolean): Promise<void>
  /** Hands the hub every local pairing and drops the phone pairings it holds that are gone here. */
  sync(): Promise<void>
  paired(p: RemotePairing): Promise<void>
  unpaired(pairingId: string): Promise<void>
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How often the app checks the hub's pairing list against its own while the bridge is connected. */
const SYNC_EVERY_MS = 5 * 60_000

export function createRemoteAccess(opts: { remote: BridgeRemote; source: PairSource | null; relayUrl?: string | null; forget?: (pairingId: string) => Promise<void> }): RemoteAccess {
  const pending = new Set<string>()
  let state: RemoteState = { status: null, busy: false }
  const listeners = new Set<() => void>()
  const set = (next: RemoteState) => {
    state = next
    for (const l of listeners) l()
  }
  const on = () => state.status?.enabled === true
  const api: RemoteAccess = {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    ownsRelayRoutes: on,
    async refresh() {
      try {
        const status = await opts.remote.status()
        // The quota is the relay's answer to a question the hub sends; ask again whenever remote access is on.
        set({ ...state, status: status.enabled ? await opts.remote.quota().catch(() => status) : status })
      } catch (e) {
        set({ ...state, error: text(e) })
      }
    },
    async setToken(token) {
      if (!opts.remote.setToken) return
      try {
        await opts.remote.setToken(token)
        await api.refresh()
      } catch (e) {
        // The text never carries the token; show the failure only.
        set({ ...state, error: text(e) })
      }
    },
    async setEnabled(want) {
      if (state.busy) return
      set({ ...state, busy: true })
      try {
        // Removals the hub has not heard stay on show until it confirms them, whichever way this goes.
        if (!want) {
          set({ status: await opts.remote.configure({ enabled: false }), busy: false, pendingRemovals: [...pending] })
          return
        }
        if (!opts.relayUrl) throw new Error('This build has no relay to reach the hub through.')
        if (!opts.source) throw new Error('Remote access uses the identity your phones paired with. Turn on phone access and pair a phone first.')
        const status = await opts.remote.configure({ enabled: true, relay: opts.relayUrl, host: await opts.source.identity(), hostDh: await opts.source.hostDh() })
        set({ status, busy: false, pendingRemovals: [...pending] })
        await api.sync()
        await api.refresh()
      } catch (e) {
        set({ ...state, busy: false, error: text(e) })
      }
    },
    async sync() {
      if (!opts.source) return
      const local = await opts.source.pairings()
      const keep = new Set(local.map((p) => p.pairingId))
      if (on()) for (const p of local) await opts.remote.pairings.put({ ...p, kind: 'phone' })
      // Also while off: a phone removed here, even while the hub could not be reached, must not stay on the
      // hub. Agent pairings belong to the hub (clients.create); only phones that are gone here are dropped.
      // No phones here may mean a pair store that did not open, or another app's hub: never read it as
      // "unpair them all". Only removals this app made itself are sent then.
      if (keep.size === 0) for (const id of [...pending]) await opts.remote.pairings.remove(id)
      else if (opts.remote.pairings.sync) await opts.remote.pairings.sync([...keep])
      else for (const h of await opts.remote.pairings.list()) if (h.kind !== 'agent' && !keep.has(h.pairingId)) await opts.remote.pairings.remove(h.pairingId)
      pending.clear()
      set({ ...state, pendingRemovals: [] })
    },
    async paired(p) {
      if (on()) await opts.remote.pairings.put({ ...p, kind: 'phone' })
    },
    async unpaired(pairingId) {
      // Also while off: a revoked phone must not come back if remote access is turned on later.
      try {
        await opts.remote.pairings.remove(pairingId)
        pending.delete(pairingId)
        set({ ...state, pendingRemovals: [...pending] })
      } catch {
        // The hub keeps answering this phone until it hears: the next sync tells it.
        pending.add(pairingId)
        set({ ...state, pendingRemovals: [...pending], error: 'The hub has not heard that this phone was removed. It will be told when it is reachable.' })
      }
    },
  }
  opts.remote.onPairingRevoked?.((id) => void opts.forget?.(id).catch(() => undefined))
  return api
}

let current: RemoteAccess | null = null
/** The latest relay token, in memory only. undefined until the sign-in state is known. */
let accountToken: string | null | undefined
/** The account's session, in memory only, to mint relay tokens from. */
let accountSession: string | null = null
let mint: ((session: string) => Promise<{ token: string; expiresAt: number } | null>) | null = null
let renew: ReturnType<typeof setTimeout> | undefined
let syncTimer: ReturnType<typeof setInterval> | undefined
let source: PairSource | null = null
const registry = new Set<() => void>()

/** Called when the bridge connects (with its remote methods) and when it goes away (null). */
export function setRemoteAccess(r: RemoteAccess | null): void {
  current = r
  clearInterval(syncTimer)
  syncTimer = undefined
  if (r) {
    // A connection that comes after sign-in still gets the token.
    if (accountToken !== undefined) void r.setToken(accountToken)
    // Removals the hub missed while it was out of reach go out now and every few minutes.
    void r.sync().catch(() => undefined)
    syncTimer = setInterval(() => void r.sync().catch(() => undefined), SYNC_EVERY_MS)
  }
  for (const l of registry) l()
}

/**
 * Where relay tokens come from: the backend's `relay-token` function, which trades the account's
 * session for a short-lived token only the relay accepts. Without it the hub stays on the
 * anonymous tier; the session itself is never handed to the hub.
 */
export function configureRelayTokens(backend: { url: string; anonKey: string } | null): void {
  mint = backend
    ? async (session) => {
        const { relayAudience } = await import('@slicerx/pair')
        const res = await fetch(`${backend.url.replace(/\/+$/, '')}/functions/v1/relay-token`, { method: 'POST', headers: { authorization: `Bearer ${session}`, apikey: backend.anonKey } })
        if (!res.ok) return null
        const body = (await res.json()) as { token?: unknown; expiresAt?: unknown }
        return typeof body.token === 'string' && typeof body.expiresAt === 'number' && relayAudience(body.token) ? { token: body.token, expiresAt: body.expiresAt } : null
      }
    : null
}

/** For tests: mint relay tokens with `fn`. */
export function setRelayTokenMint(fn: typeof mint): void {
  mint = fn
}

async function mintAndPush(): Promise<void> {
  clearTimeout(renew)
  const session = accountSession
  let token: string | null = null
  if (session && mint) {
    const r = await mint(session).catch(() => null)
    if (r) {
      token = r.token
      renew = setTimeout(() => void mintAndPush(), Math.max(30_000, r.expiresAt - Date.now() - 60_000))
    }
  }
  if (accountSession !== session) return
  accountToken = token
  if (current) void current.setToken(token)
}

/** Called by the app entry with the account's session on sign-in and every refresh, and with null on sign-out. */
export function pushAccountToken(session: string | null): void {
  accountSession = session
  if (session === null) {
    // Signed out: the hub forgets its relay token at once.
    clearTimeout(renew)
    accountToken = null
    if (current) void current.setToken(null)
    return
  }
  void mintAndPush()
}

export const getRemoteAccess = (): RemoteAccess | null => current

/** Called by the app entry that builds the pairing host. */
export function setPairSource(s: PairSource | null): void {
  source = s
}

export const pairSource = (): PairSource | null => source

export function useRemoteAccess(): RemoteAccess | null {
  return useSyncExternalStore((cb) => (registry.add(cb), () => registry.delete(cb)), getRemoteAccess, () => null)
}

const NONE: RemoteState = { status: null, busy: false }

export function useRemoteState(r: RemoteAccess | null): RemoteState {
  return useSyncExternalStore((cb) => (r ? r.subscribe(cb) : () => undefined), () => (r ? r.getState() : NONE), () => NONE)
}

export function quotaText(q: RemoteQuota): string {
  const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.round(n / 1e6)} MB`)
  const reset = new Date(q.resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${gb(q.used)} of ${gb(q.cap)} used this month, resets ${reset}. ${q.connections} of ${q.maxConnections} connections.`
}
