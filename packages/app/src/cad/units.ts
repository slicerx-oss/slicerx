// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Display units for lengths in Model: mm or in. Data stays in mm everywhere (projects, history, the engine, G-code);
// only what a field shows and how a bare typed number reads change. A typed unit always wins (25.4mm, 1in, 1", 3/8 in,
// 1 1/2"), whatever the setting. Slice print settings stay in mm.
import { evaluate, namesIn, UNIT_MM, withUnit } from './values'

export type LengthUnit = 'mm' | 'in'

export interface UnitPrefs {
  length: LengthUnit
  /** Decimals shown in mm. */
  mmDigits: number
  /** Decimals shown in inches. */
  inchDigits: number
  /** Inches as fractions to this denominator (2 to 64), or 0 for decimals. */
  inchFraction: number
}

export const DEFAULT_UNITS: UnitPrefs = { length: 'mm', mmDigits: 2, inchDigits: 3, inchFraction: 0 }

export const FRACTIONS = [0, 8, 16, 32, 64] as const

/** The saved units, or undefined when they don't read. */
export function readUnits(x: unknown): UnitPrefs | undefined {
  if (!x || typeof x !== 'object') return undefined
  const r = x as Record<string, unknown>
  const digits = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6 ? v : undefined)
  const length = r['length'] === 'in' ? 'in' : r['length'] === 'mm' ? 'mm' : undefined
  if (!length) return undefined
  return {
    length,
    mmDigits: digits(r['mmDigits']) ?? DEFAULT_UNITS.mmDigits,
    inchDigits: digits(r['inchDigits']) ?? DEFAULT_UNITS.inchDigits,
    inchFraction: (FRACTIONS as readonly unknown[]).includes(r['inchFraction']) ? (r['inchFraction'] as number) : 0,
  }
}

/** Millimeters per shown unit. */
export const unitMm = (u: Pick<UnitPrefs, 'length'>) => UNIT_MM[u.length]!

/**
 * A length in mm as the shown number, without the unit: mm trimmed to its decimals (12.5), inches to a fixed count
 * (0.500) or a fraction (1 1/2).
 */
/** A readout's length: always the precision's decimals (or its fraction), so a column of them lines up. */
export function fixedLength(mm: number, u: UnitPrefs): string {
  if (!Number.isFinite(mm)) return ''
  if (u.length === 'mm') {
    const t = mm.toFixed(u.mmDigits)
    return Number(t) === 0 ? (0).toFixed(u.mmDigits) : t
  }
  return formatLength(mm, u)
}

export function formatLength(mm: number, u: UnitPrefs): string {
  if (!Number.isFinite(mm)) return ''
  if (u.length === 'mm') return String(Number(mm.toFixed(u.mmDigits)) || 0)
  const v = mm / 25.4
  if (u.inchFraction > 0) return fraction(v, u.inchFraction)
  const t = v.toFixed(u.inchDigits)
  return Number(t) === 0 ? (0).toFixed(u.inchDigits) : t
}

/** `v` to the nearest 1/`den`, reduced: 1 1/2, 3/8, -2. */
export function fraction(v: number, den: number): string {
  const sign = v < 0 ? '-' : ''
  let n = Math.round(Math.abs(v) * den)
  const whole = Math.floor(n / den)
  n -= whole * den
  if (!n) return whole ? `${sign}${whole}` : '0'
  let d = den
  while (n % 2 === 0 && d % 2 === 0) {
    n /= 2
    d /= 2
  }
  return `${sign}${whole ? `${whole} ` : ''}${n}/${d}`
}

/** A length with its unit, for readouts: 12.5 mm, 0.500 in. */
export function lengthText(mm: number, u: UnitPrefs): string {
  return `${formatLength(mm, u)} ${u.length}`
}

/** A typed length in mm: bare numbers in the shown unit, typed units as written, names in mm. NaN when it doesn't read. */
export function parseLength(text: string, u: Pick<UnitPrefs, 'length'>, values: Readonly<Record<string, number>> = {}): number {
  if (!text.trim()) return NaN
  try {
    return evaluate(text, (n) => values[n], { bareMm: unitMm(u) })
  } catch {
    return NaN
  }
}

/**
 * Typed text as a field's mm text: a plain mm number when it uses no names, else the text with the shown unit
 * written on its bare numbers (wall + 1 in inches is wall + 1in), so a step that follows it reads the same in any
 * unit. Text that doesn't read stays as typed.
 */
export function toMmText(text: string, u: Pick<UnitPrefs, 'length'>, values: Readonly<Record<string, number>> = {}): string {
  const t = text.trim()
  if (!t || u.length === 'mm') return text
  const mm = parseLength(t, u, values)
  if (!Number.isFinite(mm)) return text
  if (namesIn(t).length) return withUnit(t, u.length, (n) => values[n])
  return String(mm)
}

/** A field's mm text as it shows: a plain number in the shown unit, an expression as written. */
export function fromMmText(text: string, u: UnitPrefs): string {
  const t = text.trim()
  if (!t || u.length === 'mm') return text
  const v = Number(t.replace(',', '.'))
  return Number.isFinite(v) ? formatLength(v, u) : text
}
