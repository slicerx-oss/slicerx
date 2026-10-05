// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Interpreter for easy-map.json. The Rust side (src/easy.rs) implements the same ops.
import type { EasyGoal, EasySettings, PrintConfig, SettingValue } from '@slicerx/contracts/settings'
import easyMapJson from '../easy-map.json'
import { settingDef } from './schema'

type Scalar = number | string | boolean
type Expr = number | string | boolean | readonly [string, ...unknown[]]

interface SetRule {
  op: 'set'
  key: string
  control: string
  when?: readonly unknown[]
  expr: Expr
  unit?: string
}

interface ScaleRule {
  op: 'scale'
  control: string
  keys: string[]
  factor: Expr
  min?: number
  round?: number
  max_key?: string
  flow_cap?: {
    max_flow_key: string
    height_key: string
    width_keys: Record<string, string>
  }
}

export interface EasyMap {
  version: number
  controls: Record<string, { label: string; kind: string; min?: number; max?: number; step?: number; values?: string[]; ticks?: string[]; labels?: Record<string, string>; hints?: Record<string, string>; aliases?: Record<string, string>; under?: string; hint?: string }>
  /** Controls computed from the others, by expression. */
  derived?: Record<string, Expr>
  /** Advanced choices that set several Orca keys together. */
  choices: Record<string, EasyChoice>
  goals: Record<EasyGoal, EasySettings>
  speed_factors: Record<string, number>
  rules: (SetRule | ScaleRule)[]
}

export interface EasyChoice {
  label: string
  intent: string
  tier: string
  kind: string
  labels: Record<string, string>
  hints: Record<string, string>
  /** Value name to the Orca keys it sets. */
  values: Record<string, Record<string, Scalar>>
}

export const EASY_MAP = easyMapJson as unknown as EasyMap

type Controls = Record<string, Scalar>

function snap(v: number): number {
  return Math.round(v * 1e9) / 1e9
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return Number.NaN
}

function firstOf(v: SettingValue | undefined): Scalar | undefined {
  if (Array.isArray(v)) {
    const f = v[0]
    return typeof f === 'number' || typeof f === 'string' || typeof f === 'boolean' ? f : undefined
  }
  return v
}

interface Ctx {
  controls: Controls
  base: PrintConfig
  out: Map<string, SettingValue>
}

function lookup(ctx: Ctx, key: string, useOut: boolean): Scalar | undefined {
  if (useOut) {
    const o = ctx.out.get(key)
    if (o !== undefined) return firstOf(o)
  }
  return firstOf(ctx.base[key])
}

function evalExpr(e: unknown, ctx: Ctx): Scalar {
  const v = evalRaw(e, ctx)
  // Every arithmetic result is snapped to 1e-9 so 0.2 * 0.4 is 0.08, not 0.08000000000000002.
  return typeof v === 'number' && Number.isFinite(v) ? snap(v) : v
}

function evalRaw(e: unknown, ctx: Ctx): Scalar {
  if (typeof e === 'number' || typeof e === 'boolean') return e
  if (typeof e === 'string') {
    if (e.startsWith('$')) return ctx.controls[e.slice(1)] ?? Number.NaN
    return e
  }
  if (!Array.isArray(e) || typeof e[0] !== 'string') return Number.NaN
  const [op, ...args] = e as [string, ...unknown[]]
  const n = (i: number): number => num(evalExpr(args[i], ctx))
  switch (op) {
    case 'linear': {
      const [x, x0, y0, x1, y1] = [n(0), n(1), n(2), n(3), n(4)]
      return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0)
    }
    case 'round_to': {
      const q = n(1)
      return snap(Math.round(n(0) / q) * q)
    }
    case 'floor':
      return Math.floor(n(0) + 1e-9)
    case 'ceil':
      return Math.ceil(n(0) - 1e-9)
    case 'add':
      return args.reduce<number>((a, _, i) => a + n(i), 0)
    case 'mul':
      return args.reduce<number>((a, _, i) => a * n(i), 1)
    case 'sub':
      return n(0) - n(1)
    case 'div':
      return n(0) / n(1)
    case 'min':
      return Math.min(...args.map((_, i) => n(i)))
    case 'max':
      return Math.max(...args.map((_, i) => n(i)))
    case 'clamp':
      return Math.min(Math.max(n(0), n(1)), n(2))
    case 'table': {
      const key = String(evalExpr(args[0], ctx))
      const map = args[1]
      if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
        const hit = (map as Record<string, unknown>)[key]
        if (typeof hit === 'number' || typeof hit === 'string' || typeof hit === 'boolean') return hit
      }
      return Number.NaN
    }
    case 'base':
    case 'ref': {
      const v = lookup(ctx, String(args[0]), op === 'ref')
      if (v === undefined) return args[1] === undefined ? Number.NaN : evalExpr(args[1], ctx)
      // Orca stores 0 for "auto" nozzle-like values; a zero base is treated as missing when a default is given.
      if (v === 0 && args[1] !== undefined) return evalExpr(args[1], ctx)
      return typeof v === 'string' ? num(Number(v)) : v
    }
    default:
      return Number.NaN
  }
}

