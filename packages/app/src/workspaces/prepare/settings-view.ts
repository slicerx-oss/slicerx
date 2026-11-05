// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print settings as tabs of named sections (setting-sections.ts), for the panel and for the agent bridge's read-back.
// A section is open or closed by hand, or takes its default: the first section with rows in its tab is open.
import type { SettingDef, SettingIntent } from '@slicerx/contracts'
import type { IconName } from '@slicerx/ui'
import { isVisible, resolveConfig, SETTINGS } from '../../adapters/settings'
import { resolveSlots } from '../../filament/slots'
import { FEATURE_FILAMENT_KEYS, featureFilamentReadback } from '../../plate/feature-filaments'
import { sourceId } from '../../plate/object-settings'
import { scopeOf, type SettingsScope } from '../../plate/scope'
import { selectedIds, type AppState, type SettingsMode } from '../../state/store'
import { SECTIONS, sectionOf } from './setting-sections'

export const EDITABLE = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floats', 'ints', 'percents', 'floatOrPercent'])

/**
 * Per-extruder choice lists (schema type `enums`) a printer row edits, one by one. Other list choices (nozzle type,
 * extruder type, lift enforcement) join once their labels are checked.
 */
export const LIST_ENUM_KEYS: ReadonlySet<string> = new Set(['z_hop_types'])

/** Process rows also support per-extruder switches, text and number-or-percent lists. */
export const PROCESS_EDITABLE: ReadonlySet<string> = new Set([...EDITABLE, 'bools', 'string', 'floatsOrPercents'])

/** The intents in the order the panel shows them. Output (G-code and file keys) is mostly Expert. */
export const INTENTS: readonly { id: SettingIntent; label: string; icon: IconName; blurb: string }[] = [
  { id: 'quality', label: 'Quality', icon: 'tab-quality', blurb: 'Surfaces, walls, seams and dimensional accuracy' },
  { id: 'strength', label: 'Strength', icon: 'tab-strength', blurb: 'Shells and infill' },
  { id: 'speed', label: 'Speed', icon: 'tab-speed', blurb: 'How fast each feature prints' },
  { id: 'supports', label: 'Supports', icon: 'support', blurb: 'Where supports go and how they touch the part' },
  { id: 'adhesion', label: 'Adhesion', icon: 'tab-adhesion', blurb: 'Brim, skirt and raft' },
  { id: 'multicolor', label: 'Color', icon: 'tab-color', blurb: 'Prime tower, flushing and which filament prints what' },
  { id: 'effects', label: 'Surface', icon: 'tab-surface', blurb: 'Ironing, fuzzy skin and spiral vase' },
  { id: 'output', label: 'Output and print order', icon: 'tab-output', blurb: 'Print order, G-code and file options' },
]

/** Settings the prime tower row's atlas line sets: they are not listed as rows. */
export const ATLAS_KEYS = new Set(['prime_tower_auto_position', 'wipe_tower_x', 'wipe_tower_y'])

/** Rows that head their section: the prime tower switch, print sequence. */
const HEADS = ['enable_prime_tower', 'print_sequence']

/**
 * Schema levels shown for an app settings mode: Simple shows simple, Advanced adds advanced, Expert adds expert
 * and Developer adds develop.
 */
export function visibleLevels(mode: SettingsMode, _layout?: unknown): ReadonlySet<SettingDef['mode']> {
  if (mode === 'developer') return new Set(['simple', 'advanced', 'expert', 'develop'])
  if (mode === 'expert') return new Set(['simple', 'advanced', 'expert'])
  if (mode === 'advanced') return new Set(['simple', 'advanced'])
  return new Set(['simple'])
}

export interface ViewSection {
  id: string
  label: string
  /** "tab/section": what the open state is kept by. */
  key: string
  /** Advanced keys, and simple keys once changed, always listed. */
  shown: SettingDef[]
  /** Keys above Advanced: a changed one is always listed, the rest in Expert behind "more" and in any mode by a search. */
  more: SettingDef[]
  /** The two combined Advanced choices (overhang slowdown, unsupported overhangs) head this section. */
  choices?: true
  /** The feature filament table's settings (plate/feature-filaments.ts): shown as one table in every mode, never as rows. */
  table?: SettingDef[]
}

