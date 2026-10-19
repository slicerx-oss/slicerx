// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's memory across devices, for a signed-in person who turned sync on. The facts live in the app's local store
// for each edition; this keeps that store in step with the person's rows in mimir_memory on the edition's Supabase
// project (supabase/migrations/0029_mimir_memory.sql). Per fact id the newer updatedAt wins, on either side. A
// deletion travels as a tombstone, { deleted: true, updatedAt }, so another device drops the fact too; tombstones of
// local deletions wait in a small per-edition list until a sync has sent them. Nothing is sent while sync is off or
// the person is signed out.

// Matches MemoryFact and MemoryStore of the local memory store (packages/pilot/src/memory/facts.ts). Replace these
// with the import from @slicerx/pilot once that module lands.
export type MemoryFact = {
  id: string
  kind: 'printer' | 'filament' | 'preference' | 'outcome' | 'size'
  text: string
  data?: Record<string, string | number>
  updatedAt: number
}
export interface MemoryStore {
  list(): Promise<MemoryFact[]>
  put(f: MemoryFact): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

/** A deleted fact as it syncs. */
export type MemoryTombstone = { deleted: true; updatedAt: number }
/** One row of mimir_memory as the app reads and writes it. */
export type MemoryRow = { id: string; fact: MemoryFact | MemoryTombstone }

/** The person's synced facts of one edition. Null from pull means signed out: the sync then does nothing. */
export interface MemoryRemote {
  pull(edition: string): Promise<MemoryRow[] | null>
  push(edition: string, rows: MemoryRow[]): Promise<void>
}

/** Where tombstones of local deletions wait until they are sent. */
export interface MemoryKeyValue {
  get(key: string): string | null
  set(key: string, value: string | null): void
}

export interface SyncOptions {
  remote?: MemoryRemote | null
  kv?: MemoryKeyValue
}

export type SyncResult = { pulled: number; pushed: number }

const isTombstone = (f: MemoryFact | MemoryTombstone): f is MemoryTombstone => (f as MemoryTombstone).deleted === true

let registered: MemoryRemote | null = null

/** Sets the remote the app syncs with (the signed-in person's rows), or null for none. */
export function registerMemoryRemote(remote: MemoryRemote | null): void {
  registered = remote
}

const browserKv: MemoryKeyValue = {
  get(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key)
      else globalThis.localStorage?.setItem(key, value)
    } catch {
      // storage blocked: a deletion then syncs only if this device still runs when it happens
    }
  },
}

const tombstoneKey = (edition: string): string => `slicerx-memory-tombstones-${edition}`

