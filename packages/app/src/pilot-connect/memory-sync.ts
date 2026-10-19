// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's memory across devices, for a signed-in person who turned sync on. The facts live in the app's local store
// for each edition; this keeps that store in step with the person's rows in mimir_memory on the edition's Supabase
// project (supabase/migrations/0029_mimir_memory.sql). Per fact id the newer updatedAt wins, on either side. A
// deletion travels as a tombstone, { deleted: true, updatedAt }, so another device drops the fact too; tombstones of
// local deletions wait in a small per-edition list until a pull shows the server has them. A fact that looks like it
// holds a secret never leaves the device. Nothing is sent while sync is off or the person is signed out.
import { dataProblem, MEMORY_KINDS, noteProblem, secretInNote, type MemoryFact, type MemoryStore } from '@slicerx/pilot'

export type { MemoryFact, MemoryStore }

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
  now?: () => number
}

export type SyncResult = { pulled: number; pushed: number }

const KINDS: ReadonlySet<string> = new Set(MEMORY_KINDS)
const DAY_MS = 24 * 60 * 60 * 1000
/** The server drops tombstones older than this (0029's prune), so a deletion this old is not waited on. */
const TOMBSTONE_KEEP_MS = 90 * DAY_MS
/** The live facts one edition holds per person on the server (the table's trigger). */
export const MEMORY_SYNC_CAP = 2000
/** The largest fact the server takes, as its jsonb text (the table's check). */
export const MEMORY_FACT_MAX_BYTES = 8192

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A synced value read back as a fact or a tombstone, or null when its shape is wrong: kind outside the list, text not
 * a string, data not a flat record of strings and numbers, an id other than the row's, or no finite updatedAt. Only
 * the known keys are kept, and the fact always carries the row's id.
 */
export function parseSynced(id: string, v: unknown): MemoryFact | MemoryTombstone | null {
  if (!isRecord(v) || !isTime(v.updatedAt)) return null
  if ('deleted' in v) return v.deleted === true && Object.keys(v).length === 2 ? { deleted: true, updatedAt: v.updatedAt } : null
  if (v.id !== id || typeof v.kind !== 'string' || !KINDS.has(v.kind) || typeof v.text !== 'string') return null
  const out: MemoryFact = { id, kind: v.kind as MemoryFact['kind'], text: v.text, updatedAt: v.updatedAt }
  if (v.data !== undefined) {
    if (!isRecord(v.data)) return null
    const data: Record<string, string | number> = {}
    for (const [k, x] of Object.entries(v.data)) {
      if (typeof x !== 'string' && !(typeof x === 'number' && Number.isFinite(x))) return null
      data[k] = x
    }
    out.data = data
  }
  return out
}

/**
 * An upper bound on the size of the fact as the server stores it: its JSON plus the space jsonb text adds after each
 * colon and comma.
 */
function storedBytes(f: MemoryFact | MemoryTombstone): number {
  const json = JSON.stringify(f)
  const members = Object.keys(f).length + ('data' in f && f.data ? Object.keys(f.data).length : 0)
  return new TextEncoder().encode(json).length + 2 * members
}

const isTombstone = (f: MemoryFact | MemoryTombstone): f is MemoryTombstone => (f as MemoryTombstone).deleted === true

/**
 * What a sync sends for a local fact or deletion, or null when it must stay on this device: a bad shape, a size the
 * server would refuse (one such fact would fail the whole batch), a time more than a day ahead of this clock, or a
 * fact that holds something like a secret (secretInNote), so a secret that reached the local store never leaves it.
 */
function pushable(id: string, f: MemoryFact | MemoryTombstone, limit: number): MemoryFact | MemoryTombstone | null {
  const clean = parseSynced(id, f)
  if (!clean || clean.updatedAt > limit || storedBytes(clean) > MEMORY_FACT_MAX_BYTES) return null
  if (!isTombstone(clean) && secretInNote(clean)) return null
  return clean
}

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
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => isTime(e[1])))
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
 * Remote rows with a bad shape, dated more than a day ahead of this clock, or that fail a note's checks (noteProblem)
 * are never applied; a local fact that is
 * malformed, too large or dated ahead stays on this device. New live facts stop at the server's cap, so one fact too
 * many cannot fail the batch.
 */
