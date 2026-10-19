// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's one memory handle: the dock, the mimir tab and the app link write through the same store, a removal keeps
// its tombstone for a later sync, and the link answers that memory is off when the edition turns it off.
import type { MemoryFact, MemoryStore } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { runCall, type LinkError } from '../src/app-link/methods'
import { appMemory, resetAppMemory } from '../src/pilot-connect/memory'
import type { MemoryKeyValue } from '../src/pilot-connect/memory-sync'

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

const edition = (id: string, local = true) => ({ id, ai: { brain: { memory: { local, sync: 'off' as const } } } }) as never

afterEach(resetAppMemory)

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
    // sync is not on until the Settings switch (stage 2)
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
