// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Read helpers over a PrintConfig, and the enabledWhen dependency check.
import type { PrintConfig, SettingCondition, SettingDef, SettingValue } from '@slicerx/contracts/settings'
import { SETTINGS, settingDef } from './schema'

type Scalar = number | string | boolean

/** The value of `key`, falling back to the schema default unless `useDefault` is false. First entry of a per-extruder list. */
export function scalarOf(config: PrintConfig, key: string, useDefault = true): Scalar | undefined {
  const raw: SettingValue | undefined = config[key] ?? (useDefault ? settingDef(key)?.default : undefined)
  if (Array.isArray(raw)) {
    const f = raw[0]
    return typeof f === 'number' || typeof f === 'string' || typeof f === 'boolean' ? f : undefined
  }
  return raw
}

export function numberOf(config: PrintConfig, key: string, useDefault = true): number | undefined {
  const v = scalarOf(config, key, useDefault)
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const t = v.endsWith('%') ? v.slice(0, -1) : v
    const n = Number(t)
    return t.trim() !== '' && Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** A line width that may be `0` (auto), `0.42`, or a percent of the nozzle. */
export function widthOf(config: PrintConfig, key: string, nozzle: number, useDefault = true): number {
  const v = scalarOf(config, key, useDefault)
  if (typeof v === 'string' && v.endsWith('%')) return (Number(v.slice(0, -1)) / 100) * nozzle
  const n = numberOf(config, key, useDefault)
  return n !== undefined && n > 0 ? n : nozzle
}

function same(a: Scalar | undefined, b: unknown): boolean {
  return a === b
}

function holds(c: SettingCondition, config: PrintConfig): boolean {
  const v = scalarOf(config, c.key)
  const rhs = c.value
  switch (c.op) {
    case 'eq':
      return same(v, rhs)
    case 'ne':
      return !same(v, rhs)
    case 'in':
      return Array.isArray(rhs) && (rhs as unknown[]).includes(v)
    case 'notin':
      return Array.isArray(rhs) && !(rhs as unknown[]).includes(v)
    default: {
      if (typeof v !== 'number' || typeof rhs !== 'number') return false
      return c.op === 'gt' ? v > rhs : c.op === 'ge' ? v >= rhs : c.op === 'lt' ? v < rhs : v <= rhs
    }
  }
}

/** True when every `enabledWhen` condition of `def` holds in `config`. */
export function isEnabled(def: SettingDef, config: PrintConfig): boolean {
  return (def.enabledWhen ?? []).every((c) => holds(c, config))
}

/** The conditions of `def` that do not hold, for "why is this grayed out" text. */
export function failedConditions(def: SettingDef, config: PrintConfig): SettingCondition[] {
  return (def.enabledWhen ?? []).filter((c) => !holds(c, config))
}

/** Keys of `config` that the current values switch off, as Orca's own UI would gray them. */
export function disabledKeys(config: PrintConfig): string[] {
  return SETTINGS.filter((d) => d.key in config && !isEnabled(d, config)).map((d) => d.key)
}

/** What the app knows that decides which keys show: the number of filaments in use on the plate. */
export interface VisibilityContext {
  filamentCount: number
}

export type UserTier = 'simple' | 'advanced' | 'expert'

/** True when a UI should list `def`: never for hidden and develop keys, and multicolor keys only with two or more filaments. */
export function isVisible(def: SettingDef, ctx: VisibilityContext): boolean {
  if (def.mode === 'hidden' || def.mode === 'develop') return false
  return def.showWhen === 'multicolor' ? ctx.filamentCount >= 2 : true
}

/** The keys a tier shows. Tiers are cumulative: advanced includes simple, expert includes both. */
export function settingsForTier(section: SettingDef['section'], tier: UserTier, ctx: VisibilityContext): SettingDef[] {
  const rank: Record<string, number> = { simple: 0, advanced: 1, expert: 2 }
  return SETTINGS.filter((d) => d.section === section && isVisible(d, ctx) && (rank[d.mode] ?? 99) <= rank[tier]!)
}
