// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pinning the printer bridge's identity. The first pairing in the browser remembers the hub's public key for that
// address; every later connect passes it, and the link client then sends no code to a program that cannot prove it
// holds that key. The desktop app gets the key from its own shell instead (LinkInfo.hubKey).

const DEFAULT_URL = 'ws://127.0.0.1:47615'
const STORE = 'slicerx.hubKeys'

export interface HubPins {
  get(url: string): string | undefined
  set(url: string, key: string): void
  /** Forgets the key for one hub address. */
  clear?(url: string): void
}

/** Pins kept in this browser's local storage, one key per hub address. Works without storage, remembering nothing. */
export function localHubPins(): HubPins {
  const read = (): Record<string, string> => {
    try {
      const v = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? '{}') as unknown
      return v && typeof v === 'object' ? (v as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  return {
    get: (url) => read()[url],
    set: (url, key) => {
      try {
        globalThis.localStorage?.setItem(STORE, JSON.stringify({ ...read(), [url]: key }))
      } catch {
        // Private windows and blocked storage: the next connect simply pairs without a pin.
      }
    },
    clear: (url) => {
      try {
        const { [url]: _gone, ...rest } = read()
        if (Object.keys(rest).length) globalThis.localStorage?.setItem(STORE, JSON.stringify(rest))
        else globalThis.localStorage?.removeItem(STORE)
      } catch {
        // Nothing was stored, so nothing to forget.
      }
    },
  }
}

/** True when this browser remembers a hub key for the address. */
export function hubPinned(url: string = DEFAULT_URL, pins: HubPins = localHubPins()): boolean {
  return pins.get(url) !== undefined
}

/**
 * Forgets the remembered hub key, so the next pairing trusts whichever bridge answers and pins that one.
 * For a bridge that was reinstalled or moved on purpose. Returns false when nothing was remembered.
 */
export function forgetHub(url: string = DEFAULT_URL, pins: HubPins = localHubPins()): boolean {
  if (pins.get(url) === undefined) return false
  pins.clear?.(url)
  return pins.get(url) === undefined
}

export const HUB_MISMATCH = 'Warning: the program on this port is not the hub you paired with, or it could not prove who it is. Your pairing code was not sent. If you reinstalled the bridge on purpose, compare fingerprints in Settings, Printers before you trust it.'

/** The hub-mismatch warning, with the key the program on the port signed with when it proved one. */
export class HubMismatchError extends Error {
  readonly presentedKey?: string
  constructor(presentedKey?: string) {
    super(HUB_MISMATCH)
    this.name = 'HubMismatchError'
    if (presentedKey) this.presentedKey = presentedKey
  }
}

/** The key this browser trusts for a hub address, if any. */
export function pinnedHubKey(url: string = DEFAULT_URL, pins: HubPins = localHubPins()): string | undefined {
  return pins.get(url)
}

/**
 * Trusts one hub key for the address, after the person compared its fingerprint with what `sx-link code` prints.
 * Only that key then gets the code, so nothing else can slip in between the check and the pairing.
 */
export function trustHub(key: string, url: string = DEFAULT_URL, pins: HubPins = localHubPins()): void {
  pins.set(url, key)
}

type ConnectFn<T> = (o: { url?: string; code: string; hubKey?: string; appId?: string }) => Promise<T>

/**
 * Connects with the pinned key for this hub when there is one, and pins the key the hub proved after the first
 * pairing. A hub that fails the check surfaces as a plain warning; nothing was sent to it.
 */
export async function connectPinned<T extends { hubKey?: string }>(connect: ConnectFn<T>, opts: { url?: string; code: string }, pins: HubPins = localHubPins()): Promise<T> {
  const address = opts.url ?? DEFAULT_URL
  const pinned = pins.get(address)
  let link: T
  try {
    link = await connect({ ...opts, ...(pinned ? { hubKey: pinned } : {}), appId: appInstallId() })
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'hub_identity') throw new HubMismatchError((e as { presentedKey?: string }).presentedKey)
    throw e
  }
  if (!pinned && link.hubKey) pins.set(address, link.hubKey)
  return link
}

const APP_ID = 'slicerx.appId'
let sessionAppId: string | undefined

/**
 * A random id for this app install, kept in local storage. The hub tags the phones this app pairs with it, so
 * two apps on one hub (the desktop app and a browser) never unpair each other's phones. Without storage it
 * lasts for this session.
 */
export function appInstallId(): string {
  try {
    const kept = globalThis.localStorage?.getItem(APP_ID)
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept
  } catch {
    // No storage: the session id below.
  }
  sessionAppId ??= Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  try {
    globalThis.localStorage?.setItem(APP_ID, sessionAppId)
  } catch {
    // Not kept; still unique for this session.
  }
  return sessionAppId
}

/** What the desktop shell's `link_start` returns, as connect options. The shell started the hub, so its key is trusted from the start. */
export function shellLinkOptions(info: { url: string; code: string; hubKey?: string }): { url: string; code: string; hubKey?: string; appId: string } {
  return { url: info.url, code: info.code, ...(info.hubKey ? { hubKey: info.hubKey } : {}), appId: appInstallId() }
}
