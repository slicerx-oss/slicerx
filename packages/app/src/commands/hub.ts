// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The logic behind the Cmd+K bar as the hub: where to jump (plates, objects, printers, presets, settings by
// name or value), when a typed line reads as a question for mimir and what context goes with it, and
// which commands to suggest before anything is typed. Pure functions over the store's state, so the ranking
// and the ask flow are tested without the UI.
import type { CommandSpec, SettingDef, SettingValue } from '@slicerx/contracts'
import type { SettingsApi } from '../adapters/load'
import { allPlates } from '../plate/plates'
import type { AppState, SettingsMode } from '../state/store'
import { fuzzyScore } from './fuzzy'

export interface HubEntry {
  id: string
  label: string
  /** Dim text at the right: what kind of thing this is. */
  hint: string
  icon: string
  score: number
  run: () => void
}

const QUESTION_WORDS = /^(how|why|what|which|where|when|who|can|could|should|would|is|are|does|do|did|will|please|help|tell|explain|suggest|recommend|plan|find|make|set up|show me|i want|i need|my)\b/i

/** True when a typed line reads as a question or a request for mimir rather than a command name. */
export function readsAsQuestion(query: string): boolean {
  const q = query.trim()
  if (!q) return false
  if (q.startsWith('?') || q.endsWith('?')) return true
  if (QUESTION_WORDS.test(q)) return true
  return q.split(/\s+/).length >= 6
}

/** The text of a "?" prefixed line, without the mark. */
export function questionText(query: string): string {
  return query.trim().replace(/^\?+\s*/, '')
}

/**
 * What mimir gets to know along with the question: what is selected, the plate, the printer and the
 * material, in a few plain lines. Never secrets, never file contents.
 */
export function askContext(s: Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'selection' | 'selectedIds' | 'printerId' | 'printerSlots' | 'easy' | 'slice'>, printerName?: string): string {
  const lines: string[] = []
  const plates = allPlates(s)
  const active = plates.find((p) => p.id === s.activePlate)
  lines.push(`Plate: ${active?.name ?? 'Plate 1'} (${plates.findIndex((p) => p.id === s.activePlate) + 1} of ${plates.length}), ${s.plate.length} ${s.plate.length === 1 ? 'object' : 'objects'}`)
  const ids = s.selectedIds.length ? s.selectedIds : s.selection ? [s.selection] : []
  const picked = s.plate.filter((p) => ids.includes(p.id))
  if (picked.length) {
    lines.push(`Selected: ${picked.slice(0, 5).map((p) => `${p.name} (${p.handle.bboxMm.map((x) => Math.round(x)).join(' x ')} mm${p.volumes?.length ? `, ${p.volumes.length} volumes` : ''})`).join('; ')}${picked.length > 5 ? ` and ${picked.length - 5} more` : ''}`)
  }
  if (printerName) lines.push(`Printer: ${printerName}`)
  const mats = [...new Set(s.printerSlots.map((x) => x.material).filter(Boolean))]
  if (mats.length) lines.push(`Loaded filament: ${mats.join(', ')}`)
  lines.push(`Detail ${Math.round(s.easy.detail)}, strength ${Math.round(s.easy.strength)}, speed ${s.easy.speed}`)
  if (s.slice.status === 'done') lines.push(`Sliced: ${s.slice.result.layerCount} layers${s.slice.stale ? ' (plate changed since)' : ''}`)
  return lines.join('\n')
}

/** The line sent to mimir: the question, then the context under it. */
export function askPrompt(query: string, context: string): string {
  return `${questionText(query)}\n\nContext from the app:\n${context}`
}

const MODE_RANK: Record<SettingsMode, number> = { simple: 0, advanced: 1, expert: 2, developer: 3 }
const LEVEL_MODE: Record<SettingDef['mode'], SettingsMode> = { simple: 'simple', advanced: 'advanced', expert: 'expert', develop: 'developer', hidden: 'developer' }

/** The app mode a setting needs to show without searching, and the current one when that is already enough. */
export function modeFor(def: Pick<SettingDef, 'mode'>, current: SettingsMode): SettingsMode {
  const need = LEVEL_MODE[def.mode]
  return MODE_RANK[need] > MODE_RANK[current] ? need : current
}

