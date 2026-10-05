// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The defaults of every setting without the rest of the schema. A startup path that only needs a config (slicing,
// export) imports this entry point and stays small; labels, ranges, tiers and help come from the full schema
// (`@slicerx/settings`), loaded when a screen needs them. defaults.json is generated from schema.json by
// scripts/gen-defaults.mjs, and defaults.test.ts checks that it still matches.
import type { SettingDef, SettingSection } from '@slicerx/contracts/settings'
import defaultsJson from '../defaults.json'

const table = defaultsJson as unknown as Record<string, [SettingSection, SettingDef['default']]>

/** A PrintConfig holding every key at its schema default; one section when given. */
export function defaultConfig(section?: SettingSection): Record<string, SettingDef['default']> {
  const out: Record<string, SettingDef['default']> = {}
  for (const [key, [s, value]] of Object.entries(table)) if (!section || s === section) out[key] = structuredClone(value)
  return out
}

/** The section a key belongs to, or undefined for a key the schema does not know. */
export function sectionOf(key: string): SettingSection | undefined {
  return table[key]?.[0]
}
