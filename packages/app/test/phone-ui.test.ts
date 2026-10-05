// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { PairQr } from '../src/features/phone/pair-dialog'
import { PendingRemovals } from '../src/features/phone/remote-rows'
import { createRemoteAccess, setRemoteAccess, type BridgeRemote } from '../src/features/phone/remote'
import { qrMatrix } from '../src/lib/qr'

describe('qr encoder', () => {
  it('draws finder patterns and grows with the text', () => {
    const m = qrMatrix('slicerx://pair')
    expect(m.length).toBe(21)
    // The top left finder: dark ring, light ring, dark 3x3 core.
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true)
    expect(m[1]![1]).toBe(false)
    expect(m[3]![3]).toBe(true)
    expect(qrMatrix('x'.repeat(300)).length).toBeGreaterThan(m.length)
    expect(qrMatrix('slicerx://pair')).toEqual(m)
  })
  it('refuses text no code can hold', () => {
    expect(() => qrMatrix('x'.repeat(3000))).toThrow(/too long/)
  })
  it('renders as an inline SVG, locally', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    flushSync(() => root.render(createElement(PairQr, { link: 'slicerx://pair?o=abc' })))
    expect(host.querySelector('svg.pair-qr path')?.getAttribute('d')?.length).toBeGreaterThan(100)
    root.unmount()
  })
})

describe('pending removals', () => {
  it('shows the label and retries through a sync', async () => {
    let fail = true
    const calls: string[] = []
    const remote: BridgeRemote = {
      status: async () => ({ enabled: false, relay: null, connected: false, sessions: 0, pairings: 0, lastError: null, quota: null }),
      configure: async () => {
        throw new Error('unused')
      },
      quota: async () => {
        throw new Error('unused')
      },
      pairings: {
        put: async () => undefined,
        remove: async (id) => {
          calls.push(`remove ${id}`)
          if (fail) throw new Error('offline')
        },
        list: async () => [],
        sync: async () => {
          calls.push('sync')
        },
      },
    }
    const r = createRemoteAccess({ remote, source: { identity: async () => ({}) as never, hostDh: async () => '', pairings: async () => [] } })
    await r.unpaired('p1')
    setRemoteAccess(r)
    const host = document.createElement('div')
    const root = createRoot(host)
    flushSync(() => root.render(createElement(PendingRemovals)))
    expect(host.textContent).toContain('Removal pending')
    fail = false
    const before = calls.length
    host.querySelector('button')!.click()
    await new Promise((res) => setTimeout(res, 20))
    // No phones are left here, so the sync sends only the removals this app made (never a full sync to an empty list).
    expect(calls.slice(before)).toContain('remove p1')
    expect(calls).not.toContain('sync')
    expect(r.getState().pendingRemovals).toEqual([])
    root.unmount()
    setRemoteAccess(null)
  })
})
