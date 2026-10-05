// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds Phone access when the printer bridge connects: the pairing host (identity, pairings, the services a
// paired phone may use) and the LAN listener behind one switch. The app entry only names where the secrets are
// kept (setPairStorage). The pairing code is loaded on first use, so nothing here costs startup while the switch is off.
import type { IdentityStore, PairingStore } from '@slicerx/pair'
import type { ConnectedBridge } from '../../link/bridge'
import type { PhoneAccess, PhoneState } from '../../lib/phone'
import { PHONE_OFF } from '../../lib/phone'
import { getRemoteAccess, type PairSource } from './remote'

export interface PairStorage {
  identity: IdentityStore
  pairings: PairingStore
  /** How this computer shows in a phone's list. */
  name: string
  kind: 'desktop' | 'web'
}

let storage: PairStorage | null = null

/** Called by the app entry, once, with where this build keeps secrets. */
export function setPairStorage(s: PairStorage | null): void {
  storage = s
}

export const pairStorage = (): PairStorage | null => storage

/** The identity and pairings the hub needs for Remote access. */
export function pairSourceFor(s: PairStorage): PairSource {
  return {
    async identity() {
      const { ensureIdentity, defaultEnv } = await import('@slicerx/pair')
      return (await ensureIdentity(s.identity, defaultEnv, s.name, s.kind)).public
    },
    async hostDh() {
      const { ensureIdentity, defaultEnv, toB64url } = await import('@slicerx/pair')
      return toB64url((await ensureIdentity(s.identity, defaultEnv, s.name, s.kind)).dhSecret)
    },
    async pairings() {
      return (await s.pairings.list()).map((r) => ({ pairingId: r.pairingId, deviceKey: r.deviceKey, peer: r.peer, rights: { request: r.rights.request, approve: r.rights.approve } }))
    },
  }
}

/** Phone access over this bridge. Off until switched on; the pairing host is built then. */
export function phoneAccessFor(bridge: ConnectedBridge, s: PairStorage, relayUrl: string | null, port?: number): PhoneAccess {
  let inner: PhoneAccess | null = null
  let state: PhoneState = PHONE_OFF
  const listeners = new Set<() => void>()
  const set = (next: PhoneState) => {
    state = next
    for (const l of listeners) l()
  }
  const build = async (): Promise<PhoneAccess> => {
    if (inner) return inner
    const [{ createPhoneAccess }, pair] = await Promise.all([import('./controller'), import('@slicerx/pair')])
    const lan = bridge.pair
    if (!lan) throw new Error('This bridge cannot serve phones.')
    inner = createPhoneAccess({
      bridge: lan,
      ...(port !== undefined ? { port } : {}),
      ...(relayUrl ? { relayUrl } : {}),
      remote: getRemoteAccess,
      host: async () => {
        const identity = await pair.ensureIdentity(s.identity, pair.defaultEnv, s.name, s.kind)
        return pair.createPairHost({
          identity,
          store: s.pairings,
          kind: s.kind,
          ...(relayUrl ? { endpoints: { lan: [], relay: relayUrl } } : {}),
          services: {
            printers: bridge.printers,
            approvals: bridge.approvals,
            ...(bridge.camera ? { camera: bridge.camera } : {}),
            ...(bridge.push ? { push: bridge.push } : {}),
          },
        })
      },
    })
    inner.subscribe(() => set(inner?.getState() ?? PHONE_OFF))
    return inner
  }
  return {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async setEnabled(on) {
      if (!on && !inner) return
      try {
        await (await build()).setEnabled(on)
      } catch (e) {
        set({ status: 'error', urls: [], devices: state.devices, error: e instanceof Error ? e.message : 'Phone access did not start' })
      }
    },
    async offer() {
      return (await build()).offer()
    },
    async revoke(id) {
      await (await build()).revoke(id)
    },
  }
}
