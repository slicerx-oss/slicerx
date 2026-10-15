// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrintConfig, SettingDef, SettingValue } from '@slicerx/contracts'
import { projectSettingsInput, projectSettingsReadInput } from '@slicerx/mcp/toolset'
import { checkValues, sameValue, SETTINGS, settingDef } from '@slicerx/settings'
import { takenFromFile } from '../lib/setting-text'
import { activeMeta } from '../plate/plates'
import { settingEditValue } from '../plate/setting-edit-value'
import { plateSliceConfig } from '../state/slice-plate'
import { get, markStale, set, toast } from '../state/store'
import { LinkError } from './methods-error'

const TYPES = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floatOrPercent', 'floats', 'ints', 'percents', 'bools', 'enums', 'floatsOrPercents'])
const offered = (d: SettingDef) => d.section !== 'printer' && (TYPES.has(d.type) || d.section === 'process' && d.type === 'string' && takenFromFile(d.key, ''))
const supported = SETTINGS.filter(offered).map((d) => d.key)
// These come from plate and filament controls, not preset rows. Read them without making them global override edits.
const readOnly = ['curr_bed_type', 'flush_multiplier', 'flush_volumes_matrix', 'filament_map', 'filament_map_mode', 'first_layer_print_sequence', 'other_layers_print_sequence', 'other_layers_print_sequence_nums']
const readable = [...supported, ...readOnly]

function readableProjectValue(key: string, value: SettingValue | undefined): boolean {
  if (key === 'curr_bed_type' || key === 'filament_map_mode') return typeof value === 'string' && value.length <= 100
  return (Array.isArray(value) ? value : [value]).every((v) => typeof v === 'number' && Number.isFinite(v))
}

function definition(key: string): SettingDef {
  const def = settingDef(key)
  if (!def || !offered(def)) throw new LinkError('invalid_input', `${key} is not a numeric, switch or choice print setting; printer settings and scripts stay in the app`)
  return def
}

function typed(key: string, raw: unknown): SettingValue {
  const def = definition(key)
  if (def.type === 'string' && !takenFromFile(key, raw)) throw new LinkError('invalid_input', `${key} does not match its text setting grammar`)
  try {
    return settingEditValue(def, raw)
  } catch (e) {
    throw new LinkError('invalid_input', e instanceof Error ? e.message : String(e))
  }
}

function read(keys: readonly string[] = readable) {
  const s = get()
  const effective = plateSliceConfig(s, activeMeta(s))
  const pick = (values: Record<string, SettingValue>) => Object.fromEntries(keys.filter((k) => Object.hasOwn(values, k) && (readOnly.includes(k) ? readableProjectValue(k, values[k]) : settingDef(k)?.type !== 'string' || takenFromFile(k, values[k]))).map((k) => [k, values[k]!]))
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
      readOnly,
      warnings: checkValues(pick(effective) as PrintConfig).filter((i) => i.code === 'enum_value_unavailable'),
    },
  }
}

export function readProjectSettings(args: Record<string, unknown>) {
  const parsed = projectSettingsReadInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  parsed.data.keys?.forEach((k) => { if (!readOnly.includes(k)) definition(k) })
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