function holds(cond: readonly unknown[] | undefined, ctx: Ctx): boolean {
  if (!cond) return true
  const [op, a, b] = cond
  const l = evalExpr(a, ctx)
  const r = evalExpr(b, ctx)
  return op === 'eq' ? l === r : op === 'ne' ? l !== r : true
}

/** Write a scalar in the shape of the base value: lists stay lists of the same length. */
function shaped(base: SettingValue | undefined, v: Scalar): SettingValue {
  if (Array.isArray(base) && base.length > 0) {
    const arr = base as unknown[]
    return arr.map(() => v) as SettingValue
  }
  return v
}

/** Parse a line width that may be `0` (auto), `0.42`, or `110%` of the nozzle. */
function width(cfg: PrintConfig, out: Map<string, SettingValue>, key: string, nozzle: number): number {
  const raw = firstOf(out.get(key) ?? cfg[key])
  if (typeof raw === 'number') return raw > 0 ? raw : nozzle
  if (typeof raw === 'string') {
    if (raw.endsWith('%')) return (Number(raw.slice(0, -1)) / 100) * nozzle
    const v = Number(raw)
    return v > 0 ? v : nozzle
  }
  return nozzle
}

/**
 * Apply the Easy controls to a base config and return a new one. `base` is the
 * unmodified profile: speed scaling multiplies its values, so applying twice to
 * an already scaled config would scale twice.
 */
/**
 * Applies the Easy controls to a profile. `only` limits it to the rules of some controls (detail, strength, speed,
 * supports, brim, smartLayer): the app uses it to apply just the controls the person moved off the quality tier, so a
 * maker preset keeps its own values until they ask for something else. TypeScript only; the Rust side applies every rule.
 */
export function applyEasy(easy: EasySettings, base: PrintConfig, only?: ReadonlySet<string>): PrintConfig {
  // `only` names controls: detail, strength, speed, supports, brim, varyLayerHeight (a saved smartLayer counts as varyLayerHeight).
  const controls: Controls = {
    detail: easy.detail,
    strength: easy.strength,
    speed: alias('speed', easy.speed),
    supports: alias('supports', easy.supports),
    brim: easy.brim,
    varyLayerHeight: easy.varyLayerHeight ?? (easy.smartLayer !== undefined && easy.smartLayer !== 'off'),
  }
  const ctx: Ctx = { controls, base, out: new Map() }
  for (const [name, expr] of Object.entries(EASY_MAP.derived ?? {})) controls[name] = evalExpr(expr, ctx)
  // A saved smartLayer mode with no varyLayerHeight keeps its exact mode.
  if (easy.varyLayerHeight === undefined && easy.smartLayer !== undefined) controls.smartLayerMode = easy.smartLayer
  const nozzle = num(firstOf(base.nozzle_diameter)) || 0.4
  for (const rule of EASY_MAP.rules) {
    if (only && !only.has(rule.control) && !(rule.control === 'varyLayerHeight' && only.has('smartLayer'))) continue
    if (rule.op === 'set') {
      if (!holds(rule.when, ctx)) continue
      const v = evalExpr(rule.expr, ctx)
      if (typeof v === 'number' && !Number.isFinite(v)) continue
      ctx.out.set(rule.key, shaped(base[rule.key], v))
    } else {
      const factor = num(evalExpr(rule.factor, ctx))
      if (!Number.isFinite(factor)) continue
      const maxFlow = rule.flow_cap ? num(firstOf(base[rule.flow_cap.max_flow_key])) : 0
      const height = rule.flow_cap ? num(firstOf(ctx.out.get(rule.flow_cap.height_key) ?? base[rule.flow_cap.height_key])) : 0
      const limit = rule.max_key ? num(firstOf(base[rule.max_key])) : 0
      for (const key of rule.keys) {
        const cur = ctx.out.get(key) ?? base[key]
        // A cap only limits an increase: it never pushes a value below the profile's own.
        const scale = (x: number): number => {
          if (x <= 0) return x
          let v = x * factor
          const wk = rule.flow_cap?.width_keys[key]
          if (rule.flow_cap && wk && maxFlow > 0 && height > 0) {
            const w = width(base, ctx.out, wk, nozzle)
            v = Math.min(v, Math.max(maxFlow / (w * height), x))
          }
          if (limit > 0) v = Math.min(v, Math.max(limit, x))
          if (rule.min !== undefined) v = Math.max(v, rule.min)
          if (rule.round) v = Math.round(v / rule.round) * rule.round
          return snap(v)
        }
        if (typeof cur === 'number') ctx.out.set(key, scale(cur))
        else if (Array.isArray(cur) && cur.every((x) => typeof x === 'number')) ctx.out.set(key, (cur as number[]).map(scale))
      }
    }
  }
  const next: PrintConfig = { ...base }
  for (const [k, v] of ctx.out) next[k] = v
  return next
}

