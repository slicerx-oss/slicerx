// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where mimir's notes about the person live on this device: one IndexedDB database per edition
// (slicerx-memory-<edition>), so one edition never reads what the person told another on the same machine. The app
// reads and writes them through one handle per edition (memoryFor): mimir's memory.remember, the chip that asks first and
// Settings > Memory all share it, so a note saved in the chat shows in Settings at once.
import type { EditionConfig } from '@slicerx/edition-config'
import type { CreatePilotOptions, MemoryFact, MemoryStore } from '@slicerx/pilot'
import { useEdition } from '../edition'
import { get } from '../state/store'

const TABLE = 'facts'

function open(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, 1)
    let settled = false
    req.onupgradeneeded = () => req.result.createObjectStore(TABLE, { keyPath: 'id' })
    req.onsuccess = () => {
      const db = req.result
      // opened after we gave up waiting (onblocked): close it rather than leave it holding the database
      if (settled) return db.close()
      settled = true
      // a newer copy of the app upgrading the database: let it through
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => {
      settled = true
      reject(req.error ?? new Error('Could not open the memory store'))
    }
    req.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error('The memory store is busy in another SlicerX window. Close it and try again.'))
    }
  })
}

function indexedDbMemory(idb: IDBFactory, name: string): MemoryStore {
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open(idb, name).then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          // every way out closes the database: done, failed, aborted (a full disk aborts) or thrown before it began
          const fail = (e: unknown, fallback: string) => {
            db.close()
            reject(e ?? new Error(fallback))
          }
          try {
            const tx = db.transaction(TABLE, mode)
            const req = fn(tx.objectStore(TABLE))
            tx.oncomplete = () => {
              db.close()
              resolve(req.result)
            }
            tx.onerror = () => fail(tx.error, 'The memory store failed')
            tx.onabort = () => fail(tx.error, 'The memory store stopped before saving (the disk may be full)')
          } catch (e) {
            fail(e, 'The memory store failed')
          }
        }),
    )
  return {
    list: () => run('readonly', (s) => s.getAll() as IDBRequest<MemoryFact[]>),
    put: (f) => run('readwrite', (s) => s.put(f)).then(() => undefined),
    remove: (id) => run('readwrite', (s) => s.delete(id)).then(() => undefined),
    clear: () => run('readwrite', (s) => s.clear()).then(() => undefined),
  }
}

// For tests and hosts with no storage: the notes last until the page closes, still one set per edition.
const inMemory = new Map<string, Map<string, MemoryFact>>()

function memoryOnly(name: string): MemoryStore {
  const rows = inMemory.get(name) ?? new Map<string, MemoryFact>()
  inMemory.set(name, rows)
  return {
    list: async () => [...rows.values()].map((r) => structuredClone(r)),
    put: async (f) => void rows.set(f.id, structuredClone(f)),
    remove: async (id) => void rows.delete(id),
    clear: async () => rows.clear(),
  }
}

/** The notes for `edition` (its config id). `idb` is the browser's IndexedDB; null keeps them in memory. */
export function openMemoryStore(edition: string, idb: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): MemoryStore {
  const name = `slicerx-memory-${edition}`
  return idb ? indexedDbMemory(idb, name) : memoryOnly(name)
}

/** The app's handle on one edition's notes: the store, and a call for each change made through it. */
export type AppMemory = MemoryStore & { subscribe(listener: () => void): () => void }

const handles = new Map<string, AppMemory>()

function watched(store: MemoryStore): AppMemory {
  const listeners = new Set<() => void>()
  const changed = <T>(p: Promise<T>): Promise<T> =>
    p.then((v) => {
      // a listener that throws never fails the save, nor keeps the others from hearing of it
      for (const l of listeners) {
        try {
          l()
        } catch (e) {
          console.error('memory listener failed', e)
        }
      }
      return v
    })
  return {
    list: () => store.list(),
    put: (f) => changed(store.put(f)),
    remove: (id) => changed(store.remove(id)),
    clear: () => changed(store.clear()),
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

/**
 * The one handle every write and delete of `edition`'s notes goes through: mimir saving one, Settings editing,
 * deleting or clearing them. Anything that copies notes elsewhere wraps this, so it sees every change.
 */
export function memoryFor(edition: string): AppMemory {
  let h = handles.get(edition)
  if (!h) {
    h = watched(openMemoryStore(edition))
    handles.set(edition, h)
  }
  return h
}

/** The handle for the edition this app runs as. */
export function useMemoryStore(): AppMemory {
  return memoryFor(useEdition().id)
}

/**
 * What mimir runs with: the edition's switch, the shared handle, and whether saving a note shows the chip first.
 * Settings > Memory > Save notes without asking turns the chip off, read at each save, so it applies at once.
 */
export function pilotMemory(edition: EditionConfig, store: MemoryStore): NonNullable<CreatePilotOptions['memory']> {
  return { local: edition.ai.brain.memory.local, store, ask: () => !get().mimirRememberWithoutAsking }
}
