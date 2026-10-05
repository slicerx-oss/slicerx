// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer profile search for first-run setup (PrinterSetupHost.searchProfiles). It searches SlicerX's own
// printer profiles (profiles.ts) unless the host installs another source with `setProfileProvider`.
import { listPrinterProfiles } from './profiles'

export interface PrinterProfileHit {
  /** The profile id addPrinter takes: the printer catalog's model id. */
  id: string
  vendor: string
  model: string
  /** Nozzle diameters in mm the model supports, ascending. */
  nozzles: number[]
}

/** A list of printers to search, sync or async. */
export type ProfileProvider = () => readonly PrinterProfileHit[] | Promise<readonly PrinterProfileHit[]>

let provider: ProfileProvider | undefined

/** Install (or clear, with undefined) a replacement for the built-in printer profile list. */
export function setProfileProvider(p: ProfileProvider | undefined): void {
  provider = p
}

interface Entry extends PrinterProfileHit {
  hay: string
  words: string[]
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\.(?!\d)/g, ' ').trim()

function entries(list: readonly PrinterProfileHit[]): Entry[] {
  return list.map((p) => {
    const hay = norm(`${p.vendor} ${p.model}`)
    return { id: p.id, vendor: p.vendor, model: p.model, nozzles: [...p.nozzles].sort((a, b) => a - b), hay, words: hay.split(' ') }
  })
}

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length] as number
}

/** How well one query word matches a model: 0 for no match. Exact word, word prefix, substring, then a typo. */
function wordScore(q: string, m: Entry): number {
  if (m.words.includes(q)) return 4
  if (m.words.some((w) => w.startsWith(q))) return 3
  if (m.hay.replace(/ /g, '').includes(q) || m.hay.includes(q)) return 2
  const max = q.length >= 6 ? 2 : q.length >= 4 ? 1 : 0
  if (max === 0) return 0
  for (const w of m.words) if (distance(q, w, max) <= max || distance(q, w.slice(0, q.length), max) <= max) return 1
  return 0
}

/**
 * Fuzzy search over printer models by vendor and model text. Every word of the query must match: as a
 * word, a word start, part of the name or a near typo. Best matches first. An empty query lists every
 * model. A provider that throws gives an empty list, never an error.
 */
export async function searchProfiles(query: string, from: ProfileProvider | undefined = provider): Promise<PrinterProfileHit[]> {
  let list: readonly PrinterProfileHit[]
  try {
    list = from ? await from() : listPrinterProfiles()
  } catch {
    return []
  }
  const words = norm(query).split(' ').filter(Boolean)
  const scored: { m: Entry; score: number }[] = []
  for (const m of entries(list)) {
    let score = 0
    let ok = true
    for (const w of words) {
      const s = wordScore(w, m)
      if (s === 0) { ok = false; break }
      score += s
    }
    if (ok) scored.push({ m, score })
  }
  scored.sort((a, b) => b.score - a.score || `${a.m.vendor} ${a.m.model}`.localeCompare(`${b.m.vendor} ${b.m.model}`, 'en', { numeric: true }))
  return scored.map(({ m }) => ({ id: m.id, vendor: m.vendor, model: m.model, nozzles: m.nozzles }))
}
