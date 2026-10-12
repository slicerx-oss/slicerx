// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer bridge (sx-link) as the app sees it. The app entry registers a connector; connecting swaps the
// host's demo printers for the bridge's real ones, and its approval broker, camera streams and printer setup
// with them. The desktop app starts its own bridge and connects by itself; the browser build asks the person
// for the pairing code sx-link printed.
import type { ApprovalHost, Host, PrinterHost, PrinterConnection, SecretsHost } from '@slicerx/contracts'
import type { CameraStreams } from '../camera/stream'
import { fromLinkResult, registerPrinterSetup, type AppSetupHost, type FoundPrinter } from '../first-run/setup-registry'
import { createRemoteAccess, pairSource, setPairSource, setRemoteAccess, type BridgeRemote } from '../features/phone/remote'
import { pairSourceFor, pairStorage, phoneAccessFor } from '../features/phone/wire'
import { getPhoneAccess, setPhoneAccess } from '../lib/phone'
import { appStore, get, set, toast } from '../state/store'
import { promoteHandPrinters, withHandPrinters } from '../lib/hand-printers'
import { bridgeConnector, forgetConnector, reconnects } from './connector'

/** What a connected bridge gives the app. */
export interface ConnectedBridge {
  printers: PrinterHost
  approvals: ApprovalHost
  /** Live camera streams, when the bridge has them. */
  streams?: CameraStreams
  setup: BridgeSetup
  /** Printer credentials go to the bridge's keychain, write only. */
  secrets?: SecretsHost
  /** The hub's remote access methods (remote.*), when the link client has them. */
  remote?: BridgeRemote
  /** LAN listener, camera and push of the hub, which Phone access hands to paired phones. */
  pair?: import('@slicerx/pair').LanBridge
  camera?: import('@slicerx/pair').PairCameraSource
  push?: import('@slicerx/pair').PairPushHub
  /** The print watch's per-printer settings, when the hub has them (watch.huginn). */
  watch?: { huginnPrinters(): Promise<string[]>; setHuginn(printerId: string, enabled: boolean): Promise<void> }
  /** Connected apps the hub talks to (Spoolman, BamBuddy), set up in Settings, Connected apps. */
  services?: BridgeServices
  /** The hub's own settings: whether it accepts experimental connectors. Absent on an older hub. */
  hubSettings?: { get(): Promise<{ experimentalConnectors: boolean }>; set(patch: { experimentalConnectors: boolean }): Promise<{ experimentalConnectors: boolean }> }
  /** The relay this edition uses for remote access (wss://), if any. */
  relayUrl?: string | null
  /** The hub's public key, as it proved it on connect. Its fingerprint is shown in Settings. */
  hubKey?: string
  /** Keys the hub remembers: partner app keys (Connect your AI agent) and the Devices list (Printer bridge). */
  clients?: BridgeClients
  /** The app link's app side (app-link/host.ts): the desktop app only, never the browser build. */
  appLink?: BridgeAppLink
  /** Runs once when the connection ends: `requested` after close(), false when it dropped. Absent on an older client. */
  onDisconnect?(cb: (info: { requested: boolean }) => void): () => void
  close(): void
}

/** The hub's app link, as the app hosting it sees it (packages/connect/link/src/app_link.rs). */
export interface BridgeAppLink {
  /** The person's switch, kept by the hub. */
  isOn(): Promise<boolean>
  setOn(on: boolean): Promise<boolean>
  host(): Promise<{ on: boolean; origin?: string | null }>
  onCall(cb: (c: { callId: number; method: string; args: Record<string, unknown>; client: { id: string; name: string } }) => void): () => void
  onAsk(cb: (a: { askId: number; clientId: string; name: string; createdAt: string }) => void): () => void
  onAskEnded(cb: (askId: number) => void): () => void
  reply(callId: number, out: { ok: true; value: unknown } | { ok: false; code: string; message: string }): Promise<void>
  answer(askId: number, decision: 'allow' | 'read' | 'deny'): Promise<void>
  grants(): Promise<{ clientId: string; name: string; rights: 'read' | 'edit' | null; grantedAt: string | null; denied: boolean }[]>
  revoke(clientId: string): Promise<void>
}

/** A key the hub remembers, as Devices lists it. Never the key itself. */
export interface RememberedClient {
  id: string
  name: string
  role: 'app' | 'agent' | 'watch'
  /** A partner app's key. */
  partner?: boolean
  createdAt: string
  /** Null for a partner key nobody has used yet. */
  lastSeenAt: string | null
}

