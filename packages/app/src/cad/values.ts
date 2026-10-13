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

/** Millimeters in each unit a typed length may carry. */
export const UNIT_MM: Readonly<Record<string, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, ft: 304.8, "'": 304.8 }
const UNIT = /^(inches|inch|in|mm|cm|ft|m(?![A-Za-z0-9_])|"|')(?![A-Za-z0-9_])/

export interface EvalOptions {
  /** Millimeters per bare number, so 1 reads as an inch when inches are shown. Names are always millimeters. */
  bareMm?: number
  /** Filled with the spans of bare numbers that took `bareMm`, so the text can be written with its unit (withUnit). */
  marks?: [number, number][]
}

// a number with no unit yet (bare) or a length in mm; spans are source offsets
interface Val {
  v: number
  bare: boolean
  s: number
  e: number
}

/**
 * The value of an arithmetic expression; throws an Error with a sentence part that says what is wrong. Numbers may
 * carry a unit (25.4mm, 1in, 1", 3/8 in, 1 1/2"), always read to mm. A bare number added to a length takes the
 * display unit (`bareMm`), as does a result with no length in it at all; one that scales (wall * 2) stays a factor.
 */
export function evaluate(text: string, lookup: Lookup, opts: EvalOptions = {}): number {
  const bareMm = opts.bareMm ?? 1
  const s = text.trim()
  if (!s) throw new Error('the value is empty')
  if (s.length > MAX_TEXT) throw new Error(`the value is longer than ${MAX_TEXT} characters`)
  // A lone decimal comma (2,5) reads as a point; there are no function arguments to confuse it with.
  const src = s.replace(/(\d),(\d)/g, '$1.$2')
  let at = 0
  const space = () => {
    while (src[at] === ' ' || src[at] === '\t') at++
  }
  const toLength = (x: Val): Val => {
    if (!x.bare) return x
    opts.marks?.push([x.s, x.e])
    return { ...x, v: x.v * bareMm, bare: false }
  }
  // a unit right after a number or a closing parenthesis
  const unit = (x: Val): Val => {
    const save = at
    space()
    const u = UNIT.exec(src.slice(at))
    if (!u) {
      at = save
      return x
    }
    if (!x.bare) throw new Error('it has two units on one number')
    at += u[0].length
    return { v: x.v * UNIT_MM[u[1]!]!, bare: false, s: x.s, e: x.e }
  }
  const expr = (depth: number): Val => {
    let v = term(depth)
    for (;;) {
      space()
      const c = src[at]
      if (c !== '+' && c !== '-') return v
      at++
      let r = term(depth)
      if (v.bare !== r.bare) {
        v = toLength(v)
        r = toLength(r)
      }
      v = { v: c === '+' ? v.v + r.v : v.v - r.v, bare: v.bare && r.bare, s: v.s, e: r.e }
    }
  }
  const term = (depth: number): Val => {
    let v = factor(depth)
    for (;;) {
      space()
      const c = src[at]
      if (c !== '*' && c !== '/') return v
      at++
      const r = factor(depth)
      if (c === '/' && r.v === 0) throw new Error('it divides by 0')
      // a length over a length is a plain ratio
      v = c === '*' ? { v: v.v * r.v, bare: v.bare && r.bare, s: v.s, e: r.e } : { v: v.v / r.v, bare: v.bare === r.bare, s: v.s, e: r.e }
    }
  }
  const factor = (depth: number): Val => {
    if (depth > MAX_DEPTH) throw new Error('it nests too deep')
    space()
    const c = src[at]
    const from = at
    if (c === undefined) throw new Error('it ends too soon')
    if (c === '-' || c === '+') {
      at++
      const v = factor(depth + 1)
      return { ...v, v: c === '-' ? -v.v : v.v, s: from }
    }
    if (c === '(') {
      at++
      const v = expr(depth + 1)
      space()
      if (src[at] !== ')') throw new Error('a closing parenthesis is missing')
      at++
      return unit({ ...v, s: from, e: at })
    }
    const rest = src.slice(at)
    // 1 1/2 and 3/8 in read as one number: a mixed number always, a fraction when a unit follows
    const mixed = /^(\d+)[ \t]+(\d+)\/(\d+)/.exec(rest)
    const frac = mixed ? null : /^(\d+)\/(\d+)(?=[ \t]*(inches|inch|in|mm|cm|ft|m|"|')(?![A-Za-z0-9_]))/.exec(rest)
    if (mixed || frac) {
      const [whole, n, d] = mixed ? [Number(mixed[1]), Number(mixed[2]), Number(mixed[3])] : [0, Number(frac![1]), Number(frac![2])]
      if (d === 0) throw new Error('it divides by 0')
      at += (mixed ?? frac)![0].length
      return unit({ v: whole + n / d, bare: true, s: from, e: at })
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(rest)
    if (num) {
      at += num[0].length
      return unit({ v: Number(num[0]), bare: true, s: from, e: at })
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (name) {
      at += name[0].length
      const v = lookup(name[0])
      if (v === undefined) throw new Error(`there is no value named ${name[0]}`)
      return { v, bare: false, s: from, e: at }
    }
    throw new Error(`it cannot read ${c}`)
  }
  let v = expr(0)
  space()
  if (at < src.length) throw new Error(`it cannot read ${src[at]}`)
  if (bareMm !== 1) v = toLength(v)
  if (!Number.isFinite(v.v)) throw new Error('it is not a finite number')
  return v.v
}

/**
 * The text with `unit` written on each bare number that took it, so it gives the same millimeters whatever unit is
 * shown later: `wall + 1` in inches is `wall + 1in`. Text that does not read comes back as it was.
 */
export function withUnit(text: string, unit: string, lookup: Lookup): string {
  const s = text.trim()
  const mm = UNIT_MM[unit]
  if (!mm || mm === 1) return s
  const marks: [number, number][] = []
  try {
    evaluate(s, lookup, { bareMm: mm, marks })
  } catch {
    return s
  }
  let out = s
  for (const [a, b] of marks.sort((x, y) => y[0] - x[0])) {
    const piece = out.slice(a, b)
    out = out.slice(0, a) + (/^(\d+[ \t]+\d+\/\d+|\d+\/\d+|\d+[.,]?\d*|\.\d+)$/.test(piece) ? `${piece}${unit}` : `(${piece})${unit}`) + out.slice(b)
  }
  return out
}

/** The names an expression uses, each once, in order. A unit after a number is not a name. */
export function namesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (UNIT_MM[m[0]] && /[\d.)][ \t]*$/.test(text.slice(0, m.index))) continue
    if (!out.includes(m[0])) out.push(m[0])
  }
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
