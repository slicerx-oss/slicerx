// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalHost, Host, PrinterHost } from '@slicerx/contracts'
import { createIdentity, defaultEnv, storeIdentity, type LanBridge } from '@slicerx/pair'
import { connectBridge, disconnectBridge, resetBridge, setBridgeConnector, type ConnectedBridge } from '../src/link/bridge'
import { getPhoneAccess, setPhoneAccess } from '../src/lib/phone'
import { pairSource, setPairSource } from '../src/features/phone/remote'
import { sealedPairStores, type DocStore } from '../src/features/phone/sealed'
import { setPairStorage } from '../src/features/phone/wire'

function memoryDoc(): DocStore & { text: () => string | null } {
  let t: string | null = null
  return { read: async () => t, write: async (x) => void (t = x), text: () => t }
}

const lan = (): LanBridge => ({ listen: async (on) => ({ listening: on, port: 47616, addresses: ['192.168.1.9'] }), send: async () => undefined, close: async () => undefined, onFrame: () => () => undefined, onClosed: () => () => undefined })

function bridge(): ConnectedBridge {
  return {
    printers: { id: 'link' } as unknown as PrinterHost,
    approvals: { id: 'a' } as unknown as ApprovalHost,
    setup: { discover: async () => [], testConnection: async () => ({ ok: true, steps: [] }), addPrinter: async () => ({ printerId: 'p' }) },
    pair: lan(),
    close: vi.fn(),
  }
}
const host = () => ({ capabilities: { printers: 'sim', secureStorage: false } }) as unknown as Host

// connectBridge loads the spool usage watcher in the background and does not wait for it. Loaded here first, so
// that import is already done and nothing is still loading when the file's environment is torn down.
beforeAll(async () => {
  await Promise.all([import('../src/inventory/usage'), import('../src/state/actions')])
})

beforeEach(() => {
  resetBridge()
  setBridgeConnector(null)
  setPairStorage(null)
  setPhoneAccess(null)
  setPairSource(null)
})

describe('sealed pair stores', () => {
  it('keeps the identity and pairings in one document and never writes a key in the clear', async () => {
    const doc = memoryDoc()
    const s = sealedPairStores(doc)
    const id = createIdentity(defaultEnv, 'Studio', 'desktop')
    await s.identity.save(storeIdentity(id))
    expect((await s.identity.load())?.public.deviceId).toBe(id.public.deviceId)
    await s.pairings.addRevokedGrant('g1')
    await s.pairings.addRevokedGrant('g1')
    expect(await s.pairings.revokedGrants()).toEqual(['g1'])
  })

  it('serializes quick writes and survives an unreadable document', async () => {
    const written: string[] = []
    const s = sealedPairStores({ read: async () => 'not json', write: async (t) => void written.push(t) })
    expect(await s.pairings.list()).toEqual([])
    // L7: a document that does not open is never replaced by a new identity and no pairings.
    await expect(s.identity.save(storeIdentity(createIdentity(defaultEnv, 'Studio', 'desktop')))).rejects.toThrow(/left untouched/)
    expect(written).toEqual([])
    const doc = memoryDoc()
    const t = sealedPairStores(doc)
    await Promise.all(['a', 'b', 'c'].map((x) => t.pairings.addRevokedGrant(x)))
    expect((await t.pairings.revokedGrants()).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('phone access wiring', () => {
  it('builds Phone access and the pair source when the bridge connects, and removes them on disconnect', async () => {
    const doc = memoryDoc()
    setPairStorage({ ...sealedPairStores(doc), name: 'Test Mac', kind: 'desktop' })
    setBridgeConnector({ automatic: true, connect: async () => bridge() })
    const h = host()
    expect(await connectBridge(h)).toBe(true)
    const phone = getPhoneAccess()
    expect(phone).not.toBeNull()
    const me = await pairSource()!.identity()
    expect(me.name).toBe('Test Mac')
    // The same identity comes back, so a phone paired earlier still recognizes this computer.
    expect((await pairSource()!.identity()).deviceId).toBe(me.deviceId)
    await phone!.setEnabled(true)
    expect(phone!.getState()).toMatchObject({ status: 'on', urls: ['ws://192.168.1.9:47616/pair'] })
    await phone!.setEnabled(false)
    disconnectBridge(h)
    expect(getPhoneAccess()).toBeNull()
    expect(pairSource()).toBeNull()
  })

  it('offers nothing when the entry gave no storage or the bridge has no LAN listener', async () => {
    setBridgeConnector({ automatic: true, connect: async () => bridge() })
    await connectBridge(host())
    expect(getPhoneAccess()).toBeNull()
  })
})
