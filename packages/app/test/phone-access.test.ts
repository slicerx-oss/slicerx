// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { LanBridge, PairHost } from '@slicerx/pair'
import { describe, expect, it, vi } from 'vitest'
import { createPhoneAccess } from '../src/features/phone/controller'

function fakes(listenFails = false) {
  const listen = vi.fn(async (enabled: boolean) => {
    if (listenFails && enabled) throw new Error('port in use')
    return enabled ? { listening: true, port: 47616, addresses: ['192.168.1.20', 'fe80::1%en0', '8.8.8.8'] } : { listening: false }
  })
  const bridge: LanBridge = { listen, send: async () => undefined, close: async () => undefined, onFrame: () => () => undefined, onClosed: () => () => undefined }
  let changed: () => void = () => undefined
  const setEndpoints = vi.fn()
  const host = {
    handlePipe: vi.fn(),
    setEndpoints,
    devices: async () => [{ pairingId: 'p1', deviceId: 'd1', name: 'Pixel', platform: 'android', online: true, rights: {}, createdAt: 1, accountLinked: false }],
    revoke: vi.fn(async () => undefined),
    onDevicesChanged: (cb: () => void) => {
      changed = cb
      return () => undefined
    },
  } as unknown as PairHost
  return { bridge, host, listen, setEndpoints, fire: () => changed() }
}

describe('phone access', () => {
  it('is off until switched on, and builds nothing while off', () => {
    const { bridge } = fakes()
    const host = vi.fn()
    const p = createPhoneAccess({ host, bridge })
    expect(p.getState().status).toBe('off')
    expect(host).not.toHaveBeenCalled()
  })

  it('serves the LAN, advertises private addresses and lists paired phones', async () => {
    const f = fakes()
    const p = createPhoneAccess({ host: async () => f.host, bridge: f.bridge, relayUrl: 'wss://relay.example/v1' })
    await p.setEnabled(true)
    const s = p.getState()
    expect(s.status).toBe('on')
    expect(s.urls).toEqual(['ws://192.168.1.20:47616/pair'])
    expect(f.setEndpoints).toHaveBeenCalledWith({ lan: ['ws://192.168.1.20:47616/pair'], relay: 'wss://relay.example/v1' })
    expect(s.devices).toMatchObject([{ id: 'p1', name: 'Pixel', online: true }])
  })

  it('stops the listener and clears the addresses when switched off', async () => {
    const f = fakes()
    const p = createPhoneAccess({ host: async () => f.host, bridge: f.bridge })
    await p.setEnabled(true)
    await p.setEnabled(false)
    expect(p.getState()).toMatchObject({ status: 'off', urls: [] })
    expect(f.listen).toHaveBeenLastCalledWith(false)
    expect(f.setEndpoints).toHaveBeenLastCalledWith({ lan: [] })
  })

  it('reports a listener that did not start', async () => {
    const f = fakes(true)
    const p = createPhoneAccess({ host: async () => f.host, bridge: f.bridge })
    await p.setEnabled(true)
    expect(p.getState()).toMatchObject({ status: 'error', error: 'port in use', urls: [] })
  })

  it('removes a paired phone', async () => {
    const f = fakes()
    const p = createPhoneAccess({ host: async () => f.host, bridge: f.bridge })
    await p.setEnabled(true)
    await p.revoke('p1')
    expect(f.host.revoke).toHaveBeenCalledWith('p1')
  })
})
