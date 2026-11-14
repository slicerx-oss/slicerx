// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.lookup_sizes: mimir looks a real thing's sizes up on the web before it plans a display model of it. The web
// answer comes back one size per line ("Tower height: 227 m"); each is read here into mm, kept under a lookup id for
// the chat, and shown to the person as a lookup card. design.plan then holds each real size it is given with that id to
// the figure the lookup found (plan-detail.ts), so a planned size times the scale cannot stand in for a real one. An
// answer that ran no search finds nothing: its sizes are from memory, as when no source gave them. Its sources are the
// pages its answer cites; a search that ran with none cited keeps its sizes, and the card links no page.
import { defineTool, type PilotTool, type ToolContext } from '@slicerx/pilot'
import { z } from 'zod'

/** One size a lookup found: its name as asked, in mm, and what the source said ("227 m"). */
export interface FoundSize {
  size: string
  mm: number
  said: string
}

/** A size lookup kept for its chat: what was asked, what was found, what no source gave, the pages its answer cites, and whether a search ran. */
export interface SizeLookup {
  id: string
  session: string
  subject: string
  asked: string[]
  found: FoundSize[]
  missing: string[]
  sources: { title: string; url: string }[]
  searched: boolean
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
    /**
     * By id in any chat, a lookup whose search ran, with the first page its answer cites (design.check's reply names
     * it); undefined for a lookup that ran no search, whose sizes are from memory.
     */
    source(id: string): { page?: { title: string; url: string } } | undefined {
      const l = kept.get(id.trim())
      if (!l?.searched) return undefined
      return l.sources[0] ? { page: l.sources[0] } : {}
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

/** Metric units: a line that gives a figure both ways is read by its metric one, as the source wrote it. */
const METRIC = new Set(['mm', 'millimeter', 'cm', 'centimeter', 'm', 'meter', 'km', 'kilometer'])

/**
 * The figure a line gives, in mm: its first metric length, or else its first imperial one, feet and inches read
 * together ("412 ft 6 in"). Undefined when it gives none.
 */
export function figureIn(text: string): { mm: number; said: string } | undefined {
  const hits = [...text.matchAll(AMOUNT)].flatMap((m) => {
    const unit = unitKey(m[2]!)
    const per = MM_PER[unit]
    const v = Number(m[1]!.replace(/,/g, ''))
    return per && Number.isFinite(v) && v > 0 ? [{ unit, per, v, at: m.index!, end: m.index! + m[0]!.length, said: m[0]!.trim() }] : []
  })
  const round = (mm: number): number => Math.round(mm * 1000) / 1000
  const metric = hits.find((h) => METRIC.has(h.unit))
  if (metric) return { mm: round(metric.v * metric.per), said: metric.said }
  const first = hits[0]
  if (!first) return undefined
  // feet then inches with only space between: one length
  const next = hits[1]
  if (next && first.per === MM_PER['ft'] && next.per === MM_PER['in'] && !text.slice(first.end, next.at).trim())
    return { mm: round(first.v * first.per + next.v * next.per), said: text.slice(first.at, next.end).trim() }
  return { mm: round(first.v * first.per), said: first.said }
}

/** Words that name the way a size measures; a size's name is read by the last of these it has. */
const SIZE_NOUNS = new Set(['length', 'width', 'beam', 'breadth', 'height', 'depth', 'diameter', 'radius', 'spacing', 'pitch', 'span', 'thickness', 'draft', 'draught', 'tall', 'long', 'wide'])
/** A size's name ends its own words at one of these: "Tower height above the roof" is a tower's height. */
const AFTER = new Set(['above', 'below', 'of', 'at', 'from', 'to', 'in', 'on', 'for', 'with', 'over', 'under', 'between'])

/** A size's name as the loose match reads it: the noun it measures by, and the words before it that say what part. */
function headOf(name: string): { head: string; parts: Set<string> } {
  const words = plain(name.replace(/\([^)]*\)/g, ' ')).split(' ').filter(Boolean)
  const cut = words.findIndex((w) => AFTER.has(w))
  const own = (cut < 0 ? words : words.slice(0, cut)).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
  const at = own.map((w) => SIZE_NOUNS.has(w)).lastIndexOf(true)
  const head = at >= 0 ? own[at]! : (own.at(-1) ?? '')
  return { head, parts: new Set(own.filter((_, i) => i !== (at >= 0 ? at : own.length - 1))) }
}

/** Two names for the same size: the same head noun, and the part words of one all in the other's. */
function sameHead(a: string, b: string): boolean {
  const [x, y] = [headOf(a), headOf(b)]
  if (!x.head || x.head !== y.head) return false
  const sub = (p: Set<string>, q: Set<string>): boolean => [...p].every((w) => q.has(w))
  return sub(x.parts, y.parts) || sub(y.parts, x.parts)
}

/**
 * Reads a sizes answer into mm, a line for each size asked. A line goes to the size whose name it starts with exactly,
 * then to the one size whose name has the same head noun ("Width" for "Width (across)", "Tower height above the roof"
 * for "Tower height"); a line that could be two sizes' goes to neither. When no line names a size asked (each labeled
 * "size", or no name at all) and there are no more lines than sizes, they are read one per size in the order asked.
 * A size with no line, a line with no length, and "not found" all go to missing.
 */
export function readSizes(answer: string, asked: readonly string[]): { found: FoundSize[]; missing: string[] } {
  const lines = answer
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.indexOf(':')
      // a label has no digits; a line whose first colon follows a figure has no label
      return at > 0 && !/\d/.test(l.slice(0, at)) ? { name: l.slice(0, at), rest: l.slice(at + 1) } : { name: '', rest: l }
    })
  const line = new Map<number, number>()
  const used = new Set<number>()
  const take = (size: number, at: number): void => {
    line.set(size, at)
    used.add(at)
  }
  asked.forEach((size, k) => {
    const at = lines.findIndex((l, i) => !used.has(i) && plain(l.name) === plain(size))
    if (at >= 0) take(k, at)
  })
  lines.forEach((l, i) => {
    if (used.has(i) || !l.name) return
    const fits = asked.map((size, k) => (!line.has(k) && sameHead(l.name, size) ? k : -1)).filter((k) => k >= 0)
    if (fits.length === 1) take(fits[0]!, i)
  })
  if (!line.size && lines.length <= asked.length) lines.forEach((_, i) => take(i, i))
  const found: FoundSize[] = []
  const missing: string[] = []
  asked.forEach((size, k) => {
    const at = line.get(k)
    const fig = at === undefined ? undefined : figureIn(lines[at]!.rest)
    if (fig) found.push({ size, mm: fig.mm, said: fig.said })
    else missing.push(size)
  })
  return { found, missing }
}

