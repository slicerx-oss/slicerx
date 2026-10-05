// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where user presets live on this device. The browser keeps them in IndexedDB; the desktop app's webview
// does the same inside its app data folder, and a host can supply its own store with setPresetStore.
import type { EasySettings, SettingValue } from '@slicerx/contracts'

export type PresetKind = 'printer' | 'filament' | 'process'

export interface UserPreset {
  id: string
  kind: PresetKind
  name: string
  /** Setting values in our keys, only the ones this preset changes. */
  values: Record<string, SettingValue>
  /** Process presets also keep the Easy mode choices. */
  easy?: EasySettings
  /** The system preset it started from, when known. */
  inherits?: string
  /** The printer preset it belongs to, by name, when it came in with one (an OrcaSlicer or Bambu Studio printer bundle). */
  printer?: string
  /** Set on presets written by a calibration: which filament, printer and nozzle it was tuned for, and the results. */
  tuned?: { key: string; filament: string; printerId: string; nozzleMm: number; results: Record<string, { label: string; value: string; at: number; /** The number as measured, for code that needs it back. */ raw?: number }> }
  createdAt: number
  updatedAt: number
}

export interface PresetStore {
  list(): Promise<UserPreset[]>
  put(p: UserPreset): Promise<void>
  remove(id: string): Promise<void>
}

const DB = 'slicerx-presets'
const TABLE = 'presets'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(TABLE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Could not open the preset store'))
  })
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(TABLE, mode)
        const req = fn(tx.objectStore(TABLE))
        tx.oncomplete = () => {
          db.close()
          resolve(req.result)
        }
        tx.onerror = () => reject(tx.error ?? new Error('The preset store failed'))
      }),
  )
}

export function indexedDbStore(): PresetStore {
  return {
    list: () => run('readonly', (s) => s.getAll() as IDBRequest<UserPreset[]>),
    put: (p) => run('readwrite', (s) => s.put(p)).then(() => undefined),
    remove: (id) => run('readwrite', (s) => s.delete(id)).then(() => undefined),
  }
}

/** For tests and hosts with no storage: keeps presets until the page closes. */
export function memoryStore(): PresetStore {
  const rows = new Map<string, UserPreset>()
  return {
    list: async () => [...rows.values()].map((r) => structuredClone(r)),
    put: async (p) => void rows.set(p.id, structuredClone(p)),
    remove: async (id) => void rows.delete(id),
  }
}

let current: PresetStore | null = null

export function setPresetStore(s: PresetStore | null): void {
  current = s
}

export function presetStore(): PresetStore {
  return (current ??= typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore())
}
