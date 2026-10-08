// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// User presets: save the settings you changed as a named printer, filament or process preset, apply it
// later, rename, delete, and move presets in and out as JSON (our own file, or an Orca or Bambu Studio
// profile).
import type { Host, PrintConfig, SettingValue } from '@slicerx/contracts'
import { importOrcaProfile, exportOrcaProfile, presetKind, ProfileError, settingDef } from '@slicerx/settings'
import { get, markStale, set, toast, type AppState } from '../state/store'
import { presetStore, type PresetKind, type UserPreset } from './store'
import { appName } from '../edition'

const SECTION: Record<PresetKind, 'printer' | 'filament' | 'process'> = { printer: 'printer', filament: 'filament', process: 'process' }
export const KIND_LABEL: Record<PresetKind, string> = { printer: 'Printer', filament: 'Filament', process: 'Process' }
export const KINDS: readonly PresetKind[] = ['process', 'filament', 'printer']

const MAX_NAME = 60
const MAX_FILE = 2 * 1024 * 1024

let seq = 0
const newId = () => `up_${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const cleanName = (name: string): string => name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME)

/** Keys of one kind among the changed settings. */
export function pickKind(values: Record<string, SettingValue>, kind: PresetKind): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(values)) if (settingDef(k)?.section === SECTION[kind]) out[k] = v
  return out
}

/** What is changed right now, as a preset body of one kind. */
export function capture(kind: PresetKind, s: Pick<AppState, 'overrides' | 'easy'> = get()): Pick<UserPreset, 'values' | 'easy'> {
  return { values: pickKind(s.overrides, kind), ...(kind === 'process' ? { easy: { ...s.easy } } : {}) }
}

/** Loads the saved presets into the store. */
export async function loadPresets(): Promise<void> {
  const rows = await presetStore().list()
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  // The same presets keep the same list: the list is a slice input, and the command bar loads it each time it opens
  // while there are none, which would otherwise mark a fresh slice stale and slice again on every Cmd+K.
  if (JSON.stringify(rows) !== JSON.stringify(get().userPresets)) set({ userPresets: rows })
  // Changed settings are not kept between sessions, presets are: put the ones in use back.
  const active = get().activePresets
  const live = Object.fromEntries(Object.entries(active).filter(([, id]) => rows.some((r) => r.id === id)))
  if (Object.keys(live).length !== Object.keys(active).length) set({ activePresets: live })
  for (const id of Object.values(live)) applyPreset(id)
}

function replaceInState(p: UserPreset): void {
  set((s) => ({ userPresets: [...s.userPresets.filter((x) => x.id !== p.id), p].sort((a, b) => a.name.localeCompare(b.name, 'en')) }))
}

function uniqueName(kind: PresetKind, wanted: string, ignore?: string): string {
  const taken = new Set(get().userPresets.filter((p) => p.kind === kind && p.id !== ignore).map((p) => p.name.toLowerCase()))
  const base = cleanName(wanted) || `My ${KIND_LABEL[kind].toLowerCase()} preset`
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, MAX_NAME - 4)} ${n}`
  return name
}

/** Saves the current changes of one kind as a new preset and makes it the active one, unless `activate` is false (an import). */
export async function savePreset(kind: PresetKind, name: string, body: Pick<UserPreset, 'values' | 'easy' | 'inherits' | 'printer'> = capture(kind), opts: { activate?: boolean } = {}): Promise<UserPreset> {
  const now = Date.now()
  const p: UserPreset = { id: newId(), kind, name: uniqueName(kind, name), ...body, createdAt: now, updatedAt: now }
  await presetStore().put(p)
  replaceInState(p)
  if (opts.activate !== false) set((s) => ({ activePresets: { ...s.activePresets, [kind]: p.id } }))
  return p
}

/** Replaces a preset's values with what is changed now. */
export async function updatePreset(id: string, body?: Pick<UserPreset, 'values' | 'easy'>): Promise<UserPreset | null> {
  const cur = get().userPresets.find((p) => p.id === id)
  if (!cur) return null
  const next: UserPreset = { ...cur, ...(body ?? capture(cur.kind)), updatedAt: Date.now() }
  if (cur.kind !== 'process') delete next.easy
  await presetStore().put(next)
  replaceInState(next)
  return next
}

