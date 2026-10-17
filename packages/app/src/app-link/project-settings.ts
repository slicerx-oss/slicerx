// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrintConfig, SettingDef, SettingValue } from '@slicerx/contracts'
import { projectSettingsInput, projectSettingsReadInput } from '@slicerx/mcp/toolset'
import { checkValues, coerce, sameValue, SETTINGS, settingDef } from '@slicerx/settings'
import { takenFromFile } from '../lib/setting-text'
import { activeMeta } from '../plate/plates'
import { plateSliceConfig } from '../state/slice-plate'
import { get, markStale, set, toast } from '../state/store'
import { LinkError } from './methods-error'

const TYPES = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floatOrPercent', 'floats', 'ints', 'percents', 'bools', 'enums', 'floatsOrPercents'])
const offered = (d: SettingDef) => d.section !== 'printer' && (TYPES.has(d.type) || d.section === 'process' && d.type === 'string' && takenFromFile(d.key, ''))
const supported = SETTINGS.filter(offered).map((d) => d.key)

function definition(key: string): SettingDef {
  const def = settingDef(key)
  if (!def || !offered(def)) throw new LinkError('invalid_input', `${key} is not a numeric, switch or choice print setting; printer settings and scripts stay in the app`)
  return def
}

function typed(key: string, raw: unknown): SettingValue {
  const def = definition(key)
  if (def.type === 'string' && !takenFromFile(key, raw)) throw new LinkError('invalid_input', `${key} does not match its text setting grammar`)
  const items = Array.isArray(raw) ? raw : [raw]
  if (items.length > 256 || items.some((v) => !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'string' && v.length > 500)) throw new LinkError('invalid_input', `${key} needs plain setting values`)
  if (items.length === 0 || (!def.type.endsWith('s') && items.length !== 1)) throw new LinkError('invalid_input', `${key} has the wrong number of values`)
  // Profile imports may round integers; an explicit edit must not silently change the requested number.
  if ((def.type === 'int' || def.type === 'ints') && items.some((v) => typeof v === 'boolean' || !Number.isInteger(Number(v)))) throw new LinkError('invalid_input', `${key} needs whole numbers`)
  const converted = coerce(def, raw)
  if (converted.ok !== true) throw new LinkError('invalid_input', `${key} has an invalid value; use clear to restore its inherited value`)
  const values = Array.isArray(converted.value) ? converted.value : [converted.value]
  if (values.some((v) => typeof v === 'number' && !Number.isFinite(v) || typeof v === 'string' && ['floatOrPercent', 'floatsOrPercents'].includes(def.type) && !Number.isFinite(Number(v.replace(/%$/, ''))))) throw new LinkError('invalid_input', `${key} needs finite values`)
  const lo = def.orcaMin === undefined ? def.min : def.orcaMin
  if (lo !== undefined && lo !== null && lo >= 0 && values.some((v) => typeof v === 'string' && v.endsWith('%') && Number(v.slice(0, -1)) < 0)) throw new LinkError('invalid_input', `${key} cannot be a negative percent`)
  return converted.value
}

function read(keys: readonly string[] = supported) {
  const s = get()
  const effective = plateSliceConfig(s, activeMeta(s))
  const pick = (values: Record<string, SettingValue>) => Object.fromEntries(keys.filter((k) => Object.hasOwn(values, k) && (settingDef(k)?.type !== 'string' || takenFromFile(k, values[k]))).map((k) => [k, values[k]!]))
  const overrides = pick(s.overrides)
  const shadowed = keys.filter((k) => Object.hasOwn(overrides, k) && !sameValue(overrides[k], effective[k]))
  return {
    summary: `${Object.keys(overrides).length} project overrides; effective settings for the shown plate`,
    output: {
      plate: s.activePlate,
      overrides,
      effective: pick(effective),
      shadowed,
      supported,
      warnings: checkValues(pick(effective) as PrintConfig).filter((i) => i.code === 'enum_value_unavailable'),
    },
  }
}

export function readProjectSettings(args: Record<string, unknown>) {
  const parsed = projectSettingsReadInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  parsed.data.keys?.forEach(definition)
  return read(parsed.data.keys)
}

/** Check every key and value before applying the same override edit as the settings panel. */
export function editProjectSettings(args: Record<string, unknown>, client: string) {
  const parsed = projectSettingsInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const patch = Object.fromEntries(Object.entries(parsed.data.changes).map(([k, v]) => [k, typed(k, v)]))
  parsed.data.clear.forEach(definition)
  const errors = checkValues(patch as PrintConfig).filter((i) => i.severity === 'error' || i.code === 'enum_value_unavailable')
  if (errors.length) throw new LinkError('invalid_input', errors.map((i) => i.message).join('; '))
  const s = get()
  if (s.plateLoading || s.historyEdit || s.rollback || s.dragging || s.liveEdit || s.slice.status === 'running') throw new LinkError('busy', 'Finish the current load, slice or edit before changing project settings')
  const next = { ...s.overrides }
  for (const key of parsed.data.clear) delete next[key]
  Object.assign(next, patch)
  const changed = [...new Set([...Object.keys(patch), ...parsed.data.clear])].some((k) => !sameValue(s.overrides[k], next[k]))
  if (changed) {
    set({ overrides: next })
    markStale()
    toast(`${client} changed project print settings.`, 'info')
  }
  return read()
}