/** The hub's `clients.*`, app role only. */
export interface BridgeClients {
  /** A partner app key (agent role with the partner limits). The key is in this reply once and never again. */
  createPartner(name: string): Promise<{ clientId: string; clientKey: string }>
  list(): Promise<RememberedClient[]>
  /** Also closes the client's open connections. */
  revoke(clientId: string): Promise<void>
}

/**
 * The hub's connected apps (`services.*`). Addresses only: a key goes to the hub's secrets store with
 * `secrets.set`, `configure` names it (`secretRef`), and a secret never comes back.
 */
export interface BridgeServices {
  list(): Promise<{ pluginId: string; baseUrl: string; hasSecret: boolean }[]>
  configure(pluginId: 'spoolman' | 'home-assistant' | 'bambuddy', baseUrl: string, secretRef?: string): Promise<void>
  remove(pluginId: string): Promise<boolean>
  /** Whether a connected app answers at its address with its key, and how many printers it lists (BamBuddy). Absent on an older hub. */
  check?(pluginId: 'bambuddy'): Promise<{ ok: true; printers: number }>
}

/** The bridge's printer setup calls (`createPrinterSetup` in @slicerx/connect satisfies it). */
export interface BridgeSetup {
  discover(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FoundPrinter[]>
  probe?(host: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FoundPrinter[]>
  testConnection(input: PrinterConnection): Promise<Parameters<typeof fromLinkResult>[0]>
  addPrinter(input: { profileId: string; nozzleMm: number; connection?: PrinterConnection; name?: string }): Promise<{ printerId: string }>
}

let live: { bridge: ConnectedBridge; before: Pick<Host, 'printers' | 'approvals' | 'secrets'>; caps: Pick<Host['capabilities'], 'printers' | 'secureStorage'> } | null = null

export { bridgeConnector, setBridgeConnector, type BridgeConnector } from './connector'

/** The setup host for the setup screens when a bridge is connected: the bridge does discovery, tests and adds. */
function setupFor(_host: Host, setup: BridgeSetup): AppSetupHost {
  return {
    keychain: true,
    scanRange: 'Your local network',
    // The profile library loads with the setup screens, not with the shell.
    searchProfiles: async (query) => {
      const { searchModels, brandById } = await import('@slicerx/printer-catalog')
      return searchModels(query).map((m) => ({ id: m.id, vendor: brandById(m.brand)?.name ?? m.brand, model: m.name, nozzles: [...m.nozzles] }))
    },
    discover: (opts) => setup.discover(opts),
    ...(setup.probe ? { probe: (host: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => setup.probe!(host, opts) } : {}),
    async testConnection(connection, onStep) {
      const outcome = fromLinkResult(await setup.testConnection(connection))
      onStep?.(outcome.steps)
      return outcome
    },
    addPrinter: (input) => setup.addPrinter(input),
  }
}

function explain(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  // A real bridge answers with a code ("unauthorized") and its own words ("wrong pairing code").
  const code = (e as { code?: string } | null)?.code ?? ''
  if (code === 'unauthorized' || /unauthorized|wrong pairing code/i.test(text)) return 'That pairing code was not accepted.'
  if (code === 'locked' || /locked/i.test(text)) return 'Too many wrong codes. Wait a minute and try again.'
  return text || 'Could not reach the bridge.'
}

let stopCards: (() => void) | null = null
let stopFinished: (() => void) | null = null
let stopGuard: (() => void) | null = null
let stopLink: (() => void) | null = null

/** Cards the hub raises (an AI agent's start, a queued plate whose turn came) show in the approval dialog. Loaded with the first connection. */
function watchCards(bridge: ConnectedBridge): void {
  const cards = bridge.approvals as Partial<import('./agent-cards').HubCards>
  if (typeof cards.onRequest !== 'function' || typeof cards.grantWith !== 'function' || typeof cards.deny !== 'function') return
  void import('./agent-cards').then(({ watchHubCards, printerLabels }) => {
    if (live?.bridge !== bridge) return
    let names = new Map<string, string>()
    const refresh = () =>
      bridge.printers.list().then(
        (list) => void (names = printerLabels(list)),
        () => undefined,
      )
    void refresh()
    stopCards = watchHubCards(cards as import('./agent-cards').HubCards, (id) => names.get(id) ?? id, refresh)
  })
}

let connecting: Promise<boolean> | null = null

/** Connects the bridge and puts its printers in the host. Resolves true when connected. A call while one runs waits for it. */
export function connectBridge(host: Host, code?: string, again = false): Promise<boolean> {
  connecting ??= connect(host, code, again).finally(() => {
    connecting = null
  })
  return connecting
}

async function connect(host: Host, code?: string, again = false): Promise<boolean> {
  const connector = bridgeConnector()
  if (!connector) return false
  if (live) return true
  if (!again) set({ bridgeStatus: { state: 'connecting' } })
  try {
    const bridge = await connector.connect(code)
    // After a dropped connection the host holds the dead connection's printers; what it had before that is kept.
    const before = again && kept ? kept.before : ({ printers: host.printers, approvals: host.approvals, secrets: host.secrets } as Pick<Host, 'printers' | 'approvals' | 'secrets'>)
    const caps = again && kept ? kept.caps : { printers: host.capabilities.printers, secureStorage: host.capabilities.secureStorage }
    kept = null
    live = { bridge, before, caps }
    host.capabilities.printers = 'link'
    if (bridge.secrets) {
      host.secrets = bridge.secrets
      host.capabilities.secureStorage = true
    }
    // Printers added by hand stay listed next to the bridge's.
    host.printers = withHandPrinters(Object.assign(bridge.printers, bridge.streams ? { streams: bridge.streams } : {}))
    host.approvals = bridge.approvals
    registerPrinterSetup((h) => setupFor(h, bridge.setup))
    // One saved by hand with an address the bridge can reach without a code becomes a real connection.
    void promoteHandPrinters((input) => bridge.setup.addPrinter(input))
    watchCards(bridge)
    // The app link answers agents' calls on the open project once the person turns it on (Settings, Agents).
    if (bridge.appLink) {
      void import('../app-link/host').then((m) => {
        if (live?.bridge === bridge) stopLink = m.hostAppLink(bridge.appLink!)
      })
    }
    // The camera guard brings a tripped printer's card up on the Printers tab. It listens before the bridge counts as
    // connected: a trip that came while its module loaded would reach the list but bring no card up.
    const guard = await import('../features/fleet/guard').catch(() => null)
    if (live?.bridge !== bridge) return false
    if (guard) stopGuard = guard.watchGuard(host)
    // A finished print offers to subtract its filament from the linked Spoolman spools.
    void Promise.all([import('../inventory/usage'), import('../state/actions')]).then(([u, a]) => {
      if (live?.bridge === bridge) stopFinished = u.watchFinishedPrints(host, a.recordSpoolUse)
    })
    const storage = pairStorage()
    if (storage && bridge.pair) {
      setPairSource(pairSourceFor(storage))
      setPhoneAccess(phoneAccessFor(bridge, storage, bridge.relayUrl ?? null))
    }
    if (bridge.remote) {
      // A phone that removed itself through the hub is forgotten here too, so the next sync does not hand it back.
      const forget = async (id: string) => {
        await storage?.pairings.delete(id)
        await getPhoneAccess()?.revoke(id)
      }
      setRemoteAccess(createRemoteAccess({ remote: bridge.remote, source: pairSource(), relayUrl: bridge.relayUrl ?? null, forget }))
    }
    // A connection that drops (the hub stopped, the page was suspended) comes back on its own; one closed on purpose does not.
    stopWatchClose =
      bridge.onDisconnect?.(({ requested }) => {
        if (!requested) lost(host, bridge)
      }) ?? null
    set((s) => ({ bridgeStatus: { state: 'on', ...(bridge.hubKey ? { hubKey: bridge.hubKey } : {}) }, linkEpoch: s.linkEpoch + 1, fleetRefresh: Date.now() }))
    toast(again ? 'Reconnected to the printer bridge' : 'Connected to the printer bridge', 'ok')
    return true
  } catch (e) {
    if (again) return false
    const presentedKey = (e as { presentedKey?: unknown } | null)?.presentedKey
    set({ bridgeStatus: { state: 'error', message: explain(e), ...(typeof presentedKey === 'string' ? { presentedKey } : {}) } })
    return false
  }
}

let stopWatchClose: (() => void) | null = null
/** What the host had before the bridge, kept while a dropped connection reconnects. */
let kept: { before: Pick<Host, 'printers' | 'approvals' | 'secrets'>; caps: Pick<Host['capabilities'], 'printers' | 'secureStorage'> } | null = null
/** Bumped by every connect, disconnect and loss, so a reconnect loop that is no longer wanted stops. */
let generation = 0

/** Waits between reconnect tries; the last repeats. Tests set them shorter. */
export const RECONNECT_DELAYS_MS: number[] = [500, 1000, 2000, 4000, 8000, 15000]

/** The live connection dropped: its printers leave the host until it is back. It reconnects on its own when it can. */
function lost(host: Host, bridge: ConnectedBridge): void {
  if (live?.bridge !== bridge) return
  const { before, caps } = live
  teardown(host)
  const mine = ++generation
  if (reconnects(bridgeConnector())) {
    // Until it is back the dropped connection's printers stay in the host: calls fail as closed, and no other
    // printers (the demo's) stand in for them. What the host had before the bridge comes back on a disconnect.
    kept = { before, caps }
    host.printers = bridge.printers
    host.capabilities.printers = 'link'
  } else {
    set((s) => ({ bridgeStatus: { state: 'error', message: 'The connection to the printer bridge closed. Connect again.' }, linkEpoch: s.linkEpoch + 1, fleetRefresh: Date.now() }))
    return
  }
  set((s) => ({ bridgeStatus: { state: 'reconnecting', attempt: 1 }, linkEpoch: s.linkEpoch + 1, fleetRefresh: Date.now() }))
  void (async () => {
    for (let attempt = 1; ; attempt++) {
      const wait = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)] ?? 15000
      await new Promise((r) => setTimeout(r, wait))
      if (mine !== generation || live || !reconnects(bridgeConnector())) return
      set({ bridgeStatus: { state: 'reconnecting', attempt } })
      const ok = await connectBridge(host, undefined, true)
      if (ok) return
      if (mine !== generation) return
    }
  })()
}

/**
 * Waits up to `ms` for the bridge to be connected again, as after a dropped connection. True when it is; false when
 * it is off, failed, or still away at the end.
 */
export function bridgeBack(ms: number): Promise<boolean> {
  const now = get().bridgeStatus.state
  if (now === 'on') return Promise.resolve(true)
  if (now !== 'reconnecting' && now !== 'connecting') return Promise.resolve(false)
  return new Promise((resolve) => {
    let off: () => void = () => undefined
    const done = (v: boolean) => {
      clearTimeout(timer)
      off()
      resolve(v)
    }
    const timer = setTimeout(() => done(get().bridgeStatus.state === 'on'), ms)
    off = appStore.subscribe((s) => {
      if (s.bridgeStatus.state === 'on') done(true)
      else if (s.bridgeStatus.state === 'off' || s.bridgeStatus.state === 'error') done(false)
    })
  })
}

export function disconnectBridge(host: Host): void {
  generation++
  if (!live) {
    if (kept) {
      if (kept.before.printers) host.printers = kept.before.printers
      else delete host.printers
      host.capabilities.printers = kept.caps.printers
      kept = null
    }
    if (get().bridgeStatus.state === 'reconnecting') set((s) => ({ bridgeStatus: { state: 'off' }, linkEpoch: s.linkEpoch + 1, fleetRefresh: Date.now() }))
    return
  }
  const bridge = teardown(host)
  bridge.close()
  set((s) => ({ bridgeStatus: { state: 'off' }, linkEpoch: s.linkEpoch + 1, fleetRefresh: Date.now() }))
}

/** Takes the live bridge's printers and services out of the host and stops what watched them. Returns that bridge. */
function teardown(host: Host): ConnectedBridge {
  const { bridge, before, caps } = live!
  live = null
  stopWatchClose?.()
  stopWatchClose = null
  host.capabilities.printers = caps.printers
  host.capabilities.secureStorage = caps.secureStorage
  host.secrets = before.secrets
  stopCards?.()
  stopCards = null
  stopFinished?.()
  stopFinished = null
  stopGuard?.()
  stopGuard = null
  stopLink?.()
  stopLink = null
  setRemoteAccess(null)
  setPairSource(null)
  setPhoneAccess(null)
  if (before.printers) host.printers = before.printers
  else delete host.printers
  registerPrinterSetup(null)
  if (before.approvals) host.approvals = before.approvals
  else delete host.approvals
  return bridge
}

/** For tests: forget the live connection without closing anything. */
export function resetBridge(): void {
  stopCards?.()
  stopCards = null
  stopFinished?.()
  stopFinished = null
  stopWatchClose?.()
  stopWatchClose = null
  generation++
  kept = null
  live = null
  forgetConnector()
  connecting = null
}

/** The connected bridge, for screens that use its extra methods. */
export const liveBridge = (): ConnectedBridge | null => live?.bridge ?? null

export function bridgeConnected(): boolean {
  return get().bridgeStatus.state === 'on'
}
