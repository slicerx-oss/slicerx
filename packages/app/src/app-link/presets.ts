// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's saved presets over the app link, as Settings > Presets > Compare presets has them. presets.list reads
// them (kind, name, parent, how many settings, which are in use); presets.compare compares one with another of its kind,
// its parent or the stock settings, with the same rows the panel lists (labels, keys, both values); presets.copy copies
// one setting's value from the second side into the preset, as the panel's copy button does, and answers with an undo
// id; presets.undo puts that one setting back. Copies are edits: the hub lets only a client with the edit grant make
// them, and since presets are not part of the open project the grant covers, each copy and undo also asks the person
// in the app (preset-asks.ts) and the person is told who changed what. No preset is created, renamed, deleted or
// applied, and nothing else about a preset changes.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import type { ConfigComparison } from '@slicerx/settings'
import { appName } from '../edition'
import { get, toast } from '../state/store'
import { comparePreset, CopyChanged, copyValue, parentFor, parentSide, presetWrite, stockFor, undoCopy, whole, type CompareSide, type CopyRecord } from '../presets/compare'
import { formatValue, settingDef } from '@slicerx/settings'
import { askPresetWrite } from './preset-asks'
import type { LinkClient } from './methods'
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

/** A copy the client may put back, by id. */
const undos = new Map<string, { rec: CopyRecord; label: string }>()
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

/**
 * A preset in use is followed by the plate, so writing it changes the plate's settings: refused while the plate loads,
 * slices or is being edited, as a project settings edit is.
 */
function notBusy(p: UserPreset): void {
  if (get().activePresets[p.kind] !== p.id) return
  const s = get()
  if (s.plateLoading || s.historyEdit || s.rollback || s.dragging || s.liveEdit || s.slice.status === 'running') throw new LinkError('busy', `${p.name} is in use; finish the current load, slice or edit before changing it`)
}

/** A value as the settings panel writes it; absent is the value the preset gets from the stock settings. */
function shown(p: UserPreset, key: string, v: SettingValue | undefined): string {
  const def = settingDef(key)
  return v === undefined ? `${formatValue(def, stockFor(p)[key])} (stock)` : formatValue(def, v)
}

export async function presetCall(method: string, args: Record<string, unknown>, client: LinkClient = { id: '', name: 'An agent' }): Promise<unknown> {
  // The list is read where the panel reads it, so a preset saved a moment ago is there; in the write queue, so a reload
  // never lands under a copy in flight and rolls it back.
  await presetWrite(() => loadPresets())
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
    notBusy(a)
    const yes = await askPresetWrite(client, `Set ${row.label} in ${a.name} to ${row.bText}?`, [`It is ${row.aText} now, and ${side.name} has ${row.bText}.`])
    if (!yes) throw new LinkError('refused', `The person declined: ${a.name} was not changed`, { reason: 'declined' })
    const rec = await copyValue(a.id, key, side.config, base, notBusy)
    const after = get().userPresets.find((p) => p.id === a.id)
    if (!rec || !after) throw new LinkError('not_found', `${a.name} is gone from ${appName()}`)
    const undoId = `pu_${++undoSeq}`
    undos.set(undoId, { rec, label: row.label })
    while (undos.size > UNDO_KEEP) undos.delete(undos.keys().next().value!)
    toast(`${client.name} changed ${row.label} in ${after.name}.`, 'info')
    // value is what the preset gives now; kept says whether the preset holds it as its own change or gets it from stock.
    return { preset: listed(after), key, label: row.label, value: whole(after, stockFor(after))[key] ?? null, kept: key in after.values, from: side.name, undoId }
  }
  if (method === 'presets.undo') {
    only(args, ['undoId'], method)
    const id = text(args, 'undoId', 40)
    const u = id ? undos.get(id) : undefined
    if (!u) throw new LinkError('not_found', 'No copy to put back with that undoId; it was put back already, or the app restarted')
    const cur = get().userPresets.find((p) => p.id === u.rec.id)
    if (!cur) throw new LinkError('not_found', `${u.rec.name} is gone from ${appName()}`)
    notBusy(cur)
    const yes = await askPresetWrite(client, `Put ${u.label} in ${cur.name} back to ${shown(cur, u.rec.key, u.rec.was)}?`, [`It is ${shown(cur, u.rec.key, cur.values[u.rec.key])} now, from an earlier change by this agent.`])
    if (!yes) throw new LinkError('refused', `The person declined: ${cur.name} was not changed`, { reason: 'declined' })
    let after: UserPreset
    try {
      // Only that setting goes back, and only while it still holds the copied value; checked in the write queue.
      after = await undoCopy(u.rec, notBusy)
    } catch (e) {
      if (e instanceof CopyChanged) throw new LinkError('refused', `${e.message}, so putting it back would undo a later change`, { reason: 'changed' })
      throw e
    }
    // Gone once it worked, so a failed write can be tried again.
    undos.delete(id!)
    toast(`${client.name} put back ${u.label} in ${after.name}.`, 'info')
    return { preset: listed(after), key: u.rec.key, value: whole(after, stockFor(after))[u.rec.key] ?? null, kept: u.rec.key in after.values }
  }
  throw new LinkError('not_found', `${appName()} has no app link method ${method}`)
}
