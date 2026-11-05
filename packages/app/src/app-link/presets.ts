// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's saved presets over the app link, as Settings > Presets > Compare presets has them. presets.list reads
// them (kind, name, parent, how many settings, which are in use); presets.compare compares one with another of its kind,
// its parent or the stock settings, with the same rows the panel lists (labels, keys, both values); presets.copy copies
// one setting's value from the second side into the preset, as the panel's copy button does, and answers with an undo
// id; presets.undo puts that copy back. Copies are edits: the hub lets only a client with the edit grant make them. No
// preset is created, renamed, deleted or applied, and nothing else about a preset changes.
import type { PrintConfig } from '@slicerx/contracts'
import type { ConfigComparison } from '@slicerx/settings'
import { appName } from '../edition'
import { get } from '../state/store'
import { comparePreset, copyValue, parentFor, parentSide, stockFor, undoCopy, whole, type CompareSide } from '../presets/compare'
import { loadPresets } from '../presets/presets'
import type { PresetKind, UserPreset } from '../presets/store'
import { LinkError } from './methods-error'

export interface LinkPreset {
  id: string
  kind: PresetKind
  name: string
  /** The maker preset it was made from, by name, when it names one. */
  parent?: string
  /** How many settings it changes. */
  settings: number
  /** It is the preset of its kind in use on the plate. */
  inUse: boolean
}

const listed = (p: UserPreset): LinkPreset => ({ id: p.id, kind: p.kind, name: p.name, ...(p.inherits ? { parent: p.inherits } : {}), settings: Object.keys(p.values).length, inUse: get().activePresets[p.kind] === p.id })

/** A copy the client may put back, by id: the preset as it was, and the preset as the copy left it. */
const undos = new Map<string, { before: UserPreset; key: string; updatedAt: number }>()
const UNDO_KEEP = 50
let undoSeq = 0

const text = (args: Record<string, unknown>, k: string, max = 200): string | undefined => {
  const v = args[k]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new LinkError('invalid_input', `${k} must be a name or id of up to ${max} characters`)
  return v.trim()
}

function only(args: Record<string, unknown>, keys: readonly string[], method: string): void {
  const extra = Object.keys(args).filter((k) => !keys.includes(k))
  if (extra.length) throw new LinkError('invalid_input', `${method} takes ${keys.join(', ')} only, not ${extra.join(', ')}`)
}

/** A saved preset by id, or by name (case alike) within `kind` when given. */
function find(q: string, kind?: PresetKind): UserPreset {
  const all = get().userPresets.filter((p) => !kind || p.kind === kind)
  const byId = all.find((p) => p.id === q)
  if (byId) return byId
  const named = all.filter((p) => p.name.toLowerCase() === q.toLowerCase())
  if (named.length === 1) return named[0]!
  if (named.length > 1) throw new LinkError('invalid_input', `${named.length} saved presets are named "${q}"; give its id from presets.list`, { ids: named.map((p) => p.id) })
  throw new LinkError('not_found', `No saved ${kind ? `${kind} ` : ''}preset "${q}" in ${appName()}; presets.list names them`)
}

/** The two sides of a compare of `a`: what applying it gives (over its stock settings), and the other side. */
async function sides(a: UserPreset, args: Record<string, unknown>): Promise<{ base: PrintConfig; side: CompareSide; with: string }> {
  const other = text(args, 'with')
  const against = args['against']
  if ((other === undefined) === (against === undefined)) throw new LinkError('invalid_input', 'Give the second side as with (another saved preset) or against ("parent" or "stock"), one of them')
  if (against !== undefined && against !== 'parent' && against !== 'stock') throw new LinkError('invalid_input', 'against is "parent" or "stock"')
  const base = stockFor(a)
  if (against === 'stock') return { base, side: { name: 'Stock', config: base }, with: 'stock' }
  if (against === 'parent') {
    if (!a.inherits) throw new LinkError('invalid_input', `${a.name} was not made from a maker preset, so it has no parent to compare with`, { reason: 'no_parent' })
    const parent = await parentFor(a)
    if (!parent) throw new LinkError('not_found', `${a.name} was made from ${a.inherits}, which does not ship with ${appName()}`, { reason: 'parent_not_shipped', parent: a.inherits })
    return { base, side: parentSide(a, parent), with: 'parent' }
  }
  const b = find(other!, a.kind)
  if (b.id === a.id) throw new LinkError('invalid_input', 'Compare a preset with another one, not itself')
  return { base, side: { name: b.name, config: whole(b, stockFor(b)) }, with: b.id }
}

