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

// The edition config's own secret checks, plus what a printer connection holds: a whole private key block, a LAN access
// code, a serial number, and keys or tokens named as such. A named value needs a digit, so "the access code is in
// Settings" stays a note. Each named pattern matches the value only (its name sits in a lookbehind), so a note read
// back keeps "access code: [hidden]" and loses only the code.
const NOTE_SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
  ...SECRET_PATTERNS.map(([re]) => re),
  /(?<=\b(?:(?:dev[\s_-]*)?access|lan|pairing)[\s_-]*(?:code|key)\b\W*(?:is\W+)?)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,}/i,
  /(?<=\b(?:serial(?:[\s_-]*(?:number|no\.?))?|s\/?n)\b\W*(?:is\W+)?)(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}/i,
  // a bare "code: 31415926" or "code is 31415926" (not G-code, and "the code is in Settings" stays a note)
  /(?<=(?<![-\w])code\b(?:\s*[:=]\s*|\s+is\s+))(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}/i,
  // Bambu Lab printers: 15 characters, starting 0 and a digit (01P00A..., 03919C...), in either case, or 0 and five
  // more before a letter (the app link's older check)
  /\b0\d[A-Z0-9]{13}\b/i,
  /\b0[0-9A-Z]{2}[0-9A-Z]{2}[A-Z][0-9A-Z]{9}\b/,
  /(?<=\b(?:api[\s_-]*key|token|secret)\b\W*(?:is\W+)?)(?=\S*\d)\S{8,}/i,
  /(?<=\b(?:password|passcode|passwd|pwd)\b\W*(?:is\W+)?)(?=\S*\d)\S{6,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:gh[pousr]|xox[abp]|AKIA)[A-Za-z0-9_-]{12,}/,
]

/**
 * `text` with anything that looks like a secret replaced by `mask`, and whether there was one: a note with a secret is
 * never saved, and one read back (over the app link, say) shows the mask instead.
 */
export function redactSecrets(text: string, mask = '[removed]'): { text: string; refused: boolean } {
  let out = text
  let refused = false
  for (const re of NOTE_SECRETS) {
    const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    if (all.test(out)) {
      refused = true
      all.lastIndex = 0
      out = out.replace(all, mask)
    }
  }
  return { text: out, refused }
}

/** Data names whose values are secrets whatever the value looks like. */
export const SECRET_DATA_KEY = /access[\s_-]?code|lan[\s_-]?code|^code$|serial|^s\/?n$|password|passwd|secret|token|api[\s_-]?key|private[\s_-]?key/i

// "accessCode" read as "access Code", so a name-and-value pattern sees the name
const spaced = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')

/**
 * Whether any part of a note looks like a secret: the text, each data name and value, each name with its value, and a
 * name that always holds one (SECRET_DATA_KEY). A note with one is never saved, synced or sent.
 */
export function secretInNote(n: { text: string; data?: Record<string, string | number> | undefined }): boolean {
  const parts = [n.text]
  for (const [k, v] of Object.entries(n.data ?? {})) {
    if (SECRET_DATA_KEY.test(k)) return true
    parts.push(k, String(v), `${k}: ${v}`, `${spaced(k)}: ${v}`)
  }
  return parts.some((s) => redactSecrets(s).refused)
}

/** How long a note's words may be, in characters, as memory.remember and Settings both take them. */
export const NOTE_MIN = 3
export const NOTE_MAX = 240

/**
 * What stops `text` (already trimmed) becoming a note, the same checks memory.remember makes: a line break or hidden
 * character, the length, then anything that looks like a secret. Null: it can be saved.
 */
export function noteProblem(text: string): 'one-line' | 'short' | 'long' | 'secret' | null {
  if (NOTE_UNSAFE.test(text)) return 'one-line'
  if (text.length < NOTE_MIN) return 'short'
  if (text.length > NOTE_MAX) return 'long'
  return secretInNote({ text }) ? 'secret' : null
}

/** A note's data, as every save takes it: at most this many values, each name and text value on one line and this long. */
export const DATA_MAX_KEYS = 6
export const DATA_NAME_MAX = 40
export const DATA_VALUE_MAX = 80