/** The Easy controls for a Goal preset. */
export function goalEasy(goal: EasyGoal): EasySettings {
  return { ...EASY_MAP.goals[goal] }
}

function alias(name: string, v: string): string {
  return EASY_MAP.controls[name]?.aliases?.[v] ?? v
}

function varies(e: EasySettings): boolean {
  return e.varyLayerHeight ?? (e.smartLayer !== undefined && e.smartLayer !== 'off')
}

/** The Goal whose sliders match `easy` exactly, if any. */
export function matchGoal(easy: EasySettings): EasyGoal | null {
  for (const g of Object.keys(EASY_MAP.goals) as EasyGoal[]) {
    const p = EASY_MAP.goals[g]
    if (p.detail === easy.detail && p.strength === easy.strength && alias('speed', p.speed) === alias('speed', easy.speed) && varies(p) === varies(easy)) return g
  }
  return null
}

/** Which Easy control writes `key`, if one does. Used for diff reasons. */
export function easyControlFor(key: string): string | undefined {
  for (const r of EASY_MAP.rules) {
    if (r.op === 'set' && r.key === key) return r.control
    if (r.op === 'scale' && r.keys.includes(key)) return r.control
  }
  return undefined
}

/** The Advanced choices that set several keys together (overhang slowdown, unsupported overhangs). */
export function easyChoices(): Record<string, EasyChoice> {
  return EASY_MAP.choices
}

/** Set a choice: every key of the named value is written in the shape of its current value. Unknown choice or value: unchanged. */
export function applyChoice(config: PrintConfig, choice: string, value: string): PrintConfig {
  const set = EASY_MAP.choices[choice]?.values[value]
  if (!set) return config
  const next: PrintConfig = { ...config }
  for (const [k, v] of Object.entries(set)) next[k] = shaped(config[k] ?? settingDef(k)?.default, v)
  return next
}

/** The value of a choice that the config's keys spell out, or undefined when they match none (a custom mix). */
export function choiceValue(config: PrintConfig, choice: string): string | undefined {
  const c = EASY_MAP.choices[choice]
  if (!c) return undefined
  for (const [name, set] of Object.entries(c.values)) {
    if (Object.entries(set).every(([k, v]) => firstOf(config[k] ?? settingDef(k)?.default) === v)) return name
  }
  return undefined
}

/**
 * Top and bottom shell layers from the shell thickness in mm and the layer height: ceil(thickness / layer height).
 * Users edit the thickness; the counts follow. A thickness of 0 leaves the count as it is.
 */
export function deriveShellLayers(config: PrintConfig): PrintConfig {
  const lh = firstOf(config.layer_height)
  const next: PrintConfig = { ...config }
  if (typeof lh !== 'number' || lh <= 0) return next
  for (const side of ['top', 'bottom'] as const) {
    const t = firstOf(config[`${side}_shell_thickness`])
    if (typeof t === 'number' && t > 0) next[`${side}_shell_layers`] = Math.ceil(snap(t / lh) - 1e-9)
  }
  return next
}