/** Every setting a section holds: its rows, those behind "more", and its table's. */
export function sectionDefs(s: ViewSection): SettingDef[] {
  return [...s.shown, ...s.more, ...(s.table ?? [])]
}

export interface ViewTab {
  intent: (typeof INTENTS)[number]
  sections: ViewSection[]
}

export const EDITABLE_PROCESS: readonly SettingDef[] = SETTINGS.filter((d) => PROCESS_EDITABLE.has(d.type) && d.section === 'process')

/** Every tab and section with the rows each can list. `changed` says a key holds an edit in the scope shown. */
export function buildTabs(o: { mode: SettingsMode; changed: (key: string) => boolean; filamentCount: number; searching: boolean }): ViewTab[] {
  const levels = visibleLevels(o.mode)
  const tabs: ViewTab[] = INTENTS.map((intent) => ({ intent, sections: SECTIONS[intent.id].map((s) => ({ id: s.id, label: s.label, key: `${intent.id}/${s.id}`, shown: [], more: [] })) }))
  for (const def of EDITABLE_PROCESS) {
    const changed = o.changed(def.key)
    // Profile keys show nowhere, and multi-color keys only with two or more filaments (a key the person already changed stays listed).
    if (!changed && !isVisible(def, { filamentCount: o.filamentCount })) continue
    // The tower's place is atlas's, under the Prime tower switch (prime-tower-row.tsx), not a row of its own.
    if (ATLAS_KEYS.has(def.key)) continue
    if (def.mode === 'hidden') continue
    // Print sequence (all together or one object at a time) is print order: it heads Output.
    const intent: SettingIntent | undefined = def.key === 'print_sequence' ? 'output' : def.intent
    const tab = tabs.find((t) => t.intent.id === intent)
    if (!tab) continue
    const sec = tab.sections.find((s) => s.id === sectionOf(tab.intent.id, def.key).id)!
    // Which filament prints each feature has one home, the table, in Simple and Expert alike.
    if (FEATURE_FILAMENT_KEYS.has(def.key)) {
      ;(sec.table ??= []).push(def)
      continue
    }
    // Simple keys are the Easy controls above; they are listed once changed by hand, or when a search asks for them.
    if (def.mode === 'simple' && !changed && !o.searching) continue
    if (def.mode === 'advanced' || def.mode === 'simple') sec.shown.push(def)
    // Develop keys show only in Developer mode, unless changed.
    else if (def.mode !== 'develop' || changed || levels.has('develop')) sec.more.push(def)
  }
  for (const t of tabs) {
    for (const s of t.sections) {
      for (const key of HEADS) {
        const i = s.shown.findIndex((d) => d.key === key)
        if (i > 0) s.shown.unshift(...s.shown.splice(i, 1))
      }
    }
  }
  const overhangs = tabs[0]!.sections.find((s) => s.id === 'overhangs')
  if (overhangs && o.mode !== 'simple') overhangs.choices = true
  return tabs
}

/** The rows a section lists when nobody searches: Advanced rows, changed rows above the mode, and in Expert the rest once "more" is open. */
export function sectionRows(s: ViewSection, o: { mode: SettingsMode; changed: (key: string) => boolean; moreOpen: boolean }): { shown: SettingDef[]; more: SettingDef[]; hidden: number } {
  const levels = visibleLevels(o.mode)
  const kept = s.more.filter((d) => o.changed(d.key))
  const extra = s.more.filter((d) => !o.changed(d.key) && levels.has(d.mode))
  return { shown: s.shown, more: o.moreOpen ? [...kept, ...extra] : kept, hidden: o.moreOpen ? 0 : extra.length }
}

/** True when a section lists anything in this mode (Advanced rows, choices, changed rows, or Expert rows behind "more"). */
export function sectionHasRows(s: ViewSection, o: { mode: SettingsMode; changed: (key: string) => boolean }): boolean {
  const r = sectionRows(s, { ...o, moreOpen: true })
  return Boolean(s.choices || s.table?.length || r.shown.length || r.more.length)
}

/** Whether a section is open: as set by hand, or open when it is the first in its tab with rows or holds a table. */
export function sectionOpen(saved: Readonly<Record<string, boolean>>, tab: ViewTab, s: ViewSection, o: { mode: SettingsMode; changed: (key: string) => boolean }): boolean {
  const hand = saved[s.key]
  if (hand !== undefined) return hand
  return Boolean(s.table?.length) || tab.sections.find((x) => sectionHasRows(x, o)) === s
}