export async function renamePreset(id: string, name: string): Promise<void> {
  const cur = get().userPresets.find((p) => p.id === id)
  if (!cur || !cleanName(name)) return
  const next = { ...cur, name: uniqueName(cur.kind, name, id), updatedAt: Date.now() }
  await presetStore().put(next)
  replaceInState(next)
}

export async function deletePreset(id: string): Promise<void> {
  await presetStore().remove(id)
  // A deletion is remembered so a sync file does not bring the preset back.
  set((s) => ({ presetSync: { ...s.presetSync, deleted: [...s.presetSync.deleted.filter((t) => t.id !== id), { id, at: Date.now() }] } }))
  set((s) => ({ userPresets: s.userPresets.filter((p) => p.id !== id), activePresets: Object.fromEntries(Object.entries(s.activePresets).filter(([, v]) => v !== id)) }))
}

/** Puts a preset's values in place of the changes of its kind, and makes it the active one. */
export function applyPreset(id: string): void {
  const p = get().userPresets.find((x) => x.id === id)
  if (!p) return
  set((s) => {
    const kept = Object.fromEntries(Object.entries(s.overrides).filter(([k]) => settingDef(k)?.section !== SECTION[p.kind]))
    return { overrides: { ...kept, ...p.values }, ...(p.easy ? { easy: { ...p.easy }, goal: 'custom' as const } : {}), activePresets: { ...s.activePresets, [p.kind]: p.id } }
  })
  markStale()
}

// Sync files

/** Saves every preset, the deletions and the change notes as one sync file. */
export async function saveSyncFile(host: Host): Promise<boolean> {
  const { userPresets, presetSync } = get()
  const { makeBundle } = await import('./sync')
  const bundle = makeBundle(userPresets, presetSync.deleted, presetSync.changes)
  const ref = await host.files.save('slicerx-presets.sync.json', new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), { accept: ['.json'] })
  if (ref) set((s) => ({ presetSync: { ...s.presetSync, lastAt: Date.now() } }))
  return ref !== null
}

/** Merges a sync file into the saved presets. Returns what changed here, for the person to read. */
export async function mergeSyncText(text: string): Promise<import('./sync').SyncChange[]> {
  const { parseBundle, mergeBundles } = await import('./sync')
  const remote = parseBundle(text)
  const { userPresets, presetSync } = get()
  const r = mergeBundles({ presets: userPresets, deleted: presetSync.deleted, changes: presetSync.changes }, remote, presetSync.lastAt)
  const store = presetStore()
  const before = new Map(userPresets.map((p) => [p.id, p]))
  for (const p of r.presets) if (before.get(p.id) !== p) await store.put(p)
  for (const c of r.applied) if (c.action === 'removed') await store.remove(c.id)
  set((s) => ({ presetSync: { deleted: r.deleted, changes: r.changes, lastAt: Date.now() }, activePresets: Object.fromEntries(Object.entries(s.activePresets).filter(([, id]) => r.presets.some((p) => p.id === id))) }))
  await loadPresets()
  return r.applied
}

// Files

/** The presets as one JSON file of our own format. */
export function exportPresetJson(p: UserPreset): string {
  return JSON.stringify({ slicerx: 'preset', version: 1, kind: p.kind, name: p.name, ...(p.inherits ? { inherits: p.inherits } : {}), ...(p.printer ? { printer: p.printer } : {}), values: p.values, ...(p.easy ? { easy: p.easy } : {}) }, null, 2)
}

/** The preset as an Orca or Bambu Studio profile, for opening in those apps. */
export function exportOrcaJson(p: UserPreset): string {
  return JSON.stringify(exportOrcaProfile(p.values as PrintConfig, { name: p.name, section: SECTION[p.kind], ...(p.inherits ? { inherits: p.inherits } : {}) }), null, 2)
}

export interface ParsedPreset {
  kind: PresetKind
  name: string
  values: Record<string, SettingValue>
  easy?: UserPreset['easy']
  /** Keys in the file we do not know, so the person hears what was left out. */
  skipped: string[]
}

