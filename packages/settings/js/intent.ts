// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Merges intent goals (knowledge/intents) into one set of value changes, following
// knowledge/intents/tradeoffs.yaml: core beats supporting, stated beats inferred, the pair
// rules say who keeps which key, and every goal that loses a key is reported.
import type { CalibrationResult, PlanAdvice, PlanIntent, SetupRef } from '@slicerx/contracts/settings'
const shortName = (name: string): string => name.split(' (')[0] ?? name
import { K, type GoalKnowledge, type KChange, type MaterialKnowledge } from './knowledge'

export type Scalar = number | string | boolean

export interface IntentValue {
  value: Scalar
  reason: string
  src: string[]
  goal: string
  priority: 'core' | 'supporting'
}

export interface IntentContext {
  to: SetupRef
  material: MaterialKnowledge | undefined
  /** The value a key has right now (pending plan value, base config or schema default), first entry of a list. */
  scalar: (key: string) => Scalar | undefined
  calibrations: readonly CalibrationResult[]
}

export interface IntentResult {
  values: Map<string, IntentValue>
  tellUser: string[]
  advice: PlanAdvice[]
  caveats: { text: string; sources: string[] }[]
  questions: string[]
  warnings: string[]
}

interface ActiveGoal {
  id: string
  level: string
  stated: boolean
  order: number
  k: GoalKnowledge
}

interface Cand {
  goal: ActiveGoal
  change: KChange
  value: Scalar | undefined
}

/** Keys that mean nothing in spiral vase mode. Dropped from other goals when a vase plan is chosen. */
const VASE_SKIP = [
  'seam_slope_type', 'seam_position', 'wall_sequence', 'top_surface_pattern', 'only_one_wall_top', 'ironing_type', 'ironing_flow',
  'ironing_spacing', 'ironing_speed', 'sparse_infill_pattern', 'infill_combination', 'alternate_extra_wall', 'ensure_vertical_shell_thickness',
]

const snap = (v: number): number => Math.round(v * 1e9) / 1e9

function roundTo(v: number, r: number | undefined): number {
  return snap(r ? Math.round(v / r) * r : v)
}

function levelChanges(k: GoalKnowledge, level: string, depth = 0): KChange[] {
  const lv = k.levels[level]
  if (!lv || depth > 8) return []
  const parent = lv.extends ? levelChanges(k, lv.extends, depth + 1) : []
  const own = new Set(lv.changes.map((c) => c.key))
  return [...parent.filter((c) => !own.has(c.key)), ...lv.changes]
}

function resolveValue(c: KChange, ctx: IntentContext): Scalar | undefined {
  if (c.op === 'enable') return true
  if (c.op === 'disable') return false
  const vf = c.valueFrom
  if (!vf) return c.value
  if (vf.nozzle_factor !== undefined) return roundTo(ctx.to.nozzleDiameter * vf.nozzle_factor, vf.round_to)
  const paths = ctx.material?.paths ?? {}
  if (vf.filament_range !== undefined) {
    const lo = paths[vf.filament_range + '.min']
    const hi = paths[vf.filament_range + '.max']
    if (lo === undefined || hi === undefined) return undefined
    return roundTo(lo + (vf.position ?? 0.5) * (hi - lo), vf.round_to)
  }
  if (vf.filament !== undefined) {
    const v = paths[vf.filament]
    return v === undefined ? undefined : snap(v * (vf.factor ?? 1))
  }
  if (vf.calibration !== undefined) {
    const cal = ctx.calibrations.find((x) => x.id === vf.calibration)
    const v = cal && vf.field !== undefined ? cal.values[vf.field] : undefined
    return v === undefined ? undefined : snap(v * (vf.factor ?? 1))
  }
  return undefined
}

const rankOf = (c: Cand): number => (c.change.priority === 'core' ? 0 : 1) * 10 + (c.goal.stated ? 0 : 5) + c.goal.order / 100

function describe(c: Cand): string {
  const v = c.value
  switch (c.change.op) {
    case 'at_least': return `at least ${String(v)}`
    case 'at_most': return `at most ${String(v)}`
    case 'enable': return 'on'
    case 'disable': return 'off'
    case 'multiply': return `times ${String(v)}`
    case 'increase_by': return `up by ${String(v)}`
    case 'decrease_by': return `down by ${String(v)}`
    default: return String(v)
  }
}

