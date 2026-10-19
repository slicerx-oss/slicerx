// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir memory across devices: the newer updatedAt wins per fact, a deletion syncs as a tombstone, editions stay
// apart, and nothing is read or sent while sync is off or the person is signed out.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startMemorySync,
  supabaseMemoryRemote,
  syncMemory,
  type MemoryFact,
  type MemoryKeyValue,
  type MemoryRemote,
  type MemoryRow,
  type MemoryStore,
} from '../src/pilot-connect/memory-sync'

/** A local store for one edition, as the app keeps one per edition. */
function memStore(facts: MemoryFact[] = []): MemoryStore & { facts: Map<string, MemoryFact> } {
  const map = new Map(facts.map((f) => [f.id, f]))
  return {
    facts: map,
    list: async () => [...map.values()],
    put: async (f) => void map.set(f.id, f),
    remove: async (id) => void map.delete(id),
    clear: async () => map.clear(),
  }
}

/** The person's rows on the server: per edition, and an older write changes nothing (the table's trigger). */
function server() {
  const rows = new Map<string, Map<string, MemoryRow['fact']>>()
  const sent: { edition: string; rows: MemoryRow[] }[] = []
  const pulls: string[] = []
  const of = (e: string) => rows.get(e) ?? rows.set(e, new Map()).get(e)!
  const remote: MemoryRemote = {
    pull: async (edition) => {
      pulls.push(edition)
      return [...of(edition)].map(([id, fact]) => ({ id, fact }))
    },
    push: async (edition, batch) => {
      sent.push({ edition, rows: batch })
      for (const r of batch) {
        const had = of(edition).get(r.id)
        if (!had || r.fact.updatedAt > had.updatedAt) of(edition).set(r.id, r.fact)
      }
    },
  }
  return { remote, rows: of, sent, pulls }
}

function kvMap(): MemoryKeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void (v === null ? map.delete(k) : map.set(k, v)) }
}

const fact = (id: string, text: string, updatedAt: number, kind: MemoryFact['kind'] = 'printer'): MemoryFact => ({ id, kind, text, updatedAt })

afterEach(() => vi.useRealTimers())

