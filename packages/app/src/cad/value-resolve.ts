// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Resolve the project table when a named value is used, apart from startup's number parser.
import { evaluate } from './values'
import type { NamedValue } from './value-names'

/** Every value of the table with the built-ins, and a sentence for each one that does not resolve. */
export function resolveValues(table: readonly NamedValue[], builtIns: Readonly<Record<string, number>>): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, builtIns)
  const errors: Record<string, string> = Object.create(null) as Record<string, string>
  const byName = new Map(table.map((v) => [v.name, v.expr]))
  const active = new Set<string>()
  const resolve = (name: string): number | undefined => {
    if (name in values) return values[name]
    if (name in errors) return undefined
    const expr = byName.get(name)
    if (expr === undefined) return undefined
    if (active.has(name)) throw new LoopError()
    active.add(name)
    try {
      const v = evaluate(expr, (n) => {
        const r = resolve(n)
        if (r === undefined && byName.has(n)) throw new Error(`${n} has a problem of its own`)
        return r
      })
      values[name] = v
      return v
    } catch (e) {
      errors[name] = e instanceof LoopError ? `${name} uses itself through other values` : `${name}: ${e instanceof Error ? e.message : String(e)}`
      if (e instanceof LoopError) throw e
      return undefined
    } finally {
      active.delete(name)
    }
  }
  for (const v of table) {
    try {
      resolve(v.name)
    } catch {
      // Recorded for every value on the loop.
    }
  }
  return { values, errors }
}

class LoopError extends Error {}
