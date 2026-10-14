// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Text settings of the process: which ones have a grammar, what each accepts, and which a project file may set. Used
// by the settings rows (workspaces/prepare/setting-rows.tsx) and by project opening (export/project-settings.ts).
import type { SettingDef } from '@slicerx/contracts'

/** The angle templates' language (sparse and solid infill rotation): numbers, signs, joints, counts and units. */
const ANGLE_TEMPLATE = /^[0-9\s,.+\-%*@'"cmBT!/NnZz$LlUuQq~^|#]*$/
/** Extra solid infill layers: layer numbers, a step, or a step with a count ("1,7,9", "5", "5#2"). */
const LAYER_LIST = /^[0-9\s,#]*$/

/** Text settings with a grammar of their own, and what each accepts. Other text settings take any one line. */
const TEXT_RULES: Readonly<Record<string, RegExp>> = {
  solid_infill_rotate_template: ANGLE_TEMPLATE,
  sparse_infill_rotate_template: ANGLE_TEMPLATE,
  extra_solid_infills: LAYER_LIST,
}

/** Text settings whose value is a template or prose, so the field takes the row's whole width. */
export function isWideText(def: Pick<SettingDef, 'key' | 'type'>): boolean {
  return def.type === 'string' && (def.key.endsWith('_template') || def.key.endsWith('_format') || def.key === 'notes')
}

/** Whether `text` is a value the setting can hold: one line, and the setting's own grammar when it has one. */
export function textOk(key: string, text: string): boolean {
  if (/[\r\n]/.test(text) || text.length > 500) return false
  const rule = TEXT_RULES[key]
  return rule ? rule.test(text) : true
}

/** The text settings a project file may set: the ones with a grammar checked above, so a file brings no free text. */
export function takenFromFile(key: string, value: unknown): boolean {
  return key in TEXT_RULES && typeof value === 'string' && textOk(key, value)
}