describe('memory sync', () => {
  it('the newer edit wins', async () => {
    const s = server()
    s.rows('slicerx').set('p1', fact('p1', 'A1 mini on the desk', 2000))
    s.rows('slicerx').set('f1', fact('f1', 'PLA at 215 C', 1000, 'filament'))
    const store = memStore([fact('p1', 'A1 mini', 1000), fact('f1', 'PLA at 210 C', 3000, 'filament'), fact('o1', 'Tree supports worked', 500, 'outcome')])
    const kv = kvMap()

    expect(await syncMemory(store, 'slicerx', { remote: s.remote, kv })).toEqual({ pulled: 1, pushed: 2 })
    expect(store.facts.get('p1')?.text).toBe('A1 mini on the desk')
    expect(s.rows('slicerx').get('f1')).toMatchObject({ text: 'PLA at 210 C', updatedAt: 3000 })
    expect(s.rows('slicerx').get('o1')).toMatchObject({ text: 'Tree supports worked' })
    // in step: a second sync moves nothing
    expect(await syncMemory(store, 'slicerx', { remote: s.remote, kv })).toEqual({ pulled: 0, pushed: 0 })
  })

  it('an equal updatedAt changes neither side', async () => {
    const s = server()
    s.rows('slicerx').set('p1', fact('p1', 'theirs', 1000))
    const store = memStore([fact('p1', 'mine', 1000)])
    expect(await syncMemory(store, 'slicerx', { remote: s.remote, kv: kvMap() })).toEqual({ pulled: 0, pushed: 0 })
    expect(store.facts.get('p1')?.text).toBe('mine')
  })

  it('a deletion syncs', async () => {
    const s = server()
    const kv = kvMap()
    const phone = memStore()
    const desk = memStore()
    const onDesk = startMemorySync(desk, 'slicerx', { remote: s.remote, kv, enabled: () => true, now: () => 5000 })
    await onDesk.store.put(fact('p1', 'A1 mini', 1000))
    await onDesk.chatStarted()
    await syncMemory(phone, 'slicerx', { remote: s.remote, kv: kvMap() })
    expect(phone.facts.has('p1')).toBe(true)

    // deleted on the desk: the server keeps a tombstone, and the phone drops the fact
    await onDesk.store.remove('p1')
    expect(await onDesk.chatStarted()).toEqual({ pulled: 0, pushed: 1 })
    expect(s.rows('slicerx').get('p1')).toEqual({ deleted: true, updatedAt: 5000 })
    // the deletion waits until a pull shows it on the server
    expect(kv.map.size).toBe(1)
    expect(await onDesk.chatStarted()).toEqual({ pulled: 0, pushed: 0 })
    expect(kv.map.size).toBe(0)
    expect(await syncMemory(phone, 'slicerx', { remote: s.remote, kv: kvMap() })).toEqual({ pulled: 1, pushed: 0 })
    expect(phone.facts.has('p1')).toBe(false)
    onDesk.stop()
  })

  it('a tombstone loses to a newer edit of the same fact', async () => {
    const s = server()
    s.rows('slicerx').set('p1', { deleted: true, updatedAt: 2000 })
    const store = memStore([fact('p1', 'A1 mini, re-added', 3000)])
    expect(await syncMemory(store, 'slicerx', { remote: s.remote, kv: kvMap() })).toEqual({ pulled: 0, pushed: 1 })
    expect(store.facts.has('p1')).toBe(true)
    expect(s.rows('slicerx').get('p1')).toMatchObject({ text: 'A1 mini, re-added' })

    // and an older local deletion does not remove a newer fact from another device
    const s2 = server()
    const kv = kvMap()
    const other = memStore([fact('p2', 'X1C', 1000)])
    const live = startMemorySync(other, 'slicerx', { remote: s2.remote, kv, enabled: () => true, now: () => 1500 })
    await live.store.remove('p2')
    s2.rows('slicerx').set('p2', fact('p2', 'X1C in the garage', 4000))
    expect(await live.chatStarted()).toEqual({ pulled: 1, pushed: 0 })
    expect(other.facts.get('p2')?.text).toBe('X1C in the garage')
    expect(kv.map.size).toBe(0)
    live.stop()
  })

  it('clearing the store syncs a tombstone for every fact', async () => {
    const s = server()
    const store = memStore([fact('a', 'one', 1), fact('b', 'two', 2)])
    const live = startMemorySync(store, 'slicerx', { remote: s.remote, kv: kvMap(), enabled: () => true, now: () => 100 })
    await live.store.clear()
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 2 })
    expect([...s.rows('slicerx').values()]).toEqual([{ deleted: true, updatedAt: 100 }, { deleted: true, updatedAt: 100 }])
    live.stop()
  })

  it('editions stay apart', async () => {
    const s = server()
    const kv = kvMap()
    const slicerx = memStore([fact('p1', 'A1 mini', 1000)])
    const layermate = memStore([fact('p1', 'X1C', 2000)])
    await syncMemory(slicerx, 'slicerx', { remote: s.remote, kv })
    await syncMemory(layermate, 'layermate', { remote: s.remote, kv })
    expect(s.rows('slicerx').get('p1')).toMatchObject({ text: 'A1 mini' })
    expect(s.rows('layermate').get('p1')).toMatchObject({ text: 'X1C' })
    expect(slicerx.facts.get('p1')?.text).toBe('A1 mini')

    // a deletion in one edition stays in that edition
    const live = startMemorySync(layermate, 'layermate', { remote: s.remote, kv, enabled: () => true, now: () => 3000 })
    await live.store.remove('p1')
    await live.chatStarted()
    expect(await syncMemory(slicerx, 'slicerx', { remote: s.remote, kv })).toEqual({ pulled: 0, pushed: 0 })
    expect(slicerx.facts.get('p1')?.text).toBe('A1 mini')
    live.stop()
  })

  it('sync off sends nothing', async () => {
    vi.useFakeTimers()
    const s = server()
    const kv = kvMap()
    const store = memStore([fact('p1', 'A1 mini', 1000)])
    const live = startMemorySync(store, 'slicerx', { remote: s.remote, kv, enabled: () => false, debounceMs: 50 })
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 0 })
    await live.store.put(fact('f1', 'PETG at 240 C', 2000, 'filament'))
    await vi.advanceTimersByTimeAsync(500)
    expect(s.pulls).toEqual([])
    expect(s.sent).toEqual([])
    live.stop()
  })

  it('changes sync once, after a short wait', async () => {
    vi.useFakeTimers()
    const s = server()
    const store = memStore()
    let on = true
    const live = startMemorySync(store, 'slicerx', { remote: s.remote, kv: kvMap(), enabled: () => on, debounceMs: 2000 })
    await live.store.put(fact('a', 'one', 1))
    await vi.advanceTimersByTimeAsync(1000)
    await live.store.put(fact('b', 'two', 2))
    await vi.advanceTimersByTimeAsync(1999)
    expect(s.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])

    // turned off before the wait ends: nothing goes
    await live.store.put(fact('c', 'three', 3))
    on = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.sent).toHaveLength(1)
    live.stop()
  })

  it('a failed sync keeps the deletion for the next one', async () => {
    const s = server()
    const kv = kvMap()
    const errors: unknown[] = []
    let down = true
    const remote: MemoryRemote = {
      pull: s.remote.pull,
      push: async (e, rows) => {
        if (down) throw new Error('offline')
        await s.remote.push(e, rows)
      },
    }
    const live = startMemorySync(memStore([fact('p1', 'A1 mini', 1)]), 'slicerx', { remote, kv, enabled: () => true, now: () => 10, onError: (e) => errors.push(e) })
    await live.store.remove('p1')
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 0 })
    expect(errors).toHaveLength(1)
    expect(kv.map.size).toBe(1)
    down = false
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 1 })
    expect(s.rows('slicerx').get('p1')).toEqual({ deleted: true, updatedAt: 10 })
    live.stop()
  })

  const DAY = 24 * 60 * 60 * 1000

  it('a deletion the server skipped (its clock behind ours) is sent again, until a pull shows it there', async () => {
    const s = server()
    const kv = kvMap()
    let skipping = true
    const remote: MemoryRemote = { pull: s.remote.pull, push: async (e, rows) => (skipping ? void s.sent.push({ edition: e, rows }) : s.remote.push(e, rows)) }
    s.rows('slicerx').set('p1', fact('p1', 'A1 mini', 1))
    const live = startMemorySync(memStore([fact('p1', 'A1 mini', 1)]), 'slicerx', { remote, kv, enabled: () => true, now: () => 50 })
    await live.store.remove('p1')
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 1 })
    // the server skipped it: the fact is still live there, and the deletion stays to go again rather than the fact coming back
    expect(s.rows('slicerx').get('p1')).toMatchObject({ text: 'A1 mini' })
    expect(kv.map.size).toBe(1)
    skipping = false
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 1 })
    expect(s.rows('slicerx').get('p1')).toEqual({ deleted: true, updatedAt: 50 })
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 0 })
    expect(kv.map.size).toBe(0)
    live.stop()
  })

  it('a deletion older than the server keeps tombstones is not waited on', async () => {
    const now = 1_760_000_000_000
    const kv = kvMap()
    kv.set('slicerx-memory-tombstones-slicerx', JSON.stringify({ gone: now - 91 * DAY }))
    const remote: MemoryRemote = { pull: async () => [], push: async () => {} }
    await syncMemory(memStore(), 'slicerx', { remote, kv, now: () => now })
    expect(kv.map.size).toBe(0)
  })

  it('a fact that holds a secret is never sent, though it stays in the local store', async () => {
    const s = server()
    const store = memStore([fact('p1', 'A1 access code is 31415926', 10), { ...fact('p2', 'The X1C', 10), data: { serialNumber: 'garage' } }, fact('p3', 'A1 mini', 10)])
    expect(await syncMemory(store, 'slicerx', { remote: s.remote, kv: kvMap() })).toEqual({ pulled: 0, pushed: 1 })
    expect(s.sent[0]!.rows.map((r) => r.id)).toEqual(['p3'])
    expect(store.facts.size).toBe(3)
  })

  it('a clock more than a day ahead is neither applied nor sent', async () => {
    const s = server()
    const now = 1_760_000_000_000
    s.rows('slicerx').set('p1', fact('p1', 'from a fast clock', now + 2 * DAY))
    s.rows('slicerx').set('p2', fact('p2', 'a little ahead', now + DAY / 2))
    const store = memStore([fact('p1', 'A1 mini', now - 1000), fact('f1', 'frozen', now + 3 * DAY, 'filament'), fact('f2', 'fine', now - 5, 'filament')])
    expect(await syncMemory(store, 'slicerx', { remote: s.remote, kv: kvMap(), now: () => now })).toEqual({ pulled: 1, pushed: 1 })
    expect(store.facts.get('p1')?.text).toBe('A1 mini')
    expect(store.facts.get('p2')?.text).toBe('a little ahead')
    expect(s.sent[0]!.rows.map((r) => r.id)).toEqual(['f2'])
  })

  it('pulled facts with a bad shape are skipped, and a fact keeps its row id', async () => {
    const rows: MemoryRow[] = [
      { id: 'ok', fact: { id: 'ok', kind: 'printer', text: 'A1 mini', data: { nozzle: 0.4, plate: 'PEI' }, updatedAt: 10, extra: 'x' } as unknown as MemoryFact },
      { id: 'kind', fact: { id: 'kind', kind: 'secret', text: 'x', updatedAt: 10 } as unknown as MemoryFact },
      { id: 'text', fact: { id: 'text', kind: 'printer', text: 42, updatedAt: 10 } as unknown as MemoryFact },
      { id: 'nested', fact: { id: 'nested', kind: 'printer', text: 'x', data: { a: { b: 1 } }, updatedAt: 10 } as unknown as MemoryFact },
      { id: 'other', fact: fact('someone-else', 'moved', 10) },
      { id: 'time', fact: { id: 'time', kind: 'printer', text: 'x', updatedAt: '10' } as unknown as MemoryFact },
      { id: 'nan', fact: { id: 'nan', kind: 'printer', text: 'x', updatedAt: Number.NaN } },
      { id: 'tomb', fact: { deleted: true, updatedAt: 10, text: 'kept' } as unknown as MemoryFact },
    ]
    const sent: MemoryRow[][] = []
    const remote: MemoryRemote = { pull: async () => rows, push: async (_e, b) => void sent.push(b) }
    const store = memStore([fact('tomb', 'still here', 5)])
    expect(await syncMemory(store, 'slicerx', { remote, kv: kvMap() })).toEqual({ pulled: 1, pushed: 0 })
    expect(store.facts.get('ok')).toEqual({ id: 'ok', kind: 'printer', text: 'A1 mini', data: { nozzle: 0.4, plate: 'PEI' }, updatedAt: 10 })
    expect([...store.facts.keys()].sort()).toEqual(['ok', 'tomb'])
    expect(store.facts.has('someone-else')).toBe(false)
    expect(sent).toEqual([])
  })

  it('a tombstone goes as exactly deleted and updatedAt, and an oversized fact stays local', async () => {
    const s = server()
    const kv = kvMap()
    const big = fact('big', 'x'.repeat(9000), 20)
    const store = memStore([fact('p1', 'A1 mini', 1), big, { ...fact('d1', 'with data', 20), data: { a: 1 } }])
    const live = startMemorySync(store, 'slicerx', { remote: s.remote, kv, enabled: () => true, now: () => 30 })
    await live.store.remove('p1')
    expect(await live.chatStarted()).toEqual({ pulled: 0, pushed: 2 })
    const sent = Object.fromEntries(s.sent[0]!.rows.map((r) => [r.id, r.fact]))
    expect(Object.keys(sent).sort()).toEqual(['d1', 'p1'])
    expect(sent.p1).toStrictEqual({ deleted: true, updatedAt: 30 })
    expect(store.facts.has('big')).toBe(true)
    live.stop()
  })

  it('new facts stop at the cap, and tombstones do not count', async () => {
    const s = server()
    for (let i = 0; i < 1999; i++) s.rows('slicerx').set(`n${i}`, fact(`n${i}`, 'x', 1))
    s.rows('slicerx').set('gone', { deleted: true, updatedAt: 1 })
    const store = memStore([...s.rows('slicerx').entries()].filter(([, f]) => !('deleted' in f)).map(([, f]) => f as MemoryFact))
    await store.put(fact('a', 'one', 5))
    await store.put(fact('gone', 'back', 5))
    await store.put(fact('n0', 'edited', 5))
    expect(await syncMemory(store, 'slicerx', { remote: s.remote, kv: kvMap() })).toEqual({ pulled: 0, pushed: 2 })
    // the fact written over the tombstone takes the last slot, the new one waits, and an edit of a live fact still goes
    expect(s.sent[0]!.rows.map((r) => r.id).sort()).toEqual(['gone', 'n0'])
    expect(store.facts.has('a')).toBe(true)
  })

  it('a local edit during the sync is not overwritten by the pull', async () => {
    const s = server()
    s.rows('slicerx').set('p1', fact('p1', 'theirs', 2000))
    const store = memStore([fact('p1', 'old', 1000)])
    let lists = 0
    const racing: MemoryStore = {
      ...store,
      list: async () => {
        // the person edits the fact right after the sync first reads the store
        if (lists++ === 1) await store.put(fact('p1', 'mine, just now', 3000))
        return store.list()
      },
    }
    expect(await syncMemory(racing, 'slicerx', { remote: s.remote, kv: kvMap() })).toEqual({ pulled: 0, pushed: 0 })
    expect(store.facts.get('p1')?.text).toBe('mine, just now')
  })
})