/**
 * The tabs the panel offers: Color with two or more filaments, or while one of its settings holds a change (a plate
 * down to one filament keeps its feature filament picks visible, and resettable).
 */
export function offeredTabs(filamentCount: number, colorChanged = false): (typeof INTENTS)[number][] {
  return INTENTS.filter((i) => i.id !== 'multicolor' || filamentCount >= 2 || colorChanged)
}

/** Whether any setting of the Color tab holds a change. */
export function colorChanged(tabs: readonly ViewTab[], changed: (key: string) => boolean): boolean {
  return Boolean(tabs.find((t) => t.intent.id === 'multicolor')?.sections.some((s) => sectionDefs(s).some((d) => changed(d.key))))
}

/** The scope Print settings edits, as the scope pill shows it (scope-bar.tsx useScope), for the agent bridge. */
export function viewScope(s: AppState): SettingsScope {
  const ids = selectedIds(s)
  return s.settingsScope === 'objects' && ids.length ? scopeOf(ids, s.scopePart) : { kind: 'plate' }
}

/**
 * The feature filament table as the Color tab shows it, for the agent bridge: the scope it edits, and per feature the
 * setting, its value (0 is the object's filament, null when the selection is mixed), where the value comes from, and
 * the filaments the feature printed with in the current slice (null with none).
 */
export function featureFilamentView(s: AppState, shown: boolean): Record<string, unknown> {
  return { shown, ...featureFilamentReadback(s, resolveConfig(s.easy, s.overrides), viewScope(s)) }
}

/** The plate's tabs as the panel builds them for the agent bridge, and the ones it offers. */
export function bridgeTabs(s: AppState): { changed: (key: string) => boolean; tabs: ViewTab[]; offered: (typeof INTENTS)[number][] } {
  const filamentCount = Math.max(1, resolveSlots(s).filter((r) => r.used).length)
  const changed = (k: string) => k in s.overrides
  const tabs = buildTabs({ mode: s.settingsMode, changed, filamentCount, searching: false })
  return { changed, tabs, offered: offeredTabs(filamentCount, colorChanged(tabs, changed)) }
}

/** The panel as the agent bridge reads it back: the open tab, its sections, the pins, what changed and the feature filament table. */
export function settingsView(s: AppState): Record<string, unknown> {
  const mode = s.settingsMode
  const { changed, tabs, offered } = bridgeTabs(s)
  const tabId = offered.some((t) => t.id === s.settingsTab) ? s.settingsTab : 'quality'
  const tab = tabs.find((t) => t.intent.id === tabId)!
  const label = (k: string) => SETTINGS.find((d) => d.key === k)?.label ?? k
  // Objects that print a setting with their own value, as the chips on the plate's rows show them.
  const objectValues: Record<string, { object: string; name: string; value: unknown }[]> = {}
  const seen = new Set<string>()
  for (const e of s.plate) {
    if (seen.has(sourceId(e))) continue
    seen.add(sourceId(e))
    for (const [k, v] of Object.entries(s.objectSettings[sourceId(e)] ?? {})) (objectValues[k] ??= []).push({ object: e.id, name: e.name, value: v })
  }
  return {
    mode,
    tab: tabId,
    tabs: offered.map((t) => ({ id: t.id, label: t.label, changed: tabs.find((x) => x.intent.id === t.id)!.sections.reduce((n, sec) => n + sectionDefs(sec).filter((d) => changed(d.key)).length, 0) })),
    sections: mode === 'simple' ? [] : tab.sections.filter((sec) => sectionHasRows(sec, { mode, changed })).map((sec) => ({ id: sec.id, label: sec.label, open: sectionOpen(s.settingsSections, tab, sec, { mode, changed }), changed: sectionDefs(sec).filter((d) => changed(d.key)).map((d) => d.key), ...(sec.table ? { table: 'featureFilaments' } : {}) })),
    pins: s.settingsPins.filter((k) => !FEATURE_FILAMENT_KEYS.has(k)).map((k) => ({ key: k, label: label(k) })),
    changed: Object.keys(s.overrides).length,
    objectValues,
    featureFilaments: featureFilamentView(s, offered.some((t) => t.id === 'multicolor')),
  }
}
