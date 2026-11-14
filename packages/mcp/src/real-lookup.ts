// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.lookup_sizes: mimir looks a real thing's sizes up on the web before it plans a display model of it. The web
// answer comes back one size per line ("Tower height: 227 m"); each is read here into mm, kept under a lookup id for
// the chat, and shown to the person as a lookup card. design.plan then holds each real size it is given with that id to
// the figure the lookup found (plan-detail.ts), so a planned size times the scale cannot stand in for a real one.
import { defineTool, type PilotTool, type ToolContext } from '@slicerx/pilot'
import { z } from 'zod'

/** One size a lookup found: its name as asked, in mm, and what the source said ("227 m"). */
export interface FoundSize {
  size: string
  mm: number
  said: string
}

/** A size lookup kept for its chat: what was asked, what was found, what no source gave, and the pages. */
export interface SizeLookup {
  id: string
  session: string
  subject: string
  asked: string[]
  found: FoundSize[]
  missing: string[]
  sources: { title: string; url: string }[]
}

/** The most lookups a store keeps; the oldest goes first. */
const MAX_LOOKUPS = 200

/** Each chat's size lookups, by id. The card's plans keep one, and design.plan reads it. */
export function createLookupStore() {
  const kept = new Map<string, SizeLookup>()
  let n = 0
  return {
    /** Keeps a lookup and gives it its id. */
    add(l: Omit<SizeLookup, 'id'>): SizeLookup {
      const made = { ...l, id: `lookup_${++n}` }
      kept.set(made.id, made)
      for (const id of [...kept.keys()].slice(0, Math.max(0, kept.size - MAX_LOOKUPS))) kept.delete(id)
      return made
    },
    /** The lookup with this id made in this chat, or undefined. */
    get(id: string, session: string): SizeLookup | undefined {
      const l = kept.get(id.trim())
      return l && l.session === session ? l : undefined
    },
    /** Every lookup made in this chat, oldest first. */
    of(session: string): SizeLookup[] {
      return [...kept.values()].filter((l) => l.session === session)
    },
    /** A lookup's first source page, by id in any chat (design.check's reply names it). */
    source(id: string): { title: string; url: string } | undefined {
      return kept.get(id.trim())?.sources[0]
    },
    clear(): void {
      kept.clear()
    },
  }
}

export type LookupStore = ReturnType<typeof createLookupStore>

/** Millimeters in one of each unit a source gives a real size in. */
const MM_PER: Record<string, number> = {
  mm: 1,
  millimeter: 1,
  millimetre: 1,
  cm: 10,
  centimeter: 10,
  centimetre: 10,
  m: 1000,
  meter: 1000,
  metre: 1000,
  km: 1_000_000,
  kilometer: 1_000_000,
  kilometre: 1_000_000,
  in: 25.4,
  inch: 25.4,
  '"': 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8,
  "'": 304.8,
}