describe('memory sync over Supabase', () => {
  const target = { url: 'https://proj.example.co/', anonKey: 'sb_publishable_x' }

  it('signed out, it sends nothing', async () => {
    const f = vi.fn()
    const remote = supabaseMemoryRemote(target, async () => null, f as unknown as typeof fetch)
    expect(await syncMemory(memStore([fact('p1', 'A1 mini', 1)]), 'slicerx', { remote, kv: kvMap() })).toEqual({ pulled: 0, pushed: 0 })
    expect(f).not.toHaveBeenCalled()
  })

  it('reads the edition with the session token and upserts with updated_at', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init ? { init } : {}) })
      if (!init?.method) return Response.json([{ id: 'p1', fact: { id: 'p1', kind: 'printer', text: 'A1 mini', updatedAt: 1000 } }, { id: 'bad', fact: null }])
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    const remote = supabaseMemoryRemote(target, async () => 'jwt', f)
    const store = memStore([fact('f1', 'PLA at 210 C', 1760000000000, 'filament')])
    expect(await syncMemory(store, 'slicerx', { remote, kv: kvMap() })).toEqual({ pulled: 1, pushed: 1 })
    expect(seen[0]!.url).toBe('https://proj.example.co/rest/v1/mimir_memory?select=id,fact&edition=eq.slicerx')
    expect(seen[0]!.init?.headers).toMatchObject({ apikey: 'sb_publishable_x', Authorization: 'Bearer jwt' })
    expect(seen[1]!.url).toBe('https://proj.example.co/rest/v1/mimir_memory?on_conflict=user_id,edition,id')
    expect(seen[1]!.init?.headers).toMatchObject({ Authorization: 'Bearer jwt', Prefer: 'resolution=merge-duplicates,return=minimal' })
    expect(JSON.parse(String(seen[1]!.init?.body))).toEqual([
      { edition: 'slicerx', id: 'f1', fact: { id: 'f1', kind: 'filament', text: 'PLA at 210 C', updatedAt: 1760000000000 }, updated_at: '2025-10-09T08:53:20.000Z' },
    ])
  })

  it('a refused push is an error', async () => {
    const f = (async (_url: string, init?: RequestInit) =>
      init?.method ? Response.json({ message: 'too many facts' }, { status: 400 }) : Response.json([])) as unknown as typeof fetch
    const remote = supabaseMemoryRemote(target, async () => 'jwt', f)
    await expect(syncMemory(memStore([fact('p1', 'A1 mini', 1)]), 'slicerx', { remote, kv: kvMap() })).rejects.toThrow(/too many facts/)
  })
})
