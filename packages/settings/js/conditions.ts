// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The boolean expression language of the preset compatibility fields (`compatible_printers_condition`,
// `compatible_prints_condition`), as OrcaSlicer 2.4.2 evaluates them (libslic3r/PlaceholderParser.cpp, the boolean
// expression start rule and its `expr` operators). Written from the grammar, not copied.
//
// Grammar: ternary `a ? b : c`, `or`/`||`, `and`/`&&`, equality (`== != <> =~ !~`), relational (`< > <= >=`), `+ -`,
// `* / %`, unary `- + not !`, parentheses, numbers, `true`/`false`, "strings", variable names (a vector needs an index,
// `nozzle_diameter[0]`; a missing or out-of-range index reads the first element), and the functions min, max, int, round,
// ceil, floor, is_nil, one_of, empty, size. The result has to be a boolean. Regular expressions (`/.../`) match the whole
// string and `.` matches a newline.
import type { PrintConfig } from '@slicerx/contracts/settings'
import { settingDef } from './schema'

export class ConditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConditionError'
  }
}

type Val = { t: 'b'; v: boolean } | { t: 'i'; v: number } | { t: 'd'; v: number } | { t: 's'; v: string } | { t: 'skip' }
const SKIP: Val = { t: 'skip' }

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'if', 'else', 'elsif', 'endif', 'min', 'max', 'int', 'round', 'ceil', 'floor', 'is_nil', 'one_of', 'empty', 'size', 'digits', 'zdigits', 'random', 'interpolate_table', 'filament_change', 'local', 'global', 'repeat'])

type Tok = { k: 'num'; v: number; int: boolean } | { k: 'str'; v: string } | { k: 're'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    if (/\s/.test(c)) { i++; continue }
    if (c === '"') {
      let s = ''
      i++
      for (;;) {
        if (i >= n) throw new ConditionError('unterminated string')
        const d = src[i] as string
        if (d === '"') { i++; break }
        if (d === '\\') {
          const e = src[i + 1]
          if (e === undefined) throw new ConditionError('unterminated string')
          s += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e
          i += 2
        } else { s += d; i++ }
      }
      out.push({ k: 'str', v: s })
      continue
    }
    if (c === '/') {
      // A regular expression only follows =~ or !~ or sits in a one_of list; elsewhere / is the divide operator.
      const prev = out[out.length - 1]
      const afterRe = prev && prev.k === 'op' && (prev.v === '=~' || prev.v === '!~' || prev.v === ',' || prev.v === '(' || prev.v === '~')
      if (afterRe) {
        let s = ''
        i++
        for (;;) {
          if (i >= n) throw new ConditionError('unterminated regular expression')
          const d = src[i] as string
          if (d === '/') { i++; break }
          if (d === '\\') {
            const e = src[i + 1]
            if (e === undefined) throw new ConditionError('unterminated regular expression')
            s += d + e
            i += 2
          } else { s += d; i++ }
        }
        out.push({ k: 're', v: s })
        continue
      }
    }
    const num = /^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
    if (num && /[0-9.]/.test(c)) {
      const text = num[0]
      out.push({ k: 'num', v: Number(text), int: !/[.eE]/.test(text) })
      i += text.length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '<>', '=~', '!~', '<=', '>=', '&&', '||'].includes(two)) { out.push({ k: 'op', v: two }); i += 2; continue }
    if ('+-*/%<>!?:(),[]~'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue }
    throw new ConditionError(`unexpected character ${c}`)
  }
  return out
}

/** A named option as the evaluator reads it: a scalar, or a vector of elements. */
type Opt = { vector: false; value: Val } | { vector: true; items: Val[]; float: boolean }

function typed(type: string, raw: unknown, enumValues?: string[]): Val {
  switch (type) {
    case 'float': case 'percent': case 'floats': case 'percents': return { t: 'd', v: Number(raw) }
    case 'floatOrPercent': case 'floatsOrPercents': return { t: 'd', v: parseFloat(String(raw)) }
    case 'int': case 'ints': return { t: 'i', v: Math.trunc(Number(raw)) }
    case 'bool': case 'bools': return { t: 'b', v: raw === true || raw === 1 || raw === '1' || raw === 'true' }
    case 'enums': return { t: 'i', v: Math.max(0, (enumValues ?? []).indexOf(String(raw))) }
    case 'point': case 'points': return { t: 's', v: Array.isArray(raw) ? raw.join('x') : String(raw) }
    default: return { t: 's', v: String(raw ?? '') }
  }
}