export async function presetCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  // The list is read where the panel reads it, so a preset saved a moment ago is there.
  await loadPresets()
  if (method === 'presets.list') {
    only(args, ['kind'], method)
    const kind = args['kind']
    if (kind !== undefined && kind !== 'process' && kind !== 'filament' && kind !== 'printer') throw new LinkError('invalid_input', 'kind is process, filament or printer')
    return { presets: get().userPresets.filter((p) => !kind || p.kind === kind).map(listed) }
  }
  if (method === 'presets.compare') {
    only(args, ['preset', 'with', 'against', 'all'], method)
    const q = text(args, 'preset')
    if (!q) throw new LinkError('invalid_input', 'preset names the saved preset to compare, by id or name')
    if (args['all'] !== undefined && typeof args['all'] !== 'boolean') throw new LinkError('invalid_input', 'all is true or false')
    const a = find(q)
    const { base, side, with: w } = await sides(a, args)
    const c: ConfigComparison = comparePreset(a, base, side, { all: args['all'] === true })
    return { preset: listed(a), with: { name: side.name, ...(w === 'stock' || w === 'parent' ? { against: w } : { id: w }) }, differ: c.differ, groups: c.groups, unknownKeys: c.unknownKeys }
  }
  if (method === 'presets.copy') {
    only(args, ['preset', 'key', 'with', 'against'], method)
    const q = text(args, 'preset')
    const key = text(args, 'key', 100)
    if (!q || !key) throw new LinkError('invalid_input', 'presets.copy needs preset (by id or name) and key (a setting key from presets.compare)')
    const a = find(q)
    const { base, side } = await sides(a, args)
    const row = comparePreset(a, base, side).groups.flatMap((g) => g.rows).find((r) => r.key === key)
    if (!row) throw new LinkError('invalid_input', `${key} does not differ between ${a.name} and ${side.name}, or is not a ${a.kind} setting; presets.compare lists what differs`)
    const before = await copyValue(a.id, key, side.config, base)
    const after = get().userPresets.find((p) => p.id === a.id)
    if (!before || !after) throw new LinkError('not_found', `${a.name} is gone from ${appName()}`)
    const undoId = `pu_${++undoSeq}`
    undos.set(undoId, { before, key, updatedAt: after.updatedAt })
    while (undos.size > UNDO_KEEP) undos.delete(undos.keys().next().value!)
    return { preset: listed(after), key, label: row.label, value: after.values[key] ?? null, from: side.name, undoId }
  }
  if (method === 'presets.undo') {
    only(args, ['undoId'], method)
    const id = text(args, 'undoId', 40)
    const u = id ? undos.get(id) : undefined
    if (!u) throw new LinkError('not_found', 'No copy to put back with that undoId; it was put back already, or the app restarted')
    const now = get().userPresets.find((p) => p.id === u.before.id)
    if (!now) throw new LinkError('not_found', `${u.before.name} is gone from ${appName()}`)
    // A preset changed again since the copy is not put back over that change.
    if (now.updatedAt !== u.updatedAt) throw new LinkError('refused', `${now.name} changed after that copy, so putting it back would undo the later change too`)
    undos.delete(id!)
    await undoCopy(u.before, u.key)
    const after = get().userPresets.find((p) => p.id === u.before.id)!
    return { preset: listed(after), key: u.key, value: after.values[u.key] ?? null }
  }
  throw new LinkError('not_found', `${appName()} has no app link method ${method}`)
}
