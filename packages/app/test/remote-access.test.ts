// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PairHost } from '@slicerx/pair'
import { createPhoneAccess } from '../src/features/phone/controller'
import { createRemoteAccess, quotaText, type BridgeRemote, type RemotePairing, type RemoteStatus } from '../src/features/phone/remote'

const me = { deviceId: 'a'.repeat(22), signPub: 's'.repeat(43), dhPub: 'd'.repeat(43), name: 'Studio Mac', platform: 'macos' }
const phone = (id: string): RemotePairing => ({ pairingId: id, deviceKey: 'k'.repeat(43), peer: { ...me, name: `Phone ${id}`, platform: 'ios' }, rights: { request: true, approve: true } })

function hub(start: { pairings?: { pairingId: string; kind?: 'phone' | 'agent' }[] } = {}) {
  const calls: string[] = []
  let status: RemoteStatus = { enabled: false, relay: null, connected: false, sessions: 0, pairings: 0, lastError: null, quota: null }
  let held = [...(start.pairings ?? [])]
  const remote: BridgeRemote = {
    status: async () => status,
    configure: async (o) => {
      calls.push(`configure ${o.enabled} ${o.relay ?? ''} ${o.host?.name ?? ''} ${o.hostDh ?? ''}`.trim())
      status = { ...status, enabled: o.enabled, relay: o.relay ?? status.relay, connected: o.enabled }
      return status
    },
    quota: async () => ({ ...status, quota: { tier: 'anonymous', used: 250e6, cap: 1e9, resetsAt: Date.UTC(2026, 10, 1), connections: 1, maxConnections: 4 } }),
    pairings: {
      put: async (p) => {
        calls.push(`put ${p.pairingId} ${p.kind}`)
        held = [...held.filter((h) => h.pairingId !== p.pairingId), { pairingId: p.pairingId, kind: p.kind }]
      },
      remove: async (id) => {
        calls.push(`remove ${id}`)
        held = held.filter((h) => h.pairingId !== id)
      },
      list: async () => held,
    },
  }
  return { remote, calls }
}

