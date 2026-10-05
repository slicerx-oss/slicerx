// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/**
 * Where the outbox and profile sync keep their state between launches. Values
 * are structured-cloneable (plain objects, arrays, strings, numbers,
 * Uint8Array), so IndexedDB, a Tauri store or a mobile key-value store fit.
 */
export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

/** A store that lives only as long as the process; for tests and signed-out use. */
export function memoryStore(): KeyValueStore & { dump(): Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    get: (key) => Promise.resolve(structuredClone(data.get(key))),
    set: (key, value) => {
      data.set(key, structuredClone(value))
      return Promise.resolve()
    },
    delete: (key) => {
      data.delete(key)
      return Promise.resolve()
    },
    dump: () => data,
  }
}
