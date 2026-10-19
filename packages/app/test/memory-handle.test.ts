// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's one memory handle: the mimir tab and the app link write through the same store, a removal keeps
// its tombstone for a later sync, and the link answers that memory is off when the edition turns it off. Sync with the
// account runs at a chat's start only when signed in, offered by the edition and switched on in Settings.
import { DEFAULT_POLICY, type PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type MemoryFact, type MemoryStore } from '@slicerx/pilot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCall, type LinkError } from '../src/app-link/methods'
import { appMemory, bindMemoryAccount, hostMemoryAccount, memorySyncOn, pilotMemory, resetAppMemory, startAppMemory, type MemoryAccount } from '../src/pilot-connect/memory'
import type { MemoryKeyValue } from '../src/pilot-connect/memory-sync'
import { set } from '../src/state/store'

function memStore(): MemoryStore & { facts: Map<string, MemoryFact> } {
  const facts = new Map<string, MemoryFact>()
  return {
    facts,
    list: async () => [...facts.values()],
    put: async (f) => void facts.set(f.id, f),
    remove: async (id) => void facts.delete(id),
    clear: async () => facts.clear(),
  }
}

function kvMap(): MemoryKeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void (v === null ? map.delete(k) : map.set(k, v)) }
}

const edition = (id: string, local = true, sync: 'off' | 'opt-in' = 'off') => ({ id, ai: { brain: { memory: { local, sync } } } }) as never

afterEach(() => {
  resetAppMemory()
  set({ mimirMemorySync: false })
})

describe('the app memory handle', () => {
  it('is one handle per edition, and the app link writes into the same store the pilot reads', async () => {
    const base = memStore()
    const a = appMemory(edition('slicerx'), { open: () => base, sync: { kv: kvMap() } })
    expect(appMemory(edition('slicerx'))).toBe(a)
    const out = (await runCall('mimir.memory_remember', { kind: 'printer', text: 'Has a Bambu Lab A1' })) as { fact: MemoryFact }
    expect(base.facts.get(out.fact.id)).toMatchObject({ kind: 'printer', text: 'Has a Bambu Lab A1' })
    expect((await a.store.list()).map((f) => f.id)).toEqual([out.fact.id])
    // the same note again updates it rather than adding a second
    await runCall('mimir.memory_remember', { kind: 'printer', text: 'has a bambu lab a1 ' })
    expect(base.facts.size).toBe(1)
    const read = (await runCall('mimir.memory', {})) as { facts: MemoryFact[] }
    expect(read.facts).toHaveLength(1)
  })

  it('a removal or clear through the handle keeps a tombstone for the next sync, and nothing is sent yet', async () => {
    const kv = kvMap()
    const base = memStore()
    const sent: unknown[] = []
    const h = appMemory(edition('slicerx'), { open: () => base, sync: { kv, now: () => 100, remote: { pull: async () => [], push: async (_e, rows) => void sent.push(rows) } } })
    await h.store.put({ id: 'a', kind: 'printer', text: 'A1', updatedAt: 1 })
    await h.store.put({ id: 'b', kind: 'filament', text: 'PLA', updatedAt: 1 })
    await h.store.remove('a')
    expect(JSON.parse(kv.get('slicerx-memory-tombstones-slicerx')!)).toEqual({ a: 100 })
    await h.store.clear()
    expect(JSON.parse(kv.get('slicerx-memory-tombstones-slicerx')!)).toEqual({ a: 100, b: 100 })
    // sync is off: nobody is signed in and the switch is off
    expect(await h.sync.chatStarted()).toEqual({ pulled: 0, pushed: 0 })
    expect(sent).toEqual([])
  })

  it('with memory off for the edition, the app link says memory is unavailable', async () => {
    appMemory(edition('quiet', false), { open: () => memStore(), sync: { kv: kvMap() } })
    const e = await runCall('mimir.memory', {}).then(() => null, (x: unknown) => x as LinkError)
    expect(e?.code).toBe('not_ready')
  })

  it('another edition gets its own store and takes the app link over', async () => {
    const one = memStore()
    const two = memStore()
    appMemory(edition('one'), { open: () => one, sync: { kv: kvMap() } })
    appMemory(edition('two'), { open: () => two, sync: { kv: kvMap() } })
    await runCall('mimir.memory_remember', { kind: 'size', text: 'Shelf is 18 mm thick' })
    expect(one.facts.size).toBe(0)
    expect(two.facts.size).toBe(1)
  })
})

/** A signed-in (or not) account whose REST calls are recorded: pulls answer no rows, pushes succeed. */
function fakeAccount(token: string | null) {
  let listener: ((t: string | null) => void) | null = null
  let t = token
  const calls: { url: string; method: string; auth: string | null; body: unknown }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), method: init?.method ?? 'GET', auth: headers['Authorization'] ?? null, body: init?.body ? JSON.parse(String(init.body)) : null })
    return init?.method === 'POST' ? new Response(null, { status: 201 }) : new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  const account: MemoryAccount = {
    key: {},
    target: { url: 'https://project.example', anonKey: 'anon' },
    getAccessToken: async () => t,
    onTokenChange: (cb) => {
      listener = cb
      return () => void (listener = null)
    },
    fetch: f,
  }
  return {
    calls,
    account,
    signIn(next: string | null) {
      t = next
      listener?.(next)
    },
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => false, stream: () => { throw new Error('scripted') } }