describe('remote access', () => {
  it('is off until asked, then configures the hub with the pair identity and hands it every pairing', async () => {
    const h = hub({ pairings: [{ pairingId: 'gone', kind: 'phone' }, { pairingId: 'agent-1', kind: 'agent' }] })
    const local = [phone('p1'), phone('p2')]
    const r = createRemoteAccess({ remote: h.remote, source: { identity: async () => me, hostDh: async () => 'host-dh', pairings: async () => local }, relayUrl: 'wss://relay.example.invalid' })
    await r.refresh()
    expect(r.getState().status?.enabled).toBe(false)
    expect(r.ownsRelayRoutes()).toBe(false)
    expect(h.calls).toEqual([])
    await r.setEnabled(true)
    // Phones unpaired here are dropped; the hub's own agent pairings stay.
    expect(h.calls).toEqual(['configure true wss://relay.example.invalid Studio Mac host-dh', 'put p1 phone', 'put p2 phone', 'remove gone'])
    expect(r.ownsRelayRoutes()).toBe(true)
    expect(r.getState().status?.quota?.cap).toBe(1e9)
    await r.paired(phone('p3'))
    await r.unpaired('p1')
    expect(h.calls.slice(-2)).toEqual(['put p3 phone', 'remove p1'])
    await r.setEnabled(false)
    expect(h.calls.at(-1)).toBe('configure false')
    await r.paired(phone('p4'))
    expect(h.calls.at(-1)).toBe('configure false')
  })

  it('says why it cannot turn on without a relay or a pair identity, and changes nothing', async () => {
    const h = hub()
    const noRelay = createRemoteAccess({ remote: h.remote, source: { identity: async () => me, hostDh: async () => 'host-dh', pairings: async () => [] }, relayUrl: null })
    await noRelay.setEnabled(true)
    expect(noRelay.getState().error).toMatch(/no relay/)
    const noSource = createRemoteAccess({ remote: h.remote, source: null, relayUrl: 'wss://relay.example.invalid' })
    await noSource.setEnabled(true)
    expect(noSource.getState().error).toMatch(/pair a phone first/)
    expect(h.calls).toEqual([])
  })

  it('reads the quota in plain words', () => {
    expect(quotaText({ tier: 'anonymous', used: 250e6, cap: 1e9, resetsAt: Date.UTC(2026, 10, 1, 12), connections: 1, maxConnections: 4 })).toBe('250 MB of 1.0 GB used this month, resets Nov 1. 1 of 4 connections.')
  })

  it('never attaches the pairing host to the relay, and tells the hub about pairings and revokes', async () => {
    const told: string[] = []
    let changed: () => void = () => undefined
    const host = {
      attachRelay: () => {
        throw new Error('the hub answers the relay routes')
      },
      setEndpoints: () => undefined,
      devices: async () => [],
      onDevicesChanged: (cb: () => void) => ((changed = cb), () => undefined),
      revoke: async () => undefined,
      handlePipe: () => undefined,
    } as unknown as PairHost
    const bridge = { listen: async () => ({ urls: ['ws://192.168.1.20:47616/pair'], stop: async () => undefined, onPipe: () => () => undefined }) }
    const access = createPhoneAccess({ host: async () => host, bridge: bridge as never, relayUrl: 'wss://relay.example.invalid', remote: () => ({ sync: async () => void told.push('sync'), unpaired: async (id) => void told.push(`unpaired ${id}`) }) })
    await access.setEnabled(true)
    if (access.getState().status === 'on') {
      changed()
      await new Promise((r) => setTimeout(r, 0))
      expect(told).toContain('sync')
    }
    await access.revoke('p1')
    expect(told).toContain('unpaired p1')
  })

  it('hands the hub a relay token minted from the session, never the session itself (M4)', async () => {
    const { pushAccountToken, setRemoteAccess, setRelayTokenMint } = await import('../src/features/phone/remote')
    const tick = () => new Promise((x) => setTimeout(x, 0))
    const tokens: (string | null)[] = []
    const h = hub()
    const withToken: BridgeRemote = { ...h.remote, setToken: async (t) => (tokens.push(t), { enabled: false, relay: null, connected: false, sessions: 0, pairings: 0, lastError: null, quota: null, signedIn: t !== null }) }
    // Without a backend to mint relay tokens the hub stays anonymous: the session is not passed on.
    setRelayTokenMint(null)
    const r = createRemoteAccess({ remote: withToken, source: null })
    setRemoteAccess(r)
    pushAccountToken('session-0')
    await tick()
    expect(tokens).toEqual([null])
    const minted: string[] = []
    setRelayTokenMint(async (session) => (minted.push(session), { token: `relay-${minted.length}`, expiresAt: Date.now() + 600_000 }))
    pushAccountToken('session-1')
    await tick()
    pushAccountToken('session-2')
    await tick()
    pushAccountToken(null)
    await tick()
    expect(minted).toEqual(['session-1', 'session-2'])
    expect(tokens).toEqual([null, 'relay-1', 'relay-2', null])
    expect(JSON.stringify(r.getState())).not.toContain('session-')
    setRemoteAccess(null)
    setRelayTokenMint(null)
  })

  it('remembers a removal the hub did not hear and sends it at the next sync (M1)', async () => {
    const h = hub({ pairings: [{ pairingId: 'p1', kind: 'phone' }, { pairingId: 'p2', kind: 'phone' }, { pairingId: 'a1', kind: 'agent' }] })
    let reachable = false
    const synced: string[][] = []
    const remote: BridgeRemote = {
      ...h.remote,
      pairings: {
        ...h.remote.pairings,
        remove: async (id) => {
          if (!reachable) throw new Error('the hub is not connected')
          return h.remote.pairings.remove(id)
        },
        sync: async (ids) => void synced.push(ids),
      },
    }
    const r = createRemoteAccess({ remote, source: { identity: async () => me, hostDh: async () => 'host-dh', pairings: async () => [phone('p1')] } })
    await r.unpaired('p2')
    expect(r.getState().pendingRemovals).toEqual(['p2'])
    expect(r.getState().error).toMatch(/not heard/)
    reachable = true
    await r.sync()
    // Off, nothing is handed to the hub, but the hub drops every phone that is gone here.
    expect(synced).toEqual([['p1']])
    expect(h.calls.filter((c) => c.startsWith('put'))).toEqual([])
    expect(r.getState().pendingRemovals).toEqual([])
  })

  it('keeps showing a removal the hub did not hear when remote access is turned on or off', async () => {
    const h = hub({ pairings: [{ pairingId: 'p1', kind: 'phone' }, { pairingId: 'p2', kind: 'phone' }] })
    const remote: BridgeRemote = {
      ...h.remote,
      pairings: {
        ...h.remote.pairings,
        remove: async () => {
          throw new Error('the hub is not connected')
        },
        sync: async () => {
          throw new Error('the hub is not connected')
        },
      },
    }
    const r = createRemoteAccess({ remote, source: { identity: async () => me, hostDh: async () => 'host-dh', pairings: async () => [phone('p1')] }, relayUrl: 'wss://relay.example.test/v1' })
    await r.unpaired('p2')
    expect(r.getState().pendingRemovals).toEqual(['p2'])
    await r.setEnabled(true)
    expect(r.getState().pendingRemovals).toEqual(['p2'])
    await r.setEnabled(false)
    expect(r.getState().pendingRemovals).toEqual(['p2'])
  })

  it('never reads an empty pair store as "unpair every phone" (N3)', async () => {
    const h = hub({ pairings: [{ pairingId: 'p1', kind: 'phone' }, { pairingId: 'p2', kind: 'phone' }] })
    const synced: string[][] = []
    let reachable = false
    const remote: BridgeRemote = {
      ...h.remote,
      pairings: {
        ...h.remote.pairings,
        remove: async (id) => {
          if (!reachable) throw new Error('the hub is not connected')
          return h.remote.pairings.remove(id)
        },
        sync: async (ids) => void synced.push(ids),
      },
    }
    // A store that did not open reads as no phones; only the removal made here reaches the hub.
    const r = createRemoteAccess({ remote, source: { identity: async () => me, hostDh: async () => 'host-dh', pairings: async () => [] } })
    await r.unpaired('p2')
    reachable = true
    await r.sync()
    expect(synced).toEqual([])
    expect(h.calls.filter((c) => c.startsWith('remove'))).toEqual(['remove p2'])
  })

  it('forgets a phone that removed itself through the hub', async () => {
    const h = hub()
    let fire: ((id: string) => void) | null = null
    const forgot: string[] = []
    createRemoteAccess({ remote: { ...h.remote, onPairingRevoked: (cb) => ((fire = cb), () => undefined) }, source: null, forget: async (id) => void forgot.push(id) })
    fire!('p9')
    await new Promise((x) => setTimeout(x, 0))
    expect(forgot).toEqual(['p9'])
  })
})
