// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Phone access: the LAN listener behind one switch. Enabling it serves phones
// through the bridge and advertises the addresses; disabling it stops the
// listener and drops the addresses.
import { serveLanThroughBridge, type LanBridge, type LanService, type PairHost } from '@slicerx/pair'
import { PHONE_OFF, type PhoneAccess, type PhoneState } from '../../lib/phone'
import type { RemoteAccess } from './remote'

export interface PhoneAccessOptions {
  /** The pairing host, built on first use so nothing starts while the switch is off. */
  host: () => Promise<PairHost>
  bridge: LanBridge
  /** The relay phones fall back to off the LAN, when the edition has one (wss://). */
  relayUrl?: string | null
  port?: number
  /**
   * Remote access, when the bridge has it. While it is on, the hub answers the pairing routes on the relay, so
   * this controller only tells it which phones are paired; it never attaches the pairing host to the relay.
   */
  remote?: () => Pick<RemoteAccess, 'sync' | 'unpaired'> | null
}

export function createPhoneAccess(opts: PhoneAccessOptions): PhoneAccess {
  let state: PhoneState = PHONE_OFF
  let host: PairHost | null = null
  let lan: LanService | null = null
  let offDevices: (() => void) | null = null
  const listeners = new Set<() => void>()
  const set = (next: PhoneState) => {
    state = next
    for (const l of listeners) l()
  }

  async function refreshDevices(): Promise<void> {
    if (!host) return
    const list = await host.devices()
    set({
      ...state,
      devices: list
        .map((d) => ({ id: d.pairingId, name: d.name, platform: d.platform, online: d.online, ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}) })),
    })
  }

  async function stop(): Promise<void> {
    offDevices?.()
    offDevices = null
    const service = lan
    lan = null
    await service?.stop().catch(() => undefined)
    host?.setEndpoints({ lan: [], ...(opts.relayUrl ? { relay: opts.relayUrl } : {}) })
  }

  return {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async setEnabled(on) {
      if (on === (state.status === 'on' || state.status === 'starting')) return
      if (!on) {
        await stop()
        set({ status: 'off', urls: [], devices: state.devices })
        return
      }
      set({ ...state, status: 'starting' })
      try {
        host ??= await opts.host()
        lan = await serveLanThroughBridge(host, opts.bridge, opts.port)
        host.setEndpoints({ lan: lan.urls, ...(opts.relayUrl ? { relay: opts.relayUrl } : {}) })
        // A new or removed pairing reaches the hub too, so a phone paired a minute ago works away from home.
        offDevices = host.onDevicesChanged(() => void refreshDevices().then(() => opts.remote?.()?.sync()).catch(() => undefined))
        set({ status: 'on', urls: lan.urls, devices: state.devices })
        await refreshDevices()
      } catch (e) {
        await stop()
        set({ status: 'error', urls: [], devices: state.devices, error: e instanceof Error ? e.message : 'The listener did not start' })
      }
    },
    async offer() {
      if (!host || (state.status !== 'on' && state.status !== 'starting')) throw new Error('Turn on phone access first.')
      return host.createOffer()
    },
    async revoke(deviceId) {
      await host?.revoke(deviceId)
      await opts.remote?.()?.unpaired(deviceId)
      await refreshDevices()
    },
  }
}
