// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What mimir remembers about the person: their printers, filaments, preferences, sizes and what worked, as short
// notes they approved. Notes stay on their computer, one set per edition (the host's MemoryStore). No secret is ever
// kept: a note that looks like a key, token, access code or serial is refused. A chat reads only the notes that fit
// its budget, the ones about what the question names first.
import { SECRET_PATTERNS } from '@slicerx/edition-config'

export const MEMORY_KINDS = ['printer', 'filament', 'preference', 'outcome', 'size'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export type MemoryFact = { id: string; kind: MemoryKind; text: string; data?: Record<string, string | number>; updatedAt: number }

/** Where the notes live. The app keeps one IndexedDB database per edition (packages/app/src/pilot-connect/memory-store.ts). */
export interface MemoryStore {
  list(): Promise<MemoryFact[]>
  put(f: MemoryFact): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

// The edition config's own secret checks, plus what a printer connection holds: a LAN access code, a serial number,
// and keys or tokens named as such. A named value needs a digit, so "the access code is in Settings" stays a note.
const NOTE_SECRETS: RegExp[] = [
  ...SECRET_PATTERNS.map(([re]) => re),
  /\b(?:access|lan|pairing)[\s_-]*(?:code|key)\b\W*(?:is\W+)?(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,}/i,
  /\b(?:serial(?:\s*(?:number|no\.?))?|s\/n)\b\W*(?:is\W+)?(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}/i,
  // Bambu Lab printers: 15 characters, starting 0 and a digit (01P00A..., 03919C...)
  /\b0\d[A-Z0-9]{13}\b/,
  /\b(?:api[\s_-]*key|token|password|secret)\b\W*(?:is\W+)?(?=\S*\d)\S{8,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:gh[pousr]|xox[abp]|AKIA)[A-Za-z0-9_-]{12,}/,
]

/** `text` with anything that looks like a secret cut out, and whether there was one: a note with a secret is never saved. */
export function redactSecrets(text: string): { text: string; refused: boolean } {
  let out = text
  let refused = false
  for (const re of NOTE_SECRETS) {
    const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    if (all.test(out)) {
      refused = true
      out = out.replace(all, '[removed]')
    }
  }
  return { text: out, refused }
}

/** A rough token count for budgets: about four characters a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** One note as the model reads it. */
export function factLine(f: MemoryFact): string {
  const data = f.data && Object.keys(f.data).length ? ` (${Object.entries(f.data).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''
  return `- ${f.text}${data}`
}

const STOP = new Set(['the', 'and', 'for', 'with', 'my', 'is', 'it', 'on', 'in', 'of', 'to', 'a', 'an', 'at', 'what', 'why', 'how', 'does', 'do', 'i', 'me', 'this', 'that', 'can', 'should'])

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9.]+/).map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length > 0 && !STOP.has(w)))
}

// with nothing in the question to go on, the person's printers and filaments come before the rest
const KIND_ORDER: Record<MemoryKind, number> = { printer: 0, filament: 1, preference: 2, size: 3, outcome: 4 }

/**
 * The notes a chat reads, within `budgetTokens` (as factLine counts them): the ones sharing the most words with the
 * question first (a printer, filament or size it names), then by kind and the newest. Notes past the budget wait for
 * memory.recall.
 */
export function pickFacts(facts: MemoryFact[], query: string, budgetTokens = 800): MemoryFact[] {
  const asked = words(query)
  const score = (f: MemoryFact): number => {
    const own = words(`${f.text} ${Object.values(f.data ?? {}).join(' ')}`)
    let n = 0
    for (const w of asked) if (own.has(w)) n++
    return n
  }
  const ranked = facts.map((f) => ({ f, s: score(f) })).sort((a, b) => b.s - a.s || KIND_ORDER[a.f.kind] - KIND_ORDER[b.f.kind] || b.f.updatedAt - a.f.updatedAt)
  const out: MemoryFact[] = []
  let used = 0
  for (const { f } of ranked) {
    const cost = estimateTokens(factLine(f))
    if (used + cost > budgetTokens) continue
    used += cost
    out.push(f)
  }
  return out
}