const isKind = (x: unknown): x is PresetKind => x === 'printer' || x === 'filament' || x === 'process'

/** Reads a file's text: our format, or an Orca, Bambu Studio or PrusaSlicer-style profile. Throws an Error with a plain message. */
export function parsePresetFile(text: string): ParsedPreset {
  if (text.length > MAX_FILE) throw new Error('That file is too large to be a preset.')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  const o = json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null
  if (!o) throw new Error('That file is not a preset.')
  if (o['slicerx'] === 'preset') {
    if (!isKind(o['kind'])) throw new Error('The preset has no valid type.')
    const values: Record<string, SettingValue> = {}
    const skipped: string[] = []
    const raw = o['values'] !== null && typeof o['values'] === 'object' ? (o['values'] as Record<string, SettingValue>) : {}
    for (const [k, v] of Object.entries(raw)) {
      if (settingDef(k)?.section === SECTION[o['kind']]) values[k] = v
      else skipped.push(k)
    }
    const easy = o['easy'] as UserPreset['easy'] | undefined
    return { kind: o['kind'], name: cleanName(String(o['name'] ?? '')) || 'Imported preset', values, ...(easy && o['kind'] === 'process' ? { easy } : {}), skipped }
  }
  // A user preset says what it is by the settings id it carries; only system presets have a `type`.
  const kind: PresetKind | null = presetKind(o) ?? null
  if (!kind) throw new Error(`That file is not a ${appName()}, Orca or Bambu Studio preset.`)
  let imp
  try {
    imp = importOrcaProfile(o, () => undefined)
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e
    // A parent we do not have (a system preset): keep the file's own values.
    const { inherits: _drop, ...own } = o
    imp = importOrcaProfile(own, () => undefined)
  }
  const values = pickKind(imp.config as Record<string, SettingValue>, kind)
  return { kind, name: cleanName(String(o['name'] ?? '')) || 'Imported preset', values, skipped: [...imp.unknownKeys] }
}

export async function importPresetText(text: string): Promise<{ preset: UserPreset; skipped: string[] }> {
  const parsed = parsePresetFile(text)
  // Importing does not switch to it.
  const preset = await savePreset(parsed.kind, parsed.name, { values: parsed.values, ...(parsed.easy ? { easy: parsed.easy } : {}) }, { activate: false })
  return { preset, skipped: parsed.skipped }
}

/**
 * Writes settings into the active preset of a kind, or makes one named for the material when there is none.
 * Calibration results go here so they outlive the session.
 */
export async function writeToActivePreset(kind: PresetKind, fallbackName: string): Promise<UserPreset> {
  const id = get().activePresets[kind]
  if (id && get().userPresets.some((p) => p.id === id)) return (await updatePreset(id))!
  return savePreset(kind, fallbackName)
}

/**
 * Writes calibrated values into the preset of one filament, printer and nozzle, making it when there is none.
 * Only the calibrated values go in, so another spool's results never leak into this one. The slice reads it per slot (filament/slots.ts).
 */
export async function writeTunedPreset(kind: PresetKind, meta: { key: string; filament: string; printerId: string; nozzleMm: number }, name: string, patch: Record<string, SettingValue>, result: { id: string; label: string; value: string; raw?: number }): Promise<UserPreset> {
  const cur = get().userPresets.find((p) => p.kind === kind && p.tuned?.key === meta.key)
  const at = Date.now()
  const results = { ...(cur?.tuned?.results ?? {}), [result.id]: { label: result.label, value: result.value, at, ...(result.raw !== undefined ? { raw: result.raw } : {}) } }
  const tuned = { ...meta, results }
  let p: UserPreset
  if (cur) {
    p = { ...cur, values: { ...cur.values, ...patch }, tuned, updatedAt: at }
    await presetStore().put(p)
    replaceInState(p)
  } else {
    // Tuned presets are not made the active one: they belong to one spool, and an active preset is applied to everything.
    const before = get().activePresets
    const made = await savePreset(kind, name, { values: { ...patch } })
    p = { ...made, tuned }
    await presetStore().put(p)
    replaceInState(p)
    set({ activePresets: before })
  }
  return p
}

export function reportPresetError(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e), 'error')
}
