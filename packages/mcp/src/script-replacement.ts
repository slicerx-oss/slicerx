// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ScriptReplacementChoice, SettingValue } from '@slicerx/contracts'
import { GCODE_TEXT_KEYS } from '@slicerx/settings'
import { ToolInputError } from './models'

/** Copies only the chosen slots; the native engine separately verifies and records application. */
export function replacementConfig(config: Record<string, SettingValue>, choices: ScriptReplacementChoice[], direction: 'candidate' | 'original'): Record<string, SettingValue> {
  const result = { ...config }
  const seen = new Set<string>()
  for (const choice of choices) {
    const id = JSON.stringify([choice.key, choice.slot ?? null])
    if (!GCODE_TEXT_KEYS.includes(choice.key) || seen.has(id)) throw new ToolInputError('Replacement choices must name distinct script slots', 'invalid_input')
    seen.add(id)
    const value = result[choice.key]
    const current = choice.slot === undefined ? value : Array.isArray(value) ? value[choice.slot] : undefined
    const expected = direction === 'candidate' ? choice.original : choice.replacement
    if (typeof current !== 'string' || current !== expected) throw new ToolInputError('The script replacement no longer matches the current settings; inspect the script and its profile overrides again', 'script_replacement_stale')
    const text = direction === 'candidate' ? choice.replacement : choice.original
    if (choice.slot === undefined) result[choice.key] = text
    else {
      const slots = [...value as SettingValue[]]
      slots[choice.slot] = text
      result[choice.key] = slots as SettingValue
    }
  }
  return result
}