/** Settings whose name, key or current value matches. Process settings open in Expert settings, printer settings in their dialog. */
export function settingEntries(query: string, s: Pick<AppState, 'easy' | 'overrides' | 'settingsMode'>, open: (def: SettingDef, mode: SettingsMode) => void, api: Pick<SettingsApi, 'SETTINGS' | 'resolveConfig' | 'formatValue'>, limit = 6): HubEntry[] {
  const q = query.trim()
  if (q.length < 2) return []
  const { SETTINGS, resolveConfig, formatValue } = api
  const config = resolveConfig(s.easy, s.overrides) as Record<string, SettingValue | undefined>
  const out: HubEntry[] = []
  for (const def of SETTINGS) {
    if ((def.section !== 'process' && def.section !== 'printer') || def.type === 'string' || def.type === 'strings') continue
    const value = formatValue(def, config[def.key] ?? def.default)
    const score = Math.max(fuzzyScore(q, def.label), fuzzyScore(q, def.key) - 30, fuzzyScore(q, `${def.label} ${value}`) - 15)
    if (score < 0) continue
    out.push({ id: `setting:${def.key}`, label: def.label, hint: `${def.section === 'printer' ? 'Printer setting' : 'Setting'}, now ${value}`, icon: 'sliders', score, run: () => open(def, modeFor(def, s.settingsMode)) })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

export interface NavInputs {
  plates: readonly { id: string; name: string; count: number }[]
  activePlate: string
  objects: readonly { id: string; name: string }[]
  printers: readonly { id: string; name: string; model: string }[]
  presets: readonly { id: string; name: string; kind: string }[]
}

export interface NavActions {
  plate(id: string): void
  object(id: string): void
  printer(id: string): void
  preset(id: string): void
}

/** Jump targets that match: plates, objects, printers and saved presets. */
export function navEntries(query: string, n: NavInputs, act: NavActions, limit = 6): HubEntry[] {
  const q = query.trim()
  if (!q) return []
  const out: HubEntry[] = []
  const add = (id: string, label: string, hint: string, icon: string, extra: string, run: () => void, bonus = 0) => {
    const score = Math.max(fuzzyScore(q, label), fuzzyScore(q, `${hint} ${label}`) - 20, fuzzyScore(q, extra) - 20)
    if (score >= 0) out.push({ id, label, hint, icon, score: score + bonus, run })
  }
  for (const p of n.plates) if (p.id !== n.activePlate) add(`plate:${p.id}`, p.name, `Plate, ${p.count} ${p.count === 1 ? 'object' : 'objects'}`, 'plate', 'plate go to', () => act.plate(p.id))
  for (const o of n.objects) add(`obj:${o.id}`, o.name, 'Object, select it', 'cube', 'object select', () => act.object(o.id))
  for (const p of n.printers) add(`printer:${p.id}`, p.name, `Printer, ${p.model}`, 'printer', `${p.model} printer`, () => act.printer(p.id))
  for (const p of n.presets) add(`preset:${p.id}`, p.name, `${p.kind[0]!.toUpperCase()}${p.kind.slice(1)} preset, use it`, 'save', `${p.kind} preset profile`, () => act.preset(p.id))
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** What to offer before anything is typed, from what is on screen. Ids of registered commands that can run now, best first. */
export function suggestions(s: Pick<AppState, 'plate' | 'plates' | 'slice' | 'selection' | 'workspace' | 'bridgeStatus' | 'pilot'>, known: ReadonlySet<string>): string[] {
  const out: string[] = []
  const add = (id: string) => known.has(id) && !out.includes(id) && out.push(id)
  if (s.plate.length === 0) {
    add('plate-open')
    add('plate-default')
  } else {
    if (s.selection) for (const id of ['copy', 'duplicate', 'object-orient']) add(id)
    else for (const id of ['arrange-all', 'select-all']) add(id)
    if (s.slice.status === 'idle' || (s.slice.status === 'done' && s.slice.stale)) add('slice')
    if (s.slice.status === 'done' && !s.slice.stale) for (const id of ['export-gcode', 'preview-all-layers']) add(id)
    if (s.selection) for (const id of ['tool-paint', 'volume-modifier']) add(id)
  }
  if (s.bridgeStatus.state === 'off') add('bridge-open')
  if (s.pilot === null || s.pilot.mode === 'on') add('pilot-ask')
  return out.slice(0, 5)
}

/** Commands for a query with the workspace bonus, best first. Kept here so the ranking can be tested. */
export function rankCommands(query: string, list: readonly CommandSpec[], workspace: string, score: (q: string, c: CommandSpec) => number): { command: CommandSpec; score: number }[] {
  const q = query.trim()
  const out: { command: CommandSpec; score: number }[] = []
  for (const command of list) {
    if (command.enabled && !command.enabled()) continue
    const s = score(q, command)
    if (s < 0) continue
    out.push({ command, score: s + (command.workspace === workspace ? 25 : 0) })
  }
  return out.sort((a, b) => b.score - a.score)
}
