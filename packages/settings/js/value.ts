// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Conversion between Orca's string-typed JSON and typed PrintConfig values.
import type { SettingDef, SettingType, SettingValue } from '@slicerx/contracts/settings'

export const NIL = 'nil'

export type Coerced = { ok: true; value: SettingValue } | { ok: false } | { ok: 'nil' }

const VECTOR_BASE: Partial<Record<SettingType, SettingType>> = {
  floats: 'float',
  ints: 'int',
  bools: 'bool',
  percents: 'percent',
  floatsOrPercents: 'floatOrPercent',
  enums: 'enum',
  strings: 'string',
  points: 'point',
  pointsGroups: 'points',
}

/** The number list types a project may store with an extruder's value unset. */
const PER_EXTRUDER_LIST: ReadonlySet<SettingType> = new Set<SettingType>(['floats', 'ints', 'percents', 'floatsOrPercents'])

/** The scalar number types a project may store one value per extruder. */
const PER_EXTRUDER_SCALAR: ReadonlySet<SettingType> = new Set<SettingType>(['float', 'int', 'percent', 'floatOrPercent'])

export function isVectorType(t: SettingType): boolean {
  return t in VECTOR_BASE
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return undefined
    return Number(t)
  }
  if (typeof raw === 'boolean') return raw ? 1 : 0
  return undefined
}

function parsePoint(raw: unknown): [number, number] | undefined {
  if (Array.isArray(raw) && raw.length === 2) {
    const a = parseNumber(raw[0])
    const b = parseNumber(raw[1])
    return a === undefined || b === undefined ? undefined : [a, b]
  }
  if (typeof raw !== 'string') return undefined
  const parts = raw.split(/[xX,]/)
  if (parts.length !== 2) return undefined
  const a = parseNumber(parts[0])
  const b = parseNumber(parts[1])
  return a === undefined || b === undefined ? undefined : [a, b]
}

function scalar(base: SettingType, raw: unknown): SettingValue | undefined {
  switch (base) {
    case 'float': {
      return parseNumber(raw)
    }
    case 'int': {
      const n = parseNumber(raw)
      return n === undefined ? undefined : Math.trunc(n)
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw
      if (raw === 1 || raw === '1' || raw === 'true') return true
      if (raw === 0 || raw === '0' || raw === 'false') return false
      return undefined
    }
    case 'percent': {
      if (typeof raw === 'string' && raw.trim().endsWith('%')) return parseNumber(raw.trim().slice(0, -1))
      return parseNumber(raw)
    }
    case 'floatOrPercent': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : undefined
      if (typeof raw !== 'string') return undefined
      const t = raw.trim()
      const body = t.endsWith('%') ? t.slice(0, -1) : t
      return parseNumber(body) === undefined ? undefined : t
    }
    case 'enum':
    case 'string':
    case 'gcode':
      return typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined
    case 'point':
      return parsePoint(raw)
    default:
      return undefined
  }
}

/** Read one Orca JSON value as the schema type. `nil` on a nullable key means "not set". */
export function coerce(def: SettingDef, raw: unknown): Coerced {
  const vec = VECTOR_BASE[def.type]
  if (raw === NIL) return { ok: 'nil' }
  if (vec === undefined) {
    // A scalar key stored as a one-element list by newer profiles: take the first entry. A number key stored per
    // extruder, as a list or as the comma-separated text of a project's object settings ("50,nil"), reads as the first
    // extruder's value; `nil` there leaves it unset.
    const first = typeof raw === 'string' && PER_EXTRUDER_SCALAR.has(def.type) && raw.includes(',') ? raw.split(',')[0]!.trim() : raw
    const src = Array.isArray(first) ? first[0] : first
    if (typeof src === 'string' && src.trim() === NIL) return { ok: 'nil' }
    const v = scalar(def.type, src)
    return v === undefined ? { ok: false } : { ok: true, value: v }
  }
  // Older files store lists as one comma separated string, such as "0,0".
  // A polygon may be one string of points, such as "0x0,220x0,220x220,0x220".
  const oneString = def.type === 'points' && typeof raw === 'string' && /x/i.test(raw)
  const list: unknown[] = Array.isArray(raw) ? [...raw] : oneString ? (raw as string).split(',').map((x) => x.trim()) : typeof raw === 'string' && vec !== 'point' && vec !== 'string' && vec !== 'enum' && raw.includes(',') ? raw.split(',').map((x) => x.trim()) : [raw]
  if (def.type === 'pointsGroups') {
    const groups: [number, number][][] = []
    for (const g of list) {
      // Orca stores each polygon as one comma separated string, such as "0x0,325x0,325x320,0x320".
      const items: unknown[] | undefined = Array.isArray(g) ? g : typeof g === 'string' ? g.split(',').map((x) => x.trim()) : undefined
      if (!items) return { ok: false }
      const pts: [number, number][] = []
      for (const p of items) {
        const pt = parsePoint(p)
        if (!pt) return { ok: false }
        pts.push(pt)
      }
      groups.push(pts)
    }
    return { ok: true, value: groups }
  }
  if (list.includes(NIL)) {
    // A `nil` entry is an extruder's value left unset. A number list whose first entry is set (a project's object
    // settings for a printer with two extruders, "50,nil") reads with each unset entry as the one before it, as the
    // engine reads it; any other list with a `nil` entry is left out whole, to be taken from the other profile.
    if (!PER_EXTRUDER_LIST.has(def.type) || list[0] === NIL) return { ok: 'nil' }
    for (let i = 1; i < list.length; i++) if (list[i] === NIL) list[i] = list[i - 1]
  }
  const out: unknown[] = []
  for (const item of list) {
    const v = scalar(vec, item)
    if (v === undefined) return { ok: false }
    out.push(v)
  }
  return { ok: true, value: out as SettingValue }
}

function toOrcaScalar(base: SettingType, v: unknown): string | undefined {
  switch (base) {
    case 'bool':
      return v === true ? '1' : v === false ? '0' : undefined
    case 'percent':
      return typeof v === 'number' ? String(v) + '%' : undefined
    case 'float':
    case 'int':
      return typeof v === 'number' ? String(v) : undefined
    case 'point':
      return Array.isArray(v) && v.length === 2 ? `${String(v[0])}x${String(v[1])}` : undefined
    default:
      return typeof v === 'string' ? v : undefined
  }
}

/** The inverse of `coerce`: Orca's string form for a value. */
export function toOrca(def: SettingDef, value: SettingValue): unknown {
  const vec = VECTOR_BASE[def.type]
  if (vec === undefined) return toOrcaScalar(def.type, value) ?? String(value)
  if (def.type === 'pointsGroups') return (value as [number, number][][]).map((g) => g.map((p) => `${p[0]}x${p[1]}`))
  return (value as unknown[]).map((x) => toOrcaScalar(vec, x) ?? String(x))
}