function readOpt(key: string, config: Record<string, unknown>, extra: Record<string, unknown> | undefined): Opt | undefined {
  const value = extra && key in extra ? extra[key] : config[key]
  const def = settingDef(key)
  if (value === undefined) {
    if (!def) return undefined
    return readValue(def.type, def.default, def.enumValues)
  }
  if (!def) {
    // A key outside the schema (printer_preset, num_extruders): type it by its JS value.
    if (Array.isArray(value)) return { vector: true, items: value.map((x) => typed(typeof x === 'number' ? 'float' : typeof x === 'boolean' ? 'bool' : 'string', x)), float: typeof value[0] === 'number' }
    return { vector: false, value: typeof value === 'number' ? (Number.isInteger(value) ? { t: 'i', v: value } : { t: 'd', v: value }) : typeof value === 'boolean' ? { t: 'b', v: value } : { t: 's', v: String(value) } }
  }
  return readValue(def.type, value, def.enumValues)
}

function readValue(type: string, value: unknown, enumValues?: string[]): Opt {
  if (/s$/.test(type) && type !== 'gcode' && type !== 'pointsGroups' || type === 'pointsGroups') {
    const arr = Array.isArray(value) ? value : [value]
    return { vector: true, items: arr.map((x) => typed(type, x, enumValues)), float: type === 'floats' || type === 'floatsOrPercents' }
  }
  return { vector: false, value: typed(type === 'enum' ? 'string' : type, value, enumValues) }
}

class Parser {
  private pos = 0
  private skipping = 0
  constructor(private readonly toks: Tok[], private readonly config: Record<string, unknown>, private readonly extra: Record<string, unknown> | undefined) {}

  private peek(): Tok | undefined { return this.toks[this.pos] }
  private isOp(v: string): boolean { const t = this.peek(); return t !== undefined && t.k === 'op' && t.v === v }
  private isKw(v: string): boolean { const t = this.peek(); return t !== undefined && t.k === 'id' && t.v === v }
  private eatOp(v: string): boolean { if (this.isOp(v)) { this.pos++; return true } return false }
  private expectOp(v: string): void { if (!this.eatOp(v)) throw new ConditionError(`expected ${v}`) }

  parse(): boolean {
    const v = this.ternary()
    if (this.pos < this.toks.length) throw new ConditionError('unexpected input after the expression')
    if (v.t !== 'b') throw new ConditionError('not a boolean expression')
    return v.v
  }

  /** Runtime errors inside a branch that is not taken do not count, as in Orca's skipping mode. */
  private guard<T>(fn: () => T, fallback: T): T {
    if (this.skipping === 0) return fn()
    try { return fn() } catch (e) { if (e instanceof ConditionError) return fallback; throw e }
  }

  private ternary(): Val {
    const cond = this.or()
    if (!this.eatOp('?')) return cond
    let take = false
    if (cond.t !== 'skip') {
      if (cond.t !== 'b') throw new ConditionError('not a boolean expression')
      take = cond.v
    }
    const dead = cond.t === 'skip'
    if (!take) this.skipping++
    const a = this.ternary()
    if (!take) this.skipping--
    this.expectOp(':')
    if (take || dead) this.skipping++
    const b = this.ternary()
    if (take || dead) this.skipping--
    return dead ? SKIP : take ? a : b
  }

  private or(): Val {
    let l = this.and()
    while (this.isKw('or') || this.isOp('||')) {
      this.pos++
      const r = this.and()
      l = this.logic(l, r, true)
    }
    return l
  }

  private and(): Val {
    let l = this.equality()
    while (this.isKw('and') || this.isOp('&&')) {
      this.pos++
      const r = this.equality()
      l = this.logic(l, r, false)
    }
    return l
  }