function readTombstones(kv: MemoryKeyValue, edition: string): Record<string, number> {
  try {
    const raw = JSON.parse(kv.get(tombstoneKey(edition)) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number'))
  } catch {
    return {}
  }
}

function writeTombstones(kv: MemoryKeyValue, edition: string, t: Record<string, number>): void {
  kv.set(tombstoneKey(edition), Object.keys(t).length ? JSON.stringify(t) : null)
}

/** Notes a local deletion so the next sync sends it. */
function noteDeleted(kv: MemoryKeyValue, edition: string, ids: string[], at: number): void {
  if (!ids.length) return
  const t = readTombstones(kv, edition)
  for (const id of ids) t[id] = Math.max(at, t[id] ?? 0)
  writeTombstones(kv, edition, t)
}

/**
 * Brings the local store and the person's synced facts of this edition into step: per id the newer updatedAt wins,
 * a newer remote fact or tombstone is applied locally (pulled), a newer local fact or deletion is sent (pushed).
 */
export async function syncMemory(store: MemoryStore, edition: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const remote = opts.remote === undefined ? registered : opts.remote
  const kv = opts.kv ?? browserKv
  if (!remote) return { pulled: 0, pushed: 0 }
  const rows = await remote.pull(edition)
  if (!rows) return { pulled: 0, pushed: 0 }
  const theirs = new Map(rows.map((r) => [r.id, r.fact]))
  const local = new Map((await store.list()).map((f) => [f.id, f]))
  const deleted = readTombstones(kv, edition)
  const ids = new Set([...theirs.keys(), ...local.keys(), ...Object.keys(deleted)])
  const send: MemoryRow[] = []
  let pulled = 0
  for (const id of ids) {
    const mine: MemoryFact | MemoryTombstone | undefined = local.get(id) ?? (id in deleted ? { deleted: true, updatedAt: deleted[id]! } : undefined)
    const other = theirs.get(id)
    if (mine && (!other || mine.updatedAt > other.updatedAt)) {
      send.push({ id, fact: mine })
    } else if (other && (!mine || other.updatedAt > mine.updatedAt)) {
      if (isTombstone(other)) {
        if (local.has(id)) {
          await store.remove(id)
          pulled++
        }
      } else {
        await store.put(other)
        pulled++
      }
    }
  }
  if (send.length) await remote.push(edition, send)
  // Every tombstone read here is now on the remote, or older than what is there. One noted during this sync stays.
  const now = readTombstones(kv, edition)
  for (const [id, at] of Object.entries(deleted)) if (now[id] === at) delete now[id]
  writeTombstones(kv, edition, now)
  return { pulled, pushed: send.length }
}

export interface MemorySyncOptions extends SyncOptions {
  /** Whether the person turned sync on (Settings), read before every sync. Off, nothing is read or sent. */
  enabled: () => boolean
  /** How long after the last change a sync waits. */
  debounceMs?: number
  /** A sync that failed; it runs again at the next chat or change. */
  onError?: (e: unknown) => void
  now?: () => number
}

export interface MemorySync {
  /** The store to read and write through: changes schedule a sync, and deletions are kept so they sync. */
  store: MemoryStore
  /** Runs a sync now, when sync is on (each chat start calls this). */
  chatStarted(): Promise<SyncResult>
  /** Cancels a pending sync. */
  stop(): void
}

/** Keeps one edition's store in sync: at each chat start and shortly after each change, and only while sync is on. */
export function startMemorySync(store: MemoryStore, edition: string, opts: MemorySyncOptions): MemorySync {
  const kv = opts.kv ?? browserKv
  const now = opts.now ?? Date.now
  const wait = opts.debounceMs ?? 2000
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<SyncResult> | null = null
  let again = false
  let stopped = false

  const run = (): Promise<SyncResult> => {
    if (stopped || !opts.enabled()) return Promise.resolve({ pulled: 0, pushed: 0 })
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        return await syncMemory(store, edition, opts)
      } catch (e) {
        opts.onError?.(e)
        return { pulled: 0, pushed: 0 }
      } finally {
        running = null
        if (again) {
          again = false
          schedule()
        }
      }
    })()
    return running
  }

  const schedule = (): void => {
    if (stopped || !opts.enabled()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void run()
    }, wait)
  }

  const wrapped: MemoryStore = {
    list: () => store.list(),
    async put(f) {
      await store.put(f)
      schedule()
    },
    async remove(id) {
      await store.remove(id)
      noteDeleted(kv, edition, [id], now())
      schedule()
    },
    async clear() {
      const ids = (await store.list()).map((f) => f.id)
      await store.clear()
      noteDeleted(kv, edition, ids, now())
      schedule()
    },
  }

  return {
    store: wrapped,
    chatStarted: run,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export interface SupabaseTarget {
  url: string
  anonKey: string
}

/**
 * The signed-in person's rows in mimir_memory over the project's REST API. Each call carries the session token;
 * signed out, pull answers null and nothing is sent.
 */
export function supabaseMemoryRemote(target: SupabaseTarget, token: () => Promise<string | null>, f: typeof fetch = (...a) => fetch(...a)): MemoryRemote {
  const base = `${target.url.replace(/\/+$/, '')}/rest/v1/mimir_memory`
  const headers = (session: string): Record<string, string> => ({ apikey: target.anonKey, Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' })
  const fail = async (res: Response, what: string): Promise<Error> => {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    return new Error(`memory ${what} failed: ${body.message ?? `HTTP ${res.status}`}`)
  }
  return {
    async pull(edition) {
      const session = await token().catch(() => null)
      if (!session) return null
      const res = await f(`${base}?select=id,fact&edition=eq.${encodeURIComponent(edition)}`, { headers: headers(session) })
      if (!res.ok) throw await fail(res, 'pull')
      const rows = (await res.json()) as { id: string; fact: MemoryFact | MemoryTombstone }[]
      return rows.filter((r) => r && typeof r.id === 'string' && r.fact && typeof r.fact.updatedAt === 'number')
    },
    async push(edition, rows) {
      const s = await token().catch(() => null)
      if (!s || !rows.length) return
      const body = rows.map((r) => ({ edition, id: r.id, fact: r.fact, updated_at: new Date(r.fact.updatedAt).toISOString() }))
      const res = await f(`${base}?on_conflict=user_id,edition,id`, {
        method: 'POST',
        headers: { ...headers(s), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await fail(res, 'push')
    },
  }
}
