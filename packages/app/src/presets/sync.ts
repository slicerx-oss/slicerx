// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Profile sync without an account: the presets, the deletions and a list of what changed travel in one JSON
// file that you keep wherever you like (a git repository, a synced folder, your own server). Merging two files
// is pure and order independent: per preset the newer edit wins, a deletion beats an older copy, and every
// change is written to the change notes so an update never happens silently.
import type { UserPreset } from './store'
import { appName } from '../edition'

export interface Tombstone {
  id: string
  at: number
}

export type SyncAction = 'added' | 'updated' | 'removed'

export interface SyncChange {
  at: number
  id: string
  name: string
  kind: UserPreset['kind']
  action: SyncAction
  /** Setting keys that differ, for an update. */
  keys?: string[]
  /** Both sides had edited the preset since the last sync; the newer one was kept. */
  conflict?: boolean
}

export interface SyncBundle {
  format: 'slicerx-presets'
  version: 1
  exportedAt: number
  presets: UserPreset[]
  deleted: Tombstone[]
  changes: SyncChange[]
}

export const TOMBSTONE_DAYS = 90
export const CHANGE_LIMIT = 200

export function makeBundle(presets: readonly UserPreset[], deleted: readonly Tombstone[], changes: readonly SyncChange[], now = Date.now()): SyncBundle {
  return { format: 'slicerx-presets', version: 1, exportedAt: now, presets: presets.map((p) => structuredClone(p)), deleted: [...deleted], changes: changes.slice(-CHANGE_LIMIT) }
}

/** Reads a bundle file. Throws a sentence for anything that is not one. */
export function parseBundle(text: string): SyncBundle {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`That file is not a ${appName()} sync file.`)
  }
  const o = raw as Partial<SyncBundle> | null
  if (!o || typeof o !== 'object' || o.format !== 'slicerx-presets') throw new Error(`That file is not a ${appName()} sync file.`)
  if (o.version !== 1) throw new Error(`That sync file is from a newer ${appName()}. Update the app to read it.`)
  const kinds = new Set(['printer', 'filament', 'process'])
  const presets = (Array.isArray(o.presets) ? o.presets : []).filter(
    (p): p is UserPreset => Boolean(p) && typeof p.id === 'string' && typeof p.name === 'string' && kinds.has(p.kind) && typeof p.updatedAt === 'number' && typeof p.createdAt === 'number' && p.values !== null && typeof p.values === 'object',
  )
  const deleted = (Array.isArray(o.deleted) ? o.deleted : []).filter((d): d is Tombstone => Boolean(d) && typeof d.id === 'string' && typeof d.at === 'number')
  const changes = (Array.isArray(o.changes) ? o.changes : []).filter((c): c is SyncChange => Boolean(c) && typeof c.id === 'string' && typeof c.at === 'number' && typeof c.name === 'string')
  return { format: 'slicerx-presets', version: 1, exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : 0, presets, deleted, changes }
}

const same = (a: UserPreset, b: UserPreset): boolean => a.name === b.name && JSON.stringify(a.values) === JSON.stringify(b.values) && JSON.stringify(a.easy ?? null) === JSON.stringify(b.easy ?? null)

/** Setting keys whose values differ between two presets. */
export function diffKeys(a: UserPreset, b: UserPreset): string[] {
  const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)])
  return [...keys].filter((k) => JSON.stringify(a.values[k]) !== JSON.stringify(b.values[k])).sort()
}

export interface MergeInput {
  presets: readonly UserPreset[]
  deleted: readonly Tombstone[]
  changes: readonly SyncChange[]
}

export interface MergeResult {
  presets: UserPreset[]
  deleted: Tombstone[]
  /** Every change in the result's notes, old and new. */
  changes: SyncChange[]
  /** What this merge did to the local side, for the person to read. */
  applied: SyncChange[]
}

/**
 * Merges a remote bundle into the local side. `since` is when the two last synced (0 when never): a preset edited
 * on both sides after it is reported as a conflict, and the newer edit is kept.
 */
export function mergeBundles(local: MergeInput, remote: SyncBundle, since: number, now = Date.now()): MergeResult {
  const dead = new Map<string, number>()
  for (const t of [...local.deleted, ...remote.deleted]) dead.set(t.id, Math.max(dead.get(t.id) ?? Number.NEGATIVE_INFINITY, t.at))
  const L = new Map(local.presets.map((p) => [p.id, p]))
  const R = new Map(remote.presets.map((p) => [p.id, p]))
  const out = new Map<string, UserPreset>()
  const applied: SyncChange[] = []
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id)
    const r = R.get(id)
    const gone = dead.get(id)
    if (l && r) {
      if (gone !== undefined && gone >= Math.max(l.updatedAt, r.updatedAt)) {
        applied.push({ at: now, id, name: l.name, kind: l.kind, action: 'removed' })
        continue
      }
      if (same(l, r)) out.set(id, l.updatedAt >= r.updatedAt ? l : r)
      else if (r.updatedAt > l.updatedAt) {
        out.set(id, r)
        applied.push({ at: now, id, name: r.name, kind: r.kind, action: 'updated', keys: diffKeys(l, r), ...(l.updatedAt > since && r.updatedAt > since ? { conflict: true } : {}) })
      } else out.set(id, l)
    } else if (l) {
      if (gone !== undefined && gone > l.updatedAt) applied.push({ at: now, id, name: l.name, kind: l.kind, action: 'removed' })
      else out.set(id, l)
    } else if (r) {
      if (gone !== undefined && gone >= r.updatedAt) continue
      out.set(id, r)
      applied.push({ at: now, id, name: r.name, kind: r.kind, action: 'added' })
    }
  }
  const cutoff = now - TOMBSTONE_DAYS * 86_400_000
  const deleted = [...dead].filter(([id, at]) => at >= cutoff && !out.has(id)).map(([id, at]) => ({ id, at }))
  const seen = new Set(local.changes.map((c) => `${c.at}|${c.id}|${c.action}`))
  const merged = [...local.changes, ...remote.changes.filter((c) => !seen.has(`${c.at}|${c.id}|${c.action}`)), ...applied].sort((a, b) => a.at - b.at).slice(-CHANGE_LIMIT)
  return { presets: [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')), deleted, changes: merged, applied }
}

/** One line per change, for the notes the person reads. */
export function describeChange(c: SyncChange): string {
  const what = `${c.name} (${c.kind})`
  if (c.action === 'added') return `Added ${what}.`
  if (c.action === 'removed') return `Removed ${what}.`
  const keys = c.keys?.length ? `: ${c.keys.slice(0, 4).join(', ')}${c.keys.length > 4 ? ` and ${c.keys.length - 4} more` : ''}` : ''
  return `Updated ${what}${keys}.${c.conflict ? ' Edited on both sides; the newer edit was kept.' : ''}`
}
