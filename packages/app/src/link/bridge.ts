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
import { get, set, toast } from '../state/store'
import { promoteHandPrinters, withHandPrinters } from '../lib/hand-printers'

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
  /** Service plugins the hub talks to (Spoolman), set up in Settings, Printers. */
  services?: BridgeServices
  /** The relay this edition uses for remote access (wss://), if any. */
  relayUrl?: string | null
  /** The hub's public key, as it proved it on connect. Its fingerprint is shown in Settings. */
  hubKey?: string
  close(): void
}

/** The hub's service settings (`services.*`). Addresses only; a secret never comes back. */
export interface BridgeServices {
  list(): Promise<{ pluginId: string; baseUrl: string; hasSecret: boolean }[]>
  configure(pluginId: 'spoolman' | 'home-assistant', baseUrl: string): Promise<void>
  remove(pluginId: string): Promise<boolean>
}

/** The bridge's printer setup calls (`createPrinterSetup` in @slicerx/connect satisfies it). */
export interface BridgeSetup {
  discover(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FoundPrinter[]>
  probe?(host: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FoundPrinter[]>
  testConnection(input: PrinterConnection): Promise<Parameters<typeof fromLinkResult>[0]>
  addPrinter(input: { profileId: string; nozzleMm: number; connection?: PrinterConnection; name?: string }): Promise<{ printerId: string }>
}

export interface BridgeConnector {
  /** True when the app starts the bridge itself and needs no code (desktop). */
  automatic: boolean
  /** Connects. `code` is the pairing code for a bridge the person started. */
  connect(code?: string): Promise<ConnectedBridge>
}

let connector: BridgeConnector | null = null
let live: { bridge: ConnectedBridge; before: Pick<Host, 'printers' | 'approvals' | 'secrets'>; caps: Pick<Host['capabilities'], 'printers' | 'secureStorage'> } | null = null

export function setBridgeConnector(c: BridgeConnector | null): void {
  connector = c
  set({ bridgeStatus: { state: 'off' } })
}

export const bridgeConnector = (): BridgeConnector | null => connector

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
export function connectBridge(host: Host, code?: string): Promise<boolean> {
  connecting ??= connect(host, code).finally(() => {
    connecting = null
  })
  return connecting
}

async function connect(host: Host, code?: string): Promise<boolean> {
  if (!connector) return false
  if (live) return true
  set({ bridgeStatus: { state: 'connecting' } })
  try {
    const bridge = await connector.connect(code)
    live = { bridge, before: { printers: host.printers, approvals: host.approvals, secrets: host.secrets } as Pick<Host, 'printers' | 'approvals' | 'secrets'>, caps: { printers: host.capabilities.printers, secureStorage: host.capabilities.secureStorage } }
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
    set((s) => ({ bridgeStatus: { state: 'on', ...(bridge.hubKey ? { hubKey: bridge.hubKey } : {}) }, linkEpoch: s.linkEpoch + 1, fleetRefresh: Date.now() }))
    toast('Connected to the printer bridge', 'ok')
    return true
  } catch (e) {
    const presentedKey = (e as { presentedKey?: unknown } | null)?.presentedKey
    set({ bridgeStatus: { state: 'error', message: explain(e), ...(typeof presentedKey === 'string' ? { presentedKey } : {}) } })
    return false
  }
}

export function disconnectBridge(host: Host): void {
  if (!live) return
  const { bridge, before, caps } = live
  live = null
  host.capabilities.printers = caps.printers
  host.capabilities.secureStorage = caps.secureStorage
  host.secrets = before.secrets
  stopCards?.()
  stopCards = null
  stopFinished?.()
  stopFinished = null
  setRemoteAccess(null)
  setPairSource(null)
  setPhoneAccess(null)
  bridge.close()
  if (before.printers) host.printers = before.printers
  else delete host.printers
  registerPrinterSetup(null)
  if (before.approvals) host.approvals = before.approvals
  else delete host.approvals
  set((s) => ({ bridgeStatus: { state: 'off' }, linkEpoch: s.linkEpoch + 1, fleetRefresh: Date.now() }))
}

/** For tests: forget the live connection without closing anything. */
export function resetBridge(): void {
  stopCards?.()
  stopCards = null
  stopFinished?.()
  stopFinished = null
  live = null
  connector = null
  connecting = null
}

/** The connected bridge, for screens that use its extra methods. */
export const liveBridge = (): ConnectedBridge | null => live?.bridge ?? null

export function bridgeConnected(): boolean {
  return get().bridgeStatus.state === 'on'
}