export async function syncMemory(store: MemoryStore, edition: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const remote = opts.remote === undefined ? registered : opts.remote
  const kv = opts.kv ?? browserKv
  const limit = (opts.now ?? Date.now)() + DAY_MS
  if (!remote) return { pulled: 0, pushed: 0 }
  const rows = await remote.pull(edition)
  if (!rows) return { pulled: 0, pushed: 0 }
  const theirs = new Map<string, MemoryFact | MemoryTombstone>()
  // ids whose remote row is unusable: the time a local edit must beat to replace it (Infinity: leave the id alone)
  const blocked = new Map<string, number>()
  let remoteLive = 0
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') continue
    const raw = r.fact as unknown
    if (!isRecord(raw) || !('deleted' in raw)) remoteLive++
    const f = parseSynced(r.id, raw)
    // a remote fact passes the checks a note saved here passes (noteProblem: one line, the length, no secret; its data
    // within the save's limits: each name and value on one line, names up to 40 characters, values up to 80), or is skipped
    if (f && f.updatedAt <= limit && (isTombstone(f) || (noteProblem(f.text) === null && !(f.data && dataProblem(f.data)) && !secretInNote(f)))) theirs.set(r.id, f)
    else blocked.set(r.id, isRecord(raw) && isTime(raw.updatedAt) && raw.updatedAt <= limit ? raw.updatedAt : Infinity)
  }
  const local = new Map((await store.list()).map((f) => [f.id, f]))
  const deleted = readTombstones(kv, edition)
  const ids = new Set([...theirs.keys(), ...blocked.keys(), ...local.keys(), ...Object.keys(deleted)])
  const send: MemoryRow[] = []
  const apply: [string, MemoryFact | MemoryTombstone][] = []
  for (const id of ids) {
    const kept: MemoryFact | MemoryTombstone | undefined = local.get(id) ?? (id in deleted ? { deleted: true, updatedAt: deleted[id]! } : undefined)
    const mine = kept && pushable(id, kept, limit)
    const other = theirs.get(id)
    const floor = other?.updatedAt ?? blocked.get(id)
    if (mine && (floor === undefined || mine.updatedAt > floor)) {
      const adds = !isTombstone(mine) && (!other || isTombstone(other)) && !blocked.has(id)
      if (adds && remoteLive >= MEMORY_SYNC_CAP) continue
      if (adds) remoteLive++
      send.push({ id, fact: mine })
    } else if (other && (!kept || other.updatedAt > kept.updatedAt)) {
      apply.push([id, other])
    }
  }
  let pulled = 0
  if (apply.length) {
    // Read the store again just before applying, so a local edit made while the remote answered is not overwritten.
    const fresh = new Map((await store.list()).map((f) => [f.id, f]))
    const freshDeleted = readTombstones(kv, edition)
    for (const [id, other] of apply) {
      const latest = fresh.get(id)?.updatedAt ?? freshDeleted[id]
      if (latest !== undefined && latest >= other.updatedAt) continue
      if (isTombstone(other)) {
        if (fresh.has(id)) {
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
  // A deletion waits here until a pull shows the server has it (its tombstone, or a newer edit from another device that
  // wins), since the server skips a write it finds too far ahead of its own clock. It also goes once the fact is back
  // in the local store, once an unusable remote row stands in its way, or once it is older than the server keeps
  // tombstones. One noted during this sync stays.
  const now = readTombstones(kv, edition)
  const oldest = (opts.now ?? Date.now)() - TOMBSTONE_KEEP_MS
  for (const [id, at] of Object.entries(deleted)) {
    if (now[id] !== at) continue
    const other = theirs.get(id)
    const settled = other ? (isTombstone(other) ? other.updatedAt >= at : other.updatedAt > at) : false
    const moot = local.has(id) || (blocked.get(id) ?? -Infinity) >= at || at < oldest
    if (settled || moot) delete now[id]
  }
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
}

export interface MemorySync {
  /** The store to read and write through: changes schedule a sync, and deletions are kept so they sync. */
  store: MemoryStore
  /** Runs a sync now, when sync is on (each chat start calls this). */
  chatStarted(): Promise<SyncResult>
  /**
   * Cancels a pending sync without running it. Local facts and noted deletions stay on this device and go at the next
   * sync (the next chat start).
   */
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
      // syncMemory checks each fact's shape; this only drops what is not a row at all
      const rows = (await res.json()) as unknown
      return Array.isArray(rows) ? rows.filter((r): r is MemoryRow => isRecord(r) && typeof r.id === 'string') : []
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
