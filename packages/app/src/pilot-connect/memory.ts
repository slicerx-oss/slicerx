// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's one handle on mimir's memory for the edition open now. Every writer goes through it: the dock (and the
// chip that asks first), the mimir tab, the app link (mimir.memory and mimir.memory_remember for MCP clients) and
// Settings > Memory. The local store (memory-store.ts) sits under the sync wrapper (memory-sync.ts), so a removal or a
// clear records the tombstone a later sync sends, whichever of them made it; on top, every change is announced, so a
// note saved in the chat shows in Settings at once.
//
// Sync with the account runs at each chat start and shortly after each change, and only while the person is signed
// in, the edition offers it (ai.brain.memory.sync 'opt-in') and the person turned it on (Settings > Memory > Sync with
// my account). It talks to the edition's Supabase project with the same session token the rest of the app's cloud
// calls carry (the host's store client).
import type { PilotConfig } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { whereNotesGo, type CreatePilotOptions, type MemoryFact, type MemoryStore, type NotesWhere } from '@slicerx/pilot'
import { useEffect, useSyncExternalStore } from 'react'
import { setMemoryProvider, type MemoryProvider } from '../app-link/mimir-memory'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { get } from '../state/store'
import { openMemoryStore } from './memory-store'
import { registerMemoryRemote, startMemorySync, supabaseMemoryRemote, type MemorySync, type MemorySyncOptions, type SupabaseTarget } from './memory-sync'

export interface AppMemory {
  /** The edition's config id the notes belong to. */
  edition: string
  /** Whether the edition keeps notes at all (ai.brain.memory.local). */
  local: boolean
  /** Whether the edition lets the person copy notes to their account (ai.brain.memory.sync), as last read. */
  syncMode: 'off' | 'opt-in'
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

/** The account notes sync with: the edition's Supabase project and the signed-in session's token. */
export interface MemoryAccount {
  /** What identifies this sign-in source (the host's store client), so binding the same one twice changes nothing. */
  key: unknown
  target: SupabaseTarget
  getAccessToken(): Promise<string | null>
  onTokenChange(cb: (token: string | null) => void): () => void
  /** For tests; default the browser's fetch. */
  fetch?: typeof fetch
}

let account: MemoryAccount | null = null
let accountOff: (() => void) | null = null
let signedIn = false
const signInListeners = new Set<() => void>()

function setSignedIn(v: boolean): void {
  if (v === signedIn) return
  signedIn = v
  for (const l of signInListeners) l()
  // signing in is a good moment to catch up, like a chat start
  if (v) void current?.sync.chatStarted()
}

/**
 * Sets the account notes sync with (null: none). The remote it registers carries the session token on every call, so
 * signing out stops sync at once; signing in runs one.
 */
export function bindMemoryAccount(next: MemoryAccount | null): void {
  if (next?.key === account?.key && next?.target.url === account?.target.url) return
  accountOff?.()
  accountOff = null
  account = next
  setSignedIn(false)
  registerMemoryRemote(next ? supabaseMemoryRemote(next.target, () => next.getAccessToken(), next.fetch) : null)
  if (!next) return
  const seen = (t: string | null): void => {
    if (account === next) setSignedIn(t !== null)
  }
  accountOff = next.onTokenChange(seen)
  void next.getAccessToken().then(seen, () => seen(null))
}

type TokenStore = { getAccessToken(): Promise<string | null>; onTokenChange(cb: (token: string | null) => void): () => void }

/** The account of an edition host (its store client and the edition's Supabase project), or null without one. */
export function hostMemoryAccount(host: unknown, edition: Pick<EditionConfig, 'backend' | 'features'>): MemoryAccount | null {
  const store = (host as { store?: Partial<TokenStore> } | null)?.store
  const sb = edition.features.demoData ? null : edition.backend.supabase
  if (!sb || typeof store?.getAccessToken !== 'function' || typeof store.onTokenChange !== 'function') return null
  const s = store as TokenStore
  return { key: s, target: { url: sb.url, anonKey: sb.anonKey }, getAccessToken: () => s.getAccessToken(), onTokenChange: (cb) => s.onTokenChange(cb) }
}

/** Binds this app's account for memory sync (once; a host without accounts leaves it as it is). */
export function useMemoryAccount(): void {
  const host = useHost()
  const edition = useEdition()
  useEffect(() => {
    const a = hostMemoryAccount(host, edition)
    if (a) bindMemoryAccount(a)
  }, [host, edition])
}

/** Whether someone is signed in to the account memory syncs with. */
export function useMemorySignedIn(): boolean {
  return useSyncExternalStore(
    (l) => {
      signInListeners.add(l)
      return () => void signInListeners.delete(l)
    },
    () => signedIn,
  )
}

/** Whether notes sync now: signed in, the edition offers it, and the person turned it on. */
export function memorySyncOn(): boolean {
  return signedIn && current?.syncMode === 'opt-in' && get().mimirMemorySync
}

/** Runs a sync now when sync is on (Settings turning it on). */
export function syncMemoryNow(): Promise<unknown> {
  return current?.sync.chatStarted() ?? Promise.resolve()
}

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
  const syncMode = edition.ai.brain.memory.sync
  if (current && current.edition === edition.id && current.local === local) {
    current.syncMode = syncMode
    return current
  }
  current?.sync.stop()
  const base = (opts.open ?? openMemoryStore)(edition.id)
  // The remote is the one bindMemoryAccount registers (each call carries the session token). With sync off the
  // wrapper still keeps a tombstone for each removal, so the first sync carries them.
  const sync = startMemorySync(base, edition.id, { onError: (e) => console.warn('memory sync failed', e), ...opts.sync, enabled: opts.sync?.enabled ?? memorySyncOn })
  const store = watched(sync.store)
  current = { edition: edition.id, local, syncMode, store, sync }
  setMemoryProvider(local ? memoryProvider(store) : null)
  return current
}

