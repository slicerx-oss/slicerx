// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finds the records of the standard parts table a request names: "608", "608ZZ bearing", "NEMA17 motor", "M3 screw
// clearance hole", "Raspberry Pi 4". A record matches when one of its names (id, name or an alias) appears whole in the
// request, word for word; the longest such name wins, so "M3 heat-set insert" picks the insert over the M3 screw hole.
// When nothing matches, the nearest records come back instead, so the caller can ask which one was meant.
import type { PartCategory, PartRecord, PartsTable } from './table'

/**
 * Words of a name or request, lowercase. A run of two or more letters is split from the digits next to it
 * ("NEMA17" and "NEMA 17", "1kg" and "1 kg", "608ZZ" and "608 ZZ" read the same); a single letter stays with its
 * number ("M3", "M2.5x0.45").
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z]{2,})(?=\d)/g, '$1 ')
    .replace(/(\d)(?=[a-z]{2,})/g, '$1 ')
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
}

/** "m3x10" also reads as "m3": a screw named with its length is still that screw size. */
function expand(ws: string[]): string[][] {
  const alt = ws.map((w) => w.replace(/^(m\d+(?:\.\d+)?)x\d+(?:\.\d+)?$/, '$1'))
  return alt.some((w, i) => w !== ws[i]) ? [ws, alt] : [ws]
}

function contains(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

const names = (r: PartRecord): string[] => [r.id, r.name, ...r.aliases]

/** True when a category is named by `text`: its id ("raspberry-pi") or one of its words ("bearing"). */
function namesCategory(c: PartCategory, ws: string[]): boolean {
  return [c.id, ...c.words].some((n) => contains(ws, words(n)))
}

export interface PartMatch {
  record: PartRecord
  /** The record name found in the request. */
  matched: string
  /** How many words that name has: the longer, the more specific. */
  score: number
}

export interface PartNear {
  category: string
  id: string
  name: string
}

export type PartLookup =
  | { found: true; matches: PartMatch[] }
  | { found: false; nearest: PartNear[]; categories: string[] }

/** The categories `category` names: by id, singular or plural ("bearing", "bearings"), or one of the category's words. */
export function categoriesFor(table: PartsTable, category: string): PartCategory[] {
  const ws = words(category)
  const singular = (s: string) => s.replace(/s$/, '')
  return table.categories.filter((c) => singular(c.id) === singular(ws.join('-')) || namesCategory(c, ws))
}

/**
 * Looks up `query` in `table`, within `category` when given. A name made only of digits ("608", "6000") counts only
 * when it is the whole request, a category is given, or the request names its category ("608 bearing"), so a
 * "6000 mAh battery" is not a 6000 bearing.
 */
export function matchParts(table: PartsTable, query: string, category?: string): PartLookup {
  const cats = category ? categoriesFor(table, category) : table.categories
  const inCats = new Set(cats.map((c) => c.id))
  const pool = table.records.filter((r) => inCats.has(r.category))
  // with a category given, "M3" in heat-set-inserts also reads as "M3 insert"
  const forms = [...expand(words(query)), ...(category ? cats.flatMap((c) => c.words.map((w) => words(`${query} ${w}`))) : [])]
  const named = new Set(table.categories.filter((c) => forms.some((ws) => namesCategory(c, ws))).map((c) => c.id))
  const best = new Map<PartRecord, PartMatch>()
  for (const r of pool) {
    for (const n of names(r)) {
      const nw = words(n)
      if (!forms.some((ws) => contains(ws, nw))) continue
      const numeric = nw.every((w) => /^\d+$/.test(w))
      if (numeric && !(category || named.has(r.category) || forms.some((ws) => ws.length === nw.length))) continue
      const whole = forms.some((ws) => ws.join(' ') === nw.join(' '))
      const score = nw.length + (whole ? 0.5 : 0) + (named.has(r.category) ? 0.25 : 0)
      const had = best.get(r)
      if (!had || score > had.score) best.set(r, { record: r, matched: n, score })
    }
  }
  const hits = [...best.values()].sort((a, b) => b.score - a.score)
  const top = hits[0]?.score
  if (top !== undefined) return { found: true, matches: hits.filter((h) => h.score === top) }
  return { found: false, nearest: nearest(pool, forms[0] ?? [], named), categories: [...named] }
}

/** Levenshtein distance, for near misses such as "6080" or "nema 71". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]!
}

/** The records closest to a request nothing matched: shared words first, then spelling, then the named category. */
function nearest(pool: PartRecord[], ws: string[], named: Set<string>, limit = 5): PartNear[] {
  const q = new Set(ws)
  const compact = ws.join('')
  const scored = pool.map((r) => {
    let s = 0
    for (const n of names(r)) {
      const nw = words(n)
      const shared = nw.filter((w) => q.has(w)).length / nw.length
      const close = compact ? 1 - distance(compact, nw.join('')) / Math.max(compact.length, nw.join('').length) : 0
      s = Math.max(s, shared + Math.max(0, close) * 0.5)
    }
    if (named.has(r.category)) s += 0.5
    return { r, s }
  })
  return scored
    .filter((x) => x.s > 0.35)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ r }) => ({ category: r.category, id: r.id, name: r.name }))
}
