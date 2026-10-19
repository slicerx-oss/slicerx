// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where mimir's notes about the person live on this device: one IndexedDB database per edition
// (slicerx-memory-<edition>), so one edition never reads what the person told another on the same machine.
import type { MemoryFact, MemoryStore } from '@slicerx/pilot'

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
