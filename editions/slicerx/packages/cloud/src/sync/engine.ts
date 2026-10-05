// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Offline-first sync of printer, filament and process profiles, printers and
// fleets. Edits apply locally at once and persist in the KeyValueStore; sync()
// pushes them with the revision they were based on, merges concurrent edits
// to different fields (and to different settings keys) automatically, and
// keeps real conflicts for the user to settle.
import { canonicalJson } from '@slicerx/contracts'
import type { KeyValueStore } from '../kv'
import { type CloudResult, fail, ok } from '../result'
import type { PushChange, SyncTransport } from './transport'
import {
  type Draft,
  EDITABLE,
  type EntityMap,
  PRINTER_SECRET_KEYS,
  SYNC_ENTITIES,
  type SyncEntity,
  editableRow,
  fromRow,
} from './types'

type AnyRecord = EntityMap[SyncEntity]

interface Entry {
  entity: SyncEntity
  /** The last version this device saw from the service. */
  server: AnyRecord | null
  /** The local edit not yet accepted by the service. */
  local: AnyRecord | null
  status: 'pending' | 'conflict' | 'rejected' | null
  /** Conflict: the service's version that clashes with `local`. */
  theirs?: AnyRecord | null
  error?: { code: string; message: string }
}

interface Persisted {
  version: 1
  cursor: number
  entries: Record<string, Entry>
}

export interface SyncConflict<E extends SyncEntity = SyncEntity> {
  entity: E
  id: string
  mine: EntityMap[E]
  theirs: EntityMap[E] | null
}

export interface SyncRejection {
  entity: SyncEntity
  id: string
  code: string
  message: string
}

export interface SyncReport {
  pushed: number
  merged: number
  pulled: number
  conflicts: number
  rejected: number
}

export interface ProfileSyncOptions {
  transport: SyncTransport
  store: KeyValueStore
  /** Keeps each account's copy apart on a shared device. */
  userId: string
  /** This device's id from the cloud service, recorded on every write. */
  deviceId?: string | null
  now?: () => Date
}

export interface ProfileSync {
  /** Resolves once the local copy has loaded from the store. */
  ready: Promise<void>
  list<E extends SyncEntity>(entity: E, opts?: { includeDeleted?: boolean }): EntityMap[E][]
  get<E extends SyncEntity>(entity: E, id: string): EntityMap[E] | null
  /** Creates or edits a record locally; it reaches the service on the next sync(). */
  save<E extends SyncEntity>(entity: E, draft: Draft<E>): Promise<CloudResult<EntityMap[E]>>
  /** Marks a record deleted; other devices remove it when they sync. */
  remove(entity: SyncEntity, id: string): Promise<void>
  /** Local edits that have not reached the service yet. */
  pendingCount(): number
  sync(): Promise<CloudResult<SyncReport>>
  conflicts(): SyncConflict[]
  rejections(): SyncRejection[]
  /** Settles a conflict or a rejected edit: keep this device's version, or take the service's. */
  resolve(entity: SyncEntity, id: string, keep: 'mine' | 'theirs'): Promise<void>
  subscribe(cb: () => void): () => void
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
const key = (entity: SyncEntity, id: string) => `${entity}:${id}`
const BATCH = 200
const PAGE = 500

/**
 * Three-way merge of one record. Returns the merged record, or null when both
 * sides changed the same field (or the same settings key) differently.
 */
export function mergeRecords<T extends AnyRecord>(
  entity: SyncEntity,
  base: T | null,
  mine: T,
  theirs: T,
): T | null {
  const out: Record<string, unknown> = { ...theirs }
  const m = mine as unknown as Record<string, unknown>
  const t = theirs as unknown as Record<string, unknown>
  const b = base as unknown as Record<string, unknown> | null
  for (const field of EDITABLE[entity]) {
    const bv = b?.[field]
    const mv = m[field]
    const tv = t[field]
    if (same(mv, tv) || (b !== null && same(mv, bv))) continue
    if (b !== null && same(tv, bv)) {
      out[field] = mv
      continue
    }
    if (b === null) return null
    if (field === 'settings') {
      const merged = mergeKeys(bv as Record<string, unknown>, mv as Record<string, unknown>, tv as Record<string, unknown>)
      if (!merged) return null
      out[field] = merged
      continue
    }
    if (field === 'printerIds') {
      const bs = new Set(bv as string[])
      const ms = new Set(mv as string[])
      const ts = new Set(tv as string[])
      const keep = [...(tv as string[]), ...(mv as string[])].filter(
        (id, i, all) => all.indexOf(id) === i && !(bs.has(id) && (!ms.has(id) || !ts.has(id))),
      )
      out[field] = keep
      continue
    }
    return null
  }
  return out as unknown as T
}

function mergeKeys(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const [b, m, t] = [base[k], mine[k], theirs[k]]
    let v: unknown
    if (same(m, t) || same(m, b)) v = t
    else if (same(t, b)) v = m
    else return null
    if (v !== undefined) out[k] = v
  }
  return out
}