describe('memory sync with the account', () => {
  it('signed in, offered and switched on: a chat start sends the notes with the session token, and a removal follows', async () => {
    const acc = fakeAccount('session-token')
    bindMemoryAccount(acc.account)
    await tick()
    set({ mimirMemorySync: true })
    const ed = edition('synced', true, 'opt-in')
    const h = appMemory(ed, { open: () => memStore(), sync: { kv: kvMap(), now: () => 100, debounceMs: 60_000 } })
    await h.store.put({ id: 'a1', kind: 'printer', text: 'Has a Bambu Lab A1', updatedAt: 50 })
    expect(memorySyncOn()).toBe(true)
    // the chat's first message syncs before mimir reads the notes
    const pilot = createPilot({ host: { printers, llm: noLlm, approvals: createApprovalBroker() }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([{ text: 'Hi.' }], { chunk: false }), memory: pilotMemory(ed) })
    for await (const _ of pilot.run('s', 'Hello')) void _
    const push = acc.calls.find((c) => c.method === 'POST')
    expect(acc.calls[0]).toMatchObject({ method: 'GET', auth: 'Bearer session-token' })
    expect(acc.calls[0]!.url).toContain('/rest/v1/mimir_memory?select=id,fact&edition=eq.synced')
    expect(push).toMatchObject({ auth: 'Bearer session-token', body: [{ edition: 'synced', id: 'a1', fact: { kind: 'printer', text: 'Has a Bambu Lab A1' } }] })
    // a deletion goes as a tombstone at the next sync
    await h.store.remove('a1')
    await h.sync.chatStarted()
    expect(acc.calls.filter((c) => c.method === 'POST').at(-1)!.body).toMatchObject([{ id: 'a1', fact: { deleted: true, updatedAt: 100 } }])
  })

  it('nothing is read or sent when signed out, when the switch is off, or when the edition keeps notes on this computer', async () => {
    const cases: { token: string | null; on: boolean; sync: 'off' | 'opt-in' }[] = [
      { token: null, on: true, sync: 'opt-in' },
      { token: 'session-token', on: false, sync: 'opt-in' },
      { token: 'session-token', on: true, sync: 'off' },
    ]
    for (const [i, c] of cases.entries()) {
      resetAppMemory()
      const acc = fakeAccount(c.token)
      bindMemoryAccount(acc.account)
      await tick()
      set({ mimirMemorySync: c.on })
      const h = appMemory(edition(`case-${i}`, true, c.sync), { open: () => memStore(), sync: { kv: kvMap(), debounceMs: 0 } })
      await h.store.put({ id: 'a1', kind: 'printer', text: 'Has a Bambu Lab A1', updatedAt: 50 })
      expect(memorySyncOn()).toBe(false)
      expect(await h.sync.chatStarted()).toEqual({ pulled: 0, pushed: 0 })
      await tick()
      expect(acc.calls).toEqual([])
    }
  })

  it('signing in runs a sync, and signing out stops it', async () => {
    const acc = fakeAccount(null)
    set({ mimirMemorySync: true })
    const h = appMemory(edition('later', true, 'opt-in'), { open: () => memStore(), sync: { kv: kvMap(), debounceMs: 60_000 } })
    await h.store.put({ id: 'a1', kind: 'printer', text: 'Has a Bambu Lab A1', updatedAt: 50 })
    bindMemoryAccount(acc.account)
    await tick()
    expect(acc.calls).toEqual([])
    acc.signIn('session-token')
    await tick()
    await tick()
    expect(acc.calls.some((c) => c.method === 'POST')).toBe(true)
    acc.signIn(null)
    expect(memorySyncOn()).toBe(false)
  })

  it('an edition host with a store client and a Supabase project has an account; a demo build or a host without one has none', () => {
    const store = { getAccessToken: async () => null, onTokenChange: () => () => undefined }
    const sb = { url: 'https://project.example', anonKey: 'anon' }
    expect(hostMemoryAccount({ store }, { backend: { supabase: sb }, features: { demoData: false } } as never)).toMatchObject({ key: store, target: sb })
    expect(hostMemoryAccount({ store }, { backend: { supabase: sb }, features: { demoData: true } } as never)).toBeNull()
    expect(hostMemoryAccount({}, { backend: { supabase: sb }, features: { demoData: false } } as never)).toBeNull()
    expect(hostMemoryAccount({ store }, { backend: { supabase: null }, features: { demoData: false } } as never)).toBeNull()
  })
})

describe('memory from the start of the app', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('with no dock, tab or Settings mounted, the app link reads the notes, and sync runs when signed in with sync on', async () => {
    const calls: { url: string; method: string; auth: string | null }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') })
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    set({ mimirMemorySync: true })
    const base = memStore()
    base.facts.set('a1', { id: 'a1', kind: 'printer', text: 'Has a Bambu Lab A1', updatedAt: 50 })
    const store = { getAccessToken: async () => 'session-token', onTokenChange: () => () => undefined }
    const ed = { id: 'started', ai: { brain: { memory: { local: true, sync: 'opt-in' } } }, backend: { supabase: { url: 'https://project.example', anonKey: 'anon' } }, features: { demoData: false } } as never
    startAppMemory({ store }, ed, { open: () => base, sync: { kv: kvMap(), debounceMs: 60_000 } })
    const out = (await runCall('mimir.memory', {})) as { facts: { text: string }[] }
    expect(out.facts.map((f) => f.text)).toEqual(['Has a Bambu Lab A1'])
    await tick()
    await tick()
    expect(memorySyncOn()).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'GET', auth: 'Bearer session-token' })
    expect(calls[0]!.url).toContain('/rest/v1/mimir_memory?select=id,fact&edition=eq.started')
  })
})