  private logic(l: Val, r: Val, or: boolean): Val {
    if (l.t === 'skip' || r.t === 'skip') return SKIP
    if (l.t !== 'b' || r.t !== 'b') throw new ConditionError('cannot apply a logical operation to non-boolean operands')
    return { t: 'b', v: or ? l.v || r.v : l.v && r.v }
  }

  private equality(): Val {
    let l = this.relational()
    for (;;) {
      const t = this.peek()
      if (!t || t.k !== 'op') return l
      if (t.v === '==' || t.v === '!=' || t.v === '<>') {
        this.pos++
        const r = this.relational()
        l = this.compare(l, r, '=', t.v !== '==')
      } else if (t.v === '=~' || t.v === '!~') {
        this.pos++
        const re = this.peek()
        if (!re || re.k !== 're') throw new ConditionError('expected a regular expression')
        this.pos++
        l = this.regex(l, re.v, t.v === '!~')
      } else return l
    }
  }

  private relational(): Val {
    let l = this.additive()
    for (;;) {
      const t = this.peek()
      if (!t || t.k !== 'op') return l
      if (t.v === '<=') { this.pos++; l = this.compare(l, this.additive(), '>', true) }
      else if (t.v === '>=') { this.pos++; l = this.compare(l, this.additive(), '<', true) }
      else if (t.v === '<') { this.pos++; l = this.compare(l, this.additive(), '<', false) }
      else if (t.v === '>') { this.pos++; l = this.compare(l, this.additive(), '>', false) }
      else return l
    }
  }

  private additive(): Val {
    let l = this.multiplicative()
    for (;;) {
      if (this.isOp('+')) { this.pos++; l = this.arith(l, this.multiplicative(), '+') }
      else if (this.isOp('-')) { this.pos++; l = this.arith(l, this.multiplicative(), '-') }
      else return l
    }
  }

  private multiplicative(): Val {
    let l = this.unary()
    for (;;) {
      if (this.isOp('*')) { this.pos++; l = this.arith(l, this.unary(), '*') }
      else if (this.isOp('/')) { this.pos++; l = this.arith(l, this.unary(), '/') }
      else if (this.isOp('%')) { this.pos++; l = this.arith(l, this.unary(), '%') }
      else return l
    }
  }

  private str(v: Val): string {
    if (v.t === 'b') return v.v ? 'true' : 'false'
    if (v.t === 'i') return String(v.v)
    if (v.t === 'd') return String(Number(v.v.toPrecision(6)))
    if (v.t === 's') return v.v
    return ''
  }

  private num(v: Val): number {
    if (v.t !== 'i' && v.t !== 'd') throw new ConditionError('not a numeric type')
    return v.v
  }

  private arith(l: Val, r: Val, op: string): Val {
    if (l.t === 'skip' || r.t === 'skip') return SKIP
    if (op === '+') {
      if (l.t === 's') return { t: 's', v: l.v + this.str(r) }
      if (r.t === 's') return { t: 's', v: this.str(l) + r.v }
    }
    const a = this.num(l)
    const b = this.num(r)
    const real = l.t === 'd' || r.t === 'd'
    const out = (v: number): Val => (real ? { t: 'd', v } : { t: 'i', v: Math.trunc(v) })
    switch (op) {
      case '+': return out(a + b)
      case '-': return out(a - b)
      case '*': return out(a * b)
      case '/': if (b === 0) throw new ConditionError('division by zero'); return out(a / b)
      default: if (b === 0) throw new ConditionError('division by zero'); return out(a % b)
    }
  }

