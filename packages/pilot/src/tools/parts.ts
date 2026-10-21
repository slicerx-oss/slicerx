// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// parts.lookup: the published sizes of a standard part or product a request names (a 608 bearing, a NEMA 17 motor, an
// M3 clearance hole, a Raspberry Pi 4), each with its unit and the page it came from, read from the standard parts
// table. Class read. A part the table lacks comes back as not found, with the nearest entries, so the model asks or
// looks it up instead of using a size from memory.
import type { Citation, ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import { matchParts, words, type PartMatch } from '../parts/match'
import { bundledPartsTable, type PartRecord, type PartSize, type PartsTable } from '../parts/table'
import { defineTool, type PilotTool, type ToolOutput } from '../tool'

/** How many records one answer carries at most (a family such as NEMA 17 can match several models). */
const MAX_PARTS = 4

const NOT_FOUND_HINT = 'Not in the standard parts table. Ask the person which model they have, or look it up with web.lookup and say the size came from the web. Do not use a size from memory.'

function host(url: string | null): string {
  if (!url) return 'no source'
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** "8 mm", "85 x 56 mm", "(3.5, 3.5), (61.5, 3.5) mm", "m*z (formula, mm)", "not published". */
export function sizeText(s: PartSize): string {
  const v = s.value
  if (v === null) return 'not published'
  const formula = s.unit?.startsWith('formula:')
  const unit = formula ? '' : s.unit && s.unit !== 'count' && s.unit !== 'designation' ? ` ${s.unit}` : ''
  let text: string
  if (Array.isArray(v)) text = v.every((x) => Array.isArray(x)) ? (v as number[][]).map((p) => `(${p.join(', ')})`).join(', ') : (v as (number | string)[]).join(' x ')
  else text = String(v)
  if (formula) return `${text} (formula, ${s.unit!.slice('formula:'.length)})`
  return `${text}${unit}${s.limit && s.limit !== 'nominal' ? `, ${s.limit}` : ''}`
}

const label = (key: string): string => key.replaceAll('_', ' ').replaceAll('.', ', ')

/** One record as the model reads it: every size with its unit and source, and the notes that limit its use. */
function partOut(r: PartRecord, scope: string | undefined) {
  return {
    category: r.category,
    id: r.id,
    name: r.name,
    ...(scope ? { scope } : {}),
    ...(Object.keys(r.info).length ? { info: r.info } : {}),
    sizes: r.sizes.map((s) => ({
      key: s.key,
      value: s.value,
      unit: s.unit,
      source_url: s.source_url,
      ...(s.limit ? { limit: s.limit } : {}),
      ...(s.status ? { status: s.status } : {}),
      ...(s.derivation ? { derivation: s.derivation } : {}),
      ...(s.reason ? { reason: s.reason } : {}),
    })),
  }
}

function citationsFor(parts: PartRecord[]): Citation[] {
  const out = new Map<string, Citation>()
  for (const r of parts) {
    for (const s of r.sizes) {
      if (!s.source_url || s.value === null || out.has(s.source_url)) continue
      out.set(s.source_url, { id: s.source_url, title: `${r.name} (${host(s.source_url)})`, url: s.source_url, publisher: host(s.source_url), kind: 'kb' })
    }
  }
  return [...out.values()]
}

/** The first few published sizes, for the folded row: "bore 8 mm, outside diameter 22 mm, width 7 mm". */
function brief(r: PartRecord): string {
  const shown = r.sizes.filter((s) => s.value !== null && !s.unit?.startsWith('formula:') && !/tolerance/.test(s.key)).slice(0, 3)
  return `${r.name}${shown.length ? `: ${shown.map((s) => `${label(s.key)} ${sizeText(s)}`).join(', ')}` : ''}`
}

/** Text cut to the card's room, ending in an ellipsis when it was cut. */
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}\u2026`)

// Words a request names a part with that are not part of its name: "a case for my iPhone 15" still names the iPhone 15.
const FILLER = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'for', 'of', 'to', 'with', 'and', 'case', 'holder', 'dock', 'stand', 'tray', 'mount', 'bracket', 'bumper', 'cover', 'adapter', 'plate'])

/** True when the matched name is the whole of what the request names, so "iPhone 15 mini" is not taken for the iPhone 15. */
function coversQuery(m: PartMatch, query: string, table: PartsTable): boolean {
  const own = new Set([...words(m.matched), ...words(m.record.name)])
  const category = new Set(table.categories.find((c) => c.id === m.record.category)?.words.flatMap((w) => words(w)) ?? [])
  return words(query).every((w) => own.has(w) || FILLER.has(w) || category.has(w) || category.has(w.replace(/s$/, '')))
}

/**
 * The one part found as a card in the view, as lookup.show shows one, so a looked-up size is always on screen with its
 * page: up to four published sizes from the page the first one came from. None when no size has a page.
 */
function cardOf(r: PartRecord): ToolOutput['lookup'] {
  const page = r.sizes.find((s) => s.value !== null && s.source_url)?.source_url
  if (!page) return undefined
  const shown = r.sizes.filter((s) => s.value !== null && s.source_url === page && !s.unit?.startsWith('formula:') && !/tolerance/.test(s.key)).slice(0, 4)
  return { title: clip(r.name, 60), fields: shown.map((s) => [clip(label(s.key), 32), clip(sizeText(s), 80)]), source: { title: clip(`${r.name} (${host(page)})`, 80), url: page } }
}

/** Looks `name` up in `table` and shapes the answer for the model, the chat and an MCP client. */
export function lookupParts(table: PartsTable, name: string, category?: string): ToolOutput {
  const res = matchParts(table, name, category)
  if (!res.found) {
    const which = res.nearest.length && res.categories.length ? ` It names a family: ask which one (${res.nearest.map((n) => n.name).join(', ')}), or look the model up.` : ''
    return {
      ok: false,
      summary: `"${name}" is not in the standard parts table${res.nearest.length ? `; nearest: ${res.nearest.map((n) => n.name).join(', ')}` : ''}`,
      output: { found: false, query: name, ...(category ? { category } : {}), nearest: res.nearest, hint: `${NOT_FOUND_HINT}${which}` },
    }
  }
  const parts = res.matches.slice(0, MAX_PARTS).map((m) => m.record)
  // a card only for one part whose name is all the request names: a near name ("iPhone 15 mini") gets none
  const card = res.matches.length === 1 && coversQuery(res.matches[0]!, name, table) ? cardOf(parts[0]!) : undefined
  const scopes = new Map(table.categories.map((c) => [c.id, c.scope]))
  const display: ToolDisplay[] = parts.map((r) => ({
    kind: 'table',
    head: [r.name, 'value', 'source'],
    rows: r.sizes.map((s) => [label(s.key), s.value === null ? { text: 'not published', tone: 'dim' } : `${sizeText(s)}${s.status === 'derived' ? ' (worked out)' : ''}`, host(s.source_url)]),
  }))
  return {
    summary: parts.length === 1 ? brief(parts[0]!) : `${res.matches.length} parts match "${name}": ${parts.map((r) => r.name).join(', ')}`,
    output: {
      found: true,
      query: name,
      parts: parts.map((r) => partOut(r, scopes.get(r.category))),
      ...(res.matches.length > parts.length ? { more: res.matches.length - parts.length } : {}),
      note: 'Say where each size came from (the source page). A null value is not published: ask or look it up, never fill it in.',
    },
    display,
    citations: citationsFor(parts),
    ...(card ? { lookup: card } : {}),
  }
}

/** parts.lookup over `table`, the bundled table by default. */
export function partsTool(table?: PartsTable): PilotTool<never> {
  return defineTool({
    name: 'parts.lookup',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description: 'Published sizes, with sources, of a standard part or product: 608 bearing, NEMA 17, M3, Pi 4, iPhone 15.',
    input: z.object({
      name: z.string(),
      category: z.string().optional(),
    }),
    args: (i) => `"${i.name}"${i.category ? ` --category ${i.category}` : ''}`,
    async run(i) {
      return lookupParts(table ?? (await bundledPartsTable()), i.name, i.category)
    },
  }) as PilotTool<never>
}