/**
 * True when a note's data breaks the limits every save holds it to: more than DATA_MAX_KEYS values, a name that is
 * empty, longer than DATA_NAME_MAX or not one line, or a text value longer than DATA_VALUE_MAX or not one line. A
 * number value must be finite.
 */
export function dataProblem(data: Record<string, string | number>): boolean {
  const entries = Object.entries(data)
  if (entries.length > DATA_MAX_KEYS) return true
  return entries.some(([k, v]) => !k.trim() || k.length > DATA_NAME_MAX || NOTE_UNSAFE.test(k) || (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string' || v.length > DATA_VALUE_MAX || NOTE_UNSAFE.test(v)))
}

// Unit words a data name may end in (nozzleMm, depth_mm, tempC), as they read after the value.
const DATA_UNITS: Record<string, string> = { mm: 'mm', cm: 'cm', m: 'm', in: 'in', g: 'g', kg: 'kg', c: 'C', f: 'F', deg: 'deg', pct: 'percent', percent: 'percent', s: 's', min: 'min', h: 'h', mms: 'mm/s' }

/**
 * A note's data value as a person reads it: the name, then the value and its unit. nozzleMm 0.4 reads
 * "Nozzle: 0.4 mm", depth_mm 300 reads "Depth: 300 mm", model A1 reads "Model: A1". The chip and Settings both show it.
 */
export function dataLabel(key: string, value: string | number): string {
  const words = oneLine(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')).toLowerCase().split(' ').filter(Boolean)
  const unit = words.length > 1 ? DATA_UNITS[words.at(-1)!] : undefined
  const name = (unit ? words.slice(0, -1) : words).join(' ')
  const shown = name.charAt(0).toUpperCase() + name.slice(1)
  return `${shown}: ${oneLine(value)}${unit ? ` ${unit}` : ''}`
}

/** A rough token count for budgets: about four characters a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * Characters a note may not hold: line breaks and other control characters (C0, C1 with U+0085), the line and
 * paragraph separators, zero-width marks (with the word joiner U+2060 and U+FEFF) and bidi controls (with the Arabic
 * letter mark U+061C). Any of them could start a new line or hide text in the chat context, so a note could pass
 * itself off as a section of its own.
 */
export const NOTE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/
const UNSAFE_RUN = new RegExp(`(?:\\s|${NOTE_UNSAFE.source})+`, 'g')

/** `text` on one line: every run of spaces, line breaks and unsafe characters becomes one space. */
export const oneLine = (text: string | number): string => String(text).replace(UNSAFE_RUN, ' ').trim()

/** One note as the model reads it, always a single line, whatever the store holds. */
export function factLine(f: MemoryFact): string {
  const data = f.data && Object.keys(f.data).length ? ` (${Object.entries(f.data).map(([k, v]) => `${oneLine(k)}: ${oneLine(v)}`).join(', ')})` : ''
  return `- ${oneLine(f.text)}${data}`
}

const STOP = new Set(['the', 'and', 'for', 'with', 'my', 'is', 'it', 'on', 'in', 'of', 'to', 'a', 'an', 'at', 'what', 'why', 'how', 'does', 'do', 'i', 'me', 'this', 'that', 'can', 'should'])

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9.]+/).map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length > 0 && !STOP.has(w)))
}

// with nothing in the question to go on, the person's printers and filaments come before the rest
const KIND_ORDER: Record<MemoryKind, number> = { printer: 0, filament: 1, preference: 2, size: 3, outcome: 4 }

// What the notes block costs around the notes themselves: its label and end line in contextMessage (prompt.ts).
const NOTES_FRAME_TOKENS = 80

/**
 * The notes a chat reads, within `budgetTokens` (the block's label and end line, then each factLine and its line
 * break): the ones sharing the most words with the
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
  let used = NOTES_FRAME_TOKENS
  for (const { f } of ranked) {
    const cost = estimateTokens(`${factLine(f)}\n`)
    if (used + cost > budgetTokens) continue
    used += cost
    out.push(f)
  }
  return out
}
