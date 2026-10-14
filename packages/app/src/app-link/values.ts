// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Project value commands use the same table and history operations as the values panel.
import { mainNumber, withNumber } from '@slicerx/cad-history'
import { appValueInputs, type AppValuesResult } from '@slicerx/mcp/toolset'
import { replaying, setParams } from '../cad/history/ops'
import { refreshBound, removeValue, setValue } from '../cad/value-ops'
import { builtIns, valueTable } from '../cad/value-table'
import { evaluate } from '../cad/values'
import { get } from '../state/store'
import { LinkError } from './methods-error'

type Loader = Parameters<typeof setParams>[0]
type Method = keyof typeof appValueInputs
let changing = false

/** Every binding, including ones waiting for their plate to be shown and refreshed. */
export function projectValues(): AppValuesResult {
  const s = get()
  const table = valueTable(s)
  const bindings: AppValuesResult['bindings'] = []
  const plates = [{ id: s.activePlate, objects: s.plate }, ...s.plates.filter((p) => p.id !== s.activePlate)]
  for (const plate of plates) for (const e of plate.objects) e.history?.steps.forEach((step, i) => {
    if (step.bind === undefined) return
    const n = mainNumber(step.params)
    let resolved: number | undefined
    let error: string | undefined = step.broken
    try {
      resolved = evaluate(step.bind, (name) => {
        if (table.errors[name]) throw new Error(table.errors[name])
        return table.values[name]
      })
      const params = withNumber(step.params, resolved)
      if (typeof params === 'string') error = params
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const same = n && resolved !== undefined && Math.abs(resolved - n.value) <= 1e-9 * Math.max(1, Math.abs(resolved))
    bindings.push({ plate: plate.id, design: e.id, step: i + 1, id: step.id, expression: step.bind, value: n?.value ?? null,
      ...(resolved !== undefined ? { resolved } : {}), state: error ? 'broken' : same && !replaying(e.id) ? 'current' : 'pending', ...(error ? { error } : {}) })
  })
  return {
    activePlate: s.activePlate,
    values: s.namedValues.map((v) => {
      const error = table.errors[v.name]
      const value = table.values[v.name]
      return { name: v.name, expression: v.expr, ...(error !== undefined ? { error } : value !== undefined ? { value } : {}) }
    }),
    builtIns: builtIns(s), bindings, replayed: [],
    issues: [...Object.values(table.errors), ...bindings.filter((b) => b.error).map((b) => `${b.design}, step ${b.step}: ${b.error}`)],
  }
}

export async function valueCall(method: Method, args: Record<string, unknown>, loader: Loader | null): Promise<AppValuesResult> {
  const parsed = appValueInputs[method].safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  if (method === 'values.list') return projectValues()
  if (!loader) throw new LinkError('not_ready', 'The project is still loading its history tools.')
  if (changing || get().historyEdit || get().plate.some((e) => replaying(e.id))) throw new LinkError('busy', 'The project is changing a history step; try again when it is done.')
  changing = true
  let applied = false
  const replayed: string[] = []
  const issues: string[] = []
  try {
    if (method === 'values.set') {
      const i = appValueInputs[method].parse(args)
      setValue(i.name, i.expression)
      applied = true
    } else if (method === 'values.remove') {
      const i = appValueInputs[method].parse(args)
      if (!get().namedValues.some((v) => v.name === i.name)) throw new LinkError('not_found', `There is no project value named ${i.name}.`)
      removeValue(i.name)
      applied = true
    } else {
      const i = appValueInputs[method].parse(args)
      const entry = get().plate.find((e) => e.id === i.design)
      if (!entry?.history) throw new LinkError('not_found', 'The design must have history on the shown plate; design.list lists it.')
      const index = typeof i.step === 'number' ? i.step - 1 : entry.history.steps.findIndex((s) => s.id === i.step)
      const step = entry.history.steps[index]
      if (!step) throw new LinkError('not_found', 'There is no such history step; design.steps lists them.')
      if (!mainNumber(step.params)) throw new LinkError('invalid_input', 'This step has no main number to bind.')
      let params = step.params
      if (i.expression !== null) {
        const table = valueTable()
        const n = evaluate(i.expression, (name) => {
          if (table.errors[name]) throw new Error(table.errors[name])
          return table.values[name]
        })
        const next = withNumber(params, n)
        if (typeof next === 'string') throw new LinkError('invalid_input', next)
        params = next
      }
      const result = await setParams(loader, entry.id, index, params, i.expression ?? undefined)
      applied = true
      replayed.push(entry.id)
      result.status.forEach((s, n) => { if (s.state === 'broken') issues.push(`${entry.name}, step ${n + 1}: ${s.message ?? 'The step failed.'}`) })
    }
    if (method !== 'values.bind') {
      const result = await refreshBound(loader)
      replayed.push(...result.replayed)
      issues.push(...result.broken)
    }
  } catch (e) {
    if (!applied) throw e instanceof LinkError ? e : new LinkError('invalid_input', e instanceof Error ? e.message : String(e))
    issues.push(e instanceof Error ? e.message : String(e))
  } finally {
    changing = false
  }
  const state = projectValues()
  return { ...state, applied, replayed, issues: [...new Set([...state.issues, ...issues])] }
}