export function createProfileSync(opts: ProfileSyncOptions): ProfileSync {
  const storeKey = `sx-cloud:sync:${opts.userId}`
  const now = opts.now ?? (() => new Date())
  const listeners = new Set<() => void>()
  let state: Persisted = { version: 1, cursor: 0, entries: {} }
  let running: Promise<CloudResult<SyncReport>> | null = null

  const ready = (async () => {
    const saved = await opts.store.get(storeKey)
    if (saved && typeof saved === 'object' && (saved as Persisted).version === 1) state = saved as Persisted
  })()

  const persist = () => opts.store.set(storeKey, state)
  const notify = () => {
    for (const l of listeners) l()
  }
  const view = (e: Entry): AnyRecord | null => e.local ?? e.server

  async function commit() {
    await persist()
    notify()
  }

  function blankFor<E extends SyncEntity>(entity: E, id: string): EntityMap[E] {
    const common = { id, deleted: false, revision: 0, updatedAt: now().toISOString(), updatedBy: opts.deviceId ?? null }
    const blank: Record<SyncEntity, AnyRecord> = {
      profile: { ...common, kind: 'process', name: '', inherits: null, settings: {} },
      printer: {
        ...common,
        name: '',
        driver: null,
        model: null,
        printerProfileId: null,
        deviceId: null,
        localId: null,
        settings: {},
      },
      fleet: { ...common, name: '', printerIds: [] },
    }
    return blank[entity] as EntityMap[E]
  }

  function applyPushResult(e: Entry, id: string, status: string, row: unknown, report: SyncReport): void {
    if (status === 'applied') {
      e.server = fromRow(e.entity, row)
      e.local = null
      e.status = null
      delete e.theirs
      delete e.error
      report.pushed += 1
      return
    }
    if (status === 'rejected') {
      const r = (row ?? {}) as { code?: unknown; message?: unknown }
      e.status = 'rejected'
      e.error = { code: String(r.code ?? 'rejected'), message: String(r.message ?? 'the service refused the change') }
      report.rejected += 1
      return
    }
    const theirs = row === null ? null : fromRow(e.entity, row)
    const mine = e.local
    if (!mine) return
    if (theirs === null) {
      e.status = 'rejected'
      e.error = { code: 'not_found', message: `${e.entity} ${id} is not available to this account` }
      report.rejected += 1
      return
    }
    const merged = mergeRecords(e.entity, e.server, mine, theirs)
    if (merged && same(editableRow(e.entity, merged), editableRow(e.entity, theirs))) {
      // Our change already landed (its answer was lost) or matches theirs.
      e.server = theirs
      e.local = null
      e.status = null
      report.pushed += 1
    } else if (merged) {
      e.server = theirs
      e.local = { ...merged, revision: theirs.revision }
      e.status = 'pending'
      report.merged += 1
    } else {
      e.theirs = theirs
      e.status = 'conflict'
      report.conflicts += 1
    }
  }

  async function push(report: SyncReport): Promise<CloudResult<void>> {
    for (let round = 0; round < 3; round += 1) {
      const ids = Object.keys(state.entries).filter((k) => state.entries[k]?.status === 'pending')
      if (ids.length === 0) return ok(undefined)
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH)
        const changes: PushChange[] = []
        for (const k of batch) {
          const e = state.entries[k]
          if (!e?.local) continue
          changes.push({
            entity: e.entity,
            row: editableRow(e.entity, e.local),
            baseRevision: e.server ? e.server.revision : null,
          })
        }
        const res = await opts.transport.push(changes, opts.deviceId ?? null)
        if (!res.ok) return res
        for (const r of res.value) {
          const k = batch[r.idx]
          const e = k === undefined ? undefined : state.entries[k]
          if (e && k) applyPushResult(e, k.slice(k.indexOf(':') + 1), r.status, r.row, report)
        }
        await commit()
      }
    }
    return ok(undefined)
  }

  async function pull(report: SyncReport): Promise<CloudResult<void>> {
    for (;;) {
      const res = await opts.transport.pull(state.cursor, PAGE)
      if (!res.ok) return res
      for (const r of res.value) {
        const rec = fromRow(r.entity, r.row)
        state.cursor = Math.max(state.cursor, r.revision)
        if (!rec) continue
        const k = key(r.entity, rec.id)
        const e = state.entries[k]
        if (!e) {
          state.entries[k] = { entity: r.entity, server: rec, local: null, status: null }
        } else if (e.status === 'conflict') {
          e.theirs = rec
        } else if (e.local === null) {
          e.server = rec
        }
        // A pending edit keeps its base; its next push conflicts and merges against `rec`.
        report.pulled += 1
      }
      await commit()
      if (res.value.length < PAGE) return ok(undefined)
    }
  }

  async function runSync(): Promise<CloudResult<SyncReport>> {
    await ready
    const report: SyncReport = { pushed: 0, merged: 0, pulled: 0, conflicts: 0, rejected: 0 }
    const pushed = await push(report)
    if (!pushed.ok) return pushed
    const pulled = await pull(report)
    if (!pulled.ok) return pulled
    // Edits merged during the push go out now rather than on the next sync.
    const again = await push(report)
    if (!again.ok) return again
    report.conflicts = Object.values(state.entries).filter((e) => e.status === 'conflict').length
    return ok(report)
  }

  const api: ProfileSync = {
    ready,

    list<E extends SyncEntity>(entity: E, o: { includeDeleted?: boolean } = {}) {
      const out: EntityMap[E][] = []
      for (const e of Object.values(state.entries)) {
        if (e.entity !== entity) continue
        const v = view(e)
        if (v && (o.includeDeleted || !v.deleted)) out.push(v as EntityMap[E])
      }
      return out.sort((a, b) => ('name' in a && 'name' in b ? a.name.localeCompare(b.name) : 0))
    },

    get<E extends SyncEntity>(entity: E, id: string) {
      const e = state.entries[key(entity, id)]
      return e ? ((view(e) as EntityMap[E] | null) ?? null) : null
    },

    async save<E extends SyncEntity>(entity: E, draft: Draft<E>) {
      await ready
      if (!SYNC_ENTITIES.includes(entity)) return fail<EntityMap[E]>('bad_request', `unknown entity ${entity}`)
      const d = draft as Record<string, unknown>
      const name = typeof d.name === 'string' ? d.name.trim() : ''
      if (!name) return fail<EntityMap[E]>('bad_request', 'a name is required')
      if (entity === 'printer') {
        const s = (d.settings ?? {}) as Record<string, unknown>
        const bad = PRINTER_SECRET_KEYS.find((k) => k in s)
        if (bad) return fail<EntityMap[E]>('bad_request', `printer settings cannot hold ${bad}; keep it in the keychain`)
      }
      const id = typeof d.id === 'string' ? d.id : globalThis.crypto.randomUUID()
      const k = key(entity, id)
      const e: Entry = state.entries[k] ?? { entity, server: null, local: null, status: null }
      const current = view(e) ?? blankFor(entity, id)
      const next = { ...current, ...d, id, name, updatedAt: now().toISOString() } as EntityMap[E]
      e.local = next
      e.status = e.status === 'conflict' ? 'conflict' : 'pending'
      delete e.error
      state.entries[k] = e
      await commit()
      return ok(next)
    },

    async remove(entity, id) {
      await ready
      const e = state.entries[key(entity, id)]
      const current = e ? view(e) : null
      if (!e || !current) return
      e.local = { ...current, deleted: true, updatedAt: now().toISOString() }
      e.status = e.status === 'conflict' ? 'conflict' : 'pending'
      await commit()
    },

    pendingCount: () => Object.values(state.entries).filter((e) => e.status === 'pending').length,

    sync() {
      running ??= runSync().finally(() => {
        running = null
      })
      return running
    },

    conflicts() {
      const out: SyncConflict[] = []
      for (const [k, e] of Object.entries(state.entries)) {
        if (e.status === 'conflict' && e.local) {
          out.push({ entity: e.entity, id: k.slice(k.indexOf(':') + 1), mine: e.local, theirs: e.theirs ?? null })
        }
      }
      return out
    },

    rejections() {
      const out: SyncRejection[] = []
      for (const [k, e] of Object.entries(state.entries)) {
        if (e.status === 'rejected' && e.error) {
          out.push({ entity: e.entity, id: k.slice(k.indexOf(':') + 1), ...e.error })
        }
      }
      return out
    },

    async resolve(entity, id, keep) {
      const e = state.entries[key(entity, id)]
      if (!e || (e.status !== 'conflict' && e.status !== 'rejected')) return
      if (keep === 'theirs') {
        if (e.theirs !== undefined) e.server = e.theirs
        e.local = null
        e.status = null
      } else if (e.status === 'conflict' && e.theirs) {
        // Rebase on their version so the next push overwrites it.
        e.server = e.theirs
        e.status = 'pending'
      } else {
        e.status = 'pending'
      }
      delete e.theirs
      delete e.error
      if (e.server === null && e.local === null) delete state.entries[key(entity, id)]
      await commit()
    },

    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return api
}