/**
 * What the app does once at start (SlicerXApp), and again when the edition or the host changes: makes the edition's
 * memory handle, so the app link's mimir.memory answers with the notes before any chat or Settings > Memory mounts,
 * and binds the account notes sync with. Signing in and out after that is followed through the account's token.
 */
export function startAppMemory(host: unknown, edition: Pick<EditionConfig, 'id' | 'ai' | 'backend' | 'features'>, opts: AppMemoryOptions = {}): AppMemory {
  const h = appMemory(edition, opts)
  const a = hostMemoryAccount(host, edition)
  if (a) bindMemoryAccount(a)
  return h
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
 * What mimir runs with: the edition's switch, the shared store, whether saving a note shows the chip first, and the
 * sync each chat start runs (when sync is on). Settings > Memory > Save notes without asking turns the chip off, read
 * at each save, so it applies at once. `remember: false` is for a host that cannot grant the approval a save needs.
 * `where` is where the chat's model runs (chatNotesGo), so the chip says whether and where notes go along with chats.
 */
/**
 * Where a chat's notes go with it: to the cloud for any model that answers from elsewhere (mimir cloud, or the person's
 * own Anthropic or OpenAI key), by the server's address for a server the person runs (this computer, or a computer
 * on their network), and nowhere for the built-in demo (`live` false).
 */
export function chatNotesGo(config: Pick<PilotConfig, 'provider' | 'baseUrl'>, live: boolean): NotesWhere {
  return live ? whereNotesGo(config) : 'computer'
}

export function pilotMemory(edition: Pick<EditionConfig, 'id' | 'ai'>, opts: { remember?: boolean; where?: NotesWhere } = {}): NonNullable<CreatePilotOptions['memory']> {
  const h = appMemory(edition)
  const where = opts.where ?? 'computer'
  return { local: h.local, store: h.store, ask: () => !get().mimirRememberWithoutAsking, chatStarted: () => h.sync.chatStarted(), where: () => where, ...(opts.remember === false ? { remember: false } : {}) }
}

/** Drops the handle and takes it off the app link (tests, and a window closing). */
export function resetAppMemory(): void {
  current?.sync.stop()
  current = null
  setMemoryProvider(null)
  bindMemoryAccount(null)
}