  private compare(l: Val, r: Val, op: '=' | '<' | '>', invert: boolean): Val {
    if (l.t === 'skip' || r.t === 'skip') return SKIP
    if ((l.t === 'i' || l.t === 'd') && (r.t === 'i' || r.t === 'd')) {
      const real = l.t === 'd' || r.t === 'd'
      const v = op === '=' ? (real ? Math.abs(l.v - r.v) < 1e-8 : l.v === r.v) : op === '<' ? l.v < r.v : l.v > r.v
      return { t: 'b', v: invert ? !v : v }
    }
    if (l.t === 'b' && r.t === 'b') {
      if (op !== '=') throw new ConditionError('cannot compare the types')
      return { t: 'b', v: invert ? l.v !== r.v : l.v === r.v }
    }
    if (l.t === 's' || r.t === 's') {
      const a = this.str(l)
      const b = this.str(r)
      const v = op === '=' ? a === b : op === '<' ? a < b : a > b
      return { t: 'b', v: invert ? !v : v }
    }
    throw new ConditionError('cannot compare the types')
  }

  private regex(l: Val, pattern: string, invert: boolean): Val {
    if (l.t === 'skip') return l
    if (l.t !== 's') throw new ConditionError('the left side of a regular expression match must be a string')
    return { t: 'b', v: matchWhole(l.v, pattern) !== invert }
  }

  private variable(): Val {
    const t = this.peek() as Tok & { k: 'id' }
    this.pos++
    if (this.skipping > 0 && !this.isOp('[')) {
      // Still resolve the name so a typo in a live branch is not hidden, but tolerate it in a skipped one.
    }
    const opt = readOpt(t.v, this.config, this.extra)
    if (!opt) {
      if (this.skipping > 0) { this.skipIndex(); return SKIP }
      throw new ConditionError(`not a variable name: ${t.v}`)
    }
    let index = -1
    if (this.eatOp('[')) {
      const iv = this.additive()
      this.expectOp(']')
      if (iv.t === 'skip') index = 0
      else if (iv.t !== 'i' && iv.t !== 'd') throw new ConditionError('index is not a number')
      else index = Math.trunc(iv.v)
      if (index < 0) index = 0
    }
    return this.guard(() => this.read(opt, index, t.v), SKIP)
  }

  private skipIndex(): void {
    if (this.eatOp('[')) { this.additive(); this.expectOp(']') }
  }

  private read(opt: Opt, index: number, name: string): Val {
    if (!opt.vector) return opt.value
    if (opt.items.length === 0) throw new ConditionError(`indexing an empty vector variable ${name}`)
    if (index < 0) {
      if (!opt.float) throw new ConditionError(`referencing a vector variable when scalar is expected: ${name}`)
      return opt.items[0] as Val
    }
    return (opt.items[index >= opt.items.length ? 0 : index]) as Val
  }

  private ref(): { name: string; opt: Opt | undefined; index: number } {
    const t = this.peek()
    if (!t || t.k !== 'id' || KEYWORDS.has(t.v)) throw new ConditionError('expected a variable name')
    this.pos++
    let index = -1
    if (this.eatOp('[')) {
      const iv = this.additive()
      this.expectOp(']')
      index = iv.t === 'i' || iv.t === 'd' ? Math.max(0, Math.trunc(iv.v)) : 0
    }
    const opt = readOpt(t.v, this.config, this.extra)
    if (!opt && this.skipping === 0) throw new ConditionError(`not a variable name: ${t.v}`)
    return { name: t.v, opt, index }
  }

