// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SettingValue } from '@slicerx/contracts'
import { appObjectSettingsInputs, type AppObjectSettings } from '@slicerx/mcp/toolset'
import { checkValues, SETTINGS, settingDef } from '@slicerx/settings'
import { history } from '../plate/history'
import { layerHeightConflict, objectOverrides, partOverridesOf, sourceId } from '../plate/object-settings'
import { activeMeta, allPlates } from '../plate/plates'
import { variesPerObject } from '../plate/plate-wide'
import { plateSequence } from '../plate/plate-sequence'
import { setScopedMany } from '../plate/scope'
import { settingEditValue } from '../plate/setting-edit-value'
import { plateSliceConfig } from '../state/slice-plate'
import { get, toast, type AppState, type PlateEntry } from '../state/store'
import { LinkError } from './methods-error'

function object(s: AppState, name: string): PlateEntry {
  const exact = s.plate.find((p) => p.id === name)
  const matches = exact ? [exact] : s.plate.filter((p) => p.name === name)
  if (!matches.length) throw new LinkError('not_found', 'The object is not on the shown plate')
  if (matches.length > 1) throw new LinkError('invalid_input', 'More than one object has that name; use its id')
  return matches[0]!
}

function definition(key: string) {
  const def = settingDef(key)
  if (!def || !variesPerObject(def) || def.type === 'gcode') throw new LinkError('invalid_input', `${key} cannot vary per object or part`)
  return def
}

const supported = SETTINGS.filter((d) => variesPerObject(d) && d.type !== 'gcode').map((d) => d.key)
const pick = (values: Readonly<Record<string, SettingValue>>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => Object.hasOwn(values, k)).map((k) => [k, values[k]!]))

function state(s: AppState, e: PlateEntry, keys: readonly string[] = supported): AppObjectSettings {
  const plates = allPlates(s)
  const entries = plates.flatMap((p) => p.objects)
  const base = plateSliceConfig(s, activeMeta(s))
  const own = objectOverrides(s, e)
  const parts = partOverridesOf(entries, e)
  const warning = layerHeightConflict(s, plateSequence(activeMeta(s), base), Number(base['layer_height']))
  return {
    object: { id: e.id, name: e.name, source: sourceId(e), settings: pick(own, supported), effective: pick({ ...base, ...own }, keys) },
    parts: e.parts.map((p) => {
      const settings = Object.hasOwn(parts, p.name) ? parts[p.name]! : {}
      return { name: p.name, settings: pick(settings, supported), effective: pick({ ...base, ...own, ...settings }, keys) }
    }),
    plate: { id: s.activePlate, settings: pick(base, keys) },
    affected: plates.flatMap((p) => p.objects.filter((o) => sourceId(o) === sourceId(e)).map((o) => ({ id: o.id, name: o.name, plate: p.id }))),
    warnings: warning ? [warning] : [],
  }
}

export function readObjectSettings(args: Record<string, unknown>): AppObjectSettings {
  const parsed = appObjectSettingsInputs.get.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  parsed.data.keys?.forEach(definition)
  const s = get()
  return state(s, object(s, parsed.data.object), parsed.data.keys)
}

/** Validate the whole patch before changing the shared settings in one toolbar step. */
export async function editObjectSettings(args: Record<string, unknown>, client: string): Promise<AppObjectSettings> {
  const parsed = appObjectSettingsInputs.set.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const i = parsed.data
  const typed: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(i.set)) {
    const def = definition(key)
    try {
      typed[key] = settingEditValue(def, value)
    } catch (e) {
      throw new LinkError('invalid_input', e instanceof Error ? e.message : String(e))
    }
  }
  i.clear.forEach(definition)
  const errors = checkValues(typed).filter((e) => e.severity === 'error' || e.code === 'unknown_key' || e.code === 'enum_value_unavailable')
  if (errors.length) throw new LinkError('invalid_input', errors.map((e) => e.message).join('; '))
  const { replaying } = await import('../cad/history/ops')
  const s = get()
  const e = object(s, i.object)
  const family = allPlates(s).flatMap((p) => p.objects).filter((p) => sourceId(p) === sourceId(e))
  if (s.rollback || s.plateLoading || s.dragging || s.liveEdit || family.some((p) => s.historyEdit?.objectId === p.id || replaying(p.id))) throw new LinkError('busy', 'Finish the current load or object edit and return to the end of the timeline first')
  if (i.part !== undefined && e.parts.filter((p) => p.name === i.part).length !== 1) throw new LinkError('invalid_input', 'The part name must identify exactly one part of this object')
  const parts = partOverridesOf(allPlates(s).flatMap((p) => p.objects), e)
  const old = i.part === undefined ? objectOverrides(s, e) : Object.hasOwn(parts, i.part) ? parts[i.part]! : {}
  const next = { ...old }
  for (const key of i.clear) delete next[key]
  Object.assign(next, typed)
  const entries: [string, SettingValue | undefined][] = [...new Set([...i.clear, ...Object.keys(typed)])]
    .filter((key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]))
    .map((key) => [key, next[key]])
  if (entries.length) {
    history()
    setScopedMany(s, i.part === undefined ? { kind: 'objects', ids: [e.id] } : { kind: 'part', id: e.id, part: i.part }, entries)
    toast(`${client} changed print settings for ${e.name}${i.part ? ` / ${i.part}` : ''}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  }
  return state(get(), object(get(), e.id))
}
