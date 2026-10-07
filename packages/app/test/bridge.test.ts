// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalHost, Host, PrinterHost } from '@slicerx/contracts'
import { bridgeConnector, connectBridge, disconnectBridge, resetBridge, setBridgeConnector, type ConnectedBridge } from '../src/link/bridge'
import { setupHostFor } from '../src/first-run/setup-host'
import { get } from '../src/state/store'

const demoPrinters = { id: 'demo' } as unknown as PrinterHost
const demoApprovals = { id: 'demo-approvals' } as unknown as ApprovalHost

function host(): Host {
  return { printers: demoPrinters, approvals: demoApprovals, secrets: { id: 'none' }, capabilities: { printers: 'sim', secureStorage: false } } as unknown as Host
}

function fakeBridge(closed: string[]): ConnectedBridge {
  return {
    printers: { id: 'link' } as unknown as PrinterHost,
    approvals: { id: 'link-approvals' } as unknown as ApprovalHost,
    streams: { open: async () => { throw new Error('none') } },
    setup: {
      discover: async () => [{ id: 'a', name: 'Bay 1', family: 'bambu-lan' }],
      testConnection: async () => ({ ok: true, steps: [{ id: 'reach' as const, ok: true }] }),
      addPrinter: async () => ({ printerId: 'p1' }),
    },
    secrets: { id: 'link-secrets' } as never,
    close: () => void closed.push('closed'),
  }
}

beforeEach(() => {
  resetBridge()
  setBridgeConnector(null)
})

// connectBridge starts loading the card, guard and filament watchers without waiting for them; the file must not
// end while those modules are still loading, or the environment is torn down under them.
afterEach(() => vi.dynamicImportSettled())

describe('printer bridge', () => {
  it('swaps the host printers, approvals and streams in and restores them on disconnect', async () => {
    const closed: string[] = []
    setBridgeConnector({ automatic: false, connect: async (code) => (code === 'ABCD1234' ? fakeBridge(closed) : Promise.reject(new Error('unauthorized'))) })
    const h = host()
    const epoch = get().linkEpoch
    expect(await connectBridge(h, 'ABCD1234')).toBe(true)
    expect((h.printers as unknown as { id: string }).id).toBe('link')
    expect((h.printers as unknown as { streams?: unknown }).streams).toBeDefined()
    expect((h.approvals as unknown as { id: string }).id).toBe('link-approvals')
    expect(get().bridgeStatus.state).toBe('on')
    expect(get().linkEpoch).toBeGreaterThan(epoch)
    // The setup screens now go through the bridge.
    const setup = setupHostFor(h)
    expect(setup.keychain).toBe(true)
    expect(h.capabilities.printers).toBe('link')
    expect(await setup.discover()).toEqual([{ id: 'a', name: 'Bay 1', family: 'bambu-lan' }])
    expect((await setup.testConnection({ family: 'bambu-lan', address: '192.168.1.5' })).ok).toBe(true)
    disconnectBridge(h)
    expect(h.printers).toBe(demoPrinters)
    expect(h.approvals).toBe(demoApprovals)
    expect(h.capabilities).toEqual({ printers: 'sim', secureStorage: false })
    expect((h.secrets as unknown as { id: string }).id).toBe('none')
    expect(closed).toEqual(['closed'])
    expect(get().bridgeStatus.state).toBe('off')
  })

  it('says plainly when the code is wrong and leaves the host alone', async () => {
    setBridgeConnector({ automatic: false, connect: async () => Promise.reject(new Error('unauthorized')) })
    const h = host()
    expect(await connectBridge(h, 'WRONG123')).toBe(false)
    expect(get().bridgeStatus).toEqual({ state: 'error', message: 'That pairing code was not accepted.' })
    expect(h.printers).toBe(demoPrinters)
  })

  it('does nothing without a connector', async () => {
    expect(bridgeConnector()).toBeNull()
    expect(await connectBridge(host())).toBe(false)
  })
})