  private unary(): Val {
    const t = this.peek()
    if (!t) throw new ConditionError('unexpected end of the expression')
    if (t.k === 'num') { this.pos++; return this.skipping > 0 ? SKIP : t.int ? { t: 'i', v: t.v } : { t: 'd', v: t.v } }
    if (t.k === 'str') { this.pos++; return this.skipping > 0 ? SKIP : { t: 's', v: t.v } }
    if (t.k === 're') throw new ConditionError('unexpected regular expression')
    if (t.k === 'op') {
      if (t.v === '(') {
        this.pos++
        const v = this.ternary()
        this.expectOp(')')
        return v
      }
      if (t.v === '-') {
        this.pos++
        const v = this.unary()
        if (v.t === 'skip') return v
        if (v.t !== 'i' && v.t !== 'd') throw new ConditionError('cannot apply unary minus')
        return { t: v.t, v: -v.v }
      }
      if (t.v === '+') { this.pos++; return this.unary() }
      if (t.v === '!') { this.pos++; return this.not(this.unary()) }
      throw new ConditionError(`unexpected ${t.v}`)
    }
    // identifier or keyword
    switch (t.v) {
      case 'not': this.pos++; return this.not(this.unary())
      case 'true': this.pos++; return this.skipping > 0 ? SKIP : { t: 'b', v: true }
      case 'false': this.pos++; return this.skipping > 0 ? SKIP : { t: 'b', v: false }
      case 'min': case 'max': {
        this.pos++
        this.expectOp('(')
        const a = this.ternary()
        this.expectOp(',')
        const b = this.ternary()
        this.expectOp(')')
        if (a.t === 'skip' || b.t === 'skip') return SKIP
        const x = this.num(a)
        const y = this.num(b)
        const v = t.v === 'min' ? Math.min(x, y) : Math.max(x, y)
        return a.t === 'd' || b.t === 'd' ? { t: 'd', v } : { t: 'i', v }
      }
      case 'int': case 'round': case 'ceil': case 'floor': {
        this.pos++
        this.expectOp('(')
        const a = this.ternary()
        this.expectOp(')')
        if (a.t === 'skip') return a
        const x = this.num(a)
        return { t: 'i', v: Math.trunc(t.v === 'int' ? x : t.v === 'round' ? Math.round(Math.abs(x)) * Math.sign(x) : t.v === 'ceil' ? Math.ceil(x) : Math.floor(x)) }
      }
      case 'is_nil': {
        this.pos++
        this.expectOp('(')
        this.ref()
        this.expectOp(')')
        // Nothing the compatibility checks read is nullable, so no value is nil.
        return this.skipping > 0 ? SKIP : { t: 'b', v: false }
      }
      case 'empty': case 'size': {
        this.pos++
        this.expectOp('(')
        const r = this.ref()
        this.expectOp(')')
        if (!r.opt) return SKIP
        const n = r.opt.vector ? r.opt.items.length : 1
        return t.v === 'empty' ? { t: 'b', v: n === 0 } : { t: 'i', v: n }
      }
      case 'one_of': {
        this.pos++
        this.expectOp('(')
        const m = this.unary()
        let hit = false
        while (this.eatOp(',')) {
          if (this.isOp(')')) break
          const p = this.peek()
          if (p && p.k === 're') {
            this.pos++
            if (m.t !== 'skip' && !hit) {
              if (m.t !== 's') throw new ConditionError('one_of(): the first parameter has to be a string')
              hit = matchWhole(m.v, p.v)
            }
          } else if (this.eatOp('~')) {
            const pv = this.unary()
            if (m.t !== 'skip' && !hit) {
              if (m.t !== 's' || pv.t !== 's') throw new ConditionError('one_of(): the parameters have to be strings')
              hit = matchWhole(m.v, pv.v)
            }
          } else {
            const pv = this.unary()
            if (m.t !== 'skip' && !hit) {
              if (m.t !== 's' || pv.t !== 's') throw new ConditionError('one_of(): the parameters have to be strings')
              hit = m.v === pv.v
            }
          }
        }
        this.expectOp(')')
        return m.t === 'skip' ? m : { t: 'b', v: hit }
      }
      default:
        if (KEYWORDS.has(t.v)) throw new ConditionError(`unsupported keyword ${t.v}`)
        return this.variable()
    }
  }

  private not(v: Val): Val {
    if (v.t === 'skip') return v
    if (v.t !== 'b') throw new ConditionError('cannot apply a not operator')
    return { t: 'b', v: !v.v }
  }
}

function matchWhole(subject: string, pattern: string): boolean {
  let re: RegExp
  try {
    re = new RegExp(`^(?:${pattern})$`, 's')
  } catch {
    throw new ConditionError('regular expression compilation failed')
  }
  return re.test(subject)
}

/**
 * Evaluate a boolean condition against a config (`extra` is checked first, as Orca's config override is). Throws
 * ConditionError on a syntax or runtime error; the compatibility check treats that as "compatible".
 */
export function evaluateCondition(expression: string, config: PrintConfig | Record<string, unknown>, extra?: Record<string, unknown>): boolean {
  return new Parser(lex(expression), config as Record<string, unknown>, extra).parse()
}
