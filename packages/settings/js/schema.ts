// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings schema as data: facts (keys, types, units, defaults, ranges) and our own labels.
// schema.json is checked in as our own data (key names follow OrcaSlicer's for profile interchange). sx-settings reads the same file.
import { productName } from '@slicerx/contracts/brand'
import type { SettingDef, SettingSection } from '@slicerx/contracts/settings'
import type { SliceStage } from '@slicerx/contracts/slice'
import notesJson from '../notes.json'
import schemaJson from '../schema.json'

interface SchemaFile {
  orca_commit: string
  project_keys: string[]
  settings: SettingDef[]
}

const file = schemaJson as unknown as SchemaFile

/** Orca commit the schema was extracted from. */
export const ORCA_COMMIT: string = file.orca_commit

const NOTES = (notesJson as { notes: Record<string, string> }).notes

/** Plain notes keyed by setting key: what each setting does and when to change it. */
// The notes name the product as the edition does (white label): notes.json says SlicerX, read when asked.
export const SETTING_NOTES: Readonly<Record<string, string>> = Object.defineProperties(
  {},
  Object.fromEntries(Object.entries(NOTES).map(([k, v]) => [k, { enumerable: true, get: () => v.replaceAll('SlicerX', productName()) }])),
)

/** `d` with the note from notes.json, read when asked like `SETTING_NOTES`, unless the schema or an overlay gives one. */
function withNote(d: SettingDef): SettingDef {
  if (d.note !== undefined || NOTES[d.key] === undefined) return d
  return Object.defineProperty({ ...d }, 'note', { enumerable: true, get: () => SETTING_NOTES[d.key] })
}

const original: readonly SettingDef[] = file.settings.map(withNote)
const list: SettingDef[] = original.slice()

/** Every setting, process first, then filament, then printer. Updated in place by `registerSettingText`. */
export const SETTINGS: readonly SettingDef[] = list

/** Keys Orca defines for a project or plate (filament colors, wipe tower position, flush volumes) rather than a preset. */
export const PROJECT_KEYS: ReadonlySet<string> = new Set(file.project_keys)

const byKey = new Map<string, SettingDef>(list.map((d) => [d.key, d]))

export function settingDef(key: string): SettingDef | undefined {
  return byKey.get(key)
}

export function settingsFor(section: SettingSection): SettingDef[] {
  return SETTINGS.filter((d) => d.section === section)
}

/** First slice stage a change to `key` invalidates. Unknown keys invalidate everything from the start. */
export function invalidates(key: string): SliceStage {
  return byKey.get(key)?.invalidates ?? 'layers'
}

/** A PrintConfig holding every key at its schema default. */
export function defaultConfig(section?: SettingSection): Record<string, SettingDef['default']> {
  const out: Record<string, SettingDef['default']> = {}
  for (const d of SETTINGS) if (!section || d.section === section) out[d.key] = structuredClone(d.default)
  return out
}

/** Optional wording for a setting, from a host that supplies its own text (see `registerSettingText`). */
export interface SettingText {
  label?: string
  help?: string
  note?: string
  enumLabels?: string[]
  /** Other spellings of an enum value that read as the value they map to (athena reads as aegis). */
  enumAliases?: Record<string, string>
  category?: string
}

/**
 * Overlay wording (labels, help text, enum labels) on the schema. The base schema has neutral
 * labels and no help text, so it works without any text package; installing one improves what
 * a UI shows. Calls replace earlier overlays. Definitions are updated in place: `SETTINGS`,
 * `settingDef` and everything built on them see the new text.
 */
export function registerSettingText(text: Readonly<Record<string, SettingText>>): void {
  for (let i = 0; i < original.length; i++) {
    const base = original[i] as SettingDef
    const t = text[base.key]
    list[i] = t ? withNote({ ...(file.settings[i] as SettingDef), ...(t.label !== undefined ? { label: t.label } : {}), ...(t.help !== undefined ? { help: t.help } : {}), ...(t.note !== undefined ? { note: t.note } : {}), ...(t.enumLabels ? { enumLabels: t.enumLabels } : {}), ...(t.category !== undefined ? { category: t.category } : {}) }) : base
    byKey.set(base.key, list[i] as SettingDef)
  }
}

/** Go back to the neutral wording. */
export function clearSettingText(): void {
  registerSettingText({})
}
