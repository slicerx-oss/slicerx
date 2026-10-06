// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Changing the project's named values (cad/values.ts) and keeping the steps that follow them in step: each step
// with a binding gets the number its expression gives now, and each object with such a change replays its history
// once (refreshBound). The shell runs refreshBound when the table or the plate in view changes, so a value change
// shows on every plate the person looks at.
import { get, set, type PlateEntry } from '../state/store'
import { applyHistory } from './history/ops'
import { mainNumber, withNumber, type Step } from './history/model'
import { valueTable } from './value-table'
import { evaluate, validName, type NamedValue } from './values'

type Loader = Parameters<typeof applyHistory>[0]

/** Sets value `name` to `expr`, adding it when new. Throws with a sentence when the name cannot be used. */
export function setValue(name: string, expr: string): void {
  const values = get().namedValues
  const at = values.findIndex((v) => v.name === name)
  if (at < 0) {
    const why = validName(name, values.map((v) => v.name))
    if (why) throw new Error(why)
  }
  const next: NamedValue = { name, expr: expr.trim() }
  set({ namedValues: at < 0 ? [...values, next] : values.map((v, i) => (i === at ? next : v)) })
}

/** Every entry on every plate, the one in view included. */
function allEntries(): PlateEntry[] {
  const s = get()
  return [...s.plate, ...s.plates.filter((p) => p.id !== s.activePlate).flatMap((p) => p.objects)]
}

/** How many steps follow `name`, on every plate. */
export function stepsUsing(name: string): number {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`)
  return allEntries().reduce((n, e) => n + (e.history?.steps.filter((s) => s.bind !== undefined && re.test(s.bind)).length ?? 0), 0)
}

/** Removes value `name`. Throws when a step still follows it: change those steps first. */
export function removeValue(name: string): void {
  const n = stepsUsing(name)
  if (n > 0) throw new Error(`${name} is used by ${n} step${n === 1 ? '' : 's'}. Type a number in ${n === 1 ? 'that step' : 'those steps'} first.`)
  set((s) => ({ namedValues: s.namedValues.filter((v) => v.name !== name) }))
}

/**
 * Brings every bound step on the plate in view to the number its expression gives now and replays each object
 * that changed. A step whose expression does not resolve keeps its number, and the sentence says why.
 */
export async function refreshBound(host: Loader): Promise<{ replayed: string[]; broken: string[] }> {
  const { values, errors } = valueTable()
  const replayed: string[] = []
  const broken: string[] = []
  for (const e of get().plate) {
    const h = e.history
    if (!h?.steps.some((s) => s.bind !== undefined)) continue
    let changed = false
    const steps = h.steps.map((s, i): Step => {
      const n = mainNumber(s.params)
      if (s.bind === undefined || !n) return s
      let v: number
      try {
        v = evaluate(s.bind, (name) => {
          if (errors[name]) throw new Error(errors[name])
          return values[name]
        })
      } catch (err) {
        broken.push(`${e.name}, step ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
        return s
      }
      if (Math.abs(v - n.value) <= 1e-9 * Math.max(1, Math.abs(v))) return s
      const params = withNumber(s.params, v)
      if (typeof params === 'string') {
        broken.push(`${e.name}, step ${i + 1}: ${s.bind} gives ${v}. ${params}`)
        return s
      }
      changed = true
      return { ...s, params }
    })
    if (!changed) continue
    await applyHistory(host, e.id, { ...h, steps })
    replayed.push(e.id)
  }
  return { replayed, broken }
}