/** Expand the request into goals: the goals given, then any they imply (as inferred). Unknown ids go to warnings. */
function activeGoals(intent: PlanIntent, warnings: string[]): ActiveGoal[] {
  const out: ActiveGoal[] = []
  const add = (id: string, level: string | undefined, stated: boolean): void => {
    if (out.some((g) => g.id === id)) return
    const k = K.goals[id]
    if (!k) {
      warnings.push(`Unknown goal "${id}".`)
      return
    }
    let lv = level ?? k.defaultLevel ?? Object.keys(k.levels)[0] ?? 'standard'
    if (!k.levels[lv]) {
      warnings.push(`${k.label} has no level "${lv}"; using ${k.defaultLevel ?? 'standard'}.`)
      lv = k.defaultLevel ?? 'standard'
    }
    out.push({ id, level: lv, stated, order: out.length, k })
  }
  for (const g of intent.goals) add(g.id, g.level, g.stated !== false)
  for (const g of [...out]) for (const imp of g.k.implies ?? []) add(imp, undefined, false)
  return out
}

/**
 * Turn the goals into values. Keys the goals do not touch are absent from the result. Values are
 * plain scalars; the planner shapes them like the config's own lists.
 */
export function mergeIntent(intent: PlanIntent, ctx: IntentContext): IntentResult {
  const res: IntentResult = { values: new Map(), tellUser: [], advice: [], caveats: [], questions: [], warnings: [] }
  const goals = activeGoals(intent, res.warnings)
  if (goals.length === 0) return res
  const ids = new Set(goals.map((g) => g.id))
  const cands: Cand[] = []
  for (const g of goals) {
    for (const change of levelChanges(g.k, g.level)) cands.push({ goal: g, change, value: resolveValue(change, ctx) })
    const rule = g.k.coolingRule
    if (rule && rule.appliesTo.includes(ctx.to.filament)) cands.push({ goal: g, change: rule.change, value: resolveValue(rule.change, ctx) })
  }
  let live = cands.filter((c) => c.value !== undefined || c.change.op === 'enable' || c.change.op === 'disable')

  // Pair rules: which goal keeps which key.
  for (const pair of K.pairs) {
    const [a, b] = pair.goals
    if (!a || !b || !ids.has(a) || !ids.has(b)) continue
    if (pair.ask) res.questions.push(pair.ask)
    if (pair.tellUser) res.tellUser.push(pair.tellUser)
    for (const [key, keeper] of Object.entries(pair.keep ?? {})) {
      const mine = live.filter((c) => c.change.key === key && (c.goal.id === a || c.goal.id === b))
      if (mine.length === 0) continue
      if (keeper.startsWith('compromise_')) {
        const v = Number(keeper.slice('compromise_'.length).replace('_', '.'))
        const first = mine[0] as Cand
        live = live.filter((c) => !mine.includes(c))
        live.push({ goal: first.goal, change: { ...first.change, op: 'set', priority: 'core', why: `${pair.resolution ?? 'Middle ground between the goals.'}`.trim(), value: v }, value: v })
      } else {
        live = live.filter((c) => !mine.includes(c) || c.goal.id === keeper)
      }
    }
  }
  if (ids.has('strength') && live.some((c) => c.change.key === 'sparse_infill_pattern' && c.value === 'lightning')) {
    live = live.filter((c) => !(c.change.key === 'sparse_infill_pattern' && c.value === 'lightning'))
    res.tellUser.push('Lightning infill was dropped: it has no strength, and this part carries load.')
  }

  const byKey = new Map<string, Cand[]>()
  for (const c of live) byKey.set(c.change.key, [...(byKey.get(c.change.key) ?? []), c])
  for (const [key, list] of byKey) {
    const ranked = list.slice().sort((x, y) => rankOf(x) - rankOf(y))
    const cur = ctx.scalar(key)
    let value: Scalar | undefined = cur
    let lo = -Infinity
    let hi = Infinity
    let setDone = false
    let credit: Cand | undefined
    const loseNote = (c: Cand, winner: Cand | undefined): void => {
      if (winner && winner.goal.id !== c.goal.id) res.tellUser.push(`${c.goal.k.label} wanted ${key} ${describe(c)}; ${winner.goal.k.label} takes priority.`)
    }
    for (const c of ranked) {
      const v = c.value
      const num = typeof value === 'number' ? value : typeof cur === 'number' ? cur : 0
      switch (c.change.op) {
        case 'set':
        case 'enable':
        case 'disable':
          if (typeof v === 'number' && (v < lo || v > hi)) loseNote(c, credit)
          else if (!setDone) {
            value = v
            setDone = true
            credit = c
          } else if (v !== value) loseNote(c, credit)
          break
        case 'at_least':
          if (typeof v === 'number' && (v > hi || (setDone && typeof value === 'number' && value < v))) loseNote(c, credit)
          else if (typeof v === 'number') {
            lo = Math.max(lo, v)
            credit ??= c
          }
          break
        case 'at_most':
          if (typeof v === 'number' && (v < lo || (setDone && typeof value === 'number' && value > v))) loseNote(c, credit)
          else if (typeof v === 'number') {
            hi = Math.min(hi, v)
            credit ??= c
          }
          break
        case 'increase_by':
          if (typeof v === 'number') (value = snap(num + v)), (credit = c)
          break
        case 'decrease_by':
          if (typeof v === 'number') (value = snap(num - v)), (credit = c)
          break
        case 'multiply':
          if (typeof v === 'number') (value = snap(num * v)), (credit = c)
          break
      }
    }
    if (typeof value !== 'number' && (lo > -Infinity || hi < Infinity) && typeof cur !== 'number') value = lo > -Infinity ? lo : hi
    if (typeof value === 'number' && lo <= hi) {
      const clamped = Math.min(Math.max(value, lo), hi)
      if (clamped !== value) {
        value = clamped
        credit = ranked.find((c) => (c.change.op === 'at_least' && c.value === lo) || (c.change.op === 'at_most' && c.value === hi)) ?? credit
      }
    }
    if (value === undefined || !credit) continue
    res.values.set(key, { value, reason: credit.change.why, src: credit.change.src, goal: credit.goal.id, priority: credit.change.priority })
  }

  if (res.values.get('sparse_infill_pattern')?.value === 'lightning') res.tellUser.push('Lightning infill has no strength; it only holds up the top skin.')

  // Vase mode drops settings that do not exist there.
  const spiral = res.values.get('spiral_mode')?.value ?? ctx.scalar('spiral_mode')
  if (spiral === true && goals.some((g) => g.id === 'vase')) {
    const dropped: string[] = []
    for (const key of VASE_SKIP) {
      const v = res.values.get(key)
      if (v && v.goal !== 'vase') {
        res.values.delete(key)
        dropped.push(key)
      }
    }
    const wl = res.values.get('wall_loops')
    if (wl && wl.goal !== 'vase') res.values.delete('wall_loops')
    if (dropped.length > 0) res.tellUser.push(`Skipped ${dropped.join(', ')}: they do not apply in vase mode.`)
  }

  // Notes that are not value changes.
  for (const g of goals) {
    const k = g.k
    if (k.alwaysShowCaveats || k.caveats.length > 0) for (const c of k.caveats) res.caveats.push({ text: c.text, sources: c.src })
    for (const a of k.advice) res.advice.push({ text: a.text, kind: a.kind, sources: a.src })
    for (const c of k.constraints) res.advice.push({ text: c.text, kind: 'workflow', sources: c.src })
    for (const t of k.checks) res.advice.push({ text: t, kind: 'workflow', sources: [] })
    const note = k.materialNotes?.[ctx.to.filament]
    if (note) res.advice.push({ text: note, kind: 'material', sources: k.src })
    const h = k.materialHints
    const mat = shortName(ctx.material?.name ?? ctx.to.filament)
    if (h.avoid?.includes(ctx.to.filament)) res.warnings.push(`${mat} is a poor fit for ${k.label.toLowerCase()}. ${h.note ?? ''}`.trim())
    else if (h.prefer && h.prefer.length > 0 && !h.prefer.includes(ctx.to.filament) && !h.acceptable?.includes(ctx.to.filament)) {
      res.advice.push({ text: `For ${k.label.toLowerCase()} consider ${h.prefer.map((id) => shortName(K.materials[id]?.name ?? id)).join(', ')} instead of ${mat}. ${h.note ?? ''}`.trim(), kind: 'material', sources: k.src })
    }
    if (g.id === 'detail' && ctx.to.nozzleDiameter >= 0.4) res.questions.push('Is a 0.2 mm nozzle available? It resolves much finer detail than 0.4 mm.')
  }
  return res
}
