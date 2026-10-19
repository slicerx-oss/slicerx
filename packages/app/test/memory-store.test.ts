// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's notes about the person are kept per edition: one IndexedDB database each, so a white-label build never
// reads what the person told another edition on the same machine.
import type { MemoryFact } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { openMemoryStore } from '../src/pilot-connect/memory-store'

type Req = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void }

/** Just enough IndexedDB for the store: named databases holding one keyed table, each call answered on a later tick. */
function fakeIndexedDb(): { factory: IDBFactory; names: () => string[] } {
  const dbs = new Map<string, Map<string, unknown>>()
  const later = (fn: () => void) => setTimeout(fn, 0)
  const factory = {
    open(name: string) {
      const req: Req = {}
      later(() => {
        const fresh = !dbs.has(name)
        if (fresh) dbs.set(name, new Map())
        const rows = dbs.get(name)!
        req.result = {
          createObjectStore: () => ({}),
          close: () => undefined,
          transaction: () => {
            const tx: { oncomplete?: () => void; onerror?: () => void; objectStore: () => unknown } = {
              objectStore: () => {
                const done = (result: unknown) => {
                  const r: Req = { result }
                  later(() => tx.oncomplete?.())
                  return r
                }
                return {
                  getAll: () => done([...rows.values()].map((v) => structuredClone(v))),
                  put: (v: { id: string }) => (rows.set(v.id, structuredClone(v)), done(v.id)),
                  delete: (id: string) => (rows.delete(id), done(undefined)),
                  clear: () => (rows.clear(), done(undefined)),
                }
              },
            }
            return tx
          },
        }
        if (fresh) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  } as unknown as IDBFactory
  return { factory, names: () => [...dbs.keys()] }
}

const fact = (id: string, text: string): MemoryFact => ({ id, kind: 'printer', text, updatedAt: 1 })

describe('the memory store', () => {
  it('stores for two editions do not see each other', async () => {
    const idb = fakeIndexedDb()
    const ours = openMemoryStore('slicerx', idb.factory)
    const theirs = openMemoryStore('layermate', idb.factory)
    await ours.put(fact('a1', 'Has a Bambu Lab A1'))
    await theirs.put(fact('mk4s', 'Has a Prusa MK4S'))
    expect((await ours.list()).map((f) => f.id)).toEqual(['a1'])
    expect((await theirs.list()).map((f) => f.id)).toEqual(['mk4s'])
    expect(idb.names().sort()).toEqual(['slicerx-memory-layermate', 'slicerx-memory-slicerx'])
    // the same edition opened again reads the same notes, and clearing one edition leaves the other
    expect((await openMemoryStore('slicerx', idb.factory).list()).map((f) => f.id)).toEqual(['a1'])
    await theirs.clear()
    expect(await theirs.list()).toEqual([])
    expect(await ours.list()).toHaveLength(1)
    await ours.remove('a1')
    expect(await ours.list()).toEqual([])

    // without IndexedDB (tests, hosts with no storage) the notes live in memory, still one set per edition
    const a = openMemoryStore('slicerx', null)
    const b = openMemoryStore('layermate', null)
    await a.put(fact('a1', 'Has a Bambu Lab A1'))
    expect(await b.list()).toEqual([])
    expect((await openMemoryStore('slicerx', null).list()).map((f) => f.id)).toEqual(['a1'])
  })
})