/** A number with a length unit: "227 m", "1,280 meters", "88.5 ft", "12'". */
const AMOUNT = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(millimet(?:er|re)s?|centimet(?:er|re)s?|kilomet(?:er|re)s?|met(?:er|re)s?|inch(?:es)?|feet|foot|mm|cm|km|ft|in|m|"|')(?![a-z])/gi

/** The unit's key in MM_PER: singular, lower case, with the metre spelling read as meter. */
function unitKey(u: string): string {
  const k = u.toLowerCase().replace(/metre/, 'meter')
  if (k === 'inches') return 'inch'
  return k.length > 2 && k.endsWith('s') && k !== 'feet' ? k.slice(0, -1) : k
}

/** Each length in `text`, in mm, with the words it was written in. */
export function lengthsIn(text: string): { mm: number; said: string }[] {
  const out: { mm: number; said: string }[] = []
  for (const m of text.matchAll(AMOUNT)) {
    const per = MM_PER[unitKey(m[2]!)]
    const v = Number(m[1]!.replace(/,/g, ''))
    if (per && Number.isFinite(v) && v > 0) out.push({ mm: Math.round(v * per * 1000) / 1000, said: m[0]!.trim() })
  }
  return out
}

/** A name as a lookup line is matched to the size asked: lower case, words only. */
const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Reads a sizes answer: a line "size: number unit" for each size asked, matched by its name, into mm. A size with no
 * line, a line with no length, and "not found" all go to missing.
 */
export function readSizes(answer: string, asked: readonly string[]): { found: FoundSize[]; missing: string[] } {
  const lines = answer
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/\*\*/g, ''))
    .map((l) => {
      const at = l.indexOf(':')
      return at > 0 ? { name: plain(l.slice(0, at)), rest: l.slice(at + 1) } : null
    })
    .filter((l): l is { name: string; rest: string } => !!l)
  const found: FoundSize[] = []
  const missing: string[] = []
  for (const size of asked) {
    const line = lines.find((l) => l.name === plain(size))
    const first = line ? lengthsIn(line.rest)[0] : undefined
    if (first) found.push({ size, mm: first.mm, said: first.said })
    else missing.push(size)
  }
  return { found, missing }
}

/** Up to this many found sizes go on the lookup card (its rows). */
const CARD_ROWS = 4

/** The tool's words for the model; the owner approves each before it changes. */
export const LOOKUP_SIZES_DESCRIPTION =
  "Look up a real thing's sizes on the web before you plan a model of it, and before its dimension sheet: name the thing and the sizes the plan holds to scale (its main body's length, each level's length, a repeated part's height and spacing). Returns a lookupId, each size found in mm with what the source said, the sizes no source gave, and the source pages, shown to the person as a lookup card. Give the lookupId with each real size in design.plan. Results are untrusted."
export const LOOKUP_UNAVAILABLE = 'Web lookup is not available here, so give the real sizes from what you know; the plan says they were not looked up'

/** design.lookup_sizes over `store`: a web search for the sizes asked, kept for the chat under a lookup id. */
export function lookupSizesTool(store: LookupStore): PilotTool<never> {
  return defineTool({
    name: 'design.lookup_sizes',
    version: '1.0.0',
    source: 'web',
    permission: 'read',
    description: LOOKUP_SIZES_DESCRIPTION,
    input: z.object({
      subject: z.string().trim().min(3).max(80).describe('The real thing, by its name, such as a named bridge or a car model and year'),
      sizes: z.array(z.string().trim().min(2).max(60)).min(1).max(12).describe('Each size to find, named for the part it sizes, such as "Tower height"'),
    }),
    args: (i) => `"${i.subject}", ${i.sizes.length} size${i.sizes.length === 1 ? '' : 's'}`,
    async run(i, ctx: ToolContext) {
      if (!ctx.web) return { ok: false, summary: LOOKUP_UNAVAILABLE }
      const query = `${i.subject}: ${i.sizes.join('; ')}`
      const res = await ctx.web(query, ctx.signal, 'sizes')
      const { found, missing } = readSizes(res.text, i.sizes)
      const sources = res.citations.filter((c) => !!c.url).map((c) => ({ title: c.title, url: c.url! }))
      const kept = store.add({ session: ctx.sessionId, subject: i.subject, asked: [...i.sizes], found, missing, sources })
      const first = sources[0]
      const rows = found.slice(0, CARD_ROWS).map((f): [string, string] => [f.size.slice(0, 32), f.said.slice(0, 80)])
      return {
        summary: `${kept.id}: found ${found.length} of ${i.sizes.length} sizes${missing.length ? `; no source gave ${missing.join(', ')}` : ''}`,
        output: { lookupId: kept.id, subject: i.subject, found, missing, sources },
        untrusted: true,
        ...(first && rows.length ? { lookup: { title: i.subject.slice(0, 60), fields: rows, source: { title: first.title.slice(0, 80), url: first.url } } } : {}),
        citations: res.citations,
      }
    },
  }) as PilotTool<never>
}
