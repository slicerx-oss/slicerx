// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Named values: a project's table of numbers (wall = 2, lip = wall * 1.5) that any typed field takes, and that a
// history step's main number can follow (docs/cad-history.md, "Named values"). Arithmetic only: numbers, names,
// + - * / and parentheses; no functions and no conditions, so a value always reads as a sum a person can check.
// `clearance` (the measured fit, plate/clearance.ts) and `nozzle` are built in (value-names.ts).
import type { NamedValue } from './value-names'

export { BUILT_IN, validName, type NamedValue } from './value-names'

const MAX_TEXT = 200
const MAX_DEPTH = 32

type Lookup = (name: string) => number | undefined

/** The value of an arithmetic expression; throws an Error with a sentence part that says what is wrong. */
export function evaluate(text: string, lookup: Lookup): number {
  const s = text.trim()
  if (!s) throw new Error('the value is empty')
  if (s.length > MAX_TEXT) throw new Error(`the value is longer than ${MAX_TEXT} characters`)
  // A lone decimal comma (2,5) reads as a point; there are no function arguments to confuse it with.
  const src = s.replace(/(\d),(\d)/g, '$1.$2')
  let at = 0
  const space = () => {
    while (src[at] === ' ' || src[at] === '\t') at++
  }
  const expr = (depth: number): number => {
    let v = term(depth)
    for (;;) {
      space()
      const c = src[at]
      if (c !== '+' && c !== '-') return v
      at++
      const r = term(depth)
      v = c === '+' ? v + r : v - r
    }
  }
  const term = (depth: number): number => {
    let v = factor(depth)
    for (;;) {
      space()
      const c = src[at]
      if (c !== '*' && c !== '/') return v
      at++
      const r = factor(depth)
      if (c === '/' && r === 0) throw new Error('it divides by 0')
      v = c === '*' ? v * r : v / r
    }
  }
  const factor = (depth: number): number => {
    if (depth > MAX_DEPTH) throw new Error('it nests too deep')
    space()
    const c = src[at]
    if (c === undefined) throw new Error('it ends too soon')
    if (c === '-' || c === '+') {
      at++
      const v = factor(depth + 1)
      return c === '-' ? -v : v
    }
    if (c === '(') {
      at++
      const v = expr(depth + 1)
      space()
      if (src[at] !== ')') throw new Error('a closing parenthesis is missing')
      at++
      return v
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(at))
    if (num) {
      at += num[0].length
      return Number(num[0])
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(at))
    if (name) {
      at += name[0].length
      const v = lookup(name[0])
      if (v === undefined) throw new Error(`there is no value named ${name[0]}`)
      return v
    }
    throw new Error(`it cannot read ${c}`)
  }
  const v = expr(0)
  space()
  if (at < src.length) throw new Error(`it cannot read ${src[at]}`)
  if (!Number.isFinite(v)) throw new Error('it is not a finite number')
  return v
}

/** The names an expression uses, each once, in order. */
export function namesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (!out.includes(m[0])) out.push(m[0])
  return out
}

/** Every value of the table with the built-ins, and a sentence for each one that does not resolve. */
export function resolveValues(table: readonly NamedValue[], builtIns: Readonly<Record<string, number>>): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = { ...builtIns }
  const errors: Record<string, string> = {}
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

/**
 * The expression a step's main number follows: the typed text when it uses a name and gives that number. A plain
 * number, or text that gives another number, binds nothing.
 */
export function bindFor(text: string, value: number, values: Readonly<Record<string, number>>): string | undefined {
  if (!namesIn(text).length) return undefined
  try {
    const v = evaluate(text, (n) => values[n])
    return Math.abs(v - value) <= 1e-9 * Math.max(1, Math.abs(value)) ? text.trim() : undefined
  } catch {
    return undefined
  }
}
