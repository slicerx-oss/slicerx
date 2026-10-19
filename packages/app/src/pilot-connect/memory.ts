// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's one handle on mimir's memory for the edition open now. Every writer goes through it: the dock (and the
// chip that asks first), the mimir tab, the app link (mimir.memory and mimir.memory_remember for MCP clients) and
// Settings > Memory. The local store (memory-store.ts) sits under the sync wrapper (memory-sync.ts), so a removal or a
// clear records the tombstone a later sync sends, whichever of them made it; on top, every change is announced, so a
// note saved in the chat shows in Settings at once.
import type { EditionConfig } from '@slicerx/edition-config'
import type { CreatePilotOptions, MemoryFact, MemoryStore } from '@slicerx/pilot'
import { setMemoryProvider, type MemoryProvider } from '../app-link/mimir-memory'
import { useEdition } from '../edition'
import { get } from '../state/store'
import { openMemoryStore } from './memory-store'
import { startMemorySync, type MemorySync, type MemorySyncOptions } from './memory-sync'

export interface AppMemory {
  /** The edition's config id the notes belong to. */
  edition: string
  /** Whether the edition keeps notes at all (ai.brain.memory.local). */
  local: boolean
  /** The store to read and write through; it tells subscribers of each change made through it. */
  store: WatchedMemory
  sync: MemorySync
}

/** A memory store that tells its listeners after each change made through it. */
export type WatchedMemory = MemoryStore & { subscribe(listener: () => void): () => void }

function watched(store: MemoryStore): WatchedMemory {
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

let current: AppMemory | null = null

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The app link's view of the store: list by kind, and remember one fact (an equal note of the same kind is updated). */
export function memoryProvider(store: MemoryStore, now: () => number = Date.now): MemoryProvider {
  return {
    list: async (kind) => (await store.list()).filter((f) => kind === undefined || f.kind === kind),
    async remember(f) {
      const old = (await store.list()).find((x) => x.kind === f.kind && same(x.text, f.text))
      const fact: MemoryFact = { id: old?.id ?? `mem_${globalThis.crypto.randomUUID()}`, kind: f.kind, text: f.text, updatedAt: now(), ...(f.data ? { data: f.data } : {}) }
      await store.put(fact)
      return fact
    },
  }
}

export interface AppMemoryOptions {
  /** The store under the wrapper; default the edition's IndexedDB store. */
  open?: (edition: string) => MemoryStore
  /** Sync options for tests (kv, now, remote). */
  sync?: Partial<MemorySyncOptions>
}

/**
 * The memory handle for `edition`, made once per edition and shared by every caller. A new edition stops the old
 * handle's sync and takes the app link over. With ai.brain.memory.local off, the link answers that memory is off.
 */
export function appMemory(edition: Pick<EditionConfig, 'id' | 'ai'>, opts: AppMemoryOptions = {}): AppMemory {
  const local = edition.ai.brain.memory.local
  if (current && current.edition === edition.id && current.local === local) return current
  current?.sync.stop()
  const base = (opts.open ?? openMemoryStore)(edition.id)
  // TODO(stage 2, with the Settings switch): sync on at chat start, the remote from the session token
  // (supabaseMemoryRemote) and enabled from ai.brain.memory.sync and the person's choice. Until then nothing is sent;
  // the wrapper still keeps a tombstone for each removal so the first sync carries them.
  const sync = startMemorySync(base, edition.id, { remote: null, ...opts.sync, enabled: opts.sync?.enabled ?? (() => false) })
  const store = watched(sync.store)
  current = { edition: edition.id, local, store, sync }
  setMemoryProvider(local ? memoryProvider(store) : null)
  return current
}

/** The store every read and write of `edition`'s notes goes through (appMemory's). */
export function memoryFor(edition: Pick<EditionConfig, 'id' | 'ai'>): WatchedMemory {
  return appMemory(edition).store
}

/** The handle's store for the edition this app runs as. */
export function useMemoryStore(): WatchedMemory {
  return memoryFor(useEdition())
}

/**
 * What mimir runs with: the edition's switch, the shared store, and whether saving a note shows the chip first.
 * Settings > Memory > Save notes without asking turns the chip off, read at each save, so it applies at once.
 */
export function pilotMemory(edition: Pick<EditionConfig, 'ai'>, store: MemoryStore): NonNullable<CreatePilotOptions['memory']> {
  return { local: edition.ai.brain.memory.local, store, ask: () => !get().mimirRememberWithoutAsking }
}

/** Drops the handle and takes it off the app link (tests, and a window closing). */
export function resetAppMemory(): void {
  current?.sync.stop()
  current = null
  setMemoryProvider(null)
}