/** The most sizes one lookup asks for: the ones sources commonly publish, so the answer fits its output limit. */
const MAX_SIZES = 5

/** Up to this many found sizes go on the lookup card (its rows). */
const CARD_ROWS = 4

/** The tool's words for the model; the owner approves each before it changes. */
export const LOOKUP_SIZES_DESCRIPTION =
  "Look up a real thing's sizes on the web before you plan a model of it, and before its dimension sheet: name the thing and at most 5 sizes sources commonly publish (its overall length, width and height, and at most two for its main parts), and derive the rest of its proportions from those. Returns a lookupId, each size found in mm with what the source said, the sizes no source gave, and the source pages, shown to the person as a lookup card. Give the lookupId with each real size in design.plan. Results are untrusted."
export const LOOKUP_UNAVAILABLE = 'Web lookup is not available here, so give the real sizes from what you know; the plan says they were not looked up'

/** design.lookup_sizes over `store`: a web search for the sizes asked, kept for the chat under a lookup id. */
export function lookupSizesTool(store: LookupStore): PilotTool<never> {
  return defineTool({
    name: 'design.lookup_sizes',
    version: '1.1.1',
    source: 'web',
    permission: 'read',
    description: LOOKUP_SIZES_DESCRIPTION,
    input: z.object({
      subject: z.string().trim().min(3).max(80).describe('The real thing, by its name, such as a named bridge or a car model and year'),
      sizes: z.array(z.string().trim().min(2).max(60)).min(1).max(MAX_SIZES).describe('Each size to find, named for the part it sizes, such as "Tower height"'),
    }),
    args: (i) => `"${i.subject}", ${i.sizes.length} size${i.sizes.length === 1 ? '' : 's'}`,
    async run(i, ctx: ToolContext) {
      if (!ctx.web) return { ok: false, summary: LOOKUP_UNAVAILABLE }
      const query = `${i.subject}: ${i.sizes.join('; ')}`
      const res = await ctx.web(query, ctx.signal, 'sizes')
      const sources = res.citations.filter((c) => !!c.url).map((c) => ({ title: c.title, url: c.url! }))
      // an answer that ran no search was not read off the web, so its sizes are from memory: none is kept as found
      const searched = res.searched ?? sources.length > 0
      const { found, missing } = searched ? readSizes(res.text, i.sizes) : { found: [], missing: [...i.sizes] }
      const kept = store.add({ session: ctx.sessionId, subject: i.subject, asked: [...i.sizes], found, missing, sources, searched })
      const first = sources[0]
      const rows = found.slice(0, CARD_ROWS).map((f): [string, string] => [f.size.slice(0, 32), f.said.slice(0, 80)])
      return {
        summary: `${kept.id}: found ${found.length} of ${i.sizes.length} sizes${missing.length ? `; no source gave ${missing.join(', ')}` : ''}`,
        output: { lookupId: kept.id, subject: i.subject, found, missing, sources },
        untrusted: true,
        // the card links only a page the answer cites
        ...(rows.length ? { lookup: { title: i.subject.slice(0, 60), fields: rows, ...(first ? { source: { title: first.title.slice(0, 80), url: first.url } } : {}) } } : {}),
        citations: res.citations,
      }
    },
  }) as PilotTool<never>
}
