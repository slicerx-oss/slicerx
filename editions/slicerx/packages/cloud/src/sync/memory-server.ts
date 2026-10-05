// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An in-memory copy of sync_pull and sync_push with the same rules as the
// database: per-user rows, one revision counter, optimistic concurrency,
// tombstones, no credentials in printer settings, fleets of own printers.
// For tests and for running the app with sync but without a service.
import { ok } from '../result'
import type { PulledRow, PushChange, PushResult, SyncTransport } from './transport'
import { PRINTER_SECRET_KEYS, type SyncEntity } from './types'

type Row = Record<string, unknown> & { id: string; user_id: string; revision: number }

export interface MemorySyncServer {
  /** A transport acting as `userId`. */
  transportFor(userId: string): SyncTransport
  /** Every stored row, for assertions. */
  rows(entity: SyncEntity): Row[]
  /** Makes the next `n` calls fail as if the network were down. */
  goOffline(n?: number): void
  /** Applies the next push but loses its answer, as a dropped connection would. */
  dropNextPushResponse(): void
}

class Rejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function createMemorySyncServer(opts: { now?: () => string } = {}): MemorySyncServer {
  const tables: Record<SyncEntity, Map<string, Row>> = { profile: new Map(), printer: new Map(), fleet: new Map() }
  let seq = 0
  let offline = 0
  let dropNext = false
  let clock = 0
  const now = opts.now ?? (() => `2026-01-01T00:00:${String(clock++ % 60).padStart(2, '0')}Z`)

  const text = (v: unknown) => (typeof v === 'string' ? v : null)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const obj = (v: unknown, d: Record<string, unknown>) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : d

  function validate(entity: SyncEntity, row: Row, userId: string) {
    const name = text(row.name)
    if (!name || name.length > (entity === 'profile' ? 120 : 80)) throw new Rejected('23514', 'name is required')
    if (entity === 'profile' && !['printer', 'filament', 'process'].includes(String(row.kind)))
      throw new Rejected('23514', 'kind must be printer, filament or process')
    if (entity === 'printer') {
      const s = obj(row.settings, {})
      if (PRINTER_SECRET_KEYS.some((k) => k in s)) throw new Rejected('23514', 'printer settings cannot hold credentials')
      const pid = row.printer_profile_id
      if (pid !== null && pid !== undefined) {
        const p = tables.profile.get(String(pid))
        if (!p || p.user_id !== userId || p.kind !== 'printer')
          throw new Rejected('23503', 'printer_profile_id must be one of the owner\'s printer profiles')
      }
    }
    if (entity === 'fleet') {
      const ids = Array.isArray(row.printer_ids) ? (row.printer_ids as unknown[]) : []
      if (ids.some((i) => tables.printer.get(String(i))?.user_id !== userId))
        throw new Rejected('23503', 'a fleet can hold only the owner\'s printers')
    }
  }

  function apply(userId: string, c: PushChange, device: string | null): Omit<PushResult, 'idx'> {
    const table = tables[c.entity]
    const r = c.row
    const id = text(r.id) ?? globalThis.crypto.randomUUID()
    const existing = table.get(id)
    const visible = existing && existing.user_id === userId ? existing : null
    const pick = (k: string, fallback: unknown) => (k in r ? r[k] : fallback)
    let next: Row
    if (c.baseRevision === null) {
      if (existing) return { status: 'conflict', row: visible ? structuredClone(visible) : null }
      next = { id, user_id: userId, revision: 0, deleted: bool(r.deleted, false), updated_at: '', updated_by: device }
      if (c.entity === 'profile')
        Object.assign(next, { kind: r.kind, name: r.name, inherits: pick('inherits', null), settings: obj(r.settings, {}) })
      if (c.entity === 'printer')
        Object.assign(next, {
          name: r.name,
          driver: pick('driver', null),
          model: pick('model', null),
          printer_profile_id: pick('printer_profile_id', null),
          device_id: null,
          local_id: null,
          settings: obj(r.settings, {}),
        })
      if (c.entity === 'fleet') Object.assign(next, { name: r.name, printer_ids: pick('printer_ids', []) })
    } else {
      if (!visible || visible.revision !== c.baseRevision)
        return { status: 'conflict', row: visible ? structuredClone(visible) : null }
      next = { ...visible, updated_by: device }
      // The same columns, and the same null handling, as the update branches of sync_push.
      const nullable: Record<SyncEntity, string[]> = {
        profile: ['inherits'],
        printer: ['driver', 'model', 'printer_profile_id'],
        fleet: [],
      }
      if (typeof r.name === 'string') next.name = r.name
      if (typeof r.deleted === 'boolean') next.deleted = r.deleted
      for (const k of nullable[c.entity]) if (k in r) next[k] = r[k] ?? null
      if (c.entity !== 'fleet' && r.settings !== null && r.settings !== undefined) next.settings = obj(r.settings, {})
      if (c.entity === 'fleet' && 'printer_ids' in r) next.printer_ids = Array.isArray(r.printer_ids) ? r.printer_ids : []
    }
    if (device !== null && device.length !== 36) throw new Rejected('23503', 'updated_by must be one of the owner\'s devices')
    validate(c.entity, next, userId)
    seq += 1
    next.revision = seq
    next.updated_at = now()
    table.set(id, next)
    return { status: 'applied', row: structuredClone(next) }
  }

  function transportFor(userId: string): SyncTransport {
    const down = () => {
      if (offline > 0) {
        offline -= 1
        return true
      }
      return false
    }
    return {
      pull(since, limit) {
        if (down()) return Promise.resolve({ ok: false, code: 'offline', message: 'network is down' })
        const out: PulledRow[] = []
        for (const entity of ['profile', 'printer', 'fleet'] as const) {
          for (const row of tables[entity].values()) {
            if (row.user_id === userId && row.revision > since)
              out.push({ entity, revision: row.revision, row: structuredClone(row) })
          }
        }
        out.sort((a, b) => a.revision - b.revision)
        return Promise.resolve(ok(out.slice(0, Math.min(Math.max(limit, 1), 1000))))
      },
      push(changes, deviceId) {
        if (down()) return Promise.resolve({ ok: false, code: 'offline', message: 'network is down' })
        const results: PushResult[] = changes.map((c, idx) => {
          try {
            return { idx, ...apply(userId, c, deviceId) }
          } catch (e) {
            if (e instanceof Rejected) return { idx, status: 'rejected', row: { code: e.code, message: e.message } }
            throw e
          }
        })
        if (dropNext) {
          dropNext = false
          return Promise.resolve({ ok: false, code: 'offline', message: 'the connection dropped' })
        }
        return Promise.resolve(ok(results))
      },
    }
  }

  return {
    transportFor,
    rows: (entity) => [...tables[entity].values()].map((r) => structuredClone(r)),
    goOffline(n = 1) {
      offline = n
    },
    dropNextPushResponse() {
      dropNext = true
    },
  }
}
