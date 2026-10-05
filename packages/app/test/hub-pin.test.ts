// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { connectLink } from '../../connect/link-client/src/index'
import { hubFingerprint } from '@slicerx/contracts'
import { connectPinned, forgetHub, hubPinned, HUB_MISMATCH, HubMismatchError, localHubPins, shellLinkOptions, trustHub, type HubPins } from '../src/link/hub-pin'

const memory = (): HubPins & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, get: (u) => map.get(u), set: (u, k) => void map.set(u, k) }
}

describe('pinning the hub', () => {
  it('passes no key on the first pairing and pins the key the hub proved', async () => {
    const pins = memory()
    const calls: unknown[] = []
    await connectPinned(async (o) => (calls.push(o), { hubKey: 'KEY-A' }), { code: 'ABCD' }, pins)
    expect(calls).toEqual([{ code: 'ABCD', appId: expect.any(String) }])
    expect(pins.map.get('ws://127.0.0.1:47615')).toBe('KEY-A')
  })

  it('passes the pinned key on every later connect, per hub address', async () => {
    const pins = memory()
    pins.set('ws://127.0.0.1:47615', 'KEY-A')
    pins.set('ws://10.0.0.5:47615', 'KEY-B')
    const calls: { url?: string; hubKey?: string }[] = []
    await connectPinned(async (o) => (calls.push(o), { hubKey: 'KEY-A' }), { code: 'ABCD' }, pins)
    await connectPinned(async (o) => (calls.push(o), { hubKey: 'KEY-B' }), { code: 'ABCD', url: 'ws://10.0.0.5:47615' }, pins)
    expect(calls.map((c) => c.hubKey)).toEqual(['KEY-A', 'KEY-B'])
  })

  it('turns a failed identity check into a plain warning and pins nothing', async () => {
    const pins = memory()
    pins.set('ws://127.0.0.1:47615', 'KEY-A')
    const err = Object.assign(new Error('x'), { code: 'hub_identity' })
    await expect(connectPinned(async () => { throw err }, { code: 'ABCD' }, pins)).rejects.toThrow(HUB_MISMATCH)
    expect(pins.map.get('ws://127.0.0.1:47615')).toBe('KEY-A')
  })

  it('carries the key the other program proved, and trusts only the key the person compared (R10)', async () => {
    const pins = memory()
    pins.set('ws://127.0.0.1:47615', 'KEY-A')
    const err = Object.assign(new Error('x'), { code: 'hub_identity', presentedKey: 'KEY-B' })
    const thrown = await connectPinned(async () => { throw err }, { code: 'ABCD' }, pins).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(HubMismatchError)
    expect((thrown as HubMismatchError).presentedKey).toBe('KEY-B')
    expect(pins.map.get('ws://127.0.0.1:47615')).toBe('KEY-A')
    trustHub('KEY-B', 'ws://127.0.0.1:47615', pins)
    const calls: { hubKey?: string }[] = []
    await connectPinned(async (o) => (calls.push(o), { hubKey: 'KEY-B' }), { code: 'ABCD' }, pins)
    expect(calls[0]?.hubKey).toBe('KEY-B')
  })

  it('shows the same fingerprint as sx-link code (R10)', async () => {
    // The vector in sx-link's identity.rs.
    expect(await hubFingerprint('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')).toBe('CC6W TAB6 RGSP D48J')
    expect(await hubFingerprint('not base64!')).toBeNull()
  })

  it('the desktop shell\'s key is passed to the link client', () => {
    expect(shellLinkOptions({ url: 'ws://127.0.0.1:1', code: 'C', hubKey: 'K' })).toEqual({ url: 'ws://127.0.0.1:1', code: 'C', hubKey: 'K', appId: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(shellLinkOptions({ url: 'ws://127.0.0.1:1', code: 'C' })).toEqual({ url: 'ws://127.0.0.1:1', code: 'C', appId: expect.stringMatching(/^[0-9a-f]{32}$/) })
    // One id per install: every connect from this app sends the same one.
    expect(shellLinkOptions({ url: 'u', code: 'C' }).appId).toBe(shellLinkOptions({ url: 'v', code: 'D' }).appId)
  })
})

/** A socket that answers hello with the wrong key, and records every request. */
function impostor() {
  const sent: string[] = []
  class Sock {
    static OPEN = 1
    readyState = 1
    binaryType = 'blob'
    private ls = new Map<string, ((e: unknown) => void)[]>()
    constructor() {
      queueMicrotask(() => this.fire('open', {}))
    }
    addEventListener(t: string, cb: (e: unknown) => void) {
      this.ls.set(t, [...(this.ls.get(t) ?? []), cb])
    }
    fire(t: string, e: unknown) {
      for (const cb of this.ls.get(t) ?? []) cb(e)
    }
    send(text: string) {
      const { id, method } = JSON.parse(text) as { id: number; method: string }
      sent.push(method)
      const result = method === 'hello' ? { hubKey: 'AAAA', sig: 'AAAA' } : { paired: true }
      queueMicrotask(() => this.fire('message', { data: JSON.stringify({ id, result }) }))
    }
    close() {
      this.readyState = 3
    }
  }
  return { WS: Sock as unknown as typeof WebSocket, sent }
}

describe('a hub that is not the pinned one', () => {
  it('is refused with the warning and no pairing code goes out', async () => {
    const pins = memory()
    pins.set('ws://127.0.0.1:47615', 'REAL-KEY')
    const h = impostor()
    await expect(connectPinned((o) => connectLink({ ...o, WebSocket: h.WS }), { code: 'SECRET-CODE' }, pins)).rejects.toThrow(HUB_MISMATCH)
    expect(h.sent).toEqual(['hello'])
  })

  it('forgets one hub and leaves the others pinned', () => {
    localStorage.clear()
    const pins = localHubPins()
    pins.set('ws://127.0.0.1:47615', 'KEY-A')
    pins.set('ws://10.0.0.5:47615', 'KEY-B')
    expect(hubPinned()).toBe(true)
    expect(forgetHub()).toBe(true)
    expect(hubPinned()).toBe(false)
    expect(pins.get('ws://10.0.0.5:47615')).toBe('KEY-B')
    expect(forgetHub()).toBe(false)
    expect(forgetHub('ws://10.0.0.5:47615')).toBe(true)
    expect(localStorage.getItem('slicerx.hubKeys')).toBeNull()
  })
})
