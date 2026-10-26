// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Text settings of the process: which ones have a grammar, what each accepts, and which a project file may set. Used
// by the settings rows (workspaces/prepare/setting-rows.tsx) and by project opening (export/project-settings.ts).
import type { SettingDef } from '@slicerx/contracts'
import { PROJECT_TEXT_RULES, projectTextOk } from '@slicerx/settings'

/**
 * Text settings with a grammar of their own, and what each accepts (prusa-map.json `projectTakes.text` in
 * @slicerx/settings: the infill angle templates and the extra solid infill layers). Other text settings take any one line.
 */
const TEXT_RULES: Readonly<Record<string, RegExp>> = PROJECT_TEXT_RULES

/** Text settings whose value is a template or prose, so the field takes the row's whole width. */
export function isWideText(def: Pick<SettingDef, 'key' | 'type'>): boolean {
  return def.type === 'string' && (def.key.endsWith('_template') || def.key.endsWith('_format') || def.key === 'notes')
}

/** Whether `text` is a value the setting can hold: one line, and the setting's own grammar when it has one. */
export function textOk(key: string, text: string): boolean {
  return projectTextOk(key, text)
}

/** The text settings a project file may set: the ones with a grammar checked above, so a file brings no free text. */
export function takenFromFile(key: string, value: unknown): boolean {
  return key in TEXT_RULES && typeof value === 'string' && textOk(key, value)
}
